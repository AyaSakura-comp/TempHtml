# Prefill 與 decode：兩個不同的效能問題

分類：LLM推論 · 工程推導 · 來源快照 2026-09-12

Prefill 重視大矩陣吞吐與 TTFT；decode 重視逐 token 依賴、權重/KV 流量與派送延遲。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## Prefill 的工作

Prefill 一次處理 prompt 中多個 token，建立各層 activation 與 KV cache。對線性層而言，M 可近似這次處理的 token 數乘 batch，較有機會重用同一權重區塊。這不代表所有 prefill 一定 compute-bound；短 prompt、padding、attention IO 或同步仍可能佔優。

## Decode 的工作

Autoregressive decode 需要前一個 token 的輸出才能選下一個輸入；單條序列的大部分線性層變成小 M。若 batch=1、沒有其他重用，每一步可能重新讀大量權重，並讀取累積 KV。把 decode 的 kernel 換到另一個装置，需要額外付出 buffer 可見性、dispatch 與 graph 切換成本。[Qwen backend modes](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/README.md) 是不同階段採不同裝置分工的具體範例。

## 正確拆分指標

| 指標 | 建議定義 | 不應混入的宣稱 |
|---|---|---|
| TTFT | 從明確請求邊界到第一 token 可用 | 不應用一次預先編譯 kernel 時間代替 |
| Prefill latency | 固定 prompt 工作的前向時間 | 不等於整段聊天延遲 |
| TPOT | 後續 tokens 的平均或分位間隔 | batch throughput 不等於單用戶延遲 |
| Decode throughput | 固定生成 token 数 / 對應時間 | 不要把 prompt tokens 加進分子 |
| Cold vs warm | 是否含編譯、配置、載入與映射 | 冷暖結果不可直接交叉比較 |

開始/結束時間邊界要同步裝置；只量非同步 enqueue 是派送開銷，不是完成時間。這些是本 Wiki 的量測定義建议，非上游硬體規格。

## 小 M 為什麼可能吃不滿 matrix engine

GEMM 的理想最少流量約 `(MK+KN)s_in + MN*s_out`。當 M=1，權重 KN 通常壓倒其他項，算術強度接近 `2/s_in` ops/byte；若 BF16 權重佔 2 bytes，就是接近 1 ops/byte 的簡化上界。忽略了 cache 與量化時，增加算術峰值往往無法消除頻寬限制。詳見 [效能模型](performance.md)。

硬體 matrix primitive 有固定 M/K/N geometry。把 M=1 補到8或更大，增加的是實際運算與搬運，不是有用 tokens。Compiler 能否 specialize 小 M、合併不同序列、減少 launch，要逐項驗證。

## Chunked prefill、batch 與推測解碼

Chunked prefill 把長 prompt 分塊，可能改善與 decode 請求間的排程公平性，但也改變 DMA、cache indexing 和單次 GEMM M。Continuous batching 把多條序列合在一起，提高 M 與重用，代價是更複雜的動態 shapes 與 KV 管理。[PagedAttention](https://arxiv.org/abs/2309.06180v1) 是理解 serving 記憶體系統的參考，不是本 runtime 的現成功能保證。

Speculative decoding 可把部分驗證工作變成多 token forward，但接受率、draft 成本、資料搬運與採樣正確性都要計入。不能把 GPU MTP 的已知加速比直接套到 XDNA2；本 Wiki 沒有實作或測量 NPU speculative decoding。

## 試驗怎麼設計

至少測短/中/長 prompt、短/長 cache 與不同 batch；固定模型、權重dtype、prompt、輸出 token 數及採樣策略。分列 per-op time、copy/map/sync、fallback 次數、TTFT、TPOT 與記憶體峰值。若 hetero-fast prefill 使用 NPU、decode 回 GPU，應如實標示兩段路徑，而不是稱整段生成均由 NPU 加速。[Qwen model.py](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) 是核對 dispatch 的最終入口。

## 來源
- [Qwen2.5 model.py](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) — 固定 source snapshot；裝置分支必須以實際程式為準，未在本機執行。
- [Qwen2.5 README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/README.md) — 部分敘述與 routing table 有差異，須交叉閱讀 model.py。
- [PagedAttention paper v1](https://arxiv.org/abs/2309.06180v1) — 分頁與共享的系統概念，不是本 wiki 已實作的 runtime。
- [IRON whole-array GEMM](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_examples/basic/matrix_multiplication/whole_array/whole_array.py) — 固定 SHA 範例；參數、packing、partition 須一起檢查。

## 關聯
- [gemm](gemm.md)
- [kv-cache](kv-cache.md)
- [heterogeneous](heterogeneous.md)
- [performance](performance.md)
- [qwen-case](qwen-case.md)

## 反向連結
- [llm-graph](llm-graph.md)
- [qwen-case](qwen-case.md)
- [gemm](gemm.md)
- [kv-cache](kv-cache.md)
- [heterogeneous](heterogeneous.md)
- [performance](performance.md)
