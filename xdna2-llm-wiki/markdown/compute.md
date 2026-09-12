# 計算核心：scalar、SIMD、VLIW 與累加器

分類：架構 · 來源查核 · 來源快照 2026-09-12

把核心控制、向量平行與靜態指令排程分開，建立不依賴猜測峰值的 LLM microkernel 成本觀。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 核心不是縮小版通用 CPU

**來源事實：**[Peano README](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L1-L66)將 AI Engine 描述為 in-order、exposed-pipeline VLIW。編譯器必須安排暫存器讀寫與功能單元的使用關係，不能預期通用亂序 CPU 式的動態排程替 kernel 自動消除所有相依性。README 的示範組語只解釋外露管線概念，並不是本頁可轉用的 AIE2P 指令延遲表。

對 LLM，核心主要處理已切好的局部 tensor。它不是從一個主機指標自動找到整個模型，也不會單憑 C++ 迴圈就保證產生最佳矩陣指令。資料到齊、格式正確、累加狀態與程式大小合適，才有談向量運算的基礎。

## 三種平行概念不要互換

| 概念 | 作用 | LLM 中的工程用途 |
|---|---|---|
| Scalar | 單值控制、索引與一般核心運算 | 管理 K 迴圈、地址及條件 |
| SIMD | 對多個 lane 做向量運算 | 平行處理元素、部分積與轉換 |
| VLIW | 將可同時發射的不同操作組成 bundle | 嘗試重疊載入、運算及地址更新 |

[scalar register class](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L109-L132)明確存在於 AIE2P 後端，向量及 BF16 原語則有獨立的[instruction patterns](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L295-L307)。表中的用途是工程解讀，不代表 scalar 和 vector 各有一條可獨立執行任意程式的執行緒。SIMD 的 lane 數也不是 VLIW slot 數；slot 可用不代表資料相依性允許填滿。

## 向量寬度與容器的正確讀法

[架構參考](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/skills/aie-code-creator/references/architecture.md#L39-L142)以常見的 512-bit 向量說明自然 lane 數；據型別位寬換算，i8 是 64 個、i16／BF16 是 32 個、i32／float 是 16 個 lane。這是容器容量的算術，不是每次矩陣運算的 M、K、N，也不是每週期產出數。API 可接受更大或更小的容器，後端可能用子暫存器、組合或抽取來實現。

[BF16 寬向量 pattern](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L295-L307)還明確使用 `VEC1024` 與 `ACC2048`；不能用「所有向量都只有自然寬度」否定它。反過來，型別可放進較大的容器，也不代表任意同寬操作都可原生完成。載入對齊應依 [AIE2P alignment helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/ld_st.hpp#L33-L40)判斷，不能把向量 bit 數當成實體 load/store 匯流排寬度。

## 累加器不是輸出陣列

[累加器型別映射](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/accum_native_types.hpp#L15-L24)把 acc16／acc24 提升到 acc32，把 acc40／acc48／acc56 映射到 acc64；這些標籤不是多種獨立實體位寬。[storage specialization](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/accum_native_types.hpp#L167-L172)也顯示浮點 accumulator 使用每 lane 32 bits 的儲存分類。`ACC2048` 表示整組累加器的位元量，不是一個超大精度純量。

**工程推論：**在 GEMM 中保留多個 C 區塊，可能增加 A／B 重用並鬆開相依鏈，但也延長暫存器生命週期。需要的狀態越多，不保證越快；溢出暫存器配置時可能出現 spill，轉而侵占資料記憶體及搬移資源。輸出轉成較窄的量化型別，只改變最後儲存表示，不會倒過來把中間累加變成窄位元計算。

## 一次矩陣 API 內有多少工作

**來源事實：**[非 BFP 的 BF16 helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp#L207-L269)將 `4×8×8` 乘法展開為八個 32-lane 算術步驟，外加 shuffle 與 broadcast。這證明原生 BF16 向量算術可合成矩陣工作，但不能把一次 helper 呼叫稱為單一矩陣指令。[INT4 wrapper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L39416-L39509)也先 unpack 再呼叫整數原語，說明名稱中的低位寬不等於所有中間步驟皆維持該位寬。

**工程推論：**成本應至少分成輸入載入、layout 整理、算術、累加狀態管理與輸出轉換。prefill 的較大區塊可能攤平前後處理；decode 的小工作則可能讓非算術成本突出。這是分析框架，不提供兩者的固定比例，也不能據此跳過量測。

## 排程、停頓與程式容量

[排程 itinerary](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9031-L9064)記錄 operand timing 與 bypass；它服務編譯器排程，不足以推出一個 C++ `mmul` 的固定耗時。README 所說 pipeline 不做一般相依性 stall，也不能延伸為整個系統永遠不停頓：鎖與串流等待是另一層的協調條件，見 [同步](synchronization.md)。

核心也有有限的[程式與資料記憶體](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L790)。過度展開迴圈會增加程式碼與暫存器壓力；把更多線性層、轉換及活化融合到同一核心，可能在減少中間搬移前先碰到連結限制。資料配置不應只算 A、B、C，還要算 stack 及核心靜態區段；詳見 [記憶體](memory.md)。

分析局部線性層時，可先沿一個輸出區塊追蹤生命週期：第一次乘積建立 C，後續歸約反覆更新它，最後才轉成輸出格式。接著標出各次更新前所需的輸入與重排。如果下一次更新只能等待同一份結果，增加載入距離與增加獨立累加工作是不同策略，不能用相同的「平行化」字樣掩蓋。

也應分開有效計算與容器內的額外操作。尾端不足一個完整區塊時，即使以補值維持可接受的形狀，補入部分仍不屬於模型真正需要的輸出。比較兩個 kernel 時，分母應固定為相同有效工作與相同精度，並把補值、抽取和寫回成本保留；否則較大的容器可能只是讓靜態算術數變漂亮，未提升使用者得到的結果。

## 陷阱與閱讀檢核

- 先確定 scalar／vector 操作的實際 lowering，不能由 host dtype 推定原生算術。
- 將 microtile shape、有效 lane 與完整容器大小分別記錄。
- 對每種形狀讀 accumulator 實作，不單看 `accauto` 名稱。
- 追蹤 shuffle、轉換與 spill 的可能成本，再討論算術工作量。
- 把程式展開、buffer 深度與分區配置一起檢查，避免各自最佳化卻互相擠壓。

本頁未執行編譯或 NPU，因此管線啟動間隔、bank conflict 發生率、動態利用率及每週期乘加能力仍未知。後續若取得組語，也只先提升「實際編譯輸出」證據，不能直接改標為晶片 benchmark。

## 來源
- [Peano README：架構與後端](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L1-L66) — XDNA2 target triple、in-order exposed-pipeline VLIW、編譯器責任及成熟度限制。示例 timing 非本次硬體規格。 僅靜態來源查核。
- [AIE2P 後端：scalar register class](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L109-L132) — 一般暫存器類別存在；不等於獨立 scalar 執行緒或 FP32 原生乘法。 僅靜態來源查核。
- [AIE2P patterns：寬向量 BF16](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L295-L307) — VEC1024／ACC2048 的 BF16 VMUL/VMAC selection，容器位寬不等於矩陣工作量。 僅靜態來源查核。
- [架構速查表：交叉查核對象](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/skills/aie-code-creator/references/architecture.md#L39-L142) — 用於導航與自然向量寬度；固定 clocks、latencies、BF16 MAC/cycle、路由絕對規則及 FIFO 深度不採作保證。 僅靜態來源查核。
- [AIE API：AIE2P load/store 對齊](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/ld_st.hpp#L33-L40) — 不同向量寬度的對齊 helper；full-width 64-byte alignment 不等於匯流排寬度。 僅靜態來源查核。
- [AIE API：累加型別映射](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/accum_native_types.hpp#L15-L24) — acc16/24→acc32，acc40/48/56→acc64；型別標籤不等於多種物理位寬。 僅靜態來源查核。
- [AIE API：浮點累加儲存](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/accum_native_types.hpp#L167-L172) — FP accumulator 的每 lane 32-bit storage specialization 與較大組合表示。 僅靜態來源查核。
- [AIE API：非 BFP BF16 helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp#L207-L269) — 4×8×8 的八次 32-lane MUL/MAC，加 broadcast/shuffle；無 cycle 保證。 僅靜態來源查核。
- [Peano：8b×4b wrapper 展開](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L39416-L39509) — 4×16×16 先 unpack/shuffle，再兩次 4×8×16 int8 算術；不是單一 INT4 MMA 證據。 僅靜態來源查核。
- [AIE2P itinerary：VMAC operand timing](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9031-L9064) — 來源／目的 operand timing 與 bypass 是 scheduler 模型；不可讀成 mmul 固定耗時或 issue-rate。 僅靜態來源查核。
- [AIETargetModel：核心容量與地址](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L790) — 64 KiB data、16 KiB program、地址視窗、256-bit load/store bus 及 cascade 模型；非存取延遲量測。 僅靜態來源查核。

## 關聯
- [system](system.md)
- [isa](isa.md)
- [memory](memory.md)
- [mma](mma.md)
- [performance](performance.md)

## 反向連結
- [system](system.md)
- [memory](memory.md)
- [synchronization](synchronization.md)
- [isa](isa.md)
- [mma](mma.md)
