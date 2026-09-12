# 軟體管線化：II、recurrence、resource 與迴圈總成本

分類：程式設計 · 來源查核／模型推導 · 來源快照 2026-09-12

以 pinned AIE2P post-RA pipeliner 理解 RecMII、ResMII、非單調 self-conflict、prologue/epilogue 與多累加器的條件式數值推導。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 從一條指令的延遲轉向多次迭代的重疊

軟體管線化把不同 iteration 的操作排進同一穩態時段；**II（initiation interval）是相鄰邏輯迭代啟動的距離，不是每條指令的 latency**。[架構與 target 對應](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L16-L65)所述外露管線與[AIE signed operand latency](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L892-L1024)的 signed operand 邊，使單純依程式文字順序逐條相加尤其不可靠。只有先建立資料／反相依／輸出相依、memory ordering 與 slot/resource 限制，才能討論重疊。

本頁查核的是 `aie2p`，固定 commit `386ca5c6634a84bb224b7248e79df8edabf0722f`；使用共用 AIEPostPipeliner 在此 target 可見的規則，不把它說成所有編譯流程必然啟用或達成最佳 II。本次不編譯、不跑 NPU。讀者可用[完整 scheduling-model.json](../spec-data/scheduling-model.json)核對 4,013 筆 itinerary（620 筆 memory、3 筆手寫變體包含在內），再到 [compiler](compiler.md) 核對實際 lowering；排程類別數不等於指令總數。

## RecMII：一圈資料必須走完多少相依距離

一般 modulo scheduling 的依賴式是 `t(v)−t(u) ≥ latency(u,v)−distance(u,v)×II`。沿一個閉環相加，得到 `II ≥ ceil(Σlatency / Σdistance)`，這是**數學推導**；distance 是迭代距離，不是 tile 距離。[post-RA recurrence 下界](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEPostPipeliner.cpp#L466-L503)的此版 post-RA 實作把前後兩次 iteration 展開，找回邊與祖先路徑，將 signed latency 加入 circuit 長度，取最大 RecMII。不要聲稱原始碼在此函式實作任意多距離公式；公式是通用理解，兩次展開才是此處可查核做法。

[VMAC operand/bypass](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9024-L9064)的 integer `VMAC_vmul_cm_core_X_QX` 提供一個可算的例子：dst write=6、acc1 read=4、兩端 VEC_Bypass。依[AIE signed operand latency](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L892-L1024)的一週期匹配 bypass，`6−4+1−1=2`。若每次迭代只更新同一 accumulator、資料型別與 operand 選擇確實合法，單條 loop-carried edge 的 RecMII 下界為 2；不是 write point 6 就令 II≥6。

| 明確假設的迴圈 | recurrence 推導 | 尚未證明 |
|---|---|---|
| 每迭代一個相依 integer VMAC，同 accumulator | latency=2，distance=1，因此 II≥2 | load、slot、memory 也可行 |
| 同型工作輪流使用兩個獨立 accumulator，以每次更新作邏輯迭代 | 同一 accumulator 每兩次才更新，2/2，因此 II≥1 | register 足夠且拆分符合數值語義 |
| 實體程式展開兩次為一個 super-iteration | 有兩個 vec 操作，vec slot 的 II 下界至少 2／super-iteration | 不等於每個 super-iteration 一 cycle |

最後兩列不矛盾：分母不同。兩次原始工作每 2 cycle 相當於一份每 1 cycle，但不表示兩個 vec operation 可以塞同一個 vec_slot。浮點歸約重排還可能改變捨入結果；多 accumulator 是有條件的工程策略，不是任意精度下完全等價的免費最佳化。

## ResMII：資源容量、格式與非單調自我衝突

一般資源下界可寫 `ceil(每迭代需求 / 每 cycle 可供容量)`，但必須說清需求是 issue slot、跨週期 FU 還是 memory point。[post-RA ResMII](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEPostPipeliner.cpp#L232-L251)在此版本先加總 primary slot counts、取最大值，再與每條指令的 computeInstrSelfMII 合併；它刻意不以 conflict sets 作初始 slot 計數，以免 multi-slot 指令重複計算。這是一個後端啟發式門檻，不是完整最優排程求解器。

**容量例：**若一迭代有 3 個固定 vec_slot 操作，而每 bundle 只能占一次 vec_slot，則至少需要 3 個發射 cycle，故此項 II≥3；若另有 2 個可各占 Lda、Ldb 的獨立 loads，不可武斷再加 2。它們可能重疊，卻仍受 memory points、bank 和 format 限制。[全部 composite def 列表](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L1141-L1216)的六 slot 128-bit 格式只容納一個 Vec；[分層 scoreboard 檢查](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L575-L626)在真正排程時還逐 cycle 查 memory／FU。

更微妙的是[自我衝突與 horizon](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L714-L778)明說 **self-conflict 不單調**。用來源示例中的同資源 offset `{0,3,7}` 做 modulo：

| 候選 II | offsets mod II | 同資源自撞？ |
|---:|---|---|
| 3 | 0,0,1 | 是 |
| 5 | 0,3,2 | 否 |
| 7 | 0,3,0 | 是 |
| 8 | 0,3,7 | 否 |

因此此函式不是回傳「第一個可行 II=5」，而掃至 PipelineDepth，記住**最後會自撞的 II 再加 1**；在這個單資源示意下是 8。這個保守策略可能跳過較小可行間隔，所以不應把返回值當數學上精確最小 II。表格為 modulo 算術例，不宣稱存在某條 AIE2P 指令剛好使用這三個 offset。

## 三張時間表：load-use、穩態 II、整個迴圈

[scalar load 與 register variant](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4608-L4623)的 scalar LDA dst=7、address read=1、MemoryCycles=[5]；接無 bypass、read=1 的合法 consumer，RAW edge 為 `7−1+1=7`。**這是 load-use 間距**；若操作能流水化且沒有新的循環相依，仍可以在前一個 load 結果未用到前先發射另一迭代的 load。反過來，MemoryCycles=[5] 不等於 II=5，亦不代表資料寫回=5。

以下是**理想化排程推導，非編譯輸出**：假設每個 iteration 在 `2i` 發射一個 load，獨立 scalar consumer 在 `2i+7` 發射；兩者 slot 合法且沒有其他資源、register 或 memory 衝突。

| 迭代 i | load 發射 | consumer 發射 | 同一 iteration 間距 |
|---:|---:|---:|---:|
| 0 | 0 | 7 | 7 |
| 1 | 2 | 9 | 7 |
| 2 | 4 | 11 | 7 |
| 3 | 6 | 13 | 7 |

load-use latency 是 7，**穩態 II 是 2**。若 consumer 視為占一個可觀察時間單位、尾端在發射後 1 完成，N=4 的最後完成點是 `2×(4−1)+7+1=14`；平均 14/4=3.5 cycle/iteration，而非 2。這個 1 是例題假設，不是任何未指定 consumer 的硬體時序保證。

一般同樣假設下可寫 `T≈D+(N−1)×II`，D 是第一份工作從開始到尾端的排程跨度，必須含相應尾端定義；branch/control、等待、資料搬移仍另計。[prologue/kernel/epilogue 擷取](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEPostPipeliner.cpp#L1709-L1756)實際分出 prologue、kernel、epilogue 並調整 trip count，正是不能只拿穩態 II 乘 N 就當完整 loop 時間的原因。

## register 壓力、trip count 與程式碼大小的代價

為了提前 load 並保存尚未消費的值，須延長 live range。上例以使用前距離 7、II=2 粗估，`ceil(7/2)=4` 份跨迭代值可能同時在途；這是保守的生命週期規劃例，實際 register reuse 仍須依讀寫點、同 cycle 規則與配置結果，不能硬說一定分配四個實體 register。增加 accumulator 也會增加狀態；spill 會把問題轉成更多 load/store 與 memory 資源需求。

[stage/trip count 與 peel](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEPostPipeliner.cpp#L1602-L1686)要求 `MinTripCount−(NStages−1)>0`，不夠時可嘗試 side-effect-free peeling，而非任意短迴圈都能攤平多 stage 開銷。此處 **NStages 是軟體排程的 iteration overlap stage 數**，不等於 silicon 的物理管線級數。[recurrence 與排程啟發式限制](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEPostPipeliner.cpp#L541-L566)也指出當前結構不易直接以 RecMII 當搜尋起始 II，且部分調整沒有完整考慮負 latency；不能拿理論下界保證此編譯器會達成。

[AIE2P 排程模型](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSchedule.td#L11-L32)的 MicroOpBufferSize=1000 是讓排程器接受這類操作安排的控制值，不是保證硬體替我們儲存一千份值。展開還增加 prologue/epilogue 和 text 大小；對 LLM decode 的短工作，啟動與搬移可能壓過穩態收益。要比較 kernel，須固定有效工作量、精度／歸約順序與尾端處理，而非只比較生成組語有多少個 vec mnemonic。

## 不能以 II 模型消去的 memory、lock 與 stream 等待

[部分字 store 讀改寫](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L7858-L7863)的 ST_s8 有 MemoryCycles=[5,11] 兩次接觸，source read 在 7，[資源階段 helper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L12-L31)又以 7-cycle PART_WORD_STORE 強預約保護其他 memory ops。若只保留第一個點，就既低估讀改寫的排序跨度，也丟失後續 store 對 lock 的約束。[鎖 stall/resume 與 memory edge](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L1082-L1165)另針對 acquire/release 的 stall/resume、load-only writeback、TM 例外與 stream move 非 memory 的情況處理；不是拿一個通用 load latency 全包。

鎖的等待條件可能由另一個 worker 或 DMA 生命週期決定，stream 背壓取決於接收側是否準備好。這些系統等待不同於外露 pipeline 的依賴合法性：排程器證明「資料會在讀點前依模型產生」，不等於證明輸入永遠到齊。[分層 scoreboard 檢查](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L575-L626)的靜態 bank/object 檢查亦不能提供實測 stall 機率、外部 memory latency 或跨 tile hop 數。

建議 handoff 同時留下：實際 target、lowered opcodes 與 register class；RAW/WAR/WAW／memory 邊；理論 RecMII 與 slot/resource 門檻；選中的 II、候選拒絕原因、prologue/epilogue；暫存器與 spill；最後才是執行量測。本頁只交付前述公開模型、可重現擷取與明列假設的數字推導。所有實際 II、時脈、耗電、有效吞吐與 undocumented 內部級名仍未知，請與 [performance](performance.md)、[MMA](mma.md) 和 [VLIW](vliw-pipeline.md) 一起閱讀。

## 來源
- [架構與 target 對應](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L16-L65) — README 的示意 load cycle 8 不是 AIE2P 實測表。 固定 commit 靜態查核，非實測晶片保證。
- [AIE signed operand latency](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L892-L1024) — RAW/WAR/WAW 差值、register-class variant、負值與一週期 bypass 假設。 固定 commit 靜態查核，非實測晶片保證。
- [post-RA recurrence 下界](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEPostPipeliner.cpp#L466-L503) — 兩次迭代展開、回邊與 signed latency 迴路長度。 固定 commit 靜態查核，非實測晶片保證。
- [VMAC operand/bypass](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9024-L9064) — 整數與浮點／不同路徑不可共用一個 latency；表內 dst、acc1、s1、s2 分開。 固定 commit 靜態查核，非實測晶片保證。
- [post-RA ResMII](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEPostPipeliner.cpp#L232-L251) — primary slot counts 最大值與 computeInstrSelfMII 合併。 固定 commit 靜態查核，非實測晶片保證。
- [全部 composite def 列表](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L1141-L1216) — 76 筆 generated def；128-bit 六 slot 與 long 五 slot 形式。 固定 commit 靜態查核，非實測晶片保證。
- [分層 scoreboard 檢查](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L575-L626) — issue cycle 檢查格式；MemoryAccessCycles 減 1；各 stage 另查資源。 固定 commit 靜態查核，非實測晶片保證。
- [自我衝突與 horizon](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEHazardRecognizer.cpp#L714-L778) — SelfMII 是最後衝突 II 加一的保守門檻；PipelineDepth 是軟體 horizon。 固定 commit 靜態查核，非實測晶片保證。
- [scalar load 與 register variant](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L4608-L4623) — dst=7、記憶體點 5；部分 variant 省去晚期 FU 但不改 dst 時點。 固定 commit 靜態查核，非實測晶片保證。
- [prologue/kernel/epilogue 擷取](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEPostPipeliner.cpp#L1709-L1756) — steady-state 之外仍有填入、排空與 trip count 調整。 固定 commit 靜態查核，非實測晶片保證。
- [stage/trip count 與 peel](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEPostPipeliner.cpp#L1602-L1686) — trip count 必須足以覆蓋軟體 stage；不是微架構級數。 固定 commit 靜態查核，非實測晶片保證。
- [recurrence 與排程啟發式限制](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEPostPipeliner.cpp#L541-L566) — RecMII 早期拒絕與負 latency 處理限制。 固定 commit 靜態查核，非實測晶片保證。
- [AIE2P 排程模型](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSchedule.td#L11-L32) — IssueWidth、MicroOpBufferSize 為軟體排程控制；三項 FIXME 且 CompleteModel=0。 固定 commit 靜態查核，非實測晶片保證。
- [部分字 store 讀改寫](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L7858-L7863) — ST_s8 source read=7、兩個記憶體點 [5,11]。 固定 commit 靜態查核，非實測晶片保證。
- [資源階段 helper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L12-L31) — Empty/Prefix/Simple 與 part-word Required/Reserved 的確切定義。 固定 commit 靜態查核，非實測晶片保證。
- [鎖 stall/resume 與 memory edge](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.cpp#L1082-L1165) — 2/8 是保守核心 stall/resume 模型，註明 ISA 未完整描述；非鎖等待固定耗時。 固定 commit 靜態查核，非實測晶片保證。

## 關聯
- [isa](isa.md)
- [compute](compute.md)
- [mma](mma.md)
- [performance](performance.md)
- [compiler](compiler.md)
- [instruction-cycles](instruction-cycles.md)
- [vliw-pipeline](vliw-pipeline.md)

## 反向連結
- [spec-index](spec-index.md)
- [vliw-pipeline](vliw-pipeline.md)
- [instruction-cycles](instruction-cycles.md)
