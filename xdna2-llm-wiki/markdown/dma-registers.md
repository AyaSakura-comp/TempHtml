# DMA / MMIO 規格：BD 欄位、locks、burst 與完整 register 索引

分類：架構 · 來源規格／缺口標示 · 來源快照 2026-09-12

從抽象搬移操作下鑽到 AIE2P runtime 的 descriptors、field masks、地址單位與來源差異。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## Register database 的涵蓋範圍

[xaie2pgbl_params.h](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_params.h#L1-L55)說明它由regdb headers產生；[events header](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L1-L65)另外列事件常數。本Wiki完整擷取兩檔具值的 `XAIE2PGBL_*`／`XAIE2P_EVENTS_*` object-like宏，提供 [registers-events.json](../spec-data/registers-events.json)。資料含原始expression、decimal string（若是單一literal）、file/line/source URL、SHA256；未eval任意C expression，也未觸碰hardware。

**宏數不等於register數**：一個register的offset、width、mask、各field的LSB/WIDTH/MASK/DEFVAL各是不同records。128-bit mask不可經JavaScript Number中轉。所有register包括debug/error-injection名稱，都只是文件索引；存在offset不代表適合在運作中讀寫，沒有提供直接MMIO寫入腳本。

## 三種 DMA 資源比較

| 資源 | Core | Mem tile | Shim |
|---|---|---|---|
| MM2S channels | 2 | 6 | 2 |
| S2MM channels | 2 | 6 | 2 |
| BDs | 16 | 48 | 16 |
| ND address dimensions | 3 | 4 | 3 |
| 本地 lock objects | 16 | 64 | 16 |
| Runtime DMA lock-ID空間 | 16 | 192（鄰接視窗） | 16 |
| BD stride | 0x20 bytes | 0x20 bytes | 0x20 bytes |

對照 [Mem DMA](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L1658-L1697)、[Core DMA](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L1896-L1935)、[Shim DMA](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L2149-L2188)。Mem runtime的NumLocks=192不是192個本地lock：獨立[LockMod](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L2393-L2460)給64，compiler把west/self/east分到0/64/128基底，見 [local index](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1554-L1577)。可達性仍受鄰居存在與tile邊界限制。

## 描述子位元欄位與單位

[Target model](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L771-L816)列出：

| Field | Core bits | Mem bits | Shim bits |
|---|---|---|---|
| Buffer_Length | 14 | 17 | 32 |
| Wrap | 8 | 10 | 10 |
| Step | 13 | 17 | 20 |
| Iteration_Wrap | 6 | 6 | 6 |

模型address-generation granularity=32 bits，見 [宣告](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L718-L730)。但上層tensor用元素、byte offset和lowering後的word field並不是同一單位；有些field是編碼值，不能不看轉換就把最大bit pattern當成API最大bytes。Mem BD0–23供偶數channel，24–47供奇數channel，見 [channel accessibility](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L808-L820)。剩餘BD不一定對當前channel可用。

## Burst units：兩份來源看起來不同

[BaseNPU2 burst encoding](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1609-L1615)列encoding0/1/2/3對應64/128/256/512；runtime [_XAie2P_AxiBurstLenCheck](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/dma/xaie_dma_aie2p.c#L27-L50)接受4/8/16/32。這裡分別保留**compiler length表**與**runtime BurstLen參數集合**；兩者相差16可作追查單位的線索，不能只靠比值就宣稱所有stream bus都是128-bit。未追到caller轉換、beat定義與同一IP介面前，不寫512 cycles或512 beats。

## MMIO layout 與一般欄位解碼

[compiler BD address helper](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L826-L854)在tile座標base上加core/shim `0x1D000 + bd*0x20`，mem `0xA0000 + bd*0x20`；原始碼本身保留core/shim共享base待hardware-team確認的註解，故這是helper現況，不是新硬體背書。column/row位移25/20亦是該模型值。

一般欄位的**純數學讀取**是 `(register_value & mask) >> lsb`，前提是取得的register值、位寬、讀取副作用與endianness已被正確處理。LSB/WIDTH/MASK資料可核對一致性，但不能由DEFVAL推論當前硬體狀態。MMIO offset不是使用者虛擬地址；本次不執行讀寫。

## Lock 與 buffer 生命週期

[LockMod](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L2393-L2460)的參數上下限是-64..63；這是API操作參數的model，不能只看到負數就推論buffer可用量真的變成負值。Acquire/release協定需追函式與channel；physical object count、可編碼operand範圍、目前counter value是不同東西。

安全資料流先取得空buffer，DMA寫完才發佈ready，core消費完才歸還；反向傳輸亦須等最後讀取完成。Core stall、DMA lock stall、stream starvation、backpressure各有event，見 [events](events-debug.md)。這些造成的等待不包含在單條算術指令的compiler operand latency內。

## 來源
- [xaie2pgbl_params.h](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_params.h#L1-L55) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [events header](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L1-L65) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [Mem DMA](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L1658-L1697) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [Core DMA](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L1896-L1935) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [Shim DMA](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L2149-L2188) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [LockMod](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L2393-L2460) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [local index](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1554-L1577) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [Target model](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L771-L816) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [宣告](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L718-L730) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [channel accessibility](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L808-L820) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [BaseNPU2 burst encoding](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1609-L1615) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [_XAie2P_AxiBurstLenCheck](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/dma/xaie_dma_aie2p.c#L27-L50) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [compiler BD address helper](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L826-L854) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。

## 關聯
- [dma](dma.md)
- [interconnect](interconnect.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [events-debug](events-debug.md)
- [spec-gaps](spec-gaps.md)

## 反向連結
- [spec-index](spec-index.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [interconnect](interconnect.md)
- [events-debug](events-debug.md)
- [spec-gaps](spec-gaps.md)
