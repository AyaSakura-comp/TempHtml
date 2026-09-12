# Interconnect 規格：switch ports、packet routing 與 cascade

分類：架構 · 來源規格／缺口標示 · 來源快照 2026-09-12

完整列出模型可見的 source/destination 埠資源，区分交換網路、局部 SRAM 鄰接與 cascade。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 三種互連不是同一張網

1. **局部 SRAM 鄰接**：load/store 可達記憶體，見 [affinity 函式](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L755-L824)。
2. **Stream switch**：由source埠進入switch、destination埠離開switch，可接DMA/core/方向link；[路由模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L882-L1030)列資源。
3. **Cascade**：模型回報512-bit accumulator/cascade寬度，見 [target](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L757)。它不等於通用packet network，512 bits 也不是端到端Gb/s。本次沒有將其他AIE世代的完整cascade方向圖當成XDNA2證明。

MMIO/configuration與事件broadcast又是另一個觀察面。下面表格是compiler switchbox API，不是所有矽上wire的電氣規格。

## Source / destination 與內部 tile 埠表

**Source=送進交換器（通常對應slave input）；destination=交換器送出（master output）。**不是以DMA的MM2S/S2MM字樣判斷整條route。下表為非邊界位置，依 [destination](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L881-L951)與[source](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L952-L1030)。`S/D`分別為source/destination數量。

| Bundle | Core S/D | Mem S/D | Shim S/D |
|---|---|---|---|
| Core | 1 / 1 | 0 / 0 | 0 / 0 |
| DMA | 2 / 2 | 6 / 6 | 0 / 0（switch端；DMA經mux） |
| FIFO | 1 / 1 | 0 / 0 | 1 / 1 |
| North | 4 / 6 | 4 / 6 | 4 / 6 |
| South | 6 / 4 | 6 / 4 | 8 / 6 |
| East | 4 / 4 | 0 / 0 | 4 / 4 |
| West | 4 / 4 | 0 / 0 | 4 / 4 |
| TileControl | 1 / 1 | 1 / 1 | 1 / 1 |
| Trace | 2 / 0 | 1 / 0 | 1 / 0（compiler口徑） |

Core頂列North=0；最左West=0、最右East=0，Shim水平方向同理。Mem tile沒有東西向**stream switch**埠，不代表它完全不能透過其他機制存取東西鄰SRAM。

Runtime [AIE2P stream port tables](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L214-L475)大致吻合，但 **Shim Trace slave NumPorts=2**（[346–384行](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L346-L384)），compiler只給Trace source=1。本Wiki保留兩值，未推定多出的埠一定可用或單純是bug。請勿把兩端所有埠相加當成user payload頻寬。

## 合法交叉連接不是 full crossbar 任意互接

[isLegalTileConnection](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1071-L1158)先檢查channel範圍，再依tile類型限制：

- Mem：DMA→DMA須同channel；North/South→North/South須同channel；TileControl→DMA只能dest5；Trace→DMA也是dest5。
- Core：一般bundle同向回接須同channel；Core不能直接Core→Core；TileControl不能送回TileControl或DMA；Trace→DMA限制dest0。
- Shim：West/North/East同向回接須同channel；South→South在channel範圍內可跨channel（[分支規則](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1119-L1131)）；Trace可進FIFO/South，送East/West則限定dest0。

這些是固定compiler的合法性規則，不是繞過rule後任意MMIO就安全。路由還須匹配相鄰tile對向埠、佔用、partition邊界與下游接收狀態。

## Shim mux 不等於外露 FPGA PLIO

[Shim mux 模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1031-L1069)另有DMA=2/2、NOC=4/4、PLIO=8/6、South=6/8（S/D）。此處South指mux與switch之間的介面，所以和switch那一行的方向計數互補。共用模型含PLIO/NOC bundle名稱，不保證Ryzen主機板有使用者可連的Versal FPGA PLIO pin；XDNA2 row0實際型別是ShimNOC。

## Packet / circuit / multicast 的證據層級

[模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L714-L730)給每slave port四個packet-rule slots、最大packet ID31；[AIE2P regdb](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_params.h#L4390-L4415)列ID與MASK各5-bit。Packet ID是路由比對欄位，**不是32条物理虛通道，也不是32 packets/cycle**。Master/slave configuration、mask與arbitration等fields在完整[registers資料集](../spec-data/registers-events.json)可按 `STREAM_SWITCH` 查詢。

Circuit/packet route都要有合法連接和ownership；multicast不保證每個destination獨立全速。要談head-of-line blocking或fairness須核對同代arbiter細節，本次沒有給出unbounded network的固定最壞延遲。

## 帶寬與 cycle 的未知欄位

埠數不是bits/cycle；vector512-bit、cascade512-bit、load/store bus256-bit也不能拿來填每條stream link寬度。完整頻寬表至少需 `link type × direction × payload width × clock domain × beats/cycle × arbitration × packet overhead`。目前只確定上列**模型埠數**，不把來源中的家族通則拼成XDNA2所有link的硬體保證。

工程推導可寫 `serialization cycles >= ceil(payload_bytes / effective_bytes_per_cycle)`，但分母必須由指定鏈路證據或明標假設取得；再加route/setup/backpressure。GemM broadcast、KV移動與partial-sum reduction應分別算，不把無stall kernel的MAC週期当端到端完成時間。

## 來源
- [affinity 函式](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L755-L824) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [路由模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L882-L1030) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [target](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L757) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [destination](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L881-L951) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [source](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L952-L1030) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [AIE2P stream port tables](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L214-L475) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [346–384行](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L346-L384) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [isLegalTileConnection](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1071-L1158) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [分支規則](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1119-L1131) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [Shim mux 模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1031-L1069) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L714-L730) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [AIE2P regdb](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_params.h#L4390-L4415) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。

## 關聯
- [tile-microarchitecture](tile-microarchitecture.md)
- [dma-registers](dma-registers.md)
- [synchronization](synchronization.md)
- [events-debug](events-debug.md)
- [spec-gaps](spec-gaps.md)

## 反向連結
- [spec-index](spec-index.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [dma-registers](dma-registers.md)
- [spec-gaps](spec-gaps.md)
