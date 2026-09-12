# 記憶體：program、data、banks 與局部地址

分類：架構 · 來源查核 · 來源快照 2026-09-12

用容量、連續空間、對齊及生命週期四張帳，區分 scratchpad、地址視窗與核心連結限制。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 先拆開程式與資料記憶體

**來源事實：**[AIETargetModel](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L790)給出本地 data memory `0x10000`，即 64 KiB；program memory `0x4000`，即 16 KiB。Mem tile 的[模型容量](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L830-L834)則是 512 KiB。這些是固定 snapshot 的編譯器模型值，不是實測可用 tensor 容量，也不保證每次存取的延遲。

program 放核心程式；data 工作區容納執行時資料。不可把兩者相加當成同一池，或以「尚有資料空間」解釋程式連結失敗。這裡常被稱作 L1／L2 的局部記憶體應理解為需安排搬移與 ownership 的 scratchpad，不是 CPU 式自動 coherent cache。主機 tensor 在外部記憶體存在，不表示已自動出現在核心可用的局部地址。

## 資料空間必須算進核心自己

[core_data_memory 文件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L10-L32)指出本地 data memory 由 stack、`aie.buffer` 以及核心 `.data`／`.rodata`／`.bss` 共用。ObjectFifo 的 backing buffers 只是其中一部分；常數表、全域值、靜態暫存與呼叫堆疊同樣消耗空間。

| 記帳項目 | 需要追蹤的條件 |
|---|---|
| A／B 輸入與 C 輸出 | 微區塊大小、是否同時存活 |
| 多緩衝池 | 物件大小乘以各端實際配置深度 |
| Stack | 最深可達呼叫路徑及分析是否完整 |
| 核心靜態區段 | 連結後保留的常數、全域與零初始化區 |
| 配置間隙 | 對齊、固定地址與 bank 約束 |

**工程推論：**GEMM 選塊時先留出非 tensor 預算，再增加 tile 尺寸或緩衝深度。把理論 payload 塞到容量恰好滿，通常沒有表達對齊與程式私有資料的餘地；本文不指定通用安全比例。

## 可用總量不等於可用連續區間

[核心 sections 文件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L107-L176)說明 linker script 提供的是一段連續 data region。即使總剩餘空間足夠，碎裂成不相鄰的區間仍可能放不下靜態區段。`data_size` 讓 allocator 先保留連續空間，再把其他 buffers 配置在周圍；它不會增加硬體容量。

[stack 分析文件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L34-L105)則說明工具讀取 linked ELF 的 frame 與呼叫邊，沿入口的呼叫鏈取最大需求。`measured_stack_size` 的 measured 指靜態分析所得，不是執行時堆疊探針。遞迴、間接呼叫或缺少 frame 資料都可能留下缺口；override 是使用者宣告，不能當成自動證明。這些機制本次僅閱讀，未執行。

## Banks 與局部地址是兩種問題

[bank 模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L830-L834)回傳 mem tile 八個 banks、其他 tile 四個；這是工具配置粒度的來源，不代表本次完成物理 bank 微架構驗證。Bank 問題關乎同時存取是否競爭資源；局部地址則回答一筆資料位於哪個視窗。不能用 bank 數乘以本地容量當成額外儲存，也不能把不同指標值當成必然無衝突的 bank。

[地址基底](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L790)定義南、西、北、東視窗；[鄰接實作](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L755-L824)的 East 對應 self，其他方向受 tile 邊界及 mem tile 例外約束。可看見鄰近資料不等於取得更多私有 L1，更不等於可以無同步地同時寫入。若不同核心共享同一實體 buffer，仍需把 ownership 與存取順序放入設計。

## 對齊、匯流排與配置策略

**來源事實：**模型的[load/store bus](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L790)為 256 bits，NPU2 的[full-width vector alignment](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1077-L1145)為 512 bits，即 64 bytes；[API helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/ld_st.hpp#L33-L40)也依存取寬度選擇對齊。三者不能互換：對齊要求不是每次傳輸量，更不是頻寬或週期保證。未對齊的 subview 即使母 buffer 已對齊，也必須重新檢查偏移。

[配置控制文件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L193-L218)說明 bank-aware 會考慮 bank 分散與連續區間；basic-sequential 不具 bank 概念，會忽略 `mem_bank` 並警告。指定 bank 因此不是脫離 allocator 的硬體承諾。對 LLM，輸入搬入、核心讀取及輸出寫回的重疊能否受益，需同時考慮實際位址與排程，不能只靠多緩衝數量推定。

## 對 LLM 工作集的後果

**工程推論：**把權重分塊長期保留可減少重複搬移，但會擠壓 activation、輸出與同步緩衝；把中間值移到 mem tile 可讓核心放更大的計算區塊，卻新增 DMA 與等待邊。KV cache 的總 payload 是另一層容量問題，不應假設它能整段駐留於單個核心 scratchpad。

融合算子也有兩份帳：少一次中間存回可能有利，但額外程式碼、查表及 stack 可能使核心無法連結。當錯誤指出 `program` 區域超限，應檢討程式；指出 `data` 則先檢查連續區間與共存資料。關閉檢查不會把越界變安全，詳見 [除錯](debug.md)。

實務上的容量草圖可以按時間列出：搬入下一份權重時，目前 activation 是否仍被核心讀取；輸出開始送出時，下一次輸出是否已有獨立空間。只有生命週期不重疊且配置契約允許的資料，才有機會共用地址。不能因兩個 tensor 在高階圖中屬於不同算子，就假設它們不會同時被非同步 DMA 使用。

另外，容量足夠與 bank 配置合適應各自驗收。先證明所有地址範圍不互相覆蓋，再追蹤同時發生的讀寫落在哪些資源；若為了分散 bank 造成連續區域縮小，還必須回到 linker 的需求重新檢查。這個來回是配置問題，不代表記憶體容量規格改變。改變微區塊、融合方式或緩衝深度後，原本的空間圖也應重新計算。

## 陷阱與閱讀檢核

- 以 bytes 記帳並明示 KiB，區分 payload、保留量與連結後區段。
- 畫出每個 buffer 的地址範圍、bank 約束、使用者與生命週期。
- 預建 ELF 若已佔用固定區間，按[文件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L107-L176)保留該地址；只填大小不足以表達位置。
- 同時檢查程式容量、最大連續 data run、stack 完整性與向量對齊。
- 不照抄「L1 固定一個 cycle」；仲裁、bank 映射細節、實際衝突率與存取延遲仍未量測。

## 來源
- [AIETargetModel：核心容量與地址](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L790) — 64 KiB data、16 KiB program、地址視窗、256-bit load/store bus 及 cascade 模型；非存取延遲量測。 僅靜態來源查核。
- [AIETargetModel：mem tile 容量與 banks](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L830-L834) — 512 KiB mem tile；模型回傳 mem tile 八 banks、其他 tile 四 banks。 僅靜態來源查核。
- [Core Data Memory：共用資料區](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L10-L32) — Stack、buffers、.data/.rodata/.bss 共用本地 data memory。 僅靜態來源查核。
- [Core Data Memory：連續區間與預建 ELF](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L107-L176) — data_size 保留一段連續區間；預建 ELF 固定地址須另保留，不能只用大小表達。 僅靜態來源查核。
- [Core Data Memory：stack 分析](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L34-L105) — Linked ELF 靜態呼叫路徑分析、缺失資料與 override；measured 屬編譯分析，不是 runtime 測量。 僅靜態來源查核。
- [AIETargetModel：記憶體鄰接](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L755-L824) — East=self、方向與邊界／mem tile 例外；不可推成完整 DMA 路由限制。 僅靜態來源查核。
- [AIETargetModel：NPU2 拓撲與分區](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1077-L1145) — 完整 Strix 八欄、六列角色、可變 cols 分區及 512-bit 對齊；不是所有 SKU 或 runtime 配額。 僅靜態來源查核。
- [AIE API：AIE2P load/store 對齊](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/ld_st.hpp#L33-L40) — 不同向量寬度的對齊 helper；full-width 64-byte alignment 不等於匯流排寬度。 僅靜態來源查核。
- [Core Data Memory：配置策略](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L193-L218) — bank-aware、basic-sequential、mem_bank 的不同處理；不提供 bank 延遲。 僅靜態來源查核。

## 關聯
- [system](system.md)
- [compute](compute.md)
- [dma](dma.md)
- [kv-cache](kv-cache.md)
- [gemm](gemm.md)
- [debug](debug.md)

## 反向連結
- [system](system.md)
- [compute](compute.md)
- [dma](dma.md)
- [synchronization](synchronization.md)
- [datatypes](datatypes.md)
- [iron](iron.md)
- [runtime](runtime.md)
- [gemm](gemm.md)
- [kv-cache](kv-cache.md)
- [glossary](glossary.md)
