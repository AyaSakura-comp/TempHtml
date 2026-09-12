# 正確性與效能驗證：一套不把 fallback 當成功的流程

分類：驗證與知識庫 · 工程推導 · 來源快照 2026-09-12

从 reference、數值誤差、dispatch 證據到完整 LLM quality；每一層只回答自己能證明的問題。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 五層通過，不可以跳級

| 層級 | 證據 | 仍未證明 |
|---|---|---|
| Source inspected | pinned headers / mapping / tests 已閱讀 | binary 可建置 |
| Compile | artifact 成功產生，target 正確 | 硬體成功執行 |
| Dispatch | device completion、正確 buffer／ABI | 結果數值正確 |
| Correctness | reference 與特定測資誤差通過 | 任意輸入、整個模型或效能達標 |
| End-to-end | 無未揭露 fallback，模型品質與時間可重現 | 其他 SKU、版本與 workloads 也一樣 |

這份 Wiki 主要位於第一層，加上數學和網站測試；沒有冒充後四層。Compiler dashboard 的 checkmark 可能只代表 transform file 可用，需以其圖例與實際測試紀錄為準。[Triton README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) 的「experimental」是重要範圍標示。

## 建立明確 reference

固定 shape、layout、signedness、input/output dtype、scale、rounding、saturation、accumulator 與 random seed。BF16×BF16→FP32 的 reference 應先量化輸入成相同 BF16，再累加比較；若 kernel 轉 BFP，應另有模擬同 block exponent 路徑的參考。不能用 FP32 全精度輸入的差異籠統判定所有誤差都是 compiler bug。

對 integer，至少包含負值、0、邊界與可能溢位的 K 長度；對 float，包含近零、outlier、不同量级與 mask。NaN/Inf 行為若不在規格承諾內也應明列，而不是悄悄排除。

## 指標不只一個 allclose

可同時報 max absolute error、相對誤差（分母需處理近零）、RMSE、cosine similarity，並報測資分布與 tolerance。單一 `allclose` 可能被少數大值或寬鬆門檻掩蓋。對模型還要比較 logits、top-k、固定採樣輸出與任務品質；字串一致性不是唯一品質指標，字串不一致也不自動代表全部數值錯誤。

[AIE2P BF16 helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp) 與 [IRON kernel geometry](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/python/iron/kernels/linalg.py) 是決定精度路徑的來源；設定檔與編譯 macro 必須保存。

## 揪出靜默 fallback

很多研究性範例在 NPU compilation 失敗時會回到 PyTorch。這對 demo 友善，對 benchmark 卻危險。應保存每個 op 的實際 backend、首次編譯結果、dispatch counters 與 fallback log；測量模式最好在 fallback 時顯式 fail 或至少獨立標示其耗時。[Qwen model](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) 與各 kernel wrappers 要一起讀。

CPU 的 embedding、sampling、attention core 或 LM head 若是設計選擇，應稱為 CPU+NPU 路徑，不必假装是意外 fallback；但是 mode 名叫 npu 並不能掩蓋它們。

## 端到端計時邊界

測時間前明確完成事件或 device synchronize，防止只量 enqueue。分開編譯、權重載入、配置、host packing、mapping、transfer、compute、等待與輸出後處理。比較同一筆 useful work 和同品質設定；不要一邊含下載或JIT，另一邊已warm cache。

把結果寫成 manifest：source SHA、工具鏈版本、driver/runtime、SKU/partition、shape、dtype、seed、容忍誤差、cold/warm、背景負載與artifact hash。相同 inputs 不保證相同硬體狀態，應記錄多次分布而非只報最好一次。

## 可直接使用的驗證紀錄模板

```text
Claim: 這個 op 在 AIE2P 上無 fallback 執行
Source / artifact hash:
Device / partition / driver / runtime:
Input shape / dtype / layout / seed:
Compiler flags / macros / padding:
Reference arithmetic and tolerance:
NPU dispatch evidence / fallback count:
Max error / model quality:
Warmup policy / repetitions / timing boundaries:
Result / unresolved gaps:
```

先以一條可以被否證的 claim 開始；遇到失敗先保存最小重現與 logs，再回 [debug](debug.md) 查根因，而不是不停增加 tolerance 或換測資讓它過。

## 來源
- [Qwen2.5 model.py](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) — 固定 source snapshot；裝置分支必須以實際程式為準，未在本機執行。
- [Triton-XDNA README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) — 實驗性 compiler；上游效能數字不代表本機量測。
- [AIE2P BF16 MMUL helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp) — macro 與 specialization 決定 emulation 路徑。
- [IRON linalg kernel geometry](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/python/iron/kernels/linalg.py) — dtype / mac_dims 與 kernel 路徑，非 API shape 全集。

## 關聯
- [debug](debug.md)
- [performance](performance.md)
- [quantization](quantization.md)
- [qwen-case](qwen-case.md)
- [wiki-method](wiki-method.md)

## 反向連結
- [synchronization](synchronization.md)
- [isa](isa.md)
- [datatypes](datatypes.md)
- [qwen-case](qwen-case.md)
- [attention](attention.md)
- [kv-cache](kv-cache.md)
- [quantization](quantization.md)
- [deployment](deployment.md)
- [performance](performance.md)
- [debug](debug.md)
- [sources](sources.md)
- [wiki-method](wiki-method.md)
