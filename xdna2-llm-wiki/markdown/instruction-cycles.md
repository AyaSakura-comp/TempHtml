# 指令週期：完整 itinerary、操作數時點與旁路

分類：架構 · 來源查核／模型推導 · 來源快照 2026-09-12

從 4,013 筆 AIE2P itinerary 分開閱讀資源預約、記憶體接觸點、RAW/WAR/WAW 與 bypass；不把編譯器常數冒充實測 latency。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 範圍、命名與完整資料

本頁以 llvm-aie `386ca5c6634a84bb224b7248e79df8edabf0722f` 的 **`Target/AIE/aie2p`** 為準。[架構與 target 對應](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L16-L65)將 XDNA2／Strix Point 對應 `aie2p-none-unknown-elf`。注意檔名是 **AIE2PSchedule.td = AIE2P + Schedule**、**AIE2PGenSchedule.td**；不是 `aie2ps/AIE2PSSchedule.td` 或 AIE2PSGenSchedule。排程表是公開編譯器模型，不是實測 silicon 保證，也不是由 opcode 字面猜測的耗時清單。

下載[完整排程模型 JSON](../spec-data/scheduling-model.json)：每筆保存原文、1-based 行號範圍、字元 offset、immutable URL，來源檔附 SHA-256 與 Git blob hash。全部 `InstrItinData` **與** `MemInstrItinData` 皆被掃描；後者的第四參數是 MemoryCycles，不是 bypass。[MemInstrItinData 與 MemoryCycles](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/include/llvm/Target/AIETarget.td#L22-L47)明確定義此繼承關係。[ProcessorItineraries 容器](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4223-L4310)界定處理器容器，[eWH 無旁路特例](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/ExtraItineraries.td#L10-L34)補上手寫記錄。

| 擷取統計（此 commit 的原始碼記錄） | 數量 | 解讀邊界 |
|---|---:|---|
| 生成 itinerary | 4,010 | 含 620 筆 memory itinerary |
| 手寫 eWH itinerary | 3 | register-class 時序特化，非三條新指令 |
| 總 itinerary／對應宣告 | 4,013／4,013 | 類別名稱一一覆蓋；不是 ISA instruction count |
| FuncUnit 定義 | 73 | 包含 EMPTY_FU、PART_WORD_STORE 合成資源 |
| 具名 bypass | 2 | MV_Bypass、VEC_Bypass；NoBypass 來自共用定義 |
| 完整 literal 解析／raw-only itinerary | 4,013／0 | 只解析可證明欄位，不等於執行過 TableGen |

統計是對[資源階段 helper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L12-L31)、[全部資源與 bypass 宣告](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L33-L109)所在完整生成檔與兩個 Extra include 的擷取結果；JSON 保留所有 4,095 個模型 def/class 原文，複合容器／泛型類別不冒充已求值 TableGen。未知複雜語法會保留 raw-only 記錄，而非填 0。大量 move/register variants 會使類別數膨脹，不能據此宣布「支援 4,013 條指令」。

## 一個 cycle 欄位至少有四種意思

[LLVM itinerary 欄位語義](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/include/llvm/Target/TargetItinerary.td#L41-L120)定義 stage 的 `Cycles`、`TimeInc` 與 operand cycles；[TableGen 欄位正規化](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/utils/TableGen/SubtargetEmitter.cpp#L355-L432)把預設負 TimeInc 正規化成 Cycles，並將短 bypass 陣列尾端補成 0。JSON 保存來源陣列原長，不把補值偽裝成原文。

| 欄位 | 可可靠讀出的事 | 不能直接等同 |
|---|---|---|
| InstrStage Cycles | 某資源預約持續幾個 cycle | 結果可用延遲 |
| TimeInc / NextCycles | 此 stage 起點到下一個起點的距離 | 必須串行累加的指令延遲 |
| OperandCycles[i] | 指定 operand 的讀／寫點 | 所有輸出共用完成時間 |
| MemoryCycles | 記憶體實際接觸的排程點，可有多點 | cache miss、DMA 或鎖等待時長 |
| Bypasses[i] | def/use 是否可走同一 forwarding 類別 | 晶片旁路的任意 hop latency |

**具體推導：**`[EmptyCycles<2>, PrefixCycle<A>, SimpleCycle<B>]` 在 JSON 的零起算座標中，A、B 都占 offset 2 那一個 cycle；EmptyCycles 本身占用 0 個 cycle、只把起點推進 2。預約包絡是 `max(start+duration)=3`，不是 `2+1+1=4`。這是套用[資源階段 helper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L12-L31)與[資源與 format 衝突](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L133-L178)解譯迴圈的示範，A、B 是示意資源，不是假稱晶片內部級名。

`[]` 不等於零週期指令。[MC itinerary 查詢實作](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/include/llvm/MC/MCInstrItineraries.h#L169-L262)的 getStageLatency 在 itinerary 資料存在但 stages 為空時，迴圈根本不跑而回傳初值 0；其註解提到的 one-cycle fallback 不可取代實際分支。[ABS 與 lock itineraries](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4309-L4325)的 ABS 正是空 stages 卻有 `[1,1,1]` operand points，仍有 operand 相依與 bundle slot 限制。

## 實際模型橫向表：讀點、寫點與 memory 分開

下表是從完整 JSON 選取的可核對樣例；`dst/src/acc1` 是來源註解名稱，真正 def/use 與 implicit operand 仍要對照所選 opcode。表內 **沒有「每條指令固定耗時」欄**。

| itinerary（II_ 前綴省略） | 原始主要 operand points | 額外 timing / 資源 | 來源 |
|---|---|---|---|
| ADD_alu_r_rr | d0=1、s0=1、s1=1、srCarry=1 | stages=[] | [scalar ADD itinerary](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4428-L4434) |
| LDA_dms_lda_idx | dst=7、ptr=1、dj=1 | MemoryCycles=[5]；晚期寫入資源 | [scalar load 與 register variant](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4608-L4623) |
| VLDA_128_dmv_lda_w_idx | dst=7、ptr=1、dj=1 | MemoryCycles=[5] | [向量 load itinerary](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L8407-L8414) |
| VST_128_dmv_sts_w_idx | src=1、ptr=1、dj=1 | MemoryCycles=[5] | [向量 store itinerary](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9538-L9545) |
| ST_s8_idx | src=7、ptr=1、dj=1、pe2_ads=6/6 | MemoryCycles=[5,11]；RMW | [部分字 store 讀改寫](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L7858-L7863) |
| VMAC_vmul_cm_core_X_QX | dst=6、acc1=4、s1=1、s2=1、acc=1、srSparse_of=2 | dst/acc1 是 VEC_Bypass | [VMAC operand/bypass](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9024-L9064) |
| VMUL_vmul_cm_core_X_QX | dst=6、s1=1、s2=1、acc=1、srSparse_of=2 | dst 是 VEC_Bypass | [VMUL operand/bypass](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9355-L9395) |
| VEXP2 | dst=2、src=1 | dst=MV_Bypass，src=NoBypass | [轉換與非線性 itineraries](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L8248-L8264) |
| VUNPACK_mv_unpack_w_unpackSign0 | dst/src/crUnpackSize/unpackSign0 都是 7 | EmptyCycles<6> 後同週期使用兩資源 | [UNPACK 與 UPS](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L10039-L10072) |

例如 LDA 的 `_mLRa` variant 沒列後段 write-port reservation，**dst 仍是 7**；不能只看 stage envelope 就說該 register 的 load 快了五個 cycle。MemoryCycles=[5] 也不能把 dst=7 改寫成 load-use=5。相反，ST_s8 的 source=7 是晚讀，不是寫出的數據「七週期才 ready」。

## 由 producer 與 consumer 推導 RAW，而非背一個 latency

[AIE signed operand latency](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L892-L1024)實作先根據 register class 解決兩端 itinerary，再計算 signed edge。一般資料相依可寫成 `L_RAW = W_producer − R_consumer + 1 − B`。這個版本的共用 hook 在同一非零 bypass 類別相配時給 B=1，否則 B=0，且原文仍有 FIXME。無號 getOperandLatency 將負值截為 0；signed 版本保留外露管線的先發射、晚讀可能性。

**模型數值推導一：**兩個合法 integer `VMAC_vmul_cm_core_X_QX` 以 dst→下一個 acc1 相連，[VMAC operand/bypass](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9024-L9064)給 W=6、R=4、同 VEC bypass，因此發射間距下界是 `6−4+1−1=2`。對同一結果若 consumer 在 cycle 1 讀且無旁路，則是 `6−1+1=6`。**同一 producer 有兩種 edge latency**；「VMAC 一律 6 cycle」會失去最重要的 consumer 資訊。這僅證明該 edge 的下界，尚未證明整個 bundle／loop 可行。

**模型數值推導二：**LDA dst=7 接 cycle-1 scalar use，沒有匹配 bypass 時為 `7−1+1=7`；若確定合法 consumer 在 cycle 4 才讀，單看此 edge 是 `7−4+1=4`。後者是條件式數學例，不表示任意 load 可接任意 accumulator 型別。

WAR 要避免晚讀看到新值，使用「早讀點−後寫點（反向 bypass 修正後）」且**不加 1**；WAW 使用兩寫點差再加 1。[AIE signed operand latency](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L892-L1024)的 anti 分支專門反向調整 bypass，不能把 RAW 公式機械複製到所有相依。負 edge latency 更不表示資料回到過去，而是兩條指令發射順序可與真正讀寫先後不同。

## eWH、鎖與缺口：讀到數字後還要問什麼

[eWH 無旁路特例](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/ExtraItineraries.td#L10-L34)對 VCONV 的 src、VEXP2／VTANH 的 dst，在 eWH 特化中移除 MV_Bypass；[轉換與 VEXP2 variant 綁定](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L6228-L6288)可核對 VCONV operand 1、VEXP2 operand 0 的綁定，[排程類別動態選擇](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L1363-L1432)則證明選擇不是只看 opcode 名稱。比如 VEXP2 dst=2 接 VCONV src=1，在合法 lower-W／同 bypass 假設下 `2−1+1−1=1`；一端因 eWH 不再匹配則 `2−1+1=2`。這個差異來自模型變體，不是 CPU 式動態快取運氣。

[鎖 stall/resume 與 memory edge](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L1082-L1165)另處理鎖的 core stall/resume 窗口，並明言到核心的鎖延遲在 ISA 並未完整描述、採保守值。LCKREQ reservation=4 只限模型資源；不能推出 acquire 在 4 cycle 內拿到遠端尚未 release 的鎖。stream move 即使標 mayLoadOrStore 也可能不碰 memory，程式碼特別排除；stream 背壓、資料未到、memory bank/resource 衝突與外露管線 RAW 正確性是不同層次。

[AIE2P 排程模型](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSchedule.td#L11-L32)的 LoadLatency=5、MispredictPenalty=4、HighLatency=37 都帶 FIXME，CompleteModel=0；不能拿這三個值覆蓋逐 operand 模型或當 DRAM、分支預測器、長算術保證。本資料不提供未公開的 silicon fetch/decode/execute 級數、實體級名、跨 tile hop 延遲或量測頻率。要估完整 kernel，接著閱讀 [VLIW 管線](vliw-pipeline.md) 的可編碼限制與 [軟體管線化](software-pipelining.md) 的 II／暫存器生命週期。

## 來源
- [架構與 target 對應](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L16-L65) — README 的示意 load cycle 8 不是 AIE2P 實測表。 固定 commit 靜態查核，非實測晶片保證。
- [MemInstrItinData 與 MemoryCycles](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/include/llvm/Target/AIETarget.td#L22-L47) — MemCyclesList、First/LastMemCycle 是獨立欄位。 固定 commit 靜態查核，非實測晶片保證。
- [ProcessorItineraries 容器](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4223-L4310) — FU、bypass 列表與 itinerary 容器起點；擷取器涵蓋整檔而非只此範例。 固定 commit 靜態查核，非實測晶片保證。
- [eWH 無旁路特例](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/ExtraItineraries.td#L10-L34) — 三個手寫 itinerary；保留預設 eWL bypass 與 eWH 特化差異。 固定 commit 靜態查核，非實測晶片保證。
- [資源階段 helper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L12-L31) — Empty/Prefix/Simple 與 part-word Required/Reserved 的確切定義。 固定 commit 靜態查核，非實測晶片保證。
- [全部資源與 bypass 宣告](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L33-L109) — 71 個一般符號加 EMPTY_FU、PART_WORD_STORE，共 73 個模型 FU；不是實體單元普查。 固定 commit 靜態查核，非實測晶片保證。
- [LLVM itinerary 欄位語義](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/include/llvm/Target/TargetItinerary.td#L41-L120) — 時間增量、operand cycle、bypass 與 uops 預設。 固定 commit 靜態查核，非實測晶片保證。
- [TableGen 欄位正規化](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/utils/TableGen/SubtargetEmitter.cpp#L355-L432) — 只讀程式碼：負 TimeInc 轉 Cycles，缺少的 bypass 補 0；未執行 TableGen。 固定 commit 靜態查核，非實測晶片保證。
- [資源與 format 衝突](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L133-L178) — Required/Reserved 非對稱強弱預約、slot union 可編碼性、stage 起點累進。 固定 commit 靜態查核，非實測晶片保證。
- [MC itinerary 查詢實作](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/include/llvm/MC/MCInstrItineraries.h#L169-L262) — getStageLatency、operand timing 與 forwarding；空 stage 註解和實作不可混讀。 固定 commit 靜態查核，非實測晶片保證。
- [ABS 與 lock itineraries](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4309-L4325) — 空 FU list 和 operand cycle 1；LCKREQ 占用 4。 固定 commit 靜態查核，非實測晶片保證。
- [scalar ADD itinerary](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4428-L4434) — ADD 的四個 operand 時點均為 1；不是四週期。 固定 commit 靜態查核，非實測晶片保證。
- [scalar load 與 register variant](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4608-L4623) — dst=7、記憶體點 5；部分 variant 省去晚期 FU 但不改 dst 時點。 固定 commit 靜態查核，非實測晶片保證。
- [向量 load itinerary](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L8407-L8414) — VLDA_128：dst=7、address operands=1、MemoryCycles=[5]。 固定 commit 靜態查核，非實測晶片保證。
- [向量 store itinerary](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9538-L9545) — VST_128 source read=1、MemoryCycles=[5]；不是輸出 data-ready=5。 固定 commit 靜態查核，非實測晶片保證。
- [部分字 store 讀改寫](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L7858-L7863) — ST_s8 source read=7、兩個記憶體點 [5,11]。 固定 commit 靜態查核，非實測晶片保證。
- [VMAC operand/bypass](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9024-L9064) — 整數與浮點／不同路徑不可共用一個 latency；表內 dst、acc1、s1、s2 分開。 固定 commit 靜態查核，非實測晶片保證。
- [VMUL operand/bypass](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9355-L9395) — 矩陣/向量原語的 itinerary，不是高階 mmul helper 總成本。 固定 commit 靜態查核，非實測晶片保證。
- [轉換與非線性 itineraries](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L8248-L8264) — VCONV 與 VEXP2 的同名 MV bypass 可連接；仍需合法 registers/slots。 固定 commit 靜態查核，非實測晶片保證。
- [UNPACK 與 UPS](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L10039-L10072) — UNPACK 所列 operand=7；UPS=3/1/2 混合點。 固定 commit 靜態查核，非實測晶片保證。
- [AIE signed operand latency](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L892-L1024) — RAW/WAR/WAW 差值、register-class variant、負值與一週期 bypass 假設。 固定 commit 靜態查核，非實測晶片保證。
- [轉換與 VEXP2 variant 綁定](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L6228-L6288) — VCONV 的 operand 1、VEXP2 的 operand 0 在 eWH 時改用 NoBypass。 固定 commit 靜態查核，非實測晶片保證。
- [排程類別動態選擇](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L1363-L1432) — 依實體／虛擬 register class 選 variant，不僅看 mnemonic。 固定 commit 靜態查核，非實測晶片保證。
- [鎖 stall/resume 與 memory edge](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L1082-L1165) — 2/8 是保守核心 stall/resume 模型，註明 ISA 未完整描述；非鎖等待固定耗時。 固定 commit 靜態查核，非實測晶片保證。
- [AIE2P 排程模型](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSchedule.td#L11-L32) — IssueWidth、MicroOpBufferSize 為軟體排程控制；三項 FIXME 且 CompleteModel=0。 固定 commit 靜態查核，非實測晶片保證。

## 關聯
- [isa](isa.md)
- [compute](compute.md)
- [mma](mma.md)
- [performance](performance.md)
- [compiler](compiler.md)
- [vliw-pipeline](vliw-pipeline.md)
- [software-pipelining](software-pipelining.md)

## 反向連結
- [spec-index](spec-index.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [vliw-pipeline](vliw-pipeline.md)
- [software-pipelining](software-pipelining.md)
- [events-debug](events-debug.md)
- [spec-gaps](spec-gaps.md)
