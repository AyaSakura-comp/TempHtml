# XDNA2 系統：空間資料流與 NPU2 分區

分類：架構 · 來源查核 · 來源快照 2026-09-12

從固定版本 target model 理解 tile 陣列、主機邊界及 LLM 的配置單位，避免把完整 Strix 模型當成所有可用裝置。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 證據範圍與系統邊界

**來源事實：**本頁的 XDNA2 指 Peano 對應 `aie2p-none-unknown-elf` 的目標；[版本標頭](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20)將 AIE2P 標為 arch 21。[Peano README](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L1-L66)描述 AI Engine 為陣列中的循序、外露管線 VLIW 處理器。這是工具鏈如何理解目標的證據，不是本次對晶片時脈、電源狀態或整機推論速度的測量。arch 22 的 AIE2PS 不能因名稱相似而合併成同一規格。

理解系統時要分開主機程式、陣列資料流與核心程式：主機負責準備輸入並協調工作；陣列配置決定物件如何抵達計算位置；核心執行局部運算。本文以原始碼可見範圍說明後兩者，不承諾任何框架的每個算子都已被放上 NPU。

## 三種 tile 與座標

[BaseNPU2TargetModel 與完整 Strix model](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1077-L1145)給出總共六列：row 0 為 ShimNOC、row 1 為 mem tile、row 2 至 5 為 compute tile；完整模型有八欄。因此完整模型的計算位置是八欄乘四個計算列，共三十二個，不是把所有列都當成核心。

| 角色 | 工作視角 | 不應混淆 |
|---|---|---|
| Shim | 外部記憶體與陣列的資料入口／出口 | 不是執行矩陣 kernel 的核心 |
| Mem tile | 暫存、分發與 DMA 配置位置 | 不是每個核心私有的快取 |
| Compute tile | 核心程式及局部資料工作集 | 不等於一個主機執行緒 |

下圖只示意上述列角色，箭頭代表邏輯資料流，不宣稱唯一實體路線或鏈路頻寬。

```text
外部資料 ⇄ Shim ⇄ Mem tile ⇄ Compute buffers ⇄ Kernel
                          └─ 分發／彙整其他局部工作
```

## 完整裝置不等於本次可用分區

**來源事實：**同一[模型檔](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1077-L1145)另有 `VirtualizedNPU2TargetModel`，其欄數由 `cols` 決定，並帶有虛擬化屬性。完整陣列圖只是其中一個目標；不能看見 XDNA2 字樣就固定假設每次程式都取得全部計算位置。架構參考中的家族表適合導航，但 SKU 覆蓋範圍應服從具體目標及配置證據。

**工程推論：**LLM 的矩陣切塊必須先以分區能容納的 worker 與緩衝區設計。把完整模型的核心數直接放入吞吐量公式，可能同時高估可用計算、記憶體與搬移資源。分區改變後，不只是縮小迴圈次數，輸入廣播、輸出彙整與跨 tile 中間值也可能需要重新安排。

## 記憶體可見性不是路由拓撲

[記憶體鄰接函式](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L755-L824)中的 East 是本 tile，West 是左側欄位，North／South 還受邊界與 mem tile 例外限制。它回答的是核心可如何關聯局部記憶體，不是任意 DMA 封包能走哪條路。另一組[switchbox 連接模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L885-L949)才列出各 tile 與方向的埠資源及邊界行為。

因此本文不採用「跨欄一定只能經 mem tile」作普遍定理。設計時可先畫邏輯生產者與消費者，再核對 placement、buffer affinity 與 routing 三個層次。合法的局部地址不能替代串流路徑配置；有路由也不代表接收緩衝已可安全覆寫。詳見 [DMA](dma.md) 與 [同步](synchronization.md)。

## 對 LLM 的映射後果

**工程推論：**線性層可將輸出矩陣的不同區塊分配到多個核心，讓權重或 activation 在局部重用。沿歸約維度分工則多出部分和的交換與數值合併；沿輸出維度分工可能增加輸入複製。兩者沒有脫離資料大小、可用分區及精度路徑的唯一最佳解。

prefill 有較多 token 可併成矩陣工作，decode 常是較小的即時工作；這是形狀對利用率的工程判斷，不是實測速度排名。KV cache 若超過局部容量，資料生命週期就跨出單個 tile；應明列哪些資料留在局部、哪些透過 DMA 反覆取得，而不是把整個 attention 圖當成一條矩陣指令。圖切分也要追蹤 CPU／NPU 邊界，避免只最佳化局部 kernel 卻增加主機往返。

具體規劃時，可以先替一層投影建立資料流清單：輸入由哪個入口抵達、哪些核心需要同一份輸入、每份權重被重用多久、輸出交給哪個下一階段。若把歸約分給多個核心，清單還應包含部分和的格式、合併者與釋放時間。這些選項會同時牽動核心占用及傳輸，不宜只用矩陣元素數平均分工。

另一個容易遺漏的邊界是部署資源與演算法資源不同。模型圖上獨立的算子未必需要各占一個常駐核心；反之，一個大型算子也可能橫跨多個位置。應先說明是時間上重用核心，還是空間上同時配置，再解釋吞吐量目標。沒有這個區分，分區圖、工作排程與容量估算可能各自合理，合在一起卻無法成立。

## 常見誤判與閱讀檢核

[架構速查表](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/skills/aie-code-creator/references/architecture.md#L39-L142)混合了模型值、概略效能與操作建議。本文採用可被 model 支持的容量與拓撲，不採用其固定延遲、頻率或未驗證的每週期乘加數。空間資料流表示工作與資料流被配置到不同位置，不表示沒有排程、阻塞或共享資源。

- 先記錄實際 target 名稱、架構 guard 與分區欄數，再畫陣列。
- 分別標示 kernel、暫存區、DMA 通道、串流與主機端資料。
- 追蹤每個中間 tensor 的唯一寫入者、讀取者及回收條件。
- 閱讀 [記憶體](memory.md) 後估算能容納的工作集，再選 [矩陣原語](mma.md)。
- 未知項保留為未知：SKU 實際可用資源、頻率、鏈路有效頻寬、端到端延遲與框架算子覆蓋率均未由本次查核證明。

## 來源
- [AIE2P 版本標頭](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20) — arch 21 與 model 巨集；不可混用 arch 22。 僅靜態來源查核。
- [Peano README：架構與後端](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L1-L66) — XDNA2 target triple、in-order exposed-pipeline VLIW、編譯器責任及成熟度限制。示例 timing 非本次硬體規格。 僅靜態來源查核。
- [AIETargetModel：NPU2 拓撲與分區](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1077-L1145) — 完整 Strix 八欄、六列角色、可變 cols 分區及 512-bit 對齊；不是所有 SKU 或 runtime 配額。 僅靜態來源查核。
- [AIETargetModel：記憶體鄰接](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L755-L824) — East=self、方向與邊界／mem tile 例外；不可推成完整 DMA 路由限制。 僅靜態來源查核。
- [AIETargetModel：switchbox 目的埠](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L885-L949) — 各 tile 的方向／DMA 連接資源與邊界；不是完整路由可行性證明。 僅靜態來源查核。
- [架構速查表：交叉查核對象](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/skills/aie-code-creator/references/architecture.md#L39-L142) — 用於導航與自然向量寬度；固定 clocks、latencies、BF16 MAC/cycle、路由絕對規則及 FIFO 深度不採作保證。 僅靜態來源查核。

## 關聯
- [compute](compute.md)
- [memory](memory.md)
- [dma](dma.md)
- [synchronization](synchronization.md)
- [heterogeneous](heterogeneous.md)
- [llm-graph](llm-graph.md)

## 反向連結
- [compute](compute.md)
- [memory](memory.md)
- [dma](dma.md)
- [glossary](glossary.md)
