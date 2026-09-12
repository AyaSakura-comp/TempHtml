# 效能模型：容量、Roofline 與端到端下界

分類：驗證與知識庫 · 工程推導 · 來源快照 2026-09-12

用可驗算的公式排除不合理期待，再用量測找瓶頸；計算器預設值不是本機 XDNA2 規格。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 先問是哪一種限制

容量不足、傳輸不足、算術不足、同步太多與 runtime 太慢是不同問題。容量回答「能放哪裡」；bandwidth 回答「能搬多快」；compute throughput 回答「可執行多少有效運算」；launch/依賴決定小工作是否有用。這些層級不能用一個 TOPS 數字取代。[IRON GEMM](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_examples/basic/matrix_multiplication/whole_array/whole_array.py) 同時含 tile、DMA 與 host 控制，正好說明為什麼要分開測。

## GEMM 的理想工作與最少流量

採 dense `C=A×B`、β=0、不讀舊 C、A/B 各讀一次、C 寫一次的理想模型：

```text
Ops = 2 × M × K × N
Bytes_min = (M×K + K×N) × input_bytes + M×N × output_bytes
Arithmetic intensity = Ops / Bytes_min
```

這裡的一次讀取是理想重用條件，不是實際 NPU DMA 的保證。多次搬運 C、padding、packing、metadata、權重解包或無法保留的 A/B 都會增加流量。對 FlashAttention 這类融合演算法，應用其真實中間值策略，不能把獨立 GEMM 下界直接加總當成完整 attention 下界。[FlashAttention](https://arxiv.org/abs/2205.14135v2) 特別強調 IO 模型的重要性。

## 以同一精度定義算力與流量

```text
t_compute >= Ops / effective_ops_per_second
t_memory  >= Bytes_min / effective_bytes_per_second
t_kernel  >= max(t_compute, t_memory)     # 理想充分重疊
```

若計算輸入是 BF16/BFP，卻拿 INT8 的峰值當有效算力，模型已經不一致。BFP conversion、emulation 或低精度 decomposed multiplication 應依真正路徑估算，而不是一次 `mmul` 算一次 cycle。對未知的有效頻寬，不要冒用 DRAM pin rate 或 GPU benchmark 當 NPU實測。[數值型別](datatypes.md) 與 [MMA](mma.md) 先釐清算的是什麼。

## 下界不是 prediction

下方工具的 10 TOPS 和 50 GB/s 是使用者可調的教學假設；不是實測，也不是 XDNA2 任何 SKU 保證。所得最小時間是假设所有其他成本消失且重疊理想的樂觀值。實際時間可以高很多；若量測比下界更短，先查單位、有效工作量、計時同步與假設是否错。

TOPS 使用十進位 10¹² operations/s；GB/s 使用 10⁹ bytes/s；KiB/MiB/GiB 使用 2 的冪。把兩組單位混用會引入系統性差異。下方流量顯示 MiB，而使用者頻寬輸入是 GB/s，程式在計算時明確換算。

## 從單核到模型的量測階梯

1. 查單核 schedule、spills、loads 與數值誤差。
2. 在同樣資料與相同輸出格式下，測多核心、廣播與 buffer 深度。
3. 加入 host packing、配置與完成等待。
4. 放回 Transformer graph，檢查 conversion、fallback 與共享記憶體競爭。
5. 分別報 cold TTFT、warm TTFT、TPOT、batch throughput 與 peak memory。

不以最漂亮的一次值代表穩定結果。固定輸入、記錄分布、重跑基準；對溫度、功耗政策與併行背景工作保持透明。本 Wiki 不會從這些純數學工具產生虛構 tokens/s 排名。

## 值得優先做的改善

若 memory 下界佔優，先減少重讀、改善 layout、維持 buffer 重用或選合適量化；若 dispatch 佔優，融合相鄰工作或減少跨裝置邊界；若 compute 佔優，才進一步看 microtile 與指令排程。每個改善都須以完整正確性測試守住，不把降低 precision 的結果當免費優化。

## 來源
- [IRON whole-array GEMM](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_examples/basic/matrix_multiplication/whole_array/whole_array.py) — 固定 SHA 範例；參數、packing、partition 須一起檢查。
- [FlashAttention paper v2](https://arxiv.org/abs/2205.14135v2) — GPU IO-aware 演算法論文，不是 XDNA2 kernel 的可用性證明。
- [IRON linalg kernel geometry](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/python/iron/kernels/linalg.py) — dtype / mac_dims 與 kernel 路徑，非 API shape 全集。
- [Triton-XDNA README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) — 實驗性 compiler；上游效能數字不代表本機量測。

## 關聯
- [gemm](gemm.md)
- [prefill-decode](prefill-decode.md)
- [heterogeneous](heterogeneous.md)
- [validation](validation.md)
- [debug](debug.md)

## 反向連結
- [compute](compute.md)
- [mma](mma.md)
- [runtime](runtime.md)
- [qwen-case](qwen-case.md)
- [gemm](gemm.md)
- [kv-cache](kv-cache.md)
- [prefill-decode](prefill-decode.md)
- [heterogeneous](heterogeneous.md)
- [validation](validation.md)
