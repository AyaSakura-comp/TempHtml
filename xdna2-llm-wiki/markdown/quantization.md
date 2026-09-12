# LLM 量化：格式、數學與 kernel 是三件事

分類：數值 · 工程推導 · 來源快照 2026-09-12

W4A16、INT8、BF16、BFP16 與 GGUF/AWQ 不是可以任意互換的標籤；必須追到 unpack、scale 與真正的 multiply 路徑。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 先拆開五個層次

檔案格式描述 bytes 怎麼保存；量化方案描述如何近似數值；kernel layout 描述 SIMD/MMA 需要的排列；compiler lowering 選擇指令；runtime 決定資料在哪裡解包與運算。讀到 GGUF Q4 或 AWQ 4-bit，不能直接推出 AIE2P 有相同格式的 native MMA。[AWQ](https://arxiv.org/abs/2306.00978v6) 本身就把平台感知 packing 與 kernel fusion 視為效能要素。

## W4A16 不等於 4×16 matrix primitive

W4A16 通常意指權重以低位元表示，activation 使用較高精度；真正計算可能是先反量化 W，再做 BF16 算術，也可能融合 unpack、scale 和累加。A/B 的順序、signedness、group size、zero point、scale dtype 會影響可用 implementation。僅看檔案中每個權重 4 bits，不足以用「4-bit TOPS」估算速度。

本次 Peano snapshot 的 INT8×INT4 4×16×16 wrapper 是 unpack + 兩次 INT8 primitives；這是該工具鏈的靜態路徑，不是「整顆 XDNA2 永遠沒有其他 INT4 能力」的證明。完整 immutable 展開見 [MMA 條目](mma.md) 與原始稽核。

## 常見 affine 量化的數學

```text
近似權重 w_hat = scale × (q - zero_point)
weight-only linear:
  y_j ≈ sum_k x_k × scale_group(k,j) × (q_kj - zero_group(k,j))
```

這是常見示意，不是所有 GGUF/AWQ 編碼的精確格式。scale 若每 group 改變，就不能毫無條件移到整個 K reduction 外。非對稱 zero point 也會帶來 correction term。要先寫清數學，再判斷可融合哪一段、用哪種 accumulator，以及輸出縮位在哪裡发生。

## BF16 與 BFP16 的風險不同

BF16 每個值有自己的 exponent；AIE2P BFP16 EBS8 的 block 共用 exponent，不能叫 IEEE FP16 或 FP8。對 outlier 強烈的 block，共享 exponent 會犧牲較小值精度。[AIE2P BF16 helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp) 的 BFP emulation macro 會改變數值路徑，並不保證無損等價。

BFP packing 可能減少 operands 的 bytes，但若額外保留 BF16 原本張量、conversion buffer 與轉置副本，peak memory 未必下降。對 LLM 應分別評估 projection、attention normalization、residual 與 KV，不能只在隨機矩陣上過 tolerance 就宣告整個模型可靠。

## 一個 7B 權重容量的理想下界

假設全部 7×10⁹ 個參數都用固定 4 bits，裸 payload 是 `7e9 × 4 / 8 = 3.5e9 bytes`，約 3.26 GiB。這不是實際模型檔案大小：有 scales、block headers、某些保留高精度的 tensors、metadata 與 runtime workspace。也不代表 7B 模型在 NPU 上全部算子都有 kernel。

| 要比較 | 必須固定 |
|---|---|
| 誤差 | calibration、輸入範圍、rounding、accumulator |
| Kernel 速度 | 同形狀、同 packing、相同輸出精度與有效工作量 |
| 端到端品質 | tokenizer、prompt、採樣參數、模型版本 |
| 記憶體 | 權重 + KV + peak activations + 額外轉換副本 |

## 實作前的核對清單

列出每一個格式的 bit order、group 與 padding；用正負數、全零、飽和邊界、極大極小值驗證 dequant reference；再看 compiler IR 與 core disassembly 是否有意外 CPU fallback 或重複 conversion。先確定 [資料型別](datatypes.md) 和 [數值驗證](validation.md)，再談量化加速。AWQ 論文的 GPU speedup 不能轉抄為本機 XDNA2 實測。

## 來源
- [AWQ paper v6](https://arxiv.org/abs/2306.00978v6) — weight-only quantization 與平台感知 packing；GPU 結果不能移植成 NPU 吞吐。
- [AIE2P BF16 MMUL helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp) — macro 與 specialization 決定 emulation 路徑。
- [IRON linalg kernel geometry](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/python/iron/kernels/linalg.py) — dtype / mac_dims 與 kernel 路徑，非 API shape 全集。
- [Triton-XDNA README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) — 實驗性 compiler；上游效能數字不代表本機量測。

## 關聯
- [datatypes](datatypes.md)
- [mma](mma.md)
- [validation](validation.md)
- [kv-cache](kv-cache.md)
- [deployment](deployment.md)

## 反向連結
- [datatypes](datatypes.md)
- [mma](mma.md)
- [llm-graph](llm-graph.md)
- [validation](validation.md)
