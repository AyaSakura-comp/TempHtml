# 同步：鎖、背壓、停頓與死鎖

分類：架構 · 來源查核 · 來源快照 2026-09-12

以生產者／消費者 ownership 與等待圖理解核心和 DMA 的協定，區分正常阻塞與無法前進。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 同步在資料之外表達什麼

資料地址只說明「在哪裡」，同步則說明「現在誰可以使用」。核心與 DMA 都可能碰到同一塊 buffer；如果沒有生命週期協定，資料搬入、運算與覆寫便可能互相交錯。對 LLM，錯誤不一定表現成崩潰，也可能只是偶發的 tensor 數值污染，不能因單筆結果看似合理便跳過同步檢查。

**來源事實：**[AIE UseLockOp](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L1500-L1611)區分舊架構的 binary lock 與 AIE2 的 counting semaphore；[NPU2 繼承的 target model](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L759-L824)提供對應鎖資源。本文採用 semaphore 語意理解 AIE2P 資料流，不把它當成 C++ 主機 mutex，也不將鎖操作延伸為通用 host cache coherence 保證。

## Acquire 與 Release 的可見契約

[操作定義](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L1500-L1611)指出 `AcquireGreaterEqual` 等待值至少達到要求，再扣除要求量；AIE2 的 `Release` 則增加值。這很適合表示「可用空間」與「可讀物件」的數量，但鎖本身不認識 tensor 的型別或維度。`Acquire` 的相等條件與大於等於條件不同，不應任意替換。

[Peano AIE2P lock header](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_locks.h#L14-L61)把 `acquire_greater_equal` 的值取負後交給 builtin，並提供帶 pointer 的 overload。這是編碼與編譯器介面的事實，不表示使用者應把一般計數器設成負數，也不證明任意主機記憶體的可見性已被處理。應由對應 API 傳達意圖，而不是憑負號猜測硬體狀態。

## 生產者與消費者的所有權

以下是**工程示意**，不是可直接執行的 IR；empty 和 ready 代表兩種許可，實際配置仍由 lowering 決定。

```text
生產者：取得 empty → 寫入完整物件 → 發布 ready
消費者：取得 ready → 讀取／計算完成 → 歸還 empty
DMA：   也必須按自己讀取或寫入的角色加入上述循環
```

| 狀態 | 允許行為 | 典型錯誤 |
|---|---|---|
| 空間已取得 | 唯一寫入者開始填入 | 另一端同時覆寫 |
| 內容已發布 | 消費者取得後讀取 | 發布早於完成 |
| 仍被持有 | 不得回收重用 | 只看迴圈進度便重用 |
| 使用已完成 | 歸還可用空間 | 遺漏 release 導致耗盡 |

BD 可以附帶 acquire／release，見[DMA 描述子契約](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L940-L1064)。因此核心的最後一次讀取與 DMA 的最後一次讀取應分別追蹤；「核心已算完」未必等於「整個輸出已被搬走」。

## 深度、批量取得與並行程度

[ObjectFifo 文件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2a/README.md#L258-L298)展示消費者一次取得多個物件時，足以避免局部容量阻塞的深度與能讓兩端重疊的深度不同。其示例用概念深度二與三作比較，但本文不把示例變成所有圖的最小深度定理；整體迴圈物件數、尾端行為及跨 FIFO 相依仍要另算。

**工程推論：**若消費者必須湊齊一批才能前進，而供應端的所有 buffer 在此之前已被持有，增加算術速度也不能解決問題。加深 FIFO 可能改善局部等待，但也占用更多 [記憶體](memory.md)，甚至使本來可配置的設計失敗。深度不是越大越安全，更不是 target model 中固定的一個通用上限。

## Stall 不等於死鎖

[trace 文件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-4/section-4b/README.md#L75-L101)分列 memory、stream 與 lock stall 事件名稱，說明等待來源有不同分類；本次只讀文件，沒有取得任何事件計數。等待上游生產是正常阻塞；若條件稍後能被其他參與者滿足，系統仍能前進。死鎖則是相關工作都在等不可能被現有進度解除的條件。

**工程推論：**可將「A 持有輸入並等 B 的輸出空間，B 持有輸出並等 A 釋放輸入」畫成等待環。檢查每條邊需要的許可由誰產生、產生之前是否又等待下一條邊。局部 acquire／release 數量看似平衡，仍可能因順序構成循環；初值缺少啟動 token 也可能使圖一開始就無人可動。

## LLM 管線與除錯順序

分塊 GEMM、量化轉換和 attention 中間資料可形成多階段管線。**工程推論：**分支中速度較慢的一路若持有共享物件，上游可能因無空間而停下；症狀出現在輸入端，不等於輸入 DMA 配錯。融合階段會改變持有時間，切分 K 維又會新增部分和的到齊條件，兩者都應重畫等待圖。

建議先核對有限工作量的生產／消費總數，再看初值與 acquire 批量，接著追查資料與路由，最後才分析排程效能。對尾塊、空工作及錯誤退出也要定義 release 行為。

對一條反覆執行的管線，還要區分啟動、穩態與排空。啟動時必須有人能取得最初空間，穩態時物件與許可要持續循環，排空時則不能再等待永遠不會出現的下一批輸入。局部程式在穩態可以前進，不代表有限次呼叫的最後一批能順利退出。這是後續測試設計應單獨覆蓋的活性問題。主機 timeout 僅代表未在期限內觀察到完成，不足以證明死鎖，更不能直接指定是哪個鎖出錯。

## 陷阱與閱讀檢核

[Peano README](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L1-L66)談外露管線不含一般相依性 stall 邏輯，與資料流層存在 lock／stream 等待並不矛盾。前者是指令排程模型，後者是工作能否取得資料與許可；不要用其中一句否定另一層。

- 列出每個 buffer 的所有讀寫者，包括 DMA，而非只有 kernel。
- 寫明 lock 初值、取得量、釋放量、順序與物件總數。
- 區分可前進的等待、容量不足與循環等待，先證明哪個條件不會再被滿足。
- 檢查分支與尾端路徑，不能只驗證穩態中央迴圈。
- 保留未知：本次未執行 deadlock 重現、硬體 trace 或一致性實驗，也未保證整張圖的活性。

後續 [驗證](validation.md) 應把功能正確、協定活性與效能分成不同驗收項目；能完成一次工作不代表所有批量與緩衝配置都安全。

## 來源
- [AIE LockOp／UseLockOp：鎖語意](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L1500-L1611) — Counting semaphore、AcquireGreaterEqual 等待後扣除、Release 增加；非主機 mutex/coherence 保證。 僅靜態來源查核。
- [AIETargetModel：鎖與 BD 資源](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L759-L824) — 鎖、BD 數、ND 維度及 mem tile channel 對 BD 半區的可達性。 僅靜態來源查核。
- [Peano AIE2P locks：builtin 包裝](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_locks.h#L14-L61) — Greater-equal 的負值編碼及 pointer overload；不應按負號猜測邏輯計數初值。 僅靜態來源查核。
- [AIE DMABDOp：描述子與布局契約](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L940-L1064) — Buffer、offset/len、元素單位、BD 鏈與 ND layout；文件內 stride 例子與限制文字有落差，本文不判定所有可用步距。 僅靜態來源查核。
- [ObjectFifo：概念深度與局部池](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2a/README.md#L258-L298) — 批量取得、可前進與可重疊所需容量不同；範例不是完整有限迴圈活性證明。 僅靜態來源查核。
- [Trace 文件：等待事件分類](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-4/section-4b/README.md#L75-L101) — Memory、stream、lock stall 名稱；僅讀文件，未取得任何硬體 trace。 僅靜態來源查核。
- [Peano README：架構與後端](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L1-L66) — XDNA2 target triple、in-order exposed-pipeline VLIW、編譯器責任及成熟度限制。示例 timing 非本次硬體規格。 僅靜態來源查核。

## 關聯
- [dma](dma.md)
- [memory](memory.md)
- [compute](compute.md)
- [iron](iron.md)
- [debug](debug.md)
- [validation](validation.md)

## 反向連結
- [system](system.md)
- [compute](compute.md)
- [dma](dma.md)
- [iron](iron.md)
- [runtime](runtime.md)
- [heterogeneous](heterogeneous.md)
- [debug](debug.md)
- [glossary](glossary.md)
