# DMA：描述子、通道與資料布局

分類：架構 · 來源查核 · 來源快照 2026-09-12

分清 BD 程式、具方向的通道與鎖協定，將 LLM packing、搬移和緩衝生命週期一起設計。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## DMA 不是一個隱形的 memcpy

**來源事實：**[DMAStartOp](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L1291-L1347)以方向與 index 定義 channel；[DMABDOp](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L940-L1064)則描述 buffer、offset、length、sizes、strides 等搬移內容。將兩者分開，才能理解為何有空間卻可能缺配置資源，也能理解為何發起工作不等於資料已可讀。

| 名詞 | 回答的問題 | 不代表什麼 |
|---|---|---|
| Buffer | 資料實際存在哪裡 | 不等於已傳輸完成 |
| BD | 一段搬移如何走訪資料 | 不等於一條獨立通道 |
| Channel | 哪個方向與編號執行 BD 鏈 | 不等於每個 BD 可並行 |
| Lock | 何時可讀寫或回收 buffer | 不負責定義 tensor layout |
| Flow／路由 | 串流送往哪個目的地 | 不自動建立 buffer ownership |

對 LLM，packing 與 DMA 是計算之前的契約，不是 kernel 完成後才補上的效能小技巧。

## 描述子鏈與有限資源

[Target model](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L759-L824)列出 mem tile 有 48 個 BD、core／shim 有 16 個；ND dimensions 分別為四維及三維。這些是描述子資源與地址生成能力，不是同時傳輸數，也不是一個 tensor 可以任意複製成許多並行工作。BD 可以透過 `next_bd` 形成鏈，單一通道依鏈處理多個描述子。

同一模型還限制 mem tile 的偶數 channel 使用較低半部 BD、奇數 channel 使用較高半部 BD，分界為 ID 24。因而「尚有未使用 BD」不必然表示選定通道可用它。配置器應檢查 tile 類型、方向、channel index 與 BD 可達性，而不是將整個陣列的描述子相加成一池。

## 長度單位與多維走訪

[操作契約](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L940-L1064)以 element width 解釋 offset、len、sizes 與 strides；同樣的元素長度在不同 dtype 下不是相同 bytes。文件亦特別提醒最內層 stride 的限制，因此不能把抽象巢狀迴圈任意照抄成所有 tile 都能接受的硬體設定。本文不將模型的 Buffer_Length 欄位上限直接改寫成最大 bytes，避免漏掉 lowering 的單位換算。

```text
原矩陣索引 → sizes / strides → DMA 串流次序
                                 ↓
局部 buffer layout → vector load → mmul 消費次序
```

**工程推論：**先用小矩陣手算第一批與最後一批元素的索引，再檢查是否重複、遺漏或跨界。多維 DMA 改變走訪順序，不會自動完成 BF16 到 BFP16 的數值轉換；INT4 nibble 打包也不能一律用 scalar 陣列的元素步距想像。

## 通道方向與鎖的生命週期

MM2S 表示記憶體送入串流，S2MM 表示串流寫入記憶體，見[channel 定義](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L1291-L1347)。方向一定要連同所在 tile 閱讀：上游的送出與下游的接收是不同端點，不是同一個 index 指向整條路徑。

BD 所在 block 可帶 acquire／release，再接下一個 BD，見[描述子契約](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L940-L1064)。**工程推論：**接收端應先取得可覆寫空間，完成搬入才發布可讀資料；送出端要等到內容有效才讀取，最後回報該 buffer 可回收。若核心提前 release，DMA 可能讀到被改寫的內容；若過晚或永不 release，則可能永遠等不到下一次傳輸條件。這是協定風險，不是本次已重現的硬體故障。

## Mem tile 與路由不是万能中繼

Mem tile 較多 ND 維度與容量，使它適合作為某些 layout 轉換或暫存位置；但多一跳仍多一組資料生命週期。[switchbox 模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L885-L949)按 tile、方向及邊界描述連接資源，與[記憶體鄰接](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L755-L824)不是同一套判準。因此本頁不聲稱所有跨欄資料必經 mem tile，也不保證有合法地址就能路由。

**工程推論：**若 reshaping 超出某端點地址生成能力，可考慮拆成多個 BD、改放另一級暫存，或由核心 shuffle 處理。選擇時應把額外搬移、描述子使用、局部記憶體及數值操作成本一併計入；並非遇到高維 tensor 就一定要新增一層中繼。

## LLM 的重疊與背壓

雙緩衝的目的是讓核心處理目前物件時，DMA 有另一塊合法空間可使用；「非同步」不保證必然重疊。若兩者競爭相同 bank、輸出未被消費或通道仍在等待鎖，核心再快也可能停在資料邊界。背壓會沿串流反向傳播，症狀可能出現在上游而根因位於下游。

對 prefill，較大區塊可能提高重用，卻減少能共存的物件數。對 decode，頻繁處理小批資料可能讓準備、packing 與同步更重要。這些都是工作量分析；本文未取得傳輸有效頻寬、主機 copy 成本或重疊比例，不能提供固定速度預測。

一份有用的搬移帳還應區分資料只經過一次，或因多個消費者而重送多次。例如相同 activation 被不同輸出區塊使用，邏輯上只有一份輸入，實際配置卻可能選擇複製、廣播或先暫存。這是待比較的工程方案，不可單用張量大小當成外部搬移總量。

驗證 packing 時，宜選每個位置都帶不同值的小輸入，讓轉置、步距與維度次序的錯誤能被辨認；全零或常數資料容易使錯誤路徑仍產生看似正確的結果。對低位元格式還應分別檢查原始位元與解碼後數值，避免搬移位元順序正確，卻在核心使用不同的有號解釋。

## 陷阱與閱讀檢核

- 逐條記錄 tile、方向、channel、BD ID、下一個 BD 與終止條件。
- 分別驗證元素數、bytes、packed stride 及地址邊界，不用 dtype 名稱代替布局。
- 畫出 empty／ready 的流向，將核心與 DMA 視為不同參與者。
- 對尾塊及部分填充設計明確有效長度；padding 不代表量化 zero point 必定為零。
- 若加深 FIFO，重新檢查容量與資源，不把[速查表](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/skills/aie-code-creator/references/architecture.md#L39-L142)的實務建議當成硬體深度上限。

本頁只查核描述與模型；完整通道仲裁、路由可行性及端到端完成語意仍需對具體產物驗證。接續閱讀 [同步](synchronization.md) 可把這些資源轉成可檢查的等待圖。

## 來源
- [AIE DMAStartOp：通道契約](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L1291-L1347) — 通道由 MM2S/S2MM 方向與 index 定義；channel、BD 與 per-channel padding 分層。 僅靜態來源查核。
- [AIE DMABDOp：描述子與布局契約](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIEOps.td#L940-L1064) — Buffer、offset/len、元素單位、BD 鏈與 ND layout；文件內 stride 例子與限制文字有落差，本文不判定所有可用步距。 僅靜態來源查核。
- [AIETargetModel：鎖與 BD 資源](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L759-L824) — 鎖、BD 數、ND 維度及 mem tile channel 對 BD 半區的可達性。 僅靜態來源查核。
- [AIETargetModel：switchbox 目的埠](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L885-L949) — 各 tile 的方向／DMA 連接資源與邊界；不是完整路由可行性證明。 僅靜態來源查核。
- [AIETargetModel：記憶體鄰接](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L755-L824) — East=self、方向與邊界／mem tile 例外；不可推成完整 DMA 路由限制。 僅靜態來源查核。
- [架構速查表：交叉查核對象](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/skills/aie-code-creator/references/architecture.md#L39-L142) — 用於導航與自然向量寬度；固定 clocks、latencies、BF16 MAC/cycle、路由絕對規則及 FIFO 深度不採作保證。 僅靜態來源查核。

## 關聯
- [memory](memory.md)
- [synchronization](synchronization.md)
- [system](system.md)
- [gemm](gemm.md)
- [runtime](runtime.md)
- [iron](iron.md)

## 反向連結
- [system](system.md)
- [memory](memory.md)
- [synchronization](synchronization.md)
- [iron](iron.md)
- [gemm](gemm.md)
- [glossary](glossary.md)
