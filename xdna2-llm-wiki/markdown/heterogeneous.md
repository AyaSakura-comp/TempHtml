# CPU × GPU × NPU：分工與資料所有權

分類：LLM推論 · 工程推導 · 來源快照 2026-09-12

Shared DRAM 不代表免費互通；卸載是否值得，取決於計算節省是否大於映射、同步、轉換與 fallback 的成本。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 三個裝置不是同一個 execution target

Strix Halo 的 CPU、gfx1151 GPU 與 AIE2P NPU 可以共享系統記憶體資源，但各自有不同的程式模型、指令、runtime 與完成通知。HIP binary 不能直接交給 NPU；能在 CPU 看到同一 virtual address 也不代表對所有裝置都是可用的 handle。[Triton-XDNA README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) 對 XRT、HSA 與 shared buffers 分別規範。

## 一個最小卸載成本模型

假設一段 GPU 工作耗時 t_gpu；改到 NPU 的完整替代成本為：

```text
t_replace = t_export_or_map + t_convert + t_npu
          + t_sync + t_import_or_consume + t_fallback
只有 t_replace < t_gpu 才可能單段受益
```

這是無重疊的簡化估算。真正 pipeline 需分析 critical path，不能把可重疊成本與不可重疊成本一律相加或一律忽略。若 NPU 讓 GPU 同時做其他有效工作，還要比較整個 graph 的 makespan，而非局部算子速度。

## Shared buffer 要回答四個問題

1. **位址與映射**：配置者是誰，哪個 runtime 提供每個裝置的 handle？
2. **可見性與順序**：producer 完成後，consumer 如何等待並看見最新資料？
3. **生命週期**：所有裝置完成前不能回收、重用或解除映射。
4. **表示法**：相同 pages 上的 layout、dtype、padding 是否適合兩邊？

Zero-copy 通常意指避免一份 tensor 的 staging copy，不表示沒有 DMA、DRAM traffic、cache maintenance、映射成本或同步。以 `shared` API 的 dispatch 計數確認 in-place / staged，再量端到端；不要只看函式名有 zero_copy 就當作達成。

## XRT 與 HSA 的邊界

固定版本 README 提到兩種 NPU runtime 與對應 artifacts；HSA 路徑需要 AIE-capable ROCR，不能因為已安裝可跑 gfx1151 的 ROCm 就推論也能派送 AIE kernel。PyTorch 可能先載入另一份 libhsa-runtime，造成同 process ABI/功能不匹配。這是應在隔離環境裡查核的相容性問題，**不是本 Wiki 要求你修改現有 GPU 服務**。[runtime 條目](runtime.md) 有更完整的核對方式。

## 算子放在哪裡：先當假說

| 工作 | 合理的待測候選 | 為何不能預先下結論 |
|---|---|---|
| 大 MLP / projection | NPU dense matmul | padding、dispatch、共享頻寬可能抵消 |
| Fused attention | 現有 GPU kernel | NPU mapping 是否完整需另外驗證 |
| Tiny decode op | GPU 保留或融合 | 跨裝置一次 round trip 可能更貴 |
| Tokenization / sampling | Host 控制 | CPU 工作不是「全 NPU」宣稱中可忽略的部分 |

[Qwen 範例](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) 的 npu / hetero / hetero-fast 是具體 routing choices，不是各 workload 的最佳性證明。NPU 模式內仍有 CPU 工作；hetero-fast decode 回到 GPU。把模式名稱和實際 per-op 執行分開記錄。

## 共享 DRAM 的競爭與測量

同時跑 GPU 和 NPU 可能競爭 DRAM 與功耗預算，不應把兩邊獨立跑的 bandwidth 或 peak 算力直接相加。需量相同整體 workload 的 latency、energy、device residency、fallback 與記憶體峰值。改善圖分割時，優先合併相鄰子圖、延長 buffer 重用生命週期，避免每一個小 op 都跨裝置往返。

## 來源
- [Triton-XDNA README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) — 實驗性 compiler；上游效能數字不代表本機量測。
- [Qwen2.5 model.py](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) — 固定 source snapshot；裝置分支必須以實際程式為準，未在本機執行。
- [NPU device models](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/docs/Devices.md) — 裝置型號與 partition 描述，不能直接推出效能。
- [Core data memory guide](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md) — SRAM 配置、bank 與 linker context。

## 關聯
- [runtime](runtime.md)
- [synchronization](synchronization.md)
- [prefill-decode](prefill-decode.md)
- [qwen-case](qwen-case.md)
- [performance](performance.md)

## 反向連結
- [system](system.md)
- [runtime](runtime.md)
- [llm-graph](llm-graph.md)
- [attention](attention.md)
- [prefill-decode](prefill-decode.md)
- [performance](performance.md)
- [glossary](glossary.md)
