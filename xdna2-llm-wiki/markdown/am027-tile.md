# AM027 Tile 架構：記憶體鄰接、stream switch、程式記憶體與 memory module

分類：架構 · 官方手冊摘要（AIE-ML v2，非 AIE2P） · 來源快照 2026-11-12

AIE-ML v2 一顆 tile 的三個模組：核心看得到哪四塊記憶體、64-bit stream switch 的延遲與緩衝、介面清單、bank 仲裁、tile DMA 與 lock。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 範圍

本頁是 AMD 手冊 AM027（Versal AIE-ML v2，編譯器代號 AIE2PS）的中文摘要，rev 1.1，2026-11-12 讀取。XDNA 2 用的是 AIE2P，沒有公開的專屬架構手冊；本頁的數字除非在「和 XDNA 2 的對照」一節另外寫明，都不能直接當成 AIE2P 的規格。

[Tile Architecture](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Tile-Architecture)：一顆 tile 由三個模組組成：tile interconnect（處理 AXI4-Stream 與 memory-mapped AXI4）、核心（手冊就叫 AIE-ML v2）、memory module（8 個 bank 共 64 KB、DMA、lock）。核心有純量資料路徑、向量資料路徑、三個位址產生器與 16 KB 程式記憶體。開機與 reset 時程式和資料記憶體都清為零。

## 核心看得到哪四塊記憶體

手冊列出每顆核心最多可接四塊 memory module：自己的、北邊的、南邊的、西邊的；陣列邊緣的核心少一到兩塊。它們被當成一塊連續記憶體存取，memory interface 依核心產生的位址把存取導向正確方向。同一節另有「all four directions」的說法，指的是四個方向的埠；圖上每顆 tile 的 memory module 畫在核心的東側，所以東向的那一塊就是自己的。

[Load and Store Unit](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Load-and-Store-Unit) 的數字：四塊各 64 KB 合成 256 KB，AGU 產生的位址範圍是 `0x0000`–`0x3FFFF`；每塊分成 odd／even bank 交錯。相鄰核心靠這塊共享資料記憶體交換資料，不相鄰的走 stream。

Cascade：水平與垂直都有，方向是北→南、西→東，起點與終點在陣列邊緣接死。[Register Move](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Register-Move-Functionality) 補充：cascade 一次傳一個 512-bit 累加器，輸入與輸出各有 2 格深的 512-bit FIFO，兩顆核心之間最多暫存四筆。

## 兩種 interconnect

[Memory-mapped AXI4](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Memory-mapped-AXI4-Interconnect)：外部的 AXI4 manager（經 NoC）可讀寫 tile 內所有暫存器與記憶體。請求從南邊進入每顆 tile 的 switch，位址屬於自己就在本地處理，否則往北傳。每顆 tile 佔 1 MB 位址空間：

| 位元 | 欄位 |
|---|---|
| `[31:25]`（7 bits） | 欄 |
| `[24:20]`（5 bits） | 列 |
| `[19:0]`（20 bits） | tile 內位址 |

[AXI4-Stream Interconnect](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AXI4-Stream-Interconnect)（stream switch）是 64-bit 的 crossbar，透過 memory-mapped AXI4 靜態設定，支援背壓：

- 資料路徑全是 64-bit，每週期兩個 32-bit word；`TKEEP` 用來傳奇數個 word；每個 32-bit word 一個同位元。
- 南、西、北、東與 FIFO 埠、DMA 都能跑滿 64-bit／週期；核心、trace、control packet 是 32-bit，經轉接器。
- Switch 內有一個 16 格深、68-bit 寬的 FIFO。
- 每個埠只能選 circuit 或 packet 其中一種模式。Circuit 是一對一或一對多廣播，延遲固定；packet 可多條邏輯 stream 共用實體埠，用 5-bit stream ID 決定目的地，延遲不固定。

| 路徑 | 延遲 | 緩衝 |
|---|---|---|
| 本地 slave → 本地 master | 3 週期 | 6 個 double-word |
| 本地 slave → 外部 master | 4 週期 | 8 個 double-word |
| 外部 slave → 本地 master | 3 週期 | 6 個 double-word |
| 外部 → 外部 | 4 週期 | 8 個 double-word |

| 方向 | 條數 | 每條頻寬（1 GHz） | 合計 |
|---|---|---|---|
| 往北（從南） | 6 | 8 GB/s | 48 GB/s |
| 往南（從北） | 4 | 8 GB/s | 32 GB/s |
| 往西（從東） | 4 | 8 GB/s | 32 GB/s |
| 往東（從西） | 4 | 8 GB/s | 32 GB/s |

Packet header（32 bits）：`[31]` 奇同位、`[27:21]` 來源欄、`[20:16]` 來源列、`[14:12]` packet type、`[4:0]` stream ID，其餘為 0。

## 程式記憶體與介面清單

[Tile Program Memory](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Tile-Program-Memory)：16 KB、128-bit 寬。核心只能讀；外部 manager 可經 memory-mapped AXI4 讀寫。兩邊同時存取同一個 bank 時核心優先，另一邊收到 `SLVERR`。

[Interfaces](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Interfaces) 列出核心的介面：

| 介面 | 內容 |
|---|---|
| 資料記憶體 | 兩個 512-bit load、一個 512-bit store，各 512 bits／週期 |
| 程式記憶體 | 128-bit，每週期可取一條指令 |
| 直接 AXI4-Stream | 32-bit 輸入與輸出；每 4 週期一次 128-bit 存取，或每週期一個 32-bit word |
| Cascade | 512-bit 累加器資料 |
| Lock | 可存取四個方向的 lock module；semaphore lock |
| Debug | 經 memory-mapped AXI4 讀寫所有核心暫存器 |
| Event | 16-bit；core module 與 memory module 各 128 個內部事件 |
| Tile timer | 64-bit |
| Execution trace | 32-bit，封包式 |

Stall 來源：外部 AXI4 manager、lock module、stream 空或滿、資料記憶體衝突、事件動作。

## Memory module：bank、DMA 與 lock

[Memory Module](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Module)：

- **Bank**：8 個單埠 bank，各 256 word × 256-bit。程式視角是兩兩以 256-bit 為單位交錯成 4 個 512-bit bank。Bank 0–1 有 ECC，2–7 有同位保護。
- **仲裁**：每個 bank 各自仲裁，不同 bank 可同時存取，所以一顆 tile 的資料記憶體有 8 個獨立仲裁器；仲裁是階層式的，存取者分成固定群組。
- **Tile DMA**：2 條 S2MM（把 64-bit stream 寫進記憶體）與 2 條 MM2S；16 個 buffer descriptor，可串接；吞吐量每週期兩個 32-bit word。支援 4D 位址產生（含 iteration-offset）、task queue 與 task-complete-token、S2MM 在 `TLAST` 結束與亂序封包、S2MM 解壓縮、MM2S 壓縮。
- **Lock**：16 把 semaphore lock，每把 6-bit 無號狀態；請求來自四個方向的核心、本地 DMA 與 memory-mapped AXI4。

## 和 XDNA 2 的對照

- **相同（有 AIE2P 來源）**：自己、南、西、北四個視窗與 64 KiB／16 KiB 容量，見 [Tile 微架構](tile-microarchitecture.md)；tile DMA 2+2 通道、16 個 BD、16 把 lock，見 [DMA／MMIO 規格](dma-registers.md)；lock 是計數 semaphore，見 [同步](synchronization.md)。
- **本機看得到的行為**：lock 握手、bank 衝突造成的 1 週期 stall、cascade 背壓，見 [資料上 tile](data-ingress.md) 的本機 trace。
- **未核實**：AIE2P 的 stream 是否 64-bit、load 是否兩個 512-bit／週期、switch 延遲與緩衝格數、DMA 壓縮功能。mlir-aie 模型對 NPU2 回報的 load／store bus 是 256 bits，和本手冊的 512 bits 不同。

## 來源
- [AM027：AIE-ML v2 Tile Architecture](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Tile-Architecture) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Memory-mapped AXI4 Interconnect](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Memory-mapped-AXI4-Interconnect) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AXI4-Stream Interconnect](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AXI4-Stream-Interconnect) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Tile Program Memory](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Tile-Program-Memory) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Interfaces](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Interfaces) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Memory Module](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Module) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Load and Store Unit](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Load-and-Store-Unit) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Register Move Functionality](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Register-Move-Functionality) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。

## 關聯
- [am027-overview](am027-overview.md)
- [am027-core](am027-core.md)
- [am027-memtile](am027-memtile.md)
- [am027-system](am027-system.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [interconnect](interconnect.md)
- [data-ingress](data-ingress.md)
- [synchronization](synchronization.md)

## 反向連結
- [tile-microarchitecture](tile-microarchitecture.md)
- [interconnect](interconnect.md)
- [data-ingress](data-ingress.md)
- [am027-overview](am027-overview.md)
- [am027-core](am027-core.md)
- [am027-memtile](am027-memtile.md)
- [am027-system](am027-system.md)
