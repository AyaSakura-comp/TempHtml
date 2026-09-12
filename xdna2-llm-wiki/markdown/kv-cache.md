# KV cache：容量、頻寬與生命週期

分類：LLM推論 · 工程推導 · 來源快照 2026-09-12

用 KV heads 而非 query heads 計算 payload；理解 GQA、cache append、分頁，以及「放得下」與「讀得夠快」的差別。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## Cache 保存什麼、不保存什麼

自回歸 decoder 保存各層已生成 tokens 的 keys 與 values，避免每一步重算所有過去投影。它通常不保存每一步完整 attention score matrix，也不是普通 CPU cache 的自動替換機制。配置、位置索引、append、重用、釋放都由模型/runtime 管理。[Qwen model.py](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) 有預先配置並原地寫入 KV 的具體例子。

## 先算理想 payload

若每層 KV shape 相同、所有序列長度都為 T、無 sliding window、無共享 prefix，則：

```text
KV bytes = 2 × B × L × Hkv × D × T × s
B = batch / 並行序列數
L = layers, Hkv = KV heads, D = 每 head 維度
T = 每序列保留 tokens, s = 每 KV 元素 bytes
2 = K 與 V 兩份
```

這是張量元素計數的推導，不是配置器的實測佔用。B=1、L=32、Hkv=8、D=128、T=8192、s=2 時，結果為 **1,073,741,824 bytes = 1 GiB**。每層尺寸不同則改用逐層加總；不同序列長度則按各序列有效或配置長度分別計算。

## GQA 與 MQA 如何省容量

MHA 常有 Hkv=Hq；MQA 的 Hkv=1；GQA 介於兩者之間。[GQA](https://arxiv.org/abs/2305.13245v3) 研究品質與效率的權衡。因此不能用 Q heads 代替 KV heads；也不能在模型未修改時任意減少 KV heads，因為那會改變模型架構與权重相容性。

若 query 分組讀取共享 K/V，理想可避免重複存儲。但若為滿足某 kernel layout 而把 cache 展開成完整 heads，應把 expanded buffer 另外計算；理論 GQA payload 不等於這個 backend 的真實 peak memory。

## Payload 之外的記憶體

| 項目 | 為什麼多出來 |
|---|---|
| Alignment / padding | Tile geometry、頁面與 vector 對齊 |
| Quantization metadata | scales、zero points、block headers |
| Runtime workspace | staging、packing、雙緩衝、暫存 output |
| Prefix / beam bookkeeping | page tables、索引與共享管理 |
| Peak activation | Prefill 或重排階段與 KV 同時存在 |

[核心 SRAM 文件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md) 討論 tile 級容量；系統 DRAM 裡的完整 KV 不會因為 L1/L2 命名就自動被透明快取進 NPU。一次計算應只搬需要的 block，並清楚指定順序與 buffer 生命週期。

## Decode 的頻寬問題

假設每步需要讀一次全層已有 K/V，KV read traffic 會隨 T 成長；GQA 若重用不佳則可能讀更多。權重也需要讀取，因此「模型權重小了」不代表長 context 的 decode 一定快。NPU DMA、DRAM、GPU 與 CPU 可能競爭同一實體頻寬；不能給每個裝置各算一次完整峰值頻寬後再相加。

## 分頁與正確性

[PagedAttention](https://arxiv.org/abs/2309.06180v1) 的 block 管理可減少 fragmentation、預留浪費與重複 prefix，但不會讓相同 K/V 數值的 payload 憑空消失。它也不保證 XDNA2 runtime 已有相同功能。要移植時，page table traversal、非連續地址、DMA BD 限制與 host 介入成本都需另外設計。

驗證 append 時要測 cache slot 只更新一次、query causal offset 正確、跨 page 邊界正確、不同序列彼此隔離、reset 不洩漏舊資料。下方計算器只處理理想容量；不推估本機可跑 context 上限或 tokens/s。

## 來源
- [Qwen2.5 model.py](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) — 固定 source snapshot；裝置分支必須以實際程式為準，未在本機執行。
- [GQA paper v3](https://arxiv.org/abs/2305.13245v3) — query / KV heads 分組與品質權衡。
- [Core data memory guide](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md) — SRAM 配置、bank 與 linker context。
- [PagedAttention paper v1](https://arxiv.org/abs/2309.06180v1) — 分頁與共享的系統概念，不是本 wiki 已實作的 runtime。

## 關聯
- [attention](attention.md)
- [memory](memory.md)
- [prefill-decode](prefill-decode.md)
- [performance](performance.md)
- [validation](validation.md)

## 反向連結
- [memory](memory.md)
- [llm-graph](llm-graph.md)
- [attention](attention.md)
- [quantization](quantization.md)
- [prefill-decode](prefill-decode.md)
