# GEMM：把矩陣切成可搬、可算的工作

分類：LLM推論 · 工程推導 · 來源快照 2026-09-12

從 Transformer projection 的 M/K/N，到 array、L1 與 microtile 的四層 tiling；算術多不代表 DMA 與同步便宜。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 先把 LLM 張量翻成 GEMM

線性層可寫成 `Y = XW`。把 batch 與這次處理的 token 數合成 M，輸入 hidden dimension 是 K，輸出 dimension 是 N。權重是否已轉置、stride 與連續性要明列；公式中的 B 是邏輯 K×N，不保證檔案中的權重也是這個排列。Prefill 的 M 通常較大，單序列 decode 的 M 通常為 1；後者接近 GEMV，不能直接套用大 GEMM 的效率。[Qwen model source](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) 可用來對照真實 projection 呼叫。

以下是數學工作模型，不是時間預測：dense GEMM 約 `2MKN` operations，採乘法與加法各算一次。bias、activation、padding、重排、低精度轉換不在這個數字裡。

## 四層 tiling 各自回答不同問題

| 層級 | 分割目的 | 常見錯誤 |
|---|---|---|
| Host 矩陣 M/K/N | 決定 tensor layout 與呼叫大小 | 把 batch 和 head 混進錯的維度 |
| Array rows/columns | 不同 core 負責不同輸出區塊 | 以為任意欄數都能取得 partition |
| Compute tile m/k/n | SRAM、buffer 深度、K 累加 | 只看 A/B，忘記 C 與 stack |
| Microtile r/s/t | 符合 kernel operand layout | 把 API call 當單一硬體指令 |

[whole_array.py](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_examples/basic/matrix_multiplication/whole_array/whole_array.py) 描述上述層級如何串起；[linalg.py](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/python/iron/kernels/linalg.py) 提供選定 kernel geometry。兩者都要看，不能只改最底層 template。

## 一個容量推導例子

假設 BF16 A/B、FP32 C，m=64、k=64、n=32；A/B 各雙緩衝，C 單緩衝，另留 1 KiB stack：

```text
A = 64 × 64 × 2 = 8192 bytes
B = 64 × 32 × 2 = 4096 bytes
C = 64 × 32 × 4 = 8192 bytes
budget = 2 × (8192 + 4096) + 8192 + 1024
       = 33792 bytes = 33 KiB
```

這只是算式結果，**不是保證可編譯的 tile**。實際還有 globals、對齊、FIFO 展開、額外 accumulators、spill 與 bank placement。可回原始指南使用 L1 估算器；SRAM 真實限制讀 [core_data_memory](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md)。

## Packing 與重用先於更多核心

CPU row-major 的 64×64 block 不一定等於連續 `(r,s)` microtiles。優先讓 host 或 MemTile DMA 產生 kernel 要的 stream order，降低 core shuffle 和 scatter/gather 的負擔。但「DMA 能做重排」不代表任意高維 layout 都是一個合法 BD；維度數、stride、長度、對齊與元素單位都要查。

A 沿輸出 N 重用，B 沿輸出 M 重用。廣播若增加 route、同步或 BD 壓力，可能抵消節省的 DRAM 流量。K 分段時，C 的生命週期應跨 K chunks；若每塊都把 C 回寫再讀取，就要把額外 traffic 算回 roofline。

## Padding、尾端與數值路径

當 N、K 不整除 tile 時，可使用支援的 mask 或 zero-padding，最後裁回有效輸出。不要把 padded operation count 除以原始工作量當成更高 TOPS。對 BF16/BFP16，padding 還要維持 exponent block、轉置與 rounding 模式正確；改成 BFP kernel 並非只換一個 dtype 名稱。[BF16 helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp) 說明 macro 會改变路徑。

## 實驗次序

先選一個合法小尺寸，對 CPU reference 檢查負值、outlier 與不整除尾端，再量單核、單欄、多欄。記錄 useful ops 和實際 padded ops、core time 和端到端 time。每次只變一個因素：tile、buffer 深度、placement 或 packing。若下界已由 memory 限制，先改善重用，不要先用更高宣傳 TOPS 解釋問題。

## 來源
- [IRON whole-array GEMM](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_examples/basic/matrix_multiplication/whole_array/whole_array.py) — 固定 SHA 範例；參數、packing、partition 須一起檢查。
- [IRON linalg kernel geometry](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/python/iron/kernels/linalg.py) — dtype / mac_dims 與 kernel 路徑，非 API shape 全集。
- [Core data memory guide](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md) — SRAM 配置、bank 與 linker context。
- [AIE2P BF16 MMUL helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp) — macro 與 specialization 決定 emulation 路徑。
- [Qwen2.5 model.py](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) — 固定 source snapshot；裝置分支必須以實際程式為準，未在本機執行。

## 關聯
- [mma](mma.md)
- [memory](memory.md)
- [dma](dma.md)
- [prefill-decode](prefill-decode.md)
- [performance](performance.md)

## 反向連結
- [memory](memory.md)
- [dma](dma.md)
- [mma](mma.md)
- [iron](iron.md)
- [triton](triton.md)
- [prefill-decode](prefill-decode.md)
- [performance](performance.md)
