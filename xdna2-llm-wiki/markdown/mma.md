# 矩陣乘加：原語、API 包裝與 LLM microtile

分類：數值 · 來源查核 · 來源快照 2026-09-12

逐路徑拆解 dense integer、BF16、BFP16 與 FP32 MMUL，固定形狀、packing 和精度後才討論工作量。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 先固定 M、K、N 與證據層級

**來源事實：**[公開 mmul template](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie.hpp#L6295-L6530)以 M×K×N 表示 A=M×K、B=K×N、C=M×N；不是 M×N×K。`mul` 用乘積初始化結果，`mac` 將乘積加入累加器；普通整數／BF16 vector 介面要求微區塊內 row-major。大矩陣的 tile 排列仍需另行 packing，不能把整個 contiguous 矩陣當作單個微區塊。

本文的「直接原語」指 header 到 builtin 及對應機器模式可追蹤；「wrapper」可能含多次原語與重排。形狀表只列已查到的代表性 dense 路徑，不是完整 ISA 目錄；所有數量都是靜態結構或數學工作量，沒有每週期保證。

## 整數矩陣形狀與累加器

| 輸入組合 | M×K×N | 已讀來源與判讀 |
|---|---|---|
| i8×i8 | 8×8×8 | [直接 builtin](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L58)，64×acc32 |
| i16×i16 | 8×2×8 | [API](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_16_16.hpp#L23-L105)用 acc32 原語 |
| i16×i16 | 4×4×8 | [API](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_16_16.hpp#L23-L105)內部 32×acc64 |
| i32×i16 | 4×2×8 | [直接 builtin](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L37603-L37651)，32×acc64 |
| i32×i32 | 4×2×8 | [高低字分解](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp#L10-L122)，多步組合 |

上述 I512 整數 builtin 的 [VMUL／VMAC selection](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L422-L427)可在後端交叉核對。

同為 i16 不能只填一個 accumulator 規格；同為 i32 也不能概括成「全部模擬」或「原生通用 i32×i32」。較小 M 的 API 有時使用較大原語再抽出子集；`grow` 補足容器寬度不表示所有 lane 都是有效工作。

## INT4：低位元儲存與實際算術

[Peano `4×16×16` wrapper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L39416-L39509)對 B 的 packed int4 分段 unpack，整理 A，再以兩個 `4×8×16` int8 運算累加；動態 sign 參數也帶入 unpack 與乘法。一次 API 呼叫因此不等於單一四位元機器矩陣指令，更沒有 dense 4b×4b 吞吐量的直接證明。

**工程推論：**W4 權重可能降低外部搬移 payload，卻新增局部解包、重排及較寬暫存狀態。比較量化 kernel 時要連同 scale／zero point、反量化位置與 buffer 需求計帳。未讀到的其他工具鏈路徑保留未知，不把這個 wrapper 推廣成所有 XDNA2 矽晶片的能力上限。

## BF16 非 BFP 路徑的八個步驟

[非 BFP helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp#L207-L269)把 `4×8×8` 拆成八次 32-lane BF16 算術：第一步 MUL 初始化，後續 MAC 累加；MAC 版本則從既有 accumulator 開始。前後還有 shuffle／broadcast，故「使用原生 BF16 算術」不等於「一條 BF16 matrix 指令」。

[macro 關閉的 specialization](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp#L134-L178)也明確有 `8×8×8`，內部分成兩份 `4×8×8` helper，共十六個 32-lane 算術步驟。這修正了只從 API 摘要表讀出「大形狀只能開 BFP」的誤解。**工程推論：**如果有效 M 很小，擴大形狀可能造成 lane 浪費；不能只比較形狀乘積便斷言較大一定更快。

## BFP16 原語與轉置契約

[BFP16 EBS8 `8×8×8`](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bfp16_bfp16.hpp#L17-L104)直接呼叫 `mul_8x8_8x8T`，[Peano header](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L38830-L38885)將 mantissa／exponent 交給 BFP576 builtin，再由[instruction pattern](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L443-L460)選到 BFP VMUL／VMAC。`8×8×16` specialization 則使用兩個 `4×8×16T` 原語加 shuffle，不是更大工作量都能塞進一次機器操作。

T 表示 B 的轉置消費慣例；直接 block_vector 路徑把 a、b 傳入 T intrinsic，不會自動套用 BF16 wrapper 的 transpose。啟用 [BF16 macro](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp#L63-L131)時，wrapper 先準備浮點累加表示、轉置 B，再轉成共享指數 BFP16。這是一條會改變數值表示的路徑，而非原 BF16 無誤差替身；詳見 [數值型別](datatypes.md)。EBS16 的 forwarding declaration 也不足以保證所有 EBS8 shape 都能實例化。

## Kernel macro、直接 lowering 與 FP32

[預建 kernel](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/aie_kernels/aie2p/mm.cc#L437-L487)用 `#ifdef` 切換 BF16 微區塊幾何，API 卻用 `#if`。因此定義 macro 為零，在兩層意義不同；應清楚固定為未定義，或定義 `AIE_API_EMULATE_BFLOAT16_MMUL_WITH_BFP16=1`，並同步固定 packing 與精度預期。

[直接 AIEVec 測試](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/test/Conversion/AIEVecToLLVM/matmul-aie2p.mlir#L10-L166)對 BF16 `4×8×8` 與 `8×8×8` 都預期 BFP conversion；[rewrite](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L5048-L5095)也可追到 BFP helper。這不是由 C++ preprocessor 控制的同一條路徑，不能只看 kernel macro 推測 MLIR 結果。這些是已閱讀的測試預期，未執行 FileCheck。

[FP32 shape](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_fp32_fp32.hpp#L24-L44)屬 emulation；[Peano 預設 wrapper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L54935-L54942)走 BF16 部分積分解，不能因 C 為 float 就稱原生 FP32-input GEMM。不同降精度策略的數學契約還可能不同，選路徑前必須先決定允許的誤差與邊界行為。

## 從微區塊推到 LLM，不能跳到峰值

**數學推論：**M×K×N 是該微區塊的乘加項數；例如上述 `8×8×8` 是 512 MAC／次原語工作，只有另外證明 issue-rate 才能換算 MAC／cycle。本次未證明該條件，不提供固定時脈或 TOPS。[排程表](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9031-L9064)亦不是整個 helper 的週期量測。

**工程推論：**沿 K 重複 `mac` 可讓 C 留在 accumulator，但較長歸約增加溢位或浮點誤差風險；沿 M／N 保留多份 C 可提高重用，卻增加寄存器壓力。prefill 與 decode 的有效形狀不同，尾塊 padding、輸入重排、DMA、輸出轉換都要放進端到端比較。稀疏模式另有壓縮契約，不能把 dense 表的工作量與 sparse 宣傳吞吐量混用。

一個可核對的設計順序，是先用單個微區塊驗證索引及數學，再加入沿歸約維度的迴圈，確認多次累加與第一次初始化沒有混淆，最後才增加外層的輸出區塊與多核心分工。每次擴大範圍都保留相同的輸入解碼規則，否則局部誤差與資料流錯誤容易混在一起。這是建議的驗證分層，本次並未編譯或執行樣例。

對效能比較，兩條路徑應交付相同有效矩陣與明確可接受的精度。若某方案預先把權重轉成共享指數，另一方案在每次呼叫內轉換，就要說明轉換成本是否可跨呼叫攤平；不能將前者的準備階段排除，卻把後者全部計入。對靜態權重可能合理的預處理策略，套到每次改變的 activation 未必同樣成立。

最後，微區塊形狀只是局部契約。大矩陣若沿輸出維度分配到不同核心，仍需要輸入的分送與結果拼接；沿歸約維度分配則還要定義部分和如何合併。不能把單核心原語次數乘上核心數，略過這些額外依賴，就宣稱完整 LLM 層已有相同利用率。

## 陷阱與閱讀檢核

- 明列 shape 次序、有效元素、A／B packing 與 C 初始化方式。
- 每個 API 都追到 wrapper／builtin；記錄 unpack、transpose、conversion 與子集抽取。
- 檢查實際 accumulator 與 signedness；[i16 decoder](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4895-L4904)的固定 conf 疑點僅靜態發現、未重現，不是晶片 bug 結論。
- 將 kernel macro 與直接 lowering 分開，不能用同一 dtype 名稱替代兩條數值路徑。
- 比較數值誤差、容量與搬移後才討論效能；最終組語、pipeline II、spill、硬體耗時與模型精度均待驗證。

閱讀 [GEMM](gemm.md) 時可把本頁當作局部運算契約，而不是完整大矩陣 kernel。多核切分、緩衝所有權與主機端資料準備，仍需其他層共同成立。

## 來源
- [AIE API：公開 MMUL 契約](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie.hpp#L6295-L6530) — M/K/N、size_A/B/C、mul 初始化、mac 累加、普通 vector row-major 及浮點 shift 忽略。 僅靜態來源查核。
- [Peano：i8 matrix builtin 與 sign bits](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L58) — 8×8×8 integer builtin、configuration 的 signX/signY；sign control 與 bit container 分開。 僅靜態來源查核。
- [AIE API：i16 shape 與 accumulator](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_16_16.hpp#L23-L105) — 8×2×8 acc32、4×4×8 內部 acc64；較小 shape 可取較大原語子集。 僅靜態來源查核。
- [Peano：i32×i16 直接原語](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L37603-L37651) — 4×2×8→32×acc64，直接 I512_I512_ACC2048 builtin。 僅靜態來源查核。
- [AIE API：寬整數部分積合成](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp#L10-L122) — 32×32、較大 K 的 32×16、16×32 代表 helper 以高低字、shift 與多次原語合成。 僅靜態來源查核。
- [Peano：8b×4b wrapper 展開](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L39416-L39509) — 4×16×16 先 unpack/shuffle，再兩次 4×8×16 int8 算術；不是單一 INT4 MMA 證據。 僅靜態來源查核。
- [AIE API：非 BFP BF16 helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp#L207-L269) — 4×8×8 的八次 32-lane MUL/MAC，加 broadcast/shuffle；無 cycle 保證。 僅靜態來源查核。
- [AIE API：非 BFP 大形狀](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp#L134-L178) — macro=0 仍有 8×8×8，分兩份 4×8×8 helper。 僅靜態來源查核。
- [AIE API：BFP16 MMUL specialization](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bfp16_bfp16.hpp#L17-L104) — EBS8 8×8×8 直接 T 原語、8×8×16 兩次原語；EBS16 forwarding 不保證所有 shape 成功。 僅靜態來源查核。
- [Peano：BFP16 matrix builtin](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L38830-L38885) — 8×8×8T 傳遞 mantissa/exponent 至 BFP576 builtin，回傳 accfloat。 僅靜態來源查核。
- [AIE2P patterns：BFP VMUL／VMAC](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L443-L460) — BFP576 intrinsic 到機器 pattern；不是 helper 或 kernel 耗時。 僅靜態來源查核。
- [AIE API：BF16 轉 BFP16 路徑](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp#L63-L131) — macro 開啟後 transpose B、轉 accfloat/BFP16 再呼叫 BFP 原語，涉及精度變化。 僅靜態來源查核。
- [MLIR-AIE kernel：BF16 macro 幾何](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/aie_kernels/aie2p/mm.cc#L437-L487) — Kernel 使用 #ifdef、API 使用 #if，定義為零不等同未定義。 僅靜態來源查核。
- [MLIR FileCheck：BF16 matmul 預期](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/test/Conversion/AIEVecToLLVM/matmul-aie2p.mlir#L10-L166) — 4×8×8／8×8×8 預期 BFP conversion；其他形狀預期多次 BF16 MAC。未執行。 僅靜態來源查核。
- [MLIR AIEVec rewrite：BFP helper](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L5048-L5095) — 直接 BF16 lowering 的轉換、B 轉置及 BFP helper，與 C++ macro 路徑分開。 僅靜態來源查核。
- [AIE API：FP32 MMUL emulation](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_fp32_fp32.hpp#L24-L44) — 4×8×4 specialization 在 FP32_EMULATION guard 內。 僅靜態來源查核。
- [Peano：float wrapper 預設選擇](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L54935-L54942) — mul_elem_32(v32float,...) 預設 accuracy_safe。 僅靜態來源查核。
- [AIE2P itinerary：VMAC operand timing](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9031-L9064) — 來源／目的 operand timing 與 bypass 是 scheduler 模型；不可讀成 mmul 固定耗時或 issue-rate。 僅靜態來源查核。
- [MLIR i16 decoder：未重現疑點](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4895-L4904) — 8×2×8 回傳固定 conf=24，未像 i8 合入 sign bits；靜態疑點，不是晶片 bug。 僅靜態來源查核。
- [AIE2P patterns：I512 integer VMUL／VMAC](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L422-L427) — 整數 matrix intrinsic 對應機器 selection，與 i8 及 i32×i16 header 對照；不證明每週期吞吐量。僅靜態來源查核。

## 關聯
- [compute](compute.md)
- [isa](isa.md)
- [datatypes](datatypes.md)
- [gemm](gemm.md)
- [quantization](quantization.md)
- [performance](performance.md)

## 反向連結
- [system](system.md)
- [compute](compute.md)
- [vliw-pipeline](vliw-pipeline.md)
- [instruction-cycles](instruction-cycles.md)
- [software-pipelining](software-pipelining.md)
- [isa-instructions](isa-instructions.md)
- [isa](isa.md)
- [datatypes](datatypes.md)
- [gemm](gemm.md)
- [quantization](quantization.md)
- [performance](performance.md)
