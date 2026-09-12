# VLIW 與外露管線：bundle 格式、scoreboard 與 hazard

分類：架構 · 來源查核／模型推導 · 來源快照 2026-09-12

IssueWidth=1000 並非千路發射；以 77 種 composite format 與資源時序理解 AIE2P 的靜態平行、跨週期衝突和不確定停頓。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## in-order 與外露管線究竟公開了什麼

[架構與 target 對應](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L16-L65)將 AIE 描述為 in-order、exposed-pipeline VLIW，並指出編譯器能重疊安排同一暫存器的不同讀寫。這不是「所有指令一個 cycle 結束」，也不是硬體替程式自動解開相依。bundle 內操作同時開始，而各 operand 的讀寫在不同點發生；順序發射、同週期多操作、晚讀早寫是三個不同維度。

本頁只使用 pinned `386ca5c6634a84bb224b7248e79df8edabf0722f` 的 `aie2p`：`AIE2PSchedule` 裡的 P 是目標 AIE2P 的尾字，不是 `aie2ps`。公開模型可證明編譯器施加哪些 constraints，不能證明未公開的 silicon 內部級名、ROB 深度、動態互鎖策略或晶片跳接線延遲。完整[排程／composite JSON](../spec-data/scheduling-model.json)附 immutable source ranges 與 hashes，可配合 [ISA](isa.md) 查實际指令，而不是把格式或排程類別當 opcode 清單。

## IssueWidth、issue-limit 與可編碼 slot：三道不同門

[AIE2P 排程模型](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSchedule.td#L11-L32)明說 issue limit 反正受 VLIW formats 限制，因沒有通用「無限制」語法而設定 IssueWidth=1000。MicroOpBufferSize=1000 的註解則談負 latency 與 pre-RA 啟發式；**不能稱作 1000-entry 實體亂序視窗**。[hazard recognizer issue limit](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L224-L275)另有 hazard recognizer 命令列 `issue-limit`，預設是 6；該選項可降低平行度，但 packetizer 並不直接服從這個 debug 上限。

| 層次 | 此版本的值／條件 | 實際回答的問題 |
|---|---|---|
| SchedMachineModel IssueWidth | 1000 | 不讓粗模型過早限制發射 |
| MicroOpBufferSize | 1000 | 控制排程器對負 latency 等的處理 |
| AIEHazardRecognizer issue-limit | 預設 6 | 此次排程嘗試的 issue 數門檻 |
| slot 占用與 conflict sets | 不可重疊／互斥 | 是否爭同 slot 或禁止搭配 |
| composite format | slot union 必須有合法格式 | 最後能不能編成 bundle |
| operand / FU / memory scoreboard | 各自時間點合法 | 能編碼也未必能安全執行 |

若某 ALU、MV、VEC 各一操作獨立，粗略 issue 計數只用 3；仍要驗證資源、register 邊與格式。兩個都固定 ALU slot 的操作即使 issue 計數才 2，也不能塞同 bundle。slot 名不是獨立執行緒，vec_slot 的 26 位也不是 26 個 SIMD lane。

## 格式有長短，不是每次固定 128-bit 六發射

[AIE2P slot 宣告](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSlots.td#L13-L67)列七種非人工 slot：Ldb=17、Alu=20、Lng=42、Lda=20、Mv=22、St=20、Vec=26 位；這是各欄位寬度。[Composite 寬度類別](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L24-L78)另列 composite 封包寬度，[全部 composite def 列表](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L1141-L1216)的生成檔有 76 個具名 def，再加[16-bit NOP composite](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormatsInclude.td#L11-L29)的手寫 I16_NOP，共 77 個格式記錄。這個數字是由 JSON 逐 def 統計，不是 instruction count、也不是每週期操作數。

| composite 總位數 | byte 數（位數÷8） | 格式記錄數 |
|---:|---:|---:|
| 16 | 2 | 1 |
| 32 | 4 | 6 |
| 48 | 6 | 10 |
| 64 | 8 | 9 |
| 80 | 10 | 21 |
| 96 | 12 | 20 |
| 112 | 14 | 8 |
| 128 | 16 | 2 |

**確切例：**[全部 composite def 列表](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L1141-L1216)末兩筆 `I128_LDA_LDB_ST_ALU_MV_VEC` 包含六個有用 slots；`I128_LDA_LDB_ST_LNG_VEC` 則只有五個，使用 Lng 而非分開的 Alu+Mv。前者欄位和 `20+17+20+20+22+26=125 bit`，後者 `20+17+20+42+26=125 bit`；與 128 相差的 3 bit 是這些格式中的編碼結構部分，不是額外三個操作。這是靜態格式位數推導，不是指令執行耗時。

[人工 NOP slot](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSlotInclude.td#L11-L26)把 nop_slot 標為 Artificial，用來區分同一有效 slot 組合的長短格式、選較大編碼處理對齊。不要把這個人工 slot 當第八個實體運算單元，也不要把加入 NOP 只理解為相依性等待：NOP 還能服務編碼／對齊選擇。分支目標的對齊問題見[架構與 target 對應](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L16-L65)，本頁不自行新增未核對的硬體對齊常數。

## scoreboard 並非只有當下 bundle 的空位表

[資源與 format 衝突](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L133-L178)的 `anyStage` 以起點 0 走訪 stages，每個 Cycles 展開成數個預約點，再按 NextCycles 推進。`FuncUnitWrapper::conflict` 除了 slot、conflict-set，還核對 MemoryBanks、load/store 物件位圖與 Required/Reserved FU。若兩組 occupied slots 都非空，最後還呼叫 isFormatAvailable 檢查 union。

**Required/Reserved 表：**同一模型 FU 的 Required–Required、Required–Reserved、Reserved–Required 均衝突；Reserved–Reserved 不因此衝突。[資源階段 helper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L12-L31)用 PART_WORD_STORE 表示讀改寫中的強預約 `IsPartWordStore<7 cycles>`，其他 memory op 的 AvoidPartWordStore 是弱預約。若把 Reserved 也當獨占強資源，會捏造 memory ops 彼此不能重疊的限制。

[分層 scoreboard 檢查](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L575-L626)把檢查分成三處：發射點驗證格式；memory point 按 `DeltaCycles + Cycles − 1` 查 bank／shared object；FU 預約按 `DeltaCycles + stage offset` 查詢。減 1 不是神秘加速，而是 MemoryAccessCycles 以 1 起算、scoreboard 以 0 起算的座標轉換。用 stage 與 operand 數值畫表時應在表頭宣告起算方式。

**數值演算：**若 operation A 在 offset 2 占 Required X 一週期，而 B 在其 offset 0 占同 X，A 在 t=0 發射後，B 若在 t=2 發射就撞到時間點 2；t=1 則不因這個 X 預約而撞到。兩者當下 bundle 不同且 slot 也可能不同，因此「當下 slot 有空」仍不足以判斷。這只是單一資源的示意約束，未排除其他 edges。

## register read/write、旁路與資料完整性

[AIE signed operand latency](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L892-L1024)用 resolved schedule class 計算 signed RAW/WAR/WAW；[排程類別動態選擇](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L1363-L1432)依 register class 選擇變體。因此 mnemonic 相同的兩份 kernel 在 register allocation 後可能有不同時序。[eWH 無旁路特例](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/ExtraItineraries.td#L10-L34)特別限制 upper-W 的 move bypass；若只用生成表預設值，會漏掉 VEXP2、VTANH、VCONV 的 eWH 特例。

[VMAC operand/bypass](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9024-L9064)中某 integer VMAC 是 write=6、accumulator read=4，匹配 VEC bypass 後 RAW 下界 2，而不是由 stages=[] 得出 0。又如 LDA 的 destination point=7 但 memory point=5（[scalar load 與 register variant](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4608-L4623)）；若把 memory access cycle 當結果寫回，就可能排出過早讀取。資源預約、指令編碼與真正 operand 邊互相補足，任何單張表都不能取代另外兩張。

對高階 [MMA](mma.md) 呼叫，要先確認 lowering 成哪些指令，再用 [指令週期](instruction-cycles.md) 的逐 operand 方式建立 DAG。API 一次運算可能含 shuffle、conversion、load/store 和多個算術操作；不能由 composite 具有一個 vec_slot 就推定整個 API 一 cycle 結束，也不能把 accumulator 容量當 pipeline 深度。

## 停頓、保守模型與不可宣稱的管線圖

「外露管線不替一般資料相依插 stall」與「核心／系統永不等待」不是同一主張。[鎖 stall/resume 與 memory edge](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L1082-L1165)明確實作 lock core stall/resume delay：base 值為 2 與 8，但註解說 ISA 未完整描述，因此是保守建模。memory bank 衝突在 scoreboard 有靜態避免機制；串流 mayLoadOrStore 卻不碰 memory 的情況另被排除，不能靠 load itinerary 推估 stream 背壓時間。外部資料未到、鎖條件不滿足與 downstream 接收能力都不是一條 RAW edge 的固定數字。

[AIE2P hazard 與 DONE](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrInfo.cpp#L1079-L1113)對 DONE 採 6 的保守 latency，原文只提 E4..E6 structural conflict。可引述這段來源用語，但沒有足夠證據把全核心畫成「E1 解碼、E2 搬移、E3 乘法」之類命名圖。[自我衝突與 horizon](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L714-L778)的 PipelineDepth、MaxLatency 是從模型事件算出的 scoreboard horizon；它們不是 silicon transistor-level pipeline 級數。模型未列出的內部階段、跨 tile 每 hop latency、頻率與實測 stall 機率一律保留未知。

實務檢核順序是：target → 實際 opcode/register class → 各 operand edge → 各 cycle 資源 → slot union 合法格式 → 迴圈跨迭代 → memory／lock／stream 系統條件。接著到 [軟體管線化](software-pipelining.md) 判斷穩態 II 與完整 loop 總成本；本次沒有執行 compiler、TableGen、模擬器或 NPU。

## 來源
- [架構與 target 對應](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L16-L65) — README 的示意 load cycle 8 不是 AIE2P 實測表。 固定 commit 靜態查核，非實測晶片保證。
- [AIE2P 排程模型](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSchedule.td#L11-L32) — IssueWidth、MicroOpBufferSize 為軟體排程控制；三項 FIXME 且 CompleteModel=0。 固定 commit 靜態查核，非實測晶片保證。
- [hazard recognizer issue limit](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L224-L275) — 命令列預設 6；pre-RA 深度與未知 slot 有不同處理。 固定 commit 靜態查核，非實測晶片保證。
- [AIE2P slot 宣告](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSlots.td#L13-L67) — 七種有用 slot 類別，位數不是發射指令數。 固定 commit 靜態查核，非實測晶片保證。
- [Composite 寬度類別](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L24-L78) — 32/48/64/80/96/112/128-bit 大小。 固定 commit 靜態查核，非實測晶片保證。
- [全部 composite def 列表](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L1141-L1216) — 76 筆 generated def；128-bit 六 slot 與 long 五 slot 形式。 固定 commit 靜態查核，非實測晶片保證。
- [16-bit NOP composite](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormatsInclude.td#L11-L29) — 手寫第 77 種格式。 固定 commit 靜態查核，非實測晶片保證。
- [人工 NOP slot](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSlotInclude.td#L11-L26) — Artificial=true，可用以區分不同長度的格式；註解 XM 只作動機，不轉成 AIE2P slot 名稱。 固定 commit 靜態查核，非實測晶片保證。
- [資源與 format 衝突](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L133-L178) — Required/Reserved 非對稱強弱預約、slot union 可編碼性、stage 起點累進。 固定 commit 靜態查核，非實測晶片保證。
- [資源階段 helper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L12-L31) — Empty/Prefix/Simple 與 part-word Required/Reserved 的確切定義。 固定 commit 靜態查核，非實測晶片保證。
- [分層 scoreboard 檢查](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L575-L626) — issue cycle 檢查格式；MemoryAccessCycles 減 1；各 stage 另查資源。 固定 commit 靜態查核，非實測晶片保證。
- [AIE signed operand latency](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L892-L1024) — RAW/WAR/WAW 差值、register-class variant、負值與一週期 bypass 假設。 固定 commit 靜態查核，非實測晶片保證。
- [排程類別動態選擇](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L1363-L1432) — 依實體／虛擬 register class 選 variant，不僅看 mnemonic。 固定 commit 靜態查核，非實測晶片保證。
- [eWH 無旁路特例](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/ExtraItineraries.td#L10-L34) — 三個手寫 itinerary；保留預設 eWL bypass 與 eWH 特化差異。 固定 commit 靜態查核，非實測晶片保證。
- [VMAC operand/bypass](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9024-L9064) — 整數與浮點／不同路徑不可共用一個 latency；表內 dst、acc1、s1、s2 分開。 固定 commit 靜態查核，非實測晶片保證。
- [scalar load 與 register variant](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4608-L4623) — dst=7、記憶體點 5；部分 variant 省去晚期 FU 但不改 dst 時點。 固定 commit 靜態查核，非實測晶片保證。
- [鎖 stall/resume 與 memory edge](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L1082-L1165) — 2/8 是保守核心 stall/resume 模型，註明 ISA 未完整描述；非鎖等待固定耗時。 固定 commit 靜態查核，非實測晶片保證。
- [AIE2P hazard 與 DONE](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrInfo.cpp#L1079-L1113) — DONE=6 明載保守值；E4..E6 為來源用語，不延伸實體管線級名。 固定 commit 靜態查核，非實測晶片保證。
- [自我衝突與 horizon](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L714-L778) — SelfMII 是最後衝突 II 加一的保守門檻；PipelineDepth 是軟體 horizon。 固定 commit 靜態查核，非實測晶片保證。

## 關聯
- [isa](isa.md)
- [compute](compute.md)
- [mma](mma.md)
- [performance](performance.md)
- [compiler](compiler.md)
- [instruction-cycles](instruction-cycles.md)
- [software-pipelining](software-pipelining.md)

## 反向連結
- [spec-index](spec-index.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [instruction-cycles](instruction-cycles.md)
- [software-pipelining](software-pipelining.md)
- [events-debug](events-debug.md)
