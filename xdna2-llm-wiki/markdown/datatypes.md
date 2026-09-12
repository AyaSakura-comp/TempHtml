# 數值型別：INT4、BF16、BFP16 與 FP32 的分層支援

分類：數值 · 來源查核 · 來源快照 2026-09-12

區分 packed storage、原生算術、矩陣原語與模擬路徑，說明共享指數和 rounding 對 LLM 誤差的影響。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 支援型別必須加上動詞

「支援 FP32」太含糊：可以表示能存、能轉換、能累加、能逐元素乘法或能做原生矩陣乘法。**來源事實：**本頁限定 [arch 21 AIE2P](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20)，把型別表示與實際原語分層；不將 host dtype、MLIR 型別或輸出 buffer 當成原生乘法證據。

| 層次 | 應確認的內容 | LLM 決策 |
|---|---|---|
| 儲存 | 元素或區塊布局、signedness | 權重及 KV payload |
| 算術 | 向量 MUL／MAC、conversion | 誤差與部分積成本 |
| 矩陣 | 指定形狀與 accumulator | microkernel 選擇 |
| 合成／降精度 | unpack、分解、截斷或 libcall | 真正執行的數學契約 |

來源查核只保證讀到這些實作，沒有驗證整套工具鏈可建置，也沒有量測精度或效能。

## 整數表示與 INT4 解包

[scalar typedef](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L117-L118)有 signed／unsigned `_BitInt(4)`；[packed vector 定義](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L235-L270)的 `v256int4` 使用 128-byte vector storage 表示 256 個 nibble。這是緊縮容器，不應拿 scalar 陣列的 C++ 布局直接當成 DMA stride。由位寬推得 signed nibble 值域為 −8 至 7，unsigned 為 0 至 15；解碼時必須分別做 sign extension 或 zero extension。

**來源事實：**[Peano 8b×4b wrapper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L39416-L39509)把 `4×16×16` 路徑的 B 分段 unpack 為 int8，再做兩次 `4×8×16` int8 matrix 運算。因而 W4 的儲存節省仍可能成立，算術卻不能直接稱為單一 INT4 MMA 或宣稱吞吐量自動加倍。這也不是所有 XDNA2 工具鏈都沒有其他 INT4 能力的證明。

## Signedness 與累加寬度

[i8 configuration](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L58)與[測試](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/test/Conversion/AIEVecToLLVM/matmul-aie2p.mlir#L169-L232)區分四種有號／無號組合；signless i8 在此 lowering 預設 signed，不是「讓硬體自行判斷」。非對稱量化的 zero point、scale 與整數值域必須由演算法處理，不能靠 bitcast 修正。

[accumulator 映射](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/accum_native_types.hpp#L15-L24)以 acc32／acc64 承接較小標籤；[int16 shape 實作](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_16_16.hpp#L23-L105)則顯示 `8×2×8` 使用 acc32，而 `4×4×8` 內部使用 acc64。輸入 dtype 不足以決定中間位寬。**數學推論：**兩項 `(-32768)×(-32768)` 已達 `2^31`，超出 signed acc32 正上限；最後輸出飽和不會修復已發生的中間溢位。i16 直接 MLIR 路徑另有[未執行 signedness 疑點](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4895-L4904)，不能擴大成已證實的硬體錯誤。

## BF16 不等於 BFP16

BF16 是[獨立的 `__bf16` 型別](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L235-L270)；非 BFP 的[矩陣 helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp#L207-L269)以八次 32-lane BF16 MUL／MAC 合成 `4×8×8`。啟用 [BFP macro 路徑](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp#L63-L131)後，輸入先轉共享指數格式，再使用 BFP matrix primitive；不能稱為與原 BF16 完全等價的免費加速。

[BFP 格式表](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie_doc.hpp#L229-L250)定義 EBS8 每八個 signed 8-bit mantissa 共享一個 8-bit exponent，區塊共九 bytes；六十四個值共七十二 bytes，即 576 bits。名稱 BFP16 的「16」不是每個值固定占十六 bits，也不是 per-element FP8。EBS16 每十六個 mantissa 共用 exponent，區塊十七 bytes；六十四個值的緊縮記憶體為六十八 bytes。

[register header](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L545-L578)的 EBS16 exponent 在暫存器表示中重複存放，因此其 register aggregate 不能替代緊縮記憶體的 stride。EBS16 儲存與 conversion 存在，也不保證 EBS8 的每種 [MMUL specialization](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bfp16_bfp16.hpp#L17-L104)都能直接換型別。

## FP32 輸出與不同模擬算法

[API config](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/config.hpp#L22-L24)將 FP32 emulation 與 native support 分開；[FP32 MMUL](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_fp32_fp32.hpp#L24-L44)由 emulation guard 保護。Peano 的[預設 32-lane float wrapper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L54935-L54942)走 accuracy_safe，[實作](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L53918-L53994)將每個 float 分成 BF16 部分，計算九個部分乘積與加總，另有殘差及轉換。它不是把輸入一次截成 BF16 的同一算法，也不能只憑 safe 名稱保證所有 IEEE 邊界逐位相同。

另一條 [MLIR bf16-emulation](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIEVec/Transforms/VectorToVectorConversions.cpp#L812-L943)對 binary ops 做 `truncf → bf16 op → extf`，對 `vector.fma` 甚至連 acc operand 都截為 BF16。故不能籠統說所有降精度只改 A／B、永遠保留完整 FP32 累加。scalar FP32／FP64 multiply 還可走 [libcall](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PLegalizerInfo.cpp#L214-L255)；能表示 f64 不等於原生 FP64 vector MMA。

## Rounding、飽和與 LLM 精度

[枚舉定義](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie_types.hpp#L34-L60)中 floor 是朝負無限，symmetric_floor 才朝零；舊 saturation 名稱 truncate 已廢棄，其值實際對應 saturate。整數輸出 downshift 與飽和不可照英文直覺猜測；[MMUL 契約](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie.hpp#L6295-L6530)又說浮點 `to_vector` 忽略 shift，不能把整數 SRS 規則通用化到 FP。

[BFP conversion helper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_srs.h#L1281-L1344)有 save／set／restore rounding。**工程推論：**同一共享指數區塊若混入大幅值與小幅值，小值可能失去有效資訊；轉回 FP32 也不會恢復。Attention 分數、歸約與量化 outlier 應檢查誤差分布及模型層級影響，不以單一 dtype 或單次絕對誤差門檻宣稱精度等價。

對共享指數表示，分組本身也是數學契約的一部分。相同元素若被不同 packing 放進不同區塊，可能遇到不同的大值鄰居，因而受到不同的量化影響。這是共享指數機制的工程推論，不是本次測得的誤差數字。不能只固定輸入集合卻任意重排分組，再要求輸出逐位一致；比較基準應同時固定分塊、轉置與轉換位置。

對整數量化，則要分開儲存碼值與解碼後的模型值。權重的零點不一定由整數位元零表示；尾塊若用錯補值，即使矩陣指令本身正確，歸約也可能被額外項污染。評估時應逐階段檢查打包、解包、零點修正、累加及輸出縮放，讓格式錯誤不被誤判成精度不足。

測試報告還需區分算子層與模型層。局部乘法的誤差較小，不保證跨多層歸約、正規化與非線性後仍保持相同輸出；反過來，模型答案看似相同也不證明低階算術完全正確。合理的驗收應同時保留可精確檢查的小例子、涵蓋邊界的數值案例，以及固定資料集的模型品質評估。本次不執行這些測試，因此所有建議都只是後續驗證計畫。

最後，浮點累加容器較寬，只代表中間結果的表示能力；輸入轉換已失去的資訊無法靠較寬輸出補回。選型時應先決定哪些誤差可以接受，再選擇實際支援的路徑，不以輸出型別作為品質保證。

## 不支援宣稱的邊界與閱讀檢核

[共用 header 的 arch 22 guard](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L580-L643)隔離 `_Float16`、float8、bfloat8；此範圍沒有 AIE2P 原生 FP16／FP8 MMUL 證據。BFP16 的 mantissa 也不能改稱獨立 BFP8 支援。這是查核範圍的限制，不是對所有未公開硬體的否定。

- 同時記錄 input、weight、accumulator、output 及 packed format。
- 查每個 shape 的內部位寬、signedness、macro 與 conversion。
- 將容量節省和算術加速分開報告，保留解包與量化 metadata 成本。
- 用負值、極值、長歸約及 outlier 設計後續測試，不能只用正數小矩陣。
- NaN、Inf、subnormal、signed zero、tie 與溢位邊界均未實測；本文不保證與 CPU GEMM bit-exact。

## 來源
- [AIE2P 版本標頭](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20) — arch 21 與 model 巨集；不可混用 arch 22。 僅靜態來源查核。
- [Peano：四位元 scalar typedef](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L117-L118) — signed/unsigned _BitInt(4) 表示存在；不保證 scalar 陣列即 packed vector layout。 僅靜態來源查核。
- [Peano：BF16 與 packed INT4 typedef](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L235-L270) — __bf16；v256int4 的 128-byte storage、其他 nibble 容器。 僅靜態來源查核。
- [Peano：8b×4b wrapper 展開](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L39416-L39509) — 4×16×16 先 unpack/shuffle，再兩次 4×8×16 int8 算術；不是單一 INT4 MMA 證據。 僅靜態來源查核。
- [Peano：i8 matrix builtin 與 sign bits](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L58) — 8×8×8 integer builtin、configuration 的 signX/signY；sign control 與 bit container 分開。 僅靜態來源查核。
- [MLIR FileCheck：i8 signedness 預期](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/test/Conversion/AIEVecToLLVM/matmul-aie2p.mlir#L169-L232) — 四組 configuration 與 signless 預設 signed；只讀預期、未執行測試。 僅靜態來源查核。
- [AIE API：累加型別映射](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/accum_native_types.hpp#L15-L24) — acc16/24→acc32，acc40/48/56→acc64；型別標籤不等於多種物理位寬。 僅靜態來源查核。
- [AIE API：i16 shape 與 accumulator](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_16_16.hpp#L23-L105) — 8×2×8 acc32、4×4×8 內部 acc64；較小 shape 可取較大原語子集。 僅靜態來源查核。
- [MLIR i16 decoder：未重現疑點](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4895-L4904) — 8×2×8 回傳固定 conf=24，未像 i8 合入 sign bits；靜態疑點，不是晶片 bug。 僅靜態來源查核。
- [AIE API：非 BFP BF16 helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp#L207-L269) — 4×8×8 的八次 32-lane MUL/MAC，加 broadcast/shuffle；無 cycle 保證。 僅靜態來源查核。
- [AIE API：BF16 轉 BFP16 路徑](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp#L63-L131) — macro 開啟後 transpose B、轉 accfloat/BFP16 再呼叫 BFP 原語，涉及精度變化。 僅靜態來源查核。
- [AIE API 格式表：BFP block bytes](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie_doc.hpp#L229-L250) — EBS8 八 mantissas 加共享 exponent 共九 bytes；EBS16 十七 bytes。 僅靜態來源查核。
- [Peano：BFP16 register 表示](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L545-L578) — EBS16 exponent 在 register 中重複，不等於緊縮記憶體大小。 僅靜態來源查核。
- [AIE API：BFP16 MMUL specialization](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bfp16_bfp16.hpp#L17-L104) — EBS8 8×8×8 直接 T 原語、8×8×16 兩次原語；EBS16 forwarding 不保證所有 shape 成功。 僅靜態來源查核。
- [AIE API：FP32 feature guards](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/config.hpp#L22-L24) — FP32 emulation guard 與 native support=0 分離；非所有 FP32 表示皆不支援。 僅靜態來源查核。
- [AIE API：FP32 MMUL emulation](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_fp32_fp32.hpp#L24-L44) — 4×8×4 specialization 在 FP32_EMULATION guard 內。 僅靜態來源查核。
- [Peano：float wrapper 預設選擇](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L54935-L54942) — mul_elem_32(v32float,...) 預設 accuracy_safe。 僅靜態來源查核。
- [Peano：FP32 的 BF16 部分積](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L53918-L53994) — Safe path 九個部分乘積加總，另有殘差/轉換；與單次 BF16 truncation 不同。 僅靜態來源查核。
- [MLIR：通用 bf16-emulation rewrite](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIEVec/Transforms/VectorToVectorConversions.cpp#L812-L943) — Binary ops truncf/op/extf；vector.fma 三個 operands 包括 acc 都截成 BF16。 僅靜態來源查核。
- [AIE2P legalizer：scalar FP 路徑](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PLegalizerInfo.cpp#L214-L255) — Scalar BF16 MUL 向量化後抽取；FP32/FP64 MUL 有 libcall。不能保證部署可連結。 僅靜態來源查核。
- [AIE API：rounding／saturation](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie_types.hpp#L34-L60) — Floor 與 toward-zero 不同；deprecated truncate=saturate；中間溢位與輸出飽和分開。 僅靜態來源查核。
- [AIE API：公開 MMUL 契約](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie.hpp#L6295-L6530) — M/K/N、size_A/B/C、mul 初始化、mac 累加、普通 vector row-major 及浮點 shift 忽略。 僅靜態來源查核。
- [Peano：浮點／BFP conversion](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_srs.h#L1281-L1344) — 專用 BF16 conversion，BFP conf helper save/set/restore rounding；非全 IEEE 邊界保證。 僅靜態來源查核。
- [Peano：arch 22 FP16／FP8 guard](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L580-L643) — _Float16、float8、bfloat8 在 arch 22 區塊；不可移植為 arch 21 支援。 僅靜態來源查核。

## 關聯
- [mma](mma.md)
- [isa](isa.md)
- [quantization](quantization.md)
- [validation](validation.md)
- [attention](attention.md)
- [memory](memory.md)

## 反向連結
- [isa-registers](isa-registers.md)
- [isa-instructions](isa-instructions.md)
- [isa](isa.md)
- [mma](mma.md)
- [compiler](compiler.md)
- [triton](triton.md)
- [quantization](quantization.md)
- [performance](performance.md)
- [debug](debug.md)
- [glossary](glossary.md)
- [sources](sources.md)
