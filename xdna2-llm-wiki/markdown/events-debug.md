# Events 與可觀測微架構：stall、bank conflict、counters 與 trace

分類：架構 · 來源規格／缺口標示 · 來源快照 2026-09-12

整理可用的事件識別欄位，說明如何區分資料相依、memory stall 與資料流阻塞。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## Event ID 絕對不是 cycle 數

[AIE2P event header](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L50-L76)列出以下core事件：

| 名稱後綴 | 常數值 | 所代表的分類 |
|---|---|---|
| GROUP_STALL | 22 | stall group |
| MEMORY_STALL | 23 | 記憶體等待 |
| STREAM_STALL | 24 | stream等待 |
| CASCADE_STALL | 25 | cascade等待 |
| LOCK_STALL | 26 | lock等待 |
| ECC_ERROR_STALL | 30 | ECC error stall |
| ECC_SCRUBBING_STALL | 31 | ECC scrubbing stall |
| INSTR_STREAM_GET / PUT | 40 / 41 | stream指令事件 |
| INSTR_CASCADE_GET / PUT | 42 / 43 | cascade指令事件 |

數值23表示來源常數的識別值，**不是memory latency=23 cycles**。要得到時間，必須先知道counter mode、啟停／reset、clock domain、事件是否逐cycle維持與採樣條件。本次沒有配置或執行counter。

## 資料相依與外部阻塞分開診斷

[Peano README](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L29-L45)以exposed pipeline說明：compiler安排指令資料何時可讀，不靠一般CPU式相依interlock保護錯誤schedule。這不等於任何情況都不stall。Memory contention、lock、stream、cascade與ECC等待在runtime事件面均有不同分類。

若MAC利用率低：先看loop中有多少VMAC與NOP，再看issue constraints和operand timing；若kernel停住：另看buffer protocol、DMA任務狀態與事件。不能從一個memory stall event便下結論某條LDA的基準latency錯了，也不能將stall total直接歸因給全部load instructions。

## DMA starvation / backpressure / lock

[Core memory module events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L187-L202)將S2MM／MM2S的lock stall拆開，並列S2MM stream starvation與MM2S stream backpressure。工程上可把這些視為不同假設的觀察入口：S2MM等資料、MM2S下游收不進、或buffer條件不成立。**事件名稱不是完整因果證明**；需要同時間窗的producer/consumer狀態與route／BD配置佐證。

對LLM，decode階段短工作可能主機dispatch佔比高，prefill則可能計算或搬移為主。Trace只看tile內kernel會漏掉host提交與queue等待，因此量測報告應把start/end boundary畫清楚。

## Bank conflict 命名與 allocator 不一致

[Core memory bank events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L235-L255)有0..7，[mem tile](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L527-L543)有0..15，分別是8與16個命名索引；[compiler getNumBanks](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L830-L835)卻是4/8個allocator partitions。這是需要保留的層級差別，不把少一半的配置數誤當silicon bank總數。無同代mapping表時，不從event i推斷地址bit i。

## Counter / trace configuration 面

[Runtime PerfMod](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L2467-L2536)列memory/core的MaxCounterVal=2/4、PL=2、memtile=4；這是runtime的counter數量上限參數，不是counter最大可數值2或4，更不是2-bit／4-bit計時器。counter寄存器field WIDTH應另在 [regdb](../spec-data/registers-events.json)查詢。Trace結構的 [NumTraceSlotIds=8、NumEventsPerSlot=4](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L4116-L4197)是配置介面欄位；不能乘成32條同時全速輸出的physical trace links。

Trace buffer容量、packet輸出、共享DMA與讀回本身可能影響觀測。事件配置需透過正確runtime/platform權限；本Wiki只給來源與解讀，不要求使用者直接寫debug registers。

## 建議的驗證紀錄格式

```text
architecture / compiler_SHA / runtime_SHA / partition
opcode_variant / itinerary / operand_edge
input_dtype / shape / alignment / bank_placement
counter_module / selected_event / start_stop_reset / interval
core_cycles / measured_clock_if_known / host_elapsed_time
DMA_bytes / completion_boundary / stalls / trace_overhead
```

這是未執行的量測設計。沒有測得clock就保留cycles，不用SKU行銷TOPS反推時脈再稱為測量；沒有完整host timeline就不要報端到端tokens/s。完整來源event名稱與field數值在資料集保留，未解的同步／時鐘／counter overflow條件須列為限制。

## 來源
- [AIE2P event header](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L50-L76) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [Peano README](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L29-L45) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [Core memory module events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L187-L202) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [Core memory bank events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L235-L255) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [mem tile](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L527-L543) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [compiler getNumBanks](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L830-L835) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [Runtime PerfMod](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L2467-L2536) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [NumTraceSlotIds=8、NumEventsPerSlot=4](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L4116-L4197) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。

## 關聯
- [instruction-cycles](instruction-cycles.md)
- [vliw-pipeline](vliw-pipeline.md)
- [dma-registers](dma-registers.md)
- [debug](debug.md)
- [spec-gaps](spec-gaps.md)

## 反向連結
- [spec-index](spec-index.md)
- [interconnect](interconnect.md)
- [dma-registers](dma-registers.md)
