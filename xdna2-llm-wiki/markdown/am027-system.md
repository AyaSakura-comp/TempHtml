# AM027 介面、開機與觀測：array interface、中斷、設定流程、debug、trace 與事件

分類：架構 · 官方手冊摘要（AIE-ML v2，非 AIE2P） · 來源快照 2026-09-12

AIE-ML v2 陣列和外界的介面、開機與重設步驟，以及觀測手段：memory-mapped debug、兩種 trace 模式、效能計數器、事件動作與廣播。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 範圍

本頁是 AMD 手冊 AM027（Versal AIE-ML v2，編譯器代號 AIE2PS）的中文摘要，rev 1.1，2026-11-12 讀取。XDNA 2 用的是 AIE2P，沒有公開的專屬架構手冊；本頁的數字除非在「和 XDNA 2 的對照」一節另外寫明，都不能直接當成 AIE2P 的規格。

這一頁涵蓋手冊裡和 Versal 平台綁得最緊的章節。Ryzen AI 上的 XDNA 2 沒有 PL、NoC 與 PMC，所以 array interface、中斷與開機流程主要用來理解概念，不能當成 NPU 的操作步驟。

## Array interface tile

[Array Interface Architecture](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Interface-Architecture)：每一欄對應一顆 interface tile，排成一列，把 memory-mapped AXI4 與 stream 水平傳遞、再往上送進該欄。[Array Interface](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Interface) 列出它的模組：

| 模組 | 功能 |
|---|---|
| AXI-MM switch | 32-bit；西向送往較低欄、東向送往較高欄、北向送進同欄的 memory tile 與 tile；每顆 1 MB 位址空間。支援隔離：從東西進來的交易可被擋下 |
| Stream switch | 64-bit；東、西、北向接陣列，南向接 PL 或 DMA；另接 control module、trace、control response（各 32-bit） |
| PL stream 介面 | 每條 64-bit，可設成 32 或 64-bit，或兩條合成 128-bit；`TLAST=1` 時 `TKEEP` 只支援 32-bit 粒度且有效 word 必須連續 |
| NoC 介面 | DMA（2 S2MM＋2 MM2S）、16 把 lock、NMU 介面、第二層中斷處理 |
| DMA | S2MM 把 stream 變成 AXI4 寫入、MM2S 向 NoC 讀取後送上 stream；burst 最多 512 bytes；有 task queue 與 task-complete-token |
| NMU／NSU | NMU 是 128-bit、48-bit 位址的 AXI4 manager（DMA 與 control 用）；NSU 接收外部的設定、狀態與 debug 交易 |
| Control module | 設定應用、在執行期編排運算與資料搬移、和外部主機同步；有 AXI4 manager 與 subordinate 埠，並處理 task-complete-token 與 control packet |
| 控制、debug、trace 單元 | 6 個效能計數器；事件數增加到 256 |
| NPI 與 PLL | NPI 用來設定 PLL、全域 reset 與安全位元；陣列有一個專用 PLL |
| 活動監測 | 40-bit 計數器，累計所有 tile 在一段時間內執行的向量指令數，經兩個 32-bit NPI 暫存器讀出，供電源管理使用 |

| 連線 | 條數 | 時脈 | 每條頻寬 | 合計 |
|---|---|---|---|---|
| PL → array interface | 8 | PL 500 MHz | 4 GB/s | 32 GB/s |
| Array interface → PL | 6 | PL 500 MHz | 4 GB/s | 24 GB/s |
| Array interface → stream switch | 8 | 1 GHz | 8 GB/s | 64 GB/s |
| Stream switch → array interface | 6 | 1 GHz | 8 GB/s | 48 GB/s |
| 相鄰 stream switch 之間（東西向） | 4 | 1 GHz | 8 GB/s | 32 GB/s |

## 中斷

[Interrupt Handling](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Interrupt-Handling)：硬體錯誤分三類，都是固定接線、不能設定：不可更正（2-bit ECC 與同位錯誤）、可更正（1-bit ECC）、AXI 錯誤（`SLVERR`／`DECERR`）。同一類的事件先在 tile 內 OR 起來，再沿著欄 OR 起來，由 interface tile 鎖存、遮罩、清除並產生中斷。

一般事件的中斷是兩層：每欄的第一層處理器捕捉事件，交給第二層；第二層可驅動四條中斷線中的任一條，最後接到 NPI 中斷 4–7，送往 PMC、APU 或 RPU。只有 NPI 中斷 4 可用 IMR／IER／IDR 暫存器設定，5–7 不受這些暫存器控制。

## 設定、開機與重設

[Array Configuration](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Configuration)：任何 memory-mapped AXI4 manager（例如 PS、PMC）都能經 NoC 設定陣列內的暫存器；全域暫存器（PLL、全域 reset、安全位元）走 NPI。

[Boot Sequence](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Boot-Sequence) 的順序：

1. 欄時脈預設關閉。
2. 開電並解除 power-on-reset；PLL 以預設速度運轉。PMC 與 NoC 必須先就緒。
3. PMC 經 NPI 寫入全域暫存器（例如 PLL 設定），設定映像來自 flash。
4. 開啟 PLL，等它鎖定。
5. 開啟所有欄時脈，拉起欄 reset，等若干週期後放開。
6. 設定 control module。
7. 把陣列切成一個或多個獨立分區，每個分區是整數個欄；隔離預設在所有 tile 開啟，分區內部邊界要關掉。
8. 經 memory-mapped AXI4 寫入程式記憶體、stream switch、DMA、事件與 trace 設定。

各記憶體有硬體清零邏輯，以一個 1-bit 暫存器啟動並回報完成（control module 的是 3-bit）。

[Array Reconfiguration](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Reconfiguration)：設定內容是 bootgen 產生的 PDI。Reset 有七種，範圍從整個陣列（power-on、system、INITSTATE、array soft reset）到單欄、單一核心、interface tile。欄 reset 加上 interface tile reset 可以只重設並重新載入一個子陣列，不影響相鄰的子陣列。

## Debug、trace、效能計數器與事件

[Debug](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Debug)：除錯全部走 memory-mapped AXI4：程式與資料記憶體、核心暫存器、DMA、lock、stream switch、中斷點、事件與計數器都是 memory-mapped，PS、PL、PMC 都能讀寫。主機上的除錯器經 JTAG 或 HSDP 連到 PMC。

[Trace](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Trace)：tile 內有兩個 trace unit（core module 與 memory module），interface tile 也有一個，輸出都接到 stream switch。

| 模式 | 哪些單元有 | 記錄什麼 |
|---|---|---|
| Event-time | 全部 | 逐週期追蹤最多 8 個事件，事件狀態改變時產生一個 frame |
| Event-PC | 只有 core module | 8 個事件中任一成立的週期，記錄當時的 PC 與 8 個事件的值 |

Trace 以 packet-switched 封包送出，每個封包 8 個 32-bit word（1 個 header、7 個資料），可送到 tile 的本地記憶體、經 interface DMA 送到外部 DDR、或送到 PL。以 `trace_control0/1` 啟停，`trace_event0/1` 選擇事件。

[Profiling](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Profiling-Performance-Counters)：core module 與 memory module 各 4 個效能計數器，memory tile 與 array interface 各 6 個；可計事件發生次數，或兩個事件之間的週期數。

[Events](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Events)：core module 與 memory module 各有一組事件邏輯。事件本身沒有動作，要在動作暫存器裡填 7-bit 事件編號才會觸發，例如：啟用、停用或 reset 核心；debug halt、resume、單步；error halt；重新同步 timer；啟停計數器；啟停 trace；產生 broadcast 事件；驅動 combo 事件；ECC scrubbing。

Broadcast 把事件傳給相鄰模組，為避免迴圈，方向規則如下，每個方向 16 條：

| 來源 | 送往 |
|---|---|
| 內部、東、北、南 | 西 |
| 內部、西、北、南 | 東 |
| 內部、南 | 北 |
| 內部、北 | 南 |

Core module 的東向 broadcast 在 tile 內部接到 memory module 的西向，不會離開 tile。

## 和 XDNA 2 的對照

- **不同**：XDNA 2 沒有 PL、NoC、PMC、NPI 與 bootgen PDI。[Linux 驅動文件](https://docs.kernel.org/accel/amdxdna/amdnpu.html) 描述的是 PCIe 裝置、由韌體管理、以欄為單位切成分區並綁到工作 context；本手冊的開機步驟不適用。
- **相近（有 AIE2P 來源）**：事件分類（memory、stream、cascade、lock stall 等）與 trace 的設定欄位（8 個 slot）見 [Events](events-debug.md)。那一頁引用的 aie-rt AIE2P 表把計數器數量列為 core 4、memory module 2、mem tile 4，和本手冊的 4／4／6 不同。
- **本機做過的**：event-time 模式的 trace 在這台 NPU 上錄過，結果見 [資料上 tile](data-ingress.md)；event-PC 模式沒有錄過。
- **未核實**：AIE2P 是否有 control module 與活動監測計數器。

## 來源
- [AM027：AIE-ML v2 Debug](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Debug) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Trace](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Trace) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Profiling (Performance Counters)](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Profiling-Performance-Counters) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Events](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Events) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Array Interface Architecture](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Interface-Architecture) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Array Interface](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Interface) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Interrupt Handling](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Interrupt-Handling) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Array Configuration](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Configuration) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Boot Sequence](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Boot-Sequence) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Array Reconfiguration](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Array-Reconfiguration) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [Linux kernel：AMD NPU（amdxdna）](https://docs.kernel.org/accel/amdxdna/amdnpu.html) — AMD 撰寫的驅動文件；XDNA 的韌體管理與分區。

## 關聯
- [am027-overview](am027-overview.md)
- [am027-tile](am027-tile.md)
- [am027-core](am027-core.md)
- [am027-memtile](am027-memtile.md)
- [events-debug](events-debug.md)
- [debug](debug.md)
- [runtime](runtime.md)
- [data-ingress](data-ingress.md)

## 反向連結
- [events-debug](events-debug.md)
- [am027-overview](am027-overview.md)
- [am027-tile](am027-tile.md)
- [am027-core](am027-core.md)
- [am027-memtile](am027-memtile.md)
