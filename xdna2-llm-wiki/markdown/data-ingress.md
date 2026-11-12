# 資料上 tile：DMA 路徑、lock 握手、雙緩衝與硬體 trace

分類：架構 · 官方手冊／本機產物 · 來源快照 2026-11-12

每顆 tile 的 SRAM 都要靠 DMA 餵資料：路徑、IRON 寫法、lock 握手、和指令排程的關係，以及這台 NPU 上錄到的事件 trace。

> 官方手冊、固定版本原始碼與本機產物；本機段落的日期與範圍見正文。

## 每顆 tile 有自己的 SRAM

XDNA 2 的每顆 tile 都有自己的記憶體，和主機 DRAM 不相通：compute tile 是 64 KiB 資料記憶體加 16 KiB 程式記憶體，memory tile 是 512 KiB（容量來源見 [Tile 微架構](tile-microarchitecture.md)）。AMD 寫的 [Linux 驅動文件](https://docs.kernel.org/accel/amdxdna/amdnpu.html)把 memory tile 稱為軟體管理的 L2，並說明由 DMA 在主機 DDR 與 memory tile 之間搬資料。核心沒有任何指令可以直接讀主機記憶體，所以「資料怎麼上 tile」就是「DMA 怎麼排」。

```text
主機 DDR ─▶ shim DMA ─▶ memory tile SRAM ─▶ compute tile SRAM ─▶ 核心 load
（列 0）     stream      （列 1，512 KiB）  stream  （列 2–5，64 KiB）
```

## 一筆資料上 tile 的五個步驟

1. **主機**：把資料放進 XRT 緩衝區並同步到裝置。NPU 不看 CPU cache，沒同步會讀到舊資料（見 [執行期](runtime.md)）。
2. **Shim（列 0）**：DMA 從主機 DDR 讀出資料，變成 stream 往上送。
3. **Memory tile（列 1）**：DMA 把 stream 寫進 512 KiB，再讀出來往上送；這一站可以把一份資料切給多顆核心，或重播多次。
4. **Compute tile**：tile 上的 DMA 把 stream 寫進自己的 64 KiB，寫完後釋放一把 lock。
5. **核心**：取得那把 lock，用一般的 load 指令讀那塊位址。

結果回主機是同一條路反過來走。每顆 compute tile 只有 2 進 2 出的 DMA 通道，一筆資料要放得進 64 KiB 扣掉 stack 與其他緩衝區後的空間（見 [DMA](dma.md) 與 [記憶體](memory.md)）。

## IRON 裡要寫的四樣東西

設計者不直接設定 DMA 暫存器。在 IRON 裡寫下列四樣，編譯器會產生 [BD 描述子](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L940-L1064)、[lock](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L1500-L1611) 與路由：

| 你寫的 | 作用 |
|---|---|
| `ObjectFifo(型別, depth=…)` | 宣告一條資料通道、每筆資料的大小與緩衝數（見 [ObjectFifo 文件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2a/README.md#L258-L298)） |
| `.split(…, tile=Tile(c, 1))`、`.forward(…)`、`.join(…)` | 指定在哪顆 memory tile 中轉，以及怎麼切、怎麼合、重播幾次 |
| `Worker(kernel, [fifo.cons(), …])` | 把通道接到某顆核心；核心程式裡以 `acquire`／`release` 取用 |
| runtime sequence 裡的 `fill(…)`、`drain(…)` | 執行時把主機緩衝區的哪一段送進哪條通道、從哪條收回（見 [runtime sequence 文件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2d/README.md#L28-L36)） |

`fill`／`drain` 會降成 shim DMA 的工作；放置（哪顆核心算哪一段）在手寫設計裡由設計者指定，路由與位址由編譯器決定（見 [IRON](iron.md) 與 [編譯器分工](compiler.md)）。

## 另外三種進到 tile 的方式

- **編譯時寫死**：常數表放進核心的 ELF，載入設計時就寫進 SRAM。[aie-rt 的 ELF loader](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/core/xaie_elfloader.c#L126-L202) 依資料段位址決定寫進哪一顆 tile 的記憶體，適合不會變的小表。
- **Cascade**：上游核心把累加器的值直接送給下游核心，不經過 SRAM，常用來串接部分和（見 [Interconnect](interconnect.md)）。
- **相鄰核心共用記憶體**：核心直接讀寫鄰居的 SRAM，不經 DMA。[AM027 Tile Architecture](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Tile-Architecture) 與 [AM020](https://docs.amd.com/r/en-US/am020-versal-aie-ml) 列的是自己、北、南、西四塊，沒有東邊；ObjectFifo 兩端若能共用同一塊記憶體，編譯器就不產生 DMA。**本機檢查**：2026-11-12 掃過這台機器上 400 份已編譯設計（12,375 顆核心），沒有任何一顆核心引用別顆 tile 的緩衝區；這條路在本機沒有被用過，也沒有實測。

## Lock 握手：一個真實設計的設定（本機產物）

以下取自這台機器上一個手寫 GEMM 設計（8 欄 × 4 列）編譯後的 `input_with_addresses.mlir` 與核心 ELF 的反組譯，核心在第 3 欄第 3 列。A 是單緩衝，W 是雙緩衝：

| 物件 | 位址（核心視角） | 大小 | bank | lock（生產／消費，初值） |
|---|---|---|---|---|
| A 緩衝 | `0x70800` | 23,040 B | 0 | lock 0／lock 1，初值 1／0 |
| W 緩衝 0 | `0x78000` | 10,560 B | 2 | lock 2／lock 3，初值 2／0 |
| W 緩衝 1 | `0x7C000` | 10,560 B | 3 | 同上（兩塊共用一對 lock） |

DMA 這一側（compute tile 的 S2MM 通道 1，兩個 BD 互相接續）：

```text
BD1: 取得 lock 2 (>=1) → 寫 W 緩衝 0（10,560 B） → 釋放 lock 3 → 接 BD2
BD2: 取得 lock 2 (>=1) → 寫 W 緩衝 1（10,560 B） → 釋放 lock 3 → 接 BD1
```

核心這一側（外層迴圈的反組譯，lock 編號 `0x30` 起是自己這顆 tile 的 lock，見 [lock 編號視窗](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1554-L1577)）：

```text
acq #0x31            ; 等 A 就緒（自己的 lock 1）
重複 40 次：
  acq #0x33          ; 等一塊 W 就緒（自己的 lock 3）
  p0 = 0x70800       ; A
  p1 = 0x78000 或 0x7C000   ; 兩塊 W 輪流
  jl  kernel
  rel #0x32          ; 把這塊 W 還給 DMA（自己的 lock 2）
rel #0x30            ; 把 A 還給 DMA（自己的 lock 0）
```

lock 是計數 semaphore：lock 2 的初值 2 代表「有兩塊空的 W 緩衝可寫」，DMA 每寫完一塊就把 lock 3 加一，核心每用完一塊就把 lock 2 加一。[Peano 的 lock header](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_locks.h#L14-L61) 是核心端的介面；語意見 [同步](synchronization.md)。

## 資料搬移能不能和 VLIW 指令重疊

可以，方法是雙緩衝，不是把搬移寫進指令排程：

- **重疊的條件**：ObjectFifo 的 `depth` 至少 2 時，核心在算緩衝 0 的同時，DMA 可以把下一筆寫進緩衝 1。上例的 W 就是這樣；A 是單緩衝，換下一筆 A 時核心必須等。
- **核心端的成本**：資料已經到的時候，一次 `acq` 或 `rel` 在下面的本機 trace 裡只佔 1 個週期；資料還沒到，核心就停在 `acq`。
- **Stall 期間整顆核心暫停**：[AM027 Interfaces](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2) 列出核心會因 lock、stream 滿或空、資料記憶體衝突而 stall。暫停時所有指令一起停住，所以 kernel 內部以週期計的排程（見 [指令週期](instruction-cycles.md) 與 [軟體管線化](software-pipelining.md)）不需要為 DMA 預留空檔；排程裡的「第幾週期」是不含 stall 的週期。這是由手冊敘述與下面 trace 得出的工程推論。
- **Bank**：AM027（姊妹代）說每個 bank 各自仲裁，不同 bank 可同時存取。上例中編譯器把 A 放在 bank 0、兩塊 W 放在 bank 2 與 3，DMA 寫下一塊 W 時不會和核心正在讀的那塊同 bank。
- **速率要配得上**：DMA 填滿一塊緩衝的時間若長於核心算完一塊的時間，核心每一輪都會在 `acq` 等。上例一塊 W 是 10,560 B，kernel 每塊約 1,280 個 MAC 週期加上銜接，兩者同一量級；這個設計沒有錄過 trace，哪一邊在等沒有量測。

## 硬體 trace 看得到什麼（本機 trace）

硬體沒有逐指令、逐管線級的波形。能錄的是事件 trace：每顆 tile 的 trace unit 追蹤最多八個事件，AM027（姊妹代）列出 event-time（逐週期記錄事件狀態變化）與 event-PC（事件成立時記錄 PC）兩種模式。IRON 以 `Program.enable_trace(...)` 開啟，trace 封包經 stream 送到 shim 寫回主機，再用 `aie.utils.trace` 解析成 Perfetto JSON（見 [trace 文件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-4/section-4b/README.md#L30-L72) 與 [Events](events-debug.md)）。

以下是這台 NPU 上 2026-10-27 錄的一份 event-time trace：手寫 conv3x3 設計（兩顆核心以 cascade 串成一條鏈，128 列影像），不是上一節的 GEMM 設計。從第一次呼叫 kernel 到最後一次返回，各事件佔的週期比例：

| 核心 | 向量指令 | 等 lock | 等 cascade | bank 衝突 | 其他 |
|---|---|---|---|---|---|
| 鏈頭（列 5） | 86.1% | 0.6% | 8.2% | 0.8% | 4.3% |
| 鏈尾（列 4） | 89.6% | 0.7% | 0.0% | 3.1% | 6.6% |

- **穩定狀態**：每列影像一次 kernel 呼叫，週期約 2,540，其中 2,304 個是 VMAC。每次交接有 2 到 4 次 lock 操作，各停 1 個週期，表示 DMA 一直領先核心。
- **開頭**：鏈尾核心在第一筆資料到之前停了 28,851 個週期，第三列之後又停了一次 1,703 個週期等 DMA；之後不再出現長的 lock stall。
- **Bank 衝突**：每次 1 個週期，鏈尾每列約 80 次、鏈頭約 20 次。trace 只給事件名稱，沒有指出是和誰衝突。
- **Cascade**：鏈頭每列有 4 次等 cascade，中位數 26 個週期，是下游較慢造成的背壓。

一次交接的事件順序（週期為 trace 計數）：

| 週期 | 核心 | 事件 |
|---|---|---|
| 45,786–45,815 | 鏈尾 | 8 次 MEMORY_STALL，各 1 週期，夾在向量指令之間 |
| 45,832 | 鏈尾 | INSTR_RETURN，這一列的 kernel 返回 |
| 45,832–45,873 | 鏈頭 | CASCADE_STALL 41 週期 |
| 45,842、45,847 | 鏈尾 | LOCK_STALL 各 1 週期 |
| 45,852 | 鏈尾 | INSTR_CALL，下一列開始 |
| 45,854、45,859 | 鏈尾 | LOCK_STALL 各 1 週期 |
| 45,892 | 鏈尾 | 向量指令恢復 |
| 45,897 | 鏈頭 | 向量指令恢復 |

## 未驗證與限制

- 上面的 trace 來自 conv3x3 設計；GEMM 設計沒有 trace，它的 lock 握手只有編譯產物與反組譯為證，沒有量到核心等了多久。
- AM020 與 AM027 是前一代與 Versal 姊妹代的手冊，AIE2P 沒有公開的專屬架構手冊；頻寬、load 寬度、stream 寬度等數字不可直接搬用（見 [規格缺口](spec-gaps.md)）。
- 核心直接讀寫鄰居 SRAM、核心是否完全不能碰 memory tile，在本機都沒有實測。
- event-PC 模式在本機沒有錄過；它給的是事件成立時的 PC，不是完整的指令序列。
- 錄 trace 需要另外的 shim 通道與緩衝，會改變設計的資料路徑；trace 版的時間不能直接當成正式版的時間。

## 來源
- [AM027：AIE-ML v2 Tile Architecture](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Tile-Architecture) — AMD 官方手冊 rev 1.1（2025-10-23）；記憶體鄰接為自己／北／南／西。Versal 姊妹代，非 AIE2P 專屬。2026-11-12 取得原文。
- [AM027：Versal AIE-ML v2 Architecture Manual](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2) — Interfaces（stall 來源）、Memory Module（bank 仲裁）、Memory Tile DMA、Trace（event-time／event-PC）各節。非 AIE2P 專屬。
- [AM020：Versal AIE-ML Architecture Manual](https://docs.amd.com/r/en-US/am020-versal-aie-ml) — AMD 官方手冊 rev 1.5（2026-02-18）；前一代，記憶體鄰接列舉與 AM027 相同。
- [Linux kernel：AMD NPU（amdxdna）](https://docs.kernel.org/accel/amdxdna/amdnpu.html) — AMD 撰寫的驅動文件：Strix Point 4x8、memory tile 為 L2、DMA 在主機 DDR 與 memory tile 間搬移。
- [aie-rt ELF loader：資料段位址對應 tile](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/core/xaie_elfloader.c#L126-L202) — AIE2P 表下 CardDir 4／5／6／7 對應南／西／北／自己。僅靜態來源查核。
- [AIE DMABDOp：描述子與 lock](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L940-L1064) — BD 可附帶 acquire／release 並接續下一個 BD。僅靜態來源查核。
- [AIE LockOp／UseLockOp：鎖語意](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L1500-L1611) — Counting semaphore 的 AcquireGreaterEqual 與 Release。僅靜態來源查核。
- [AIETargetModel：lock 編號視窗](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1554-L1577) — 核心視角的 lock 編號：南 0、西 16、北 32、自己 48 起。僅靜態來源查核。
- [ObjectFifo 文件：深度與重疊](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2a/README.md#L258-L298) — 深度與生產者、消費者能否重疊的關係。
- [Runtime sequence 文件：fill／drain](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2d/README.md#L28-L36) — fill／drain 降成 shim DMA 工作。
- [Trace 文件：enable_trace 與解析](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-4/section-4b/README.md#L30-L72) — trace unit 設定、封包路由到 shim、core_trace_mode。
- [Peano AIE2P lock header](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_locks.h#L14-L61) — 核心端 acquire／release 介面。僅靜態來源查核。

## 關聯
- [dma](dma.md)
- [synchronization](synchronization.md)
- [memory](memory.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [events-debug](events-debug.md)
- [iron](iron.md)
- [runtime](runtime.md)
- [software-pipelining](software-pipelining.md)
- [spec-gaps](spec-gaps.md)
- [am027-tile](am027-tile.md)
- [am027-memtile](am027-memtile.md)

## 反向連結
- [system](system.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [memory](memory.md)
- [dma](dma.md)
- [synchronization](synchronization.md)
- [events-debug](events-debug.md)
- [am027-tile](am027-tile.md)
- [am027-memtile](am027-memtile.md)
- [am027-system](am027-system.md)
