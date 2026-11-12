# AM027 Memory tile：512 KB、12 條 DMA 通道、鄰居存取、padding 與壓縮

分類：架構 · 官方手冊摘要（AIE-ML v2，非 AIE2P） · 來源快照 2026-09-12

AIE-ML v2 memory tile 的記憶體介面、DMA 功能、東西鄰居的位址與 lock 編號範圍，以及 stream switch 和 lock module。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 範圍

本頁是 AMD 手冊 AM027（Versal AIE-ML v2，編譯器代號 AIE2PS）的中文摘要，rev 1.1，2026-11-12 讀取。XDNA 2 用的是 AIE2P，沒有公開的專屬架構手冊；本頁的數字除非在「和 XDNA 2 的對照」一節另外寫明，都不能直接當成 AIE2P 的規格。

[Memory Tile Overview](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Overview-and-Features)：memory tile 像一顆沒有核心與程式記憶體的 tile，換成較大的 512 KB 資料記憶體與 DMA，目的是提高資料局部性與頻寬、少用 PL 的記憶體。它的功能區塊（記憶體、DMA、lock、stream switch、AXI4 switch、控制與 debug／trace、事件）和 tile 相同或很接近。

## 記憶體與存取介面

[Memory Tile Memory](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Memory)：512 KB 分成 8 個 bank，各 64 KB（256-bit × 2K word），全部有 ECC 與 scrubbing。Bank 以 256-bit 為單位交錯：連續的 256-bit 存取落在不同 bank，8 個 bank 輪完（每 256 bytes）再繞回。

每個 bank 有 10 個讀取介面與 10 個寫入介面：

| 介面 | 數量 |
|---|---|
| Memory-mapped AXI4（含 control packet） | 1 |
| 左邊 memory tile 的 DMA 通道 | 1 |
| 本地 DMA 通道 0–5 | 6 |
| 右邊 memory tile 的 DMA 通道 | 1 |
| ECC scrubber（寫入側另含清零） | 1 |

清單裡沒有 compute tile 的核心：核心不能直接 load／store memory tile 的記憶體，只能透過 DMA 與 stream。

## DMA：12 條通道

[Memory Tile DMA](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-DMA)：6 條 S2MM、6 條 MM2S，各自獨立，都是 64-bit stream、256-bit 記憶體介面，共用 48 個 buffer descriptor。每條通道有自己的 task queue，完成工作時可發出 task-complete-token，支援 task repeat-count。相較於 tile DMA 多了：

- 5D 位址產生（含 iteration-offset）。
- 依封包 header 做亂序 BD 處理；S2MM 可設成依序或亂序模式，支援 Finish on `TLAST`。
- MM2S 壓縮零值、S2MM 解壓縮。
- 在 BD 呼叫之間保留遞增的位址 offset；MM2S 可抑制 `TLAST`。

通道 0–3 還能存取東西兩側 memory tile 的記憶體與 lock，通道 4–5 只能碰本地的。12 條通道用同一套位址與 lock 編號：

| 區域 | 位址範圍 | Lock 編號 | 限制 |
|---|---|---|---|
| 西鄰 | `0x0_0000`–`0x7_FFFF` | 0–63 | 只有通道 0–3 |
| 本地 | `0x8_0000`–`0xF_FFFF` | 64–127 | |
| 東鄰 | `0x10_0000`–`0x17_FFFF` | 128–191 | 只有通道 0–3 |

位址或 lock 請求超出該通道可達範圍時，通道會停住，要 reset 通道才能繼續。

## Constant padding

MM2S 可以在 stream 資料裡插入常數：每條 MM2S 有一個 32-bit 暫存器存放要插入的值。用途有兩種：

- **演算法 padding**：在有效資料邊緣補出周圍的資料（例如卷積的邊界）。
- **粒度 padding**：kernel 以 16 個 channel 為單位運算，而某層有 24 個 channel 時，由 MM2S 把 channel 維度補到 32。

Padding 綁在 4D 位址產生上：較低的三個維度各有「之前」與「之後」兩個 padding 欄位，加在該維度的 wrap 之外。

## Lock 與 stream switch

[Locks Module and Stream Switch](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Locks-Module-and-Stream-Switch)：

- **Lock**：64 把 semaphore lock，每把 6-bit 無號狀態，和 tile 的 lock 相同。本地 DMA 通道、東西鄰居的通道 0–3、memory-mapped AXI4 都能存取。
- **Stream switch**：和 tile 的設計相同，17 個 manager 埠、18 個 subordinate 埠，但沒有東西向的 stream 埠。北、南與 DMA 埠可跑滿 64-bit／週期；trace 與 control 埠是 32-bit，經轉接器。
- **其他**：事件、事件動作、event broadcast 與 combo event；task-complete-token 邏輯；每顆 1 MB 的設定位址空間；stream control packet；6 個效能計數器與 64-bit tile timer。

## 和 XDNA 2 的對照

- **相同（有 AIE2P 來源）**：6+6 通道、48 個 BD、64 把本地 lock、西／本地／東的位址基底 0／`0x80000`／`0x100000` 與 192 個 lock 編號，見 [DMA／MMIO 規格](dma-registers.md) 與 [Tile 微架構](tile-microarchitecture.md)；沒有東西向 stream 埠，見 [Interconnect](interconnect.md)。
- **本機用法**：把一份資料放在 memory tile、切給同一欄的多顆核心並重播多次，見 [資料上 tile](data-ingress.md)。
- **未核實**：AIE2P 的 memory tile DMA 是否有壓縮、constant padding、亂序模式與 5D 位址；stream 是否 64-bit。mlir-aie 模型對 mem tile 回報的是 4 個位址維度。

## 來源
- [AM027：AIE-ML v2 Memory Tile Overview and Features](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Overview-and-Features) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Memory Tile Memory](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Memory) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Memory Tile DMA](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-DMA) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：AIE-ML v2 Memory Tile Locks Module and Stream Switch](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Memory-Tile-Locks-Module-and-Stream-Switch) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。

## 關聯
- [am027-overview](am027-overview.md)
- [am027-tile](am027-tile.md)
- [am027-core](am027-core.md)
- [am027-system](am027-system.md)
- [dma](dma.md)
- [dma-registers](dma-registers.md)
- [data-ingress](data-ingress.md)
- [memory](memory.md)

## 反向連結
- [data-ingress](data-ingress.md)
- [dma-registers](dma-registers.md)
- [am027-overview](am027-overview.md)
- [am027-tile](am027-tile.md)
- [am027-core](am027-core.md)
- [am027-system](am027-system.md)
