# Tile 微架構：SRAM、地址視窗、banks 與三種 tile

分類：架構 · 來源規格／缺口標示 · 來源快照 2026-09-12

把邏輯分區、核心私有儲存、allocator bank、硬體事件 bank 與 MMIO 位址拆開。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 三種 tile 的資源清單

[BaseNPU2](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1077-L1145)繼承 AIE2 的共用模型，再指定 AIE2P、六列、512-bit 最大 vector alignment；完整 Strix 有八欄。row0=ShimNOC、row1=mem tile、row2–5=core。Runtime 的 [AIE2P tile 分類](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/device/xaie_device_aie2p.c#L24-L66)亦將 row0 視為 ShimNOC；可用 columns 仍以 partition 為準。

| 項目 | Core tile | Memory tile | ShimNOC |
|---|---|---|---|
| 執行核心 kernel | 有，每 tile 自有程式 | 不是 compute core | 不是 compute core |
| Program memory | 16 KiB | 不列為 core program SRAM | 不列為 core program SRAM |
| Data SRAM | 64 KiB | 512 KiB | 不把主機 DRAM 當本地 SRAM |
| DMA channels／方向 | 2 | 6 | 2 |
| Local locks | 16 | 64 | 16 |
| BDs | 16 | 48 | 16 |
| BD ND dimensions | 3 | 4 | 3 |

容量依 [core runtime 初始化](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L180-L200)、[mem modules](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L2194-L2210)及[模型資源](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L835)；channel／BD 詳見 [DMA register 規格](dma-registers.md)。表格不是把三種 tile 的記憶體統一成 coherent cache hierarchy。

## 核心 datapath 與寬度不能混成一個數字

[模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L757)回傳 load/store bus=256 bits，cascade=512 bits；[NPU2 override](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1083-L1088)要求 full vector access 的最大對齊為512 bits。**寬度、一次指令搬移量、對齊、每 cycle 接受量是四件事**。512-bit vector 的存在不讓所有 memory instruction 自動變成一個 cycle；請接到 [operand timing](instruction-cycles.md) 核對 split operation 與 itinerary。

核心有 scalar/vector/AGU 等編譯器可見執行面；[VLIW pipeline](vliw-pipeline.md)整理可同 bundle 的 slot 與 resource。本頁不畫沒有 AIE2P 來源的「十級 silicon pipeline」或硬猜 forwarding bus 物理數量。

## Local address windows

[地址基底](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L743-L756)與[鄰接函式](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L755-L824)需一起讀：

| 核心視角 | base | 對應 |
|---|---|---|
| South | 0x40000 | 南方 core memory；不可把 mem tile 當普通南鄰 core SRAM |
| West | 0x50000 | 西方 tile memory，受邊界限制 |
| North | 0x60000 | 北方 tile memory，受邊界限制 |
| East/internal | 0x70000 | **自己**，不是右邊另一顆 tile |

這是地址視窗，不是四份新分配的64KiB私有 SRAM。Mem tile 的相鄰視窗則為 west=0、self=0x80000、east=0x100000，見 [getMemLocalBaseAddress](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1579-L1603)。共用同一 buffer 必須協調 ownership；位址可見不等於 cache coherence 或 free bandwidth。

**官方手冊對照（2026-11-12 取得原文）：**[AM027 Tile Architecture](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Tile-Architecture)（AIE-ML v2，rev 1.1，2025-10-23）寫明每顆核心 “interface with up to four distinct memory modules”：its own local memory module、north、south、west；陣列邊緣的核心少一到兩塊。[AM020](https://docs.amd.com/r/en-US/am020-versal-aie-ml)（AIE-ML，rev 1.5，2026-02-18）同一節的列舉相同。兩本另有一句 “can access memory modules in all four directions as one contiguous block”：這裡的四個方向是四個位址視窗，東視窗就是自己，不可讀成能存取東鄰 tile。AM027 的 Memory Tile DMA 一節列 West `0x0_0000–0x7_FFFF`、Local `0x8_0000–0xF_FFFF`、East `0x10_0000–0x17_FFFF`，只有 channel 0–3 可達左右鄰居，與上列模型值一致；memory tile 的存取介面清單裡沒有 compute 核心。

這兩本是 Versal 的前一代與姊妹代手冊，不是 AIE2P 專屬文件。AIE2P 專屬的對應是 [aie-rt ELF loader](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/core/xaie_elfloader.c#L126-L202)：位址除以 64 KiB 得 4／5／6／7，對應南／西／北／自己（AIE2P 的 `IsCheckerBoard=0`）。核心直接讀鄰居 SRAM 在本機沒有實測；資料實際怎麼進 tile 見 [資料上 tile](data-ingress.md)。

## Allocator bank 與 event bank 的口徑差異

[模型 getNumBanks](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L830-L835)給 core=4、mem=8；[allocator](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/Transforms/AIEAssignBuffers.cpp#L983-L1003)以 memory size 除以此值形成配置區間。因此得到 core 的16KiB區間、mem的64KiB區間，是**該配置模型的算術推導**。

但 AIE2P runtime 的 [core-memory conflict events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L235-L255)列 `DM_BANK_0..7`，[mem-tile events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L527-L543)列 `DM_BANK_0..15`。不能說 silicon 只有4／8 banks，也不能僅憑event名稱就證明固定二對一物理配對、單埠/雙埠或 interleaving bit。這裡登錄的是**配置分區4/8，事件命名8/16**，物理映射仍待同代手冊或實驗核實。

AM027 的 Memory Module 一節對姊妹代給了解釋：硬體是 8 個單埠 bank，程式視角每兩個交錯成一個，共 4 個 512-bit bank。方向與「配置分區 4、事件命名 8」相同，但那是 AIE-ML v2 的敘述，AIE2P 的實體映射仍沒有同代文件。

## SRAM 與 MMIO 是不同位址命名空間

Runtime 的 core program local addr=0，但 [host program window](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_params.h#L36-L46) offset=0x20000；這不矛盾，是不同觀察端。Model 的 tile MMIO address 用 column shift25、row shift20，见 [位址組合](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L826-L854)及[shift](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L855-L860)。它不是 Linux process pointer，不能省略device aperture、runtime映射與權限後直接寫入。

## LLM 設計後果與待補項

GEMM double buffering 要同時記帳 A/B/C、stack、靜態data、bank配置與對齊；有容量不表示三條 load/store path 無衝突。KV cache 往往超過單tile容量，應把持久資料與tile暫存分開。多core共用資料時，要追蹤哪個物理buffer由誰讀寫，不能用四個local地址當四份獨立copy。SRAM port arbitration policy、ECC每次懲罰、clock gating延遲及physical bank mapping，本次沒有足夠同代證據，不填造數字。

## 來源
- [BaseNPU2](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1077-L1145) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [AIE2P tile 分類](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/device/xaie_device_aie2p.c#L24-L66) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [core runtime 初始化](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L180-L200) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [mem modules](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L2194-L2210) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [模型資源](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L835) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L757) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [NPU2 override](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1083-L1088) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [地址基底](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L743-L756) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [鄰接函式](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L755-L824) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [getMemLocalBaseAddress](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1579-L1603) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [AM027 Tile Architecture](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Tile-Architecture) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [AM020](https://docs.amd.com/r/en-US/am020-versal-aie-ml) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [aie-rt ELF loader](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/core/xaie_elfloader.c#L126-L202) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [模型 getNumBanks](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L830-L835) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [allocator](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/Transforms/AIEAssignBuffers.cpp#L983-L1003) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [core-memory conflict events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L235-L255) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [mem-tile events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L527-L543) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [host program window](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_params.h#L36-L46) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [位址組合](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L826-L854) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [shift](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L855-L860) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。

## 關聯
- [system](system.md)
- [memory](memory.md)
- [isa-registers](isa-registers.md)
- [vliw-pipeline](vliw-pipeline.md)
- [interconnect](interconnect.md)
- [spec-gaps](spec-gaps.md)
- [data-ingress](data-ingress.md)
- [am027-tile](am027-tile.md)

## 反向連結
- [spec-index](spec-index.md)
- [interconnect](interconnect.md)
- [data-ingress](data-ingress.md)
- [dma-registers](dma-registers.md)
- [am027-overview](am027-overview.md)
- [am027-tile](am027-tile.md)
- [am027-memtile](am027-memtile.md)
- [spec-gaps](spec-gaps.md)
