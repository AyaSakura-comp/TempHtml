# Attention：算子可拆，不代表整體已能在 NPU 跑

分類：LLM推論 · 工程推導 · 來源快照 2026-09-12

把 QKᵀ、softmax、PV、causal mask 與線上歸一化分開看；FlashAttention 的 IO 思想不等於已有 AIE2P kernel。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## Attention 的工作圖

對每個 batch 與 query head，簡化寫成 `O = softmax(QKᵀ / sqrt(d) + mask)V`。投影層 Q/K/V/O 是 GEMM，但投影之間還有 RoPE、head layout、mask、reduction 與 KV 更新。具備 BF16 GEMM 和 softmax 範例，只能證明元件存在，不能證明整個 attention graph 已映射、融合或端到端變快。[Qwen model](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) 是檢查實際裝置分配的入口。

## Prefill 與 decode 的 shape 不同

Prefill 對 S 個新 token 建立多行 queries；naive self-attention 的 score matrix 可達 S×S。Decode 每條序列只有一個新 query，卻要讀取已累積的 T 個 keys/values。前者往往面臨 score 中間值的 IO，後者更容易被 KV 讀取與派送延遲限制。是否採 chunked prefill、sliding window 或 prefix reuse 會改變 shape，必須把假設寫在 benchmark 旁。

## IO-aware tiling：不要保存完整 scores

[FlashAttention](https://arxiv.org/abs/2205.14135v2) 的核心是以 SRAM tiles 計算並更新 softmax 統計，減少 GPU HBM 與 SRAM 之間的中間值存取。這是可借鑑的演算法，不是「XDNA2 已有 FlashAttention」的證據。映射到 NPU 還要回答：Q tile 放哪裡、K/V 從哪個 DMA channel 進來、row reduction 用哪些算術路徑、跨 tile 的 normalization 如何同步、partial output 是否留在 accumulator。

## 線上 softmax 的數學狀態

下面是每個 query row 的未正規化版本。m 是已看過的最大 score，l 是 exponential sum，U 是未除以 l 的 output；這是演算法示意，**不是可執行的 IRON kernel**。

```text
初值 m = -∞, l = 0, U = 0
對新的有效 score block S 與 Vblock：
  m_new = max(m, max(S))
  alpha = exp(m - m_new)
  P = exp(S - m_new)
  l_new = alpha*l + sum(P)
  U_new = alpha*U + P @ Vblock
  m,l,U = m_new,l_new,U_new
結束：O = U / l
```

若 block 全被 mask，需跳過或專門處理，不能直接讓 `-∞ - -∞` 產生 NaN。exp、除法與歸一化的精度要另行驗證；FP32 accumulator 不代表每個輸入乘法都是完整 FP32。與 reference 比較時必須對相同 causal offset、scale、RoPE 位置和有效 token 範圍。

## GQA 不只是把 heads 廣播

[GQA 論文](https://arxiv.org/abs/2305.13245v3) 區分 query heads Hq 與 KV heads Hkv。多個 query heads 共享一組 K/V，可減少 persistent KV payload。但若實作先把 K/V `repeat` 成 Hq heads 才送入 kernel，暫存和實際 traffic 可能回升。應檢查 expand 是否只是 view、是否 materialize，以及 kernel 是否原生使用 head-group 索引。

Qwen 範例 README 的部分舊 prose 與新 routing table 不一致；請讀 [案例頁](qwen-case.md) 的原始碼查核。這份 Wiki 不把 GPU-only fused kernel 冒稱為 NPU attention，也不把 CPU softmax fallback 當 NPU 成功。

## NPU attention 的驗證門檻

必須逐一證明 tail/mask 正確、長上下文穩定、cache append 正確、NPU dispatch 無 fallback、partial output 同步正確，以及完整 layer 比 baseline 更快。必要時先保留 attention 在 GPU，僅探索較大 projection 或 MLP 的 NPU 卸載；這是待測的分工方案，不是通用最佳策略。

## 來源
- [FlashAttention paper v2](https://arxiv.org/abs/2205.14135v2) — GPU IO-aware 演算法論文，不是 XDNA2 kernel 的可用性證明。
- [GQA paper v3](https://arxiv.org/abs/2305.13245v3) — query / KV heads 分組與品質權衡。
- [Qwen2.5 model.py](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) — 固定 source snapshot；裝置分支必須以實際程式為準，未在本機執行。
- [Qwen2.5 README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/README.md) — 部分敘述與 routing table 有差異，須交叉閱讀 model.py。
- [AIE2P BF16 MMUL helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp) — macro 與 specialization 決定 emulation 路徑。

## 關聯
- [llm-graph](llm-graph.md)
- [kv-cache](kv-cache.md)
- [qwen-case](qwen-case.md)
- [heterogeneous](heterogeneous.md)
- [validation](validation.md)

## 反向連結
- [datatypes](datatypes.md)
- [llm-graph](llm-graph.md)
- [kv-cache](kv-cache.md)
