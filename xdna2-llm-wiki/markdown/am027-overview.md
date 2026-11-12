# AM027 導讀：AIE-ML v2 的陣列、時脈、記憶體保護與三代比較

分類：架構 · 官方手冊摘要（AIE-ML v2，非 AIE2P） · 來源快照 2026-09-12

AMD 官方 AIE-ML v2 架構手冊的總覽章節：這本手冊和 XDNA 2 的關係、陣列組成、時脈目標、ECC，以及三代 AI Engine 的比較表。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 這本手冊和這台機器的關係

本頁是 AMD 手冊 AM027（Versal AIE-ML v2，編譯器代號 AIE2PS）的中文摘要，rev 1.1，2026-11-12 讀取。XDNA 2 用的是 AIE2P，沒有公開的專屬架構手冊；本頁的數字除非在「和 XDNA 2 的對照」一節另外寫明，都不能直接當成 AIE2P 的規格。

手冊共 60 節、27 張圖，[修訂紀錄](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Revision-History)列出 1.0（2025-05-30）、1.0.1、1.0.2 與 1.1（2025-10-23）四版；1.1 更新了 Performance、Tile Architecture、兩種 interconnect、Memory Module、Trace 與世代比較表。[引言](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Introduction-to-AI-Engines-and-AIE-ML-v2)把 AIE-ML v2 定位為 AIE-ML 的第二代：每顆 tile 的運算量最多兩倍、新增原生資料型別、能效更好。三個世代名稱的對照表在 [規格缺口](spec-gaps.md)。

本 Wiki 把手冊拆成五頁：本頁、[Tile](am027-tile.md)、[處理器](am027-core.md)、[Memory tile](am027-memtile.md)、[介面、開機與觀測](am027-system.md)。

## 陣列組成與四種記憶體

[Array Overview](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Overview) 與 [Array Hierarchy](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Hierarchy)：陣列由 AIE-ML v2 tile、一或兩列 memory tile、以及最底下一列 array interface tile 組成。Versal 裝置上有四種記憶體可用：

| 記憶體 | 位置 | 怎麼到 |
|---|---|---|
| 外部 DDR | 晶片外 | 經 NoC |
| PL 記憶體（UltraRAM／block RAM） | 可程式邏輯 | 經 PL 介面 |
| Memory tile 的共享記憶體 | 陣列內，每顆 512 KB | DMA 與 stream |
| Tile 的本地資料記憶體 | 每顆 tile 64 KB | 核心 load／store，或 tile DMA |

三種 tile 的特性（[Tile Features](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Tile-Features)、[Memory Tile Features](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Features)、[Array Interface](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Interface-to-NoC-and-PL-Resources)）：

| | AIE-ML v2 tile | Memory tile | Array interface tile |
|---|---|---|---|
| 處理器 | VLIW SIMD 向量處理器 | 無 | 無（有 control module） |
| 資料記憶體 | 64 KB：硬體 8 個 bank，各 8 KB（256-bit × 256 word）；程式視角兩兩交錯成 4 個 512-bit bank | 512 KB：8 個實體 bank，各 256-bit × 2K word | 無本地資料記憶體 |
| DMA | 2 S2MM＋2 MM2S，4-D 位址產生 | 6 S2MM＋6 MM2S，64-bit stream、256-bit 記憶體介面，可壓縮零值 | 2 S2MM＋2 MM2S，接 NoC |
| 其他 | lock、memory-mapped AXI4 設定、debug／trace／profile | 同左 | PL 介面（跨時脈域）、NoC 介面、每欄一個 control module |

## 時脈與設定介面頻寬

[Performance](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Performance)：整個陣列（含 interface tile）是單一時脈域。–1 速度等級、VCC_AIE 0.725 V 的目標是 1 GHz。

| 時脈 | 目標 | 和陣列時脈的關係 |
|---|---|---|
| AIE-ML v2 陣列時脈 | 1 GHz | 來源是陣列自己的 PLL |
| NoC 時脈 | 1000 MHz | 非同步，在 NoC 內跨時脈域 |
| PL 時脈 | 500 MHz | 非同步，在 array interface 跨時脈域 |
| NPI 時脈 | 300 MHz | 非同步 |

同一節另有一張 memory-mapped AXI4 設定介面的最低頻寬表（單位 GB/s，前提是陣列時脈 1 GHz、整批連續存取、在 NSU 量）。原表四個欄位標題都寫 Target Write BW，哪一欄是讀取原文沒有標明，這裡照原順序列出：

| 目標區塊 | 128-bit 存取 | | 32-bit 存取 | |
|---|---|---|---|---|
| Tile 與 memory tile 的資料記憶體 | 3.0 | 1.1 | 0.80 | 0.32 |
| Tile 的程式記憶體 | 2.9 | 1.1 | 0.32 | 0.32 |
| Stream switch 與 BD 暫存器 | 3.0 | 2.0 | 1.7 | 0.80 |

[Clocking Structure](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Clocking-Structure)：每顆 interface tile 有一個欄時脈閘控暫存器，控制同一欄所有 memory tile 與 tile 的時脈（不影響 interface tile 自己）；整欄沒用到時關掉可以省電。

## 記憶體錯誤保護與特權暫存器

[Memory Error Handling](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Memory-Error-Handling)：

| 記憶體 | 保護方式 |
|---|---|
| Tile 程式記憶體 16 KB | 兩組 8-bit ECC，各涵蓋 64 bits；可更正 1-bit、偵測 2-bit |
| Tile 資料記憶體 bank 0–1 | 256-bit word 的每個 32-bit lane 各有 7-bit ECC |
| Tile 資料記憶體 bank 2–7 | 每個 32-bit 一個奇同位；出錯時 memory module 發出事件 |
| Memory tile 512 KB | 全部 bank 都是每 32-bit 一組 7-bit ECC，另有 ECC scrubbing |
| Control module | 三塊 SRAM：程式 32 KB、資料 16 KB（32-bit 介面）、共享 32 KB（128-bit 介面），以 32-bit 為單位檢查 ECC |

[Privileged Register Access Control](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Privileged-Register-Access-Control)：tile、memory tile、interface tile 各有少數特權暫存器，只管制寫入；AXI4 的 `AWPROT[1]=0` 代表安全交易。

## 三代比較表

[Comparison of AIE Generations](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Comparison-of-AIE-Generations) 的重點（B/cycle 是每週期 bytes）：

| 項目 | AI Engine | AIE-ML | AIE-ML v2 |
|---|---|---|---|
| 每 tile 乘法器（節錄） | 128（INT8×INT8）、8（fp32） | 256（INT8×INT8）、128（bfloat16） | 512（INT8×INT8）、256（bfloat16、fp16）、512（fp8）、512（MX9）、1024（MX6） |
| 從自己 tile 的資料記憶體 load | 64 B/cycle | 64 B/cycle | 128 B/cycle |
| 從鄰居 tile 的資料記憶體 load | 64 B/cycle | 64 B/cycle | 單一鄰居 64 B/cycle；兩個鄰居合計 128 B/cycle |
| Store | 32 B/cycle | 32 B/cycle | 64 B/cycle |
| Cascade | 48 B/cycle | 64 B/cycle | 64 B/cycle |
| 每顆 compute tile 的資料記憶體 | 32 KB | 64 KB | 64 KB |
| 每顆 memory tile | 沒有 memory tile | 512 KB | 512 KB |
| DMA（compute／memory／interface tile） | 2+2／無／2+2 | 2+2／6+6／2+2 | 2+2／6+6／2+2 |
| Stream 寬度 | 32-bit | 32-bit | 64-bit |
| Compute tile 的 stream 條數 | 南→北 6、北→南 4、東↔西各 4 | 同左 | 同左（每條頻寬加倍） |
| Memory tile 的 stream 條數 | — | 南→北 6、北→南 4、沒有東西向 | 同左 |
| 有 control module | 否 | 否 | 是 |

## 手冊內部不一致的地方

讀全文時看到下列前後不一致，手冊沒有說明哪一個才對，本 Wiki 照原文並列、不自行更正：

- Memory tile 的 bank：正文寫 8 個 bank、各 64 KB；比較表寫「16 x 32B banks」。
- Memory tile DMA 的位址維度：特性清單寫 4D，DMA 一節寫 5D（含 iteration-offset）。
- [Memory Tile Overview](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Overview-and-Features) 的特性清單把「Six memory to stream (MM2S)」列了兩次，第二次的內容（解壓縮、out-of-order、Finish on TLAST）是 S2MM 的功能；[Memory Tile Memory](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Memory) 的寫入介面也寫成來自鄰居的 MM2S。
- 累加器：[Accumulator Registers](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Accumulator-Registers) 說 512-bit 可看成 16 個 32-bit lane；[Functional Overview](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Functional-Overview) 的累加模式寫 64 個 32-bit lane 或 32 個 64-bit lane（對應 2048-bit）。浮點資料路徑圖上寫「Accumulator Register A 9x 1024b」「Exponent Register E 12x 128b」，暫存器表則是 8 個 2048-bit 累加器、E 為 64 bits。
- 核心的直接 stream 介面：[Interfaces](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Interfaces) 寫一進一出各 32-bit；Functional Overview 寫 2×32-bit subordinate、1×32-bit manager。
- [Memory-mapped AXI4](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Memory-mapped-AXI4-Interconnect) 位址表的 row 欄位，表頭寫 `[22:18]`，下一列寫 `[24:20]`（5 bits）。

## 和 XDNA 2 的對照

- **相同（有 AIE2P 來源）**：compute tile 64 KB 資料＋16 KB 程式、memory tile 512 KB、DMA 通道數 2+2／6+6／2+2，見 [Tile 微架構](tile-microarchitecture.md) 引用的 aie-rt AIE2P 表與 mlir-aie 模型。
- **不同**：XDNA 2 在 Ryzen AI 上沒有 PL、NoC、PMC；[Linux 驅動文件](https://docs.kernel.org/accel/amdxdna/amdnpu.html) 描述的是 4x8 陣列、一列 memory tile、由韌體管理的欄分區。AIE2P 的累加器是 5 個 2048-bit（[AIE2P 暫存器](isa-registers.md)），本手冊是 8 個。
- **未核實**：stream 寬度、load／store 每週期位元數、MX6／MX9／fp8 型別、control module 在 AIE2P 上是否存在。本機 NPU 的時脈在先前量測筆記裡約 1.8 GHz，和本手冊 –1 等級的 1 GHz 目標不是同一顆晶片的數字。

## 來源
- [AM027：Introduction to AI Engines and AIE-ML v2](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Introduction-to-AI-Engines-and-AIE-ML-v2) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Tile Features](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Tile-Features) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Memory Tile Features](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Features) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Array Interface to NoC and PL Resources](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Interface-to-NoC-and-PL-Resources) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Array Overview](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Overview) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Array Hierarchy](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Hierarchy) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Performance](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Performance) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Clocking Structure](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Clocking-Structure) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Memory Error Handling](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Memory-Error-Handling) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Privileged Register Access Control](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Privileged-Register-Access-Control) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Comparison of AIE Generations](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Comparison-of-AIE-Generations) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Revision History](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Revision-History) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Memory Tile Overview and Features](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Overview-and-Features) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Memory Tile Memory](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Memory) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Accumulator Registers](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Accumulator-Registers) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Functional Overview](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Functional-Overview) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Interfaces](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Interfaces) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Memory-mapped AXI4 Interconnect](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Memory-mapped-AXI4-Interconnect) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [Linux kernel：AMD NPU（amdxdna）](https://docs.kernel.org/accel/amdxdna/amdnpu.html) — AMD 撰寫的驅動文件；XDNA 陣列拓樸、L2 記憶體與分區。

## 關聯
- [am027-tile](am027-tile.md)
- [am027-core](am027-core.md)
- [am027-memtile](am027-memtile.md)
- [am027-system](am027-system.md)
- [spec-gaps](spec-gaps.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [system](system.md)

## 反向連結
- [system](system.md)
- [am027-tile](am027-tile.md)
- [am027-core](am027-core.md)
- [am027-memtile](am027-memtile.md)
- [am027-system](am027-system.md)
- [spec-gaps](spec-gaps.md)
