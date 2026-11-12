# AM027 處理器架構：暫存器、load／store、純量與向量單元、六級管線

分類：架構 · 官方手冊摘要（AIE-ML v2，非 AIE2P） · 來源快照 2026-09-12

AIE-ML v2 核心的功能單元：暫存器檔、指令長度、三個 AGU、純量 ALU 延遲、整數與浮點向量乘加的六級管線、型別轉換與暫存器搬移。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 範圍

本頁是 AMD 手冊 AM027（Versal AIE-ML v2，編譯器代號 AIE2PS）的中文摘要，rev 1.1，2026-11-12 讀取。XDNA 2 用的是 AIE2P，沒有公開的專屬架構手冊；本頁的數字除非在「和 XDNA 2 的對照」一節另外寫明，都不能直接當成 AIE2P 的規格。

[Functional Overview](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Functional-Overview)：核心是 VLIW SIMD 處理器，包含 memory interface、純量單元、向量單元（定點與浮點）、兩個 load 單元、一個 store 單元、指令 fetch／decode 單元。另有 processor bus 可直接讀寫本地 tile 的 memory-mapped 暫存器。

## 乘加能力表

| 型別 A | 型別 B | 累加 lane 數 | 每 lane 位元 | MAC 數 |
|---|---|---|---|---|
| int8 | int8 | 64 | 32 | 512 |
| int16 | int16 | 64 | 32 | 128 |
| int16 | int16 | 32 | 64 | 128 |
| int32 | int16 | 32 | 64 | 64 |
| bfloat16 | bfloat16 | 32 | fp32 | 256 |
| float16 | float16 | 32 | fp32 | 256 |
| float8 | float8 | 64 | fp32 | 512 |
| MX6 | MX6 | 64 | fp32 | 1024 |
| MX9 | MX9 | 64 | fp32 | 512 |

- 4-bit × 4-bit 是模擬的；32 × 32 以 32 × 16 分解模擬；MX4 用 MX9 模擬。
- 乘數與被乘數可有號或無號，累加器一律有號。
- 稀疏：所有整數與浮點模式都支援（50% 稀疏），MX 區塊浮點除外。
- MX 是共用指數的區塊浮點：MX9 每個元素 8 bits、MX6 5 bits、MX4 3 bits（都是二補數的符號加 mantissa），另有 8 bits 共用指數與 8 bits 共用 sub-tile shift。
- fp8 支援 E4M3、E5M2 等格式。
- 向量加法單元：8／16／32-bit 的加、減、比較、min／max；非線性函數 tanh、exp2（bfloat16 兩者都有，float16 只有 exp2）。

## 暫存器

| 類別 | 名稱 | 位寬 | 用途 |
|---|---|---|---|
| 純量（[Scalar](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Scalar-Registers)） | `r0`–`r31` | 32 | 通用 |
| | `m0`–`m7` | 20 | modifier |
| | `p0`–`p7` | 20 | pointer |
| 特殊（[Special](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Special-Registers)） | `dn0`–`dn7`、`dj0`–`dj7`、`dc0`–`dc7` | 20 | AGU 的維度大小、步距、計數 |
| | `s0`–`s3` | 6 | shift 控制 |
| | `sp`、`lr`、`pc`、`fc` | 20 | 堆疊、連結、程式計數、fetch 計數 |
| | `ls`、`le` | 20 | 迴圈起點、終點 |
| | `lc`、`lci` | 32 | 迴圈計數 |
| | `F`／`G`／`E` | 128／64／64 | MX6 的資料高位、sub-tile shift、指數 |
| 向量（[Vector](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Vector-Registers)） | `wl0`–`wl11`、`wh0`–`wh11` | 256 | 兩個 W 合成一個 512-bit `x`，兩個 `x` 合成 1024-bit `y`（12 個 x、6 個 y） |
| Mask（[Mask](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Mask-Registers)） | `Q0`–`Q3` | 128 | 稀疏用 |
| 累加器（[Accumulator](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Accumulator-Registers)） | `bm`／`cm`／`dm` | 512／1024／2048 | 兩個 bm 合成 cm，兩個 cm 合成 dm；`dm0`–`dm7` |

狀態與控制暫存器實際上是許多小欄位，只有經 debug 介面才會合成 32-bit 的 SR／CR 來存取。

## Fetch、load／store 與純量單元

- **Fetch／decode**（[原文](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Instruction-Fetch-and-Decode-Unit)）：以 PC 為位址向程式記憶體取 128-bit 的值再解碼。指令長度 16 到 128 bits、可變長度；用滿所有 VLIW slot 時多半需要 128 bits，外層迴圈與控制碼用短格式即可。
- **Load／store**（[原文](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Load-and-Store-Unit)）：兩個 load 單元（AGUA、AGUB）與一個 store 單元（AGUS），各有一個位址產生單元，輸入是 20-bit 的 P 與 M 暫存器；AGU 延遲 1 週期。支援 2D／3D 定址。
- **純量 ALU**（[原文](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Arithmetic-Logic-Unit-and-Scalar-Functions)）：每週期可發一條指令。

| 運算 | 延遲 |
|---|---|
| 32-bit 加、減、比較 | 1 週期 |
| 位元邏輯（AND／OR／XOR） | 1 週期 |
| 左移、右移 | 1 週期 |
| 32 × 32 乘法（結果 32 bits） | 2 週期 |

另有倒數、平方根、平方根倒數的硬體加速。純量單元沒有浮點運算器，浮點靠模擬；手冊建議加法與乘法放在向量單元做。

## 向量乘加的六級管線

[Fixed-point Vector Unit](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Fixed-point-Vector-Unit) 的圖把整數乘法路徑分成 E1 到 E6：

| 級 | 圖上的方塊 |
|---|---|
| E1 | 向量暫存器檔 X（12 × 512-bit／6 × 1024-bit） |
| E2 | 兩個 permute／expand 單元：一個展開成 1024 × 8-bit，另一個成 1024 × 4-bit |
| E3 | 乘法器：1024 個 9-bit × 5-bit |
| E4–E5 | Post-add 與累加（128 × 16-bit／64 × 32-bit／32 × 64-bit），可加入最多兩個累加器輸入 |
| E6 | 寫回累加器暫存器（8 × 2048-bit） |

乘法路徑之外還有兩條向量路徑，輸入直接來自兩個向量暫存器、結果寫回向量暫存器：

- **加法／比較**：16 × 32-bit、32 × 16-bit、64 × 8-bit 三種 lane 模式，有號與無號；每個 lane 可各自選加或減；支援 `<`、`>`、`≤`、`≥`、`< 0`、min、max。
- **Shift**：以 8-bit 為單位右移；或把一個 8／16／32-bit 純量推進向量的一端，其餘 lane 依序移動。
- **Shuffle**：8／16／32-bit 的交錯與解交錯、取上半或下半；也負責搬動 MX 的指數與 sub-tile shift。

[Floating-point Vector Unit](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Floating-point-Vector-Unit) 同樣是六級：mantissa 和整數路徑一樣先經 permute 與乘法器，接著 post-add、`BFSHIFT`（對齊）、累加、`FPNORM`（正規化成 fp32）。MX 的指數來自 E 暫存器、sub-tile shift 來自 G 暫存器。所有浮點加法一次完成：把全部 mantissa 對齊到最大指數，保留 23 個小數位元。

## 型別轉換與暫存器搬移

[SRS and UPS](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Fixed-Point-SRS-and-UPS-Conversions)：SRS 讀累加器、轉換後寫到向量暫存器或直接寫進記憶體；UPS 從記憶體或向量暫存器讀、寫進累加器。

- 整數：8↔32、16↔32、16↔64、32↔64 bits。
- 浮點：fp32 累加器 ↔ bfloat16／float16 向量（16 或 32 lane）；fp32 累加器 → bfloat8／float8（32 lane）；bfloat16 → 32-bit 有號整數（16 lane）。
- 區塊浮點：MX9／MX6／MX4 區塊 ↔ fp32 累加器；轉成 MX 時是 16 個 mantissa 共用一個指數與 sub-tile shift。

[Register Move](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Register-Move-Functionality)：純量之間、立即值、純量與 AXI4-Stream 之間可搬；W／X／Y 同寬度之間一週期搬一個；BM 對 BM、CM 對 CM 一週期；向量到累加器有三條路（up-shift、乘以常數 1、BM 與 X 直接搬）；累加器到向量走 SRS 或直接搬；累加器與 cascade 互搬；純量與向量之間可插入或取出 8／16／32-bit 的值。

## 和 XDNA 2 的對照

以下 AIE2P 資料來自固定版本的 Peano 原始碼，見 [AIE2P 暫存器](isa-registers.md)：

| 項目 | AM027（AIE-ML v2） | AIE2P（Peano 來源） |
|---|---|---|
| 向量暫存器 | 24 × 256-bit（12 個 x、6 個 y） | 相同 |
| Mask 暫存器 | Q0–Q3，128-bit | 相同（`q0`–`q3`） |
| 2048-bit 累加器 | `dm0`–`dm7`，8 個 | `dm0`–`dm4`，5 個 |
| 指標、modifier、維度暫存器 | 各 8 個，20-bit | 相同 |

- **管線級數**：Peano 對 AIE2P 的排程模型（[指令週期](instruction-cycles.md)）把整數與 bfloat16 的 VMAC 寫成：來源運算元在第 1 週期讀、累加器輸入在第 4 週期讀、結果在第 6 週期寫。這和本手冊圖上的 E1（向量暫存器）、E4（累加器輸入進 post-add）、E6（寫回累加器）對得上。這是編譯器模型和姊妹代手冊的對照，不是 AIE2P 矽上級數的量測。
- **未核實**：fp8、MX6、MX9、float16 乘加在 AIE2P 上是否存在。AIE2P 的 bfp16 也是多個 8-bit mantissa 共用指數，但本 Wiki 沒有來源說它和 MX9 是同一種格式；型別請以 [資料型別](datatypes.md) 為準。

## 來源
- [AM027：Functional Overview](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Functional-Overview) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Scalar Registers](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Scalar-Registers) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Special Registers](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Special-Registers) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Vector Registers](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Vector-Registers) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Mask Registers](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Mask-Registers) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Accumulator Registers](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Accumulator-Registers) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Instruction Fetch and Decode Unit](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Instruction-Fetch-and-Decode-Unit) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Load and Store Unit](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Load-and-Store-Unit) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Arithmetic Logic Unit and Scalar Functions](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Arithmetic-Logic-Unit-and-Scalar-Functions) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Fixed-point Vector Unit](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Fixed-point-Vector-Unit) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Fixed-Point SRS and UPS Conversions](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Fixed-Point-SRS-and-UPS-Conversions) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Floating-point Vector Unit](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Floating-point-Vector-Unit) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [AM027：Register Move Functionality](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/Register-Move-Functionality) — AMD 官方手冊 AM027 rev 1.1（2025-10-23），2026-11-12 讀取全文。Versal AIE-ML v2（AIE2PS），不是 AIE2P 專屬文件。
- [Peano：AIE2P 累加器暫存器定義](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L403-L469) — AIE2P 的 BM／CM／DM 索引 0–4。僅靜態來源查核。
- [Peano：AIE2P VMAC operand/bypass 排程](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9024-L9064) — VMAC 的 dst=6、acc1=4、s1=s2=1。編譯器 itinerary，不是矽上量測。

## 關聯
- [am027-overview](am027-overview.md)
- [am027-tile](am027-tile.md)
- [am027-memtile](am027-memtile.md)
- [am027-system](am027-system.md)
- [isa-registers](isa-registers.md)
- [vliw-pipeline](vliw-pipeline.md)
- [instruction-cycles](instruction-cycles.md)
- [compute](compute.md)
- [datatypes](datatypes.md)

## 反向連結
- [vliw-pipeline](vliw-pipeline.md)
- [am027-overview](am027-overview.md)
- [am027-tile](am027-tile.md)
- [am027-memtile](am027-memtile.md)
- [am027-system](am027-system.md)
