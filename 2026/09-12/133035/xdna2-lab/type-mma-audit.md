# XDNA2 / AIE2P 數值型別與矩陣乘法獨立稽核

## 範圍、版本與證據強度

- 稽核日期：2026-09-12（以主機時間確認）。工作目錄：`/home/chihmin/xdna2-lab`。
- **僅靜態閱讀原始碼、headers、FileCheck 測試與文件；未編譯範例、未執行測試、未跑 NPU、未 benchmark。** 文中的指令數是展開／選擇模式的靜態證據，不是動態量測。
- 未修改網站、既有 source snapshots 或服務；另依授權 shallow clone `sources/aie_api`。讀取時五個 source 工作樹均乾淨。
- 「原生」須分成 **型別／儲存表示、原生算術 primitive、原生 matrix primitive、API 合成、compiler 降精度／libcall**。存在 `float` buffer、`accfloat`、`mmul` specialization 或名為 `INTRINSIC` 的 inline wrapper，均不足以單獨證明原生 FP32／單指令 MMA。
- 所有原始碼連結均鎖定 SHA，不引用可變的 `main`。各 repository 是獨立 snapshot，**未驗證這五個版本可組成一套可建置的工具鏈**；尤其 AIE API 與 Peano 的實作／文件可能不同步。

| 本地 snapshot | repository | git SHA |
|---|---|---|
| `sources/mlir-aie` | Xilinx/mlir-aie | `0ed8e7e477fd9094acee8dada7ab81604a7fb07a` |
| `sources/llvm-aie` | Xilinx/llvm-aie | `386ca5c6634a84bb224b7248e79df8edabf0722f` |
| `sources/mlir-air` | Xilinx/mlir-air | `ff95a9b35b692b4cfbdf1d52bf69e6ffe01facde` |
| `sources/Triton-XDNA` | amd/Triton-XDNA | `5c33df1263f29de30f71616780c2e8a88e623782` |
| `sources/aie_api` | Xilinx/aie_api | `bec000fd312b407c61f25ef86fd582042e42d28a` |

## 1. 網站應採用的核心結論

1. **XDNA2 = 本次檢查的 AIE2P / arch 21；不要混入 AIE2PS / arch 22（AIE-MLv2）的 FP16、FP8、MX 型別。** Peano 的 AIE2P version header 宣告 `__AIE_ARCH__=21`、`__AIE_MODEL_VERSION__=11500`。[E01、E10]
2. **BF16 原生乘法不等於原生 BF16 矩陣指令。** 未啟用 BFP macro 的 `mmul<4,8,8,bfloat16,...>` 在此 API 內是 8 次 32-lane BF16 MUL/MAC 加 shuffle/broadcast；`8×8×8` 未開 macro 時也有 specialization，但分成兩份 `4×8×8`。[E06]
3. **BFP16 `8×8×8` 有直接 matrix primitive**，`mul_8x8_8x8T` → BFP576 builtin → `VMUL ... bfp`。BF16 macro 路徑先轉換成共享指數 BFP16，不能稱為「與 BF16 數學／精度完全等價、免費倍速」。[E07、E08]
4. **int4 可表示／打包、有 8b×4b API，但此 Peano header 的 `4×16×16` wrapper 先 unpack 成 int8，再做兩次 int8 matrix 運算。** 不能把 API 模式表直接當作這份工具鏈的原生 int4 指令／1024 MAC 每週期證明，也不能據此斷言所有 XDNA2 工具鏈／矽晶片皆沒有其他 int4 能力。[E03]
5. **FP32 accumulator／output 是實際存在的；通用 FP32 乘法則不是同一回事。** AIE API 提供 BF16 分解式 FP32 emulation；MLIR/AIR/Triton 的 `bf16-emulation` 是另一種、可能更強烈的降精度路徑。[E09、E14]
6. **64 KiB L1 與 512 KiB mem-tile memory 符合 AIETargetModel；「L1 1 cycle」「BF16 256 MAC/cycle」「固定 1.5 GHz」不由這個 model 證明。** 512-bit 向量對齊也不等於 512-bit load/store bus。[E15]

## 2. 型別：支援的是哪一層？

| 型別／組合 | 本次可確認的能力 | 不可延伸成的宣稱 |
|---|---|---|
| signed/unsigned int8 | 原生 matrix primitive；S×S、S×U、U×S、U×U 均有 overload／sign 控制；典型 `acc32` | `uint8` 與 `int8` bit pattern 相同不代表乘法值相同；output i8 不是 i8 accumulator |
| signed/unsigned int16 | 原生 16×16 與 16×8 matrix 模式；16×16 有 `acc32` 與 `acc64` 幾何；8×16 在 API 會先拓寬 A | 不可把 8×16 與 16×8 視為相同原生指令／吞吐量 |
| signed/unsigned int32 | 真有原生 **32×16、4×2×8 → acc64**；32×16 的較大 K 模式、16×32、32×32 常需分解／重組 | 「所有 int32 都不原生」與「原生 int32×int32 MMA」都過度概括 |
| signed/unsigned int4 | `int4_t = signed _BitInt(4)`、`uint4_t = unsigned _BitInt(4)`；packed vector；8×4 API 四種 signedness | 本 Peano `4×16×16` 是 unpack + 兩個 int8 primitives；無本次證據支持獨立 dense 4×4 MMA |
| BF16 / `bfloat16` | `__bf16`；原生 BF16 向量乘加、32-bit `accfloat`；矩陣形狀可由這些原語合成 | 不等於 IEEE binary16；也不等於單指令 `4×8×8` BF16 MMA |
| FP32 / `float` | 儲存、轉換、`accfloat`／浮點加減能力存在；AIE API FP32 MUL/MMUL 是 BF16 分解式 emulation；scalar MUL 可走 libcall | `float` output 不證明 FP32-input native MUL/FMA；`accuracy_safe` 名稱不證明 IEEE 全邊界／逐位相同 |
| FP16 / IEEE binary16 | 本 AIE2P API 未提供該 MMUL；共用 header 的 `_Float16`／`float16` 區塊受 arch 22 guard 保護 | 不能從其他架構 header、MLIR `f16` 或 host dtype 推論 AIE2P 原生 FP16 |
| BFP16 | arch 21 block format，已核對 `bfp16ebs8` 的原生 matrix MUL/MAC；`bfp16ebs16` 有儲存／轉換 | 名稱的 16 不是每個值固定占 16 bits；EBS16 型別存在不代表該 API 的每個 EBS8 mmul shape 都有 EBS16 specialization |
| BFP8 | 未找到 AIE2P 的獨立 block-vector / MMUL 型別或 target block-format 登錄 | 不應以 BFP16 的 8-bit mantissa 冒充「BFP8」；共用 header 有一處 `bfp8` 註解其實指 arch 22 的 **brain floating point / bfloat8** |
| FP8（E4M3/E5M2 等） | 本 AIE2P header／API 沒有相應原生 MMUL；Triton backend 明確 `supported_fp8_dtypes=()` | 不可把 BFP16 共享指數當成 per-element FP8；不可搬用 arch 22 的 float8/bfloat8 |
| f64 / `double` | Peano legalizer 對 scalar 64-bit FP MUL、ADD/SUB、DIV/REM 有 libcall 路徑 | 未見 AIE2P native FP64 vector/MMUL；IR/host 接受 f64 不保證 NPU vectorization 或 runtime libcall 可成功連結 |

### Signedness 與 accumulator 的額外陷阱

- AIE2P i8 matmul 的 config：S×S `776`、U×S `264`、S×U `520`、U×U `8`；signX 在 bit 9、signY 在 bit 8。MLIR signless i8 在這個 lowering **預設 signed**，並非「自動適用 unsigned」。[E02]
- **發現 compiler signedness 風險，尚未動態重現**：同一個 `aievec.matmul_aie2p` decoder 的 **i16 8×2×8 分支回傳固定 conf=24**，沒有像 i8 分支合入已解析的 signX/signY；其 rewrite 直接沿用此 conf。依 Peano config 定義，24 的 sign bits 均為0，而 S×S 應為 `24|512|256=792`。因此不能從原生／C++ API 的 signed int16 支援，宣稱這條 MLIR 直接路徑已正確支援 signed int16。建議另補含負數的 regression test；本次只記錄疑點，不修改 compiler。[i16-sign-risk]、[i16-rewrite]。i8 的四種 sign 測試也不能代替 i16 覆蓋。
- `acc32` / `acc64` 是累加寬度，不是 A/B dtype 或最終輸出 dtype。`acc16/acc24` 會映射到 `acc32`，`acc40/acc48/acc56` 映射到 `acc64`；不是多種實體累加器寬度。
- `accfloat` 是每 lane 32-bit 浮點累加；`ACC2048` 是整個累加器組 2048 bits，例如 `64×acc32`、`32×acc64` 或 `64×accfloat`，**不是單一 2048-bit 數值**。
- 須依真實 C-block／intrinsic 確認寬度，不能只讀 `accauto` 或 template 的最小 bits：例如 16×16 的 `4×4×8` 內部明確使用 `C_block<...,64,...>`；8×16 的 `4×4×8` specialization 名義參數為 32，內部同樣是 64。
- 對 int16 的 `acc32` 不保證滿範圍 K-reduction 不溢位：僅兩項 `(-32768)×(-32768)` 相加就達 `2^31`。同理兩項 `INT32_MIN×INT32_MIN` 達 `2^63`，64-bit signed accumulator 也不夠。後端累加、輸出飽和與數學無限精度需分開。

寬度補充證據：[`sources/aie_api/include/aie_api/detail/aie2p/accum_native_types.hpp:15–24`][acc-native]、[`sources/aie_api/include/aie_api/detail/aie2p/mmul_8_16.hpp:24–62`][8x16]。

## 3. AIE2P dense MMUL 幾何與實際展開

以下皆用 **M×K×N**（A=M×K、B=K×N、C=M×N），不是 M×N×K。列的是實際查到的代表性模式，**不是所有 API shape 的完整目錄**。`grow`／extract 會造成無效 lane、額外搬移；一個 builtin 仍須經 instruction selection 才能稱為機器原語。

| A×B | API / primitive 幾何 | 實際內部累加 | 靜態判讀 |
|---|---|---|---|
| 8×8 integer | `8×8×8` | 64×acc32 | 直接 `mul/mac_8x8_8x8` builtin，integer VMUL/VMAC pattern |
| 8×8 integer | `4×8×8`；另有 `2×8×8` | 內部 64×acc32，取子集 | 使用較大 `8×8×8` primitive，非更小的新機器指令 |
| 8×4 integer | `4×16×16` | 64×acc32 | API 一次 wrapper；此 Peano wrapper 是兩次 `4×8×16` int8 運算 + unpack/shuffle |
| 16×8 integer | `8×4×8`；`4×4×8` | 64×acc32 | `4×4×8` 為較大模式的部分結果；原語直接 integer builtin |
| 16×8 integer | `4×8×8` | 32×acc64 | 直接 integer builtin；不要和 8×8→acc32 混淆 |
| 8×16 integer | `8×2×8`；`4×4×8` | 分別 acc32、內部 acc64 | A 先 unpack 至 16 bits，再用 16×16 原語 |
| 16×16 integer | `8×2×8`；`4×2×8` | 64×acc32；後者取部分 | 直接 `8×2×8`；較小 M 不代表另一種指令 |
| 16×16 integer | `4×4×8`；`2×4×8` | 32×acc64；後者取部分 | 直接 `4×4×8` primitive |
| 32×16 integer | `4×2×8` | 32×acc64 | 直接 `I512_I512_ACC2048` builtin；輸入需 grow 到 intrinsic 寬度 |
| 32×16 integer | `4×4×8`；`2×4×8` | acc64 | 此 Peano overload 切 32-bit A 高／低 16-bit，MUL + shift-acc MAC 合成 |
| 16×32／32×32 | 例 `4×4×8`／`4×2×8` | acc64 | 分解高低字、位移與多次原語；不是通用 native 32×32 matrix primitive |
| BF16×BF16，macro=0 | `4×8×8`、`8×8×4`、`4×8×4` | accfloat | 前兩者各 8 個 32-lane MUL/MAC；`4×8×4` 擴大到較大 helper 後抽取 |
| BF16×BF16，macro=0 | `8×8×8` | 兩組 32×accfloat | API 明確有此 shape，呼叫兩份 `4×8×8` helper，合計 16 個 32-lane 算術原語 |
| BF16×BF16，macro=1 | `8×8×8`；也有 `4×8×8` | 64×accfloat；後者取部分 | 轉 BFP16、transpose B，使用 BFP16 matrix 原語 |
| BFP16 EBS8×EBS8 | `8×8×8` | 64×accfloat | 直接 `mul_8x8_8x8T`；B 必須配合轉置儲存慣例 |
| BFP16 EBS8×EBS8 | `8×8×16` | 兩組 64×accfloat | 兩次 `4×8×16T` 原語 + shuffle，不是一次 1024-MAC 機器指令 |
| FP32×FP32 | 例 `4×8×4` | accfloat | helper 再呼叫 emulated FP32 element-wise primitives；有版本 guard |

16×8 的直接 builtin 證據：[`sources/llvm-aie/clang/lib/Headers/aie2p/aie2p_vmult.h:14539–14555`][16x8-native32]、[`同檔:19409–19425`][16x8-native64]；API arch 21 分支為 [`sources/aie_api/include/aie_api/detail/aie2p/mmul_16_8.hpp:23–85`][16x8-api]。16×16 intrinsic 見 [`同 vMult header:21815–21831`][16x16-native32]、[`26627–26643`][16x16-native64]。

**不要把 sparse 模式混入上述 dense 吞吐量。** 例如 `mmul_8_8.hpp:106–124` 的 `8×16×8` 接收 `sparse_vector`；`mmul_16_16.hpp:108–157` 的 `4×8×8` 等也是 sparse B 路徑。稀疏格式、非零約束及解壓成本需獨立描述。[sparse-i8]、[sparse-i16]

### BF16 4×8×8 與 BFP macro：三層不相同

1. **MLIR-AIE 預建 C++ kernel 幾何**：`aie_kernels/aie2p/mm.cc:437–487` 以 input/output 組合選幾何；BF16→BF16、BF16→FP32 未定義 macro 時用 `4×8×8`，定義後用 `8×8×8`；i8、i16 輸出選項不是新輸入原語。[kernel-shapes]
2. **AIE API 實作**：`mmul_bf16_bf16.hpp` 用 `#if AIE_API_EMULATE_BFLOAT16_MMUL_WITH_BFP16`。macro=0 時合成原生 BF16 element-wise 算術；macro=1 時 BF16→accfloat→BFP16，B 先 transpose，再使用 BFP matrix primitive。4×8×8 仍可呼叫，但內部使用 8×8×8 的較大結果。[E06、E07]
3. **MLIR 直接 codegen**：本 snapshot 的 `aievec.matmul_aie2p` 測試對 **4×8×8 與 8×8×8 BF16** 都預期 BFP16 conversion + `BFP576...mac.conf`；8×8×4／4×8×4 則檢查 8 次 BF16 MAC。這不是 C++ preprocessor macro 控制的同一條路徑。[E08] 實作亦已交叉核對 [`sources/mlir-aie/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp:5048–5095`][matmul-lowering]，其中真正的 BFP helper 使用 conf=780；enum／先前 decoder 的名稱或 conf 註解不宜取代最後 rewrite。

**Macro 值陷阱**：kernel 用 `#ifdef`，API 用 `#if`；`-D...=0` 在兩層不是同義。建議清楚使用「未定義」或 `-DAIE_API_EMULATE_BFLOAT16_MMUL_WITH_BFP16=1`，並把 kernel 幾何、packing、數值誤差預期一起固定。API 模式表把 XDNA2 `8×8×8` BF16 標成需 macro 的 e 模式，但實際 header 另有 macro=0 specialization；**本稽核以實作為準**。[api-mode-table]

## 4. 吞吐量：能證明多少，不能證明多少

### 原語工作量與理想 issue-rate 換算

下表是 primitive 的**數學 MAC 數／一次原語**，不是量測的 MAC/cycle。若另有條件證明該模式每 cycle 可 issue 一次、沒有相依性／資源停頓，右欄才是理想值；**本次沒有驗證此條件**。

| 原語／路徑 | 每原語／helper 的工作量 | 條件式理想換算（1 原語/cycle） |
|---|---|---|
| dense i8 8×8×8 | 512 MAC | 512 MAC/cycle = 1024 operations/cycle |
| dense i16×i8 8×4×8 或 4×8×8 | 256 MAC | 256 MAC/cycle |
| dense i16×i16 8×2×8 或 4×4×8 | 128 MAC | 128 MAC/cycle |
| dense i32×i16 4×2×8 | 64 MAC | 64 MAC/cycle |
| native BF16 element-wise 64 lanes | 64 MAC | 64 MAC/cycle；**不是 256** |
| BF16 4×8×8 API，macro=0 | 256 MAC / 8 個 32-lane 算術原語 | 單純算術 issue 平均至多 32 useful MAC/cycle，還沒算 shuffle 等 |
| BFP16 EBS8 8×8×8 | 512 MAC | 512 MAC/cycle；BF16 轉入 BFP16 的成本另計 |
| i8×i4 4×16×16，此 Peano wrapper | 1024 MAC / 2 個 int8 primitives | 算術 issue 平均至多 512 useful MAC/cycle，還有 unpack／shuffle |

- `mul_elem_64(v64bfloat16,...)` 直接對應 `I1024_I1024_ACC2048_bf_mul_conf`；instruction pattern 選一個 `VMUL ... bf ... Y_Y`。這是 **64-lane 原生 BF16 element-wise 能力**，不能與 BFP matrix 的 512-MAC 原語混算。[bf64]、[select-wide]
- compiler scheduling 的 VMAC itinerary 把 destination 標成 cycle 6、acc1 使用標成 cycle 4，另有 bypass 欄位。這些是 scheduler 模型的 operand timing，**不是「一個 mmul 6 cycles」或「每 cycle 必定一個 mmul」**。[schedule]
- `MAC=2 operations` 是 throughput 慣例，不代表兩條機器指令；AIR runner 讀到 `macs_per_core_per_cycle` 也確實乘 2。然而 runner 的 JSON rate/efficiency 是**輸入成本模型**，不是從硬體自動量測出的 throughput。[air-cost]
- 理想全陣列公式：`TOPS = 2 × MAC_per_tile_per_cycle × active_compute_tiles × clock_Hz / 10^12`。例如「假設 512、32 tiles、1.5 GHz」算出 49.152 TOPS，只是條件式計算；不能宣稱這次量到 ~50 TOPS，亦不能代入 BF16 native 路徑冒充同一精度。
- **速查表 `BF16 256 MAC/cycle` 不宜照抄**：本次看到的是 BF16 32/64-lane element-wise 原語及 BFP16 matrix 原語，沒有證據把 256 當成未降精度 BF16 的每 tile 週期能力。是否有其他 compiler 生成更佳排程，不在本次證據範圍。

## 5. Packing、數值精度、rounding／saturation

### Packing 與資料表示

- 整數與 BF16 的公用 `mmul.mul/mac` 介面要求 A、B 各自 tile 內 row-major；`size_A=M*K`、`size_B=K*N`、`size_C=M*N`。整個大矩陣仍要依 kernel 的 tile 次序打包，不能把任意 contiguous 大矩陣直接視為一個 microtile。[public-mmul]
- 4-bit packed vector 的位元配置不可等同於 C++ scalar `_BitInt(4)` 陣列布局；`v256int4` 實際以 128-byte vector storage 表示 256 個 nibble。signed nibble 值域 -8..7，unsigned 0..15；應透過已定義的 pack/unpack API，且 sign extension 與 zero extension 必須配對。**有緊縮儲存不表示乘法同樣在 4-bit datapath 完成。**[E03]
- BFP16 EBS8：每 8 個 **signed 8-bit mantissa** 共享 8-bit exponent，block=9 bytes；64 個值共 72 bytes=576 bits。EBS16：每 16 個 mantissa 共享 exponent，block=17 bytes，64 個值的緊縮記憶體資料=68 bytes。
- EBS16 **register representation** 仍是 `v64int8 mantissa + v8int8 exponent`；header 說明每個 exponent 重複存兩次。因此 68-byte 記憶體格式 ≠ 72-byte register aggregate。不能以 `sizeof` register wrapper 直接取代 DMA/fifo packed stride。[E12]
- BFP `...8x8T` 的 T 是 B 的轉置存放／消費慣例；BF16 emulation helper 會 transpose B，直接傳 block_vector 則不能假設同樣自動處理。API 的 EBS8 mmul 直接傳 a,b 至 T intrinsic。[E07]
- 512-bit 普通向量常見 lane 數：int4=128、i8=64、i16/BF16=32、i32/float=16；這只是容器寬度換算，**不是 MMA M/K/N 或 MAC 數**。64-lane BF16 需 1024-bit 輸入容器，BFP 另外有 exponent register。

### 精度與轉換

- BF16 與 FP16 同為 16-bit 儲存，但一般格式是 BF16 的 8-bit exponent／7-bit fraction，相對於 IEEE binary16 的 5／10；不可互換 bitcast 冒充數值轉換。這個格式常識不表示本 NPU 支援後者的運算。
- BF16→BFP16 會選共享 exponent、量化 mantissa。block 中大值可使小值丟失有效位元，跨很大動態範圍尤其需檢查；還原成 BF16／FP32 output 不會找回量化資訊。誤差不應只報 dtype 名稱或單一固定 tolerance。
- AIE API `mmul_fp32_fp32.hpp:24–44` 的 `4×8×4` 在 `__AIE_API_FP32_EMULATION__` guard 內；此 guard 為 model>=10600，而非 `__AIE_API_FP32_SUPPORT__`（後者為0）。[fp32-mmul] Peano FP32 `mul_elem_32` 預設走 `accuracy_safe`：把兩個 float 各分成多個 BF16 部分、做 **9 個 BF16 部分乘積及加總**，另有殘差生成、轉換；`accuracy_fast` 展開不同。這和「先把每個 FP32 截成一個 BF16」不是同一演算法。[E09]
- Triton 自動 matmul 對 f32 設 `contract_input_type="bf16"`、accumulator `f32`；npu2 pack=8,8,8。結合 AIEVec lowering，還可能走 BFP16 matrix 路徑。`allowed_dot_input_precisions=("ieee",)` 是前端接受的 option，不是 native IEEE FP32 GEMM 保證。[E14]
- 更要小心：通用 MLIR `--bf16-emulation` 的 binary ops 是 `truncf → bf16 op → extf`；對 `vector.fma` **連 acc operand 都轉 BF16**。不能籠統描述為「所有 f32 算術都只截 input，完整 f32 累加不變」。[bf16-demote]、[bf16-demote-test]

### Rounding／saturation

- `aie::rounding_mode` 有 floor、ceil、half-way to ±∞／away／zero、convergent-even/odd 等；`symmetric_floor` 才是朝零，**floor 不是 truncate toward zero**。
- `saturation_mode::none` 允許 overflow，`saturate` 夾到該輸出型別上下界，`symmetric` 為 signed 對稱界；舊名稱 `truncate=1` 已 deprecated，實際意義是 saturate，不可按英文直覺解讀。[E13]
- 整數 accumulator→vector 可先 downshift，再依適用模式 rounding／saturation。這和 MAC 中間溢位不同；若中間資訊已遺失，最後 `to_vector<int8>(shift)` 飽和不會補救。
- FP `to_vector<T>(shift)` 的 shift 參數被忽略；FP32→BF16 有專門 conversion builtin。不要將整數 SRS 的 shift／saturation 規則通用化為所有 FP instructions 的 IEEE rounding 設定。[public-mmul]（E13）
- BFP conversion `to_v64bfp16ebs8_conf` 明確 save `get_rnd()`、set、convert、restore。MLIR-AIE 的 BF16 BFP kernel 也暫時設 `conv_even`，註解指出預設 floor 造成低估偏差沿 K 累積。[bfp-round-kernel]
- 尚未驗證 NaN、Inf、subnormal、signed zero、tie、overflow／underflow 在各 primitive、FTZ 設定與 emulation 組合下的逐位行為；網站不可承諾「IEEE 完全相容」或「與 CPU GEMM bit-exact」。

## 6. Architecture cheatsheet 對照 AIETargetModel

受稽核文件：`sources/mlir-aie/skills/aie-code-creator/references/architecture.md`。[cheatsheet]

| 速查表敘述 | 對照結果／建議文案 |
|---|---|
| 每 compute tile 約 64 KB L1 | **符合 model，但應寫 64 KiB=65536 bytes 本地 data memory / scratchpad**，不是 coherent CPU cache；可用 tensor 空間還要扣 stack、其他 buffers／配置開銷 |
| 每 mem tile 約 512 KB L2 | 符合 `0x80000`，應寫 512 KiB；不要混為每 compute core 私有 512 KiB |
| L1 1 cycle、L2 幾 cycles、DDR 幾百 cycles | model 不提供此 latency 保證；有 bank conflict、排程與 DMA/stream 路徑差異，應標為未核實而非規格 |
| AIE2/AIE2P 有 512-bit vectors | 可作常見容器寬度說明，但 API 支援更大／更小及多 register 組合；模型 **bus=256 bits**，AIE2P full-width vector **alignment=512 bits**（64 bytes），不可混用 |
| int16 accumulator 可寫 acc32 | 必須補上 shape 決定內部 `acc64` 的例外；4×4×8 是 64-bit 內部路徑 |
| BF16 4×8×8「native mul-acc」 | 只能解讀為使用 native BF16 primitives；不代表一條 native BF16 matrix 指令 |
| macro 令 BF16 microkernel 變8×8×8 | 對預建 kernel 幾何正確，但須寫共享 exponent 轉換、精度成本；API 自身的非-macro 8×8×8 與直接 MLIR lowering 另論 |
| 每 tile i8 512、BF16 256 MAC/cycle；~1.5GHz | i8 512 與原語工作量相容但未量測 issue-rate；BF16 256 缺本次原語證據；頻率不由 target model 證明，取決於 SKU／功率／runtime |
| NPU2 8 columns ×4 compute rows | **full Strix target model 正確**：總 rows=6，row0 shim、row1 mem、row2..5 core，32 compute tiles；virtualized model 使用指定 cols，不能永遠乘32，也不能推及每個 XDNA2 SKU |
| ObjectFifo depth practical max ~8 | 不是 AIETargetModel 的固定硬體上限；受 buffer bytes、tile memory 與資源配置約束 |
| direct DMA 只能同欄／跨欄一定經 mem tile | 不能從 scratchpad memory adjacency 推得完整 DMA routing 限制；應以 switch/flow routing 規則再核對，不宜作普遍拓撲定理 |

補充已確認 model 值：program memory `0x4000`=16 KiB、cascade width=512 bits；`getNumBanks` 回傳 memtile=8、其他 tile=4。這是**本 snapshot 的 compiler model**，不是另做物理 bank 微架構驗證。BD 數 mem=48、core/shim=16；ND dims mem=4、其他=3，和速查表相符。[target-memory]、[target-banks]

記憶體鄰接函式的 East 指 self，West 指 col−1，另有 North/South 與邊界限制；最多數個 64 KiB 視窗**不是「core 私有 L1=256 KiB」**，mem tile 也不作鄰接 compute scratchpad。[target-affinity]

## 7. 短 C++ 範例：已逐項對照 headers，未編譯／未執行

此範例直接接受「已在 register 的單一 row-major microtile」，避免假裝展示完整 DMA／GEMM packing。A/B 是 BF16，C 是 FP32 容器；**不是 FP32-input GEMM**。

```cpp
#include <aie_api/aie.hpp>

static_assert(__AIE_ARCH__ == 21, "This example is for AIE2P/XDNA2");
#if AIE_API_EMULATE_BFLOAT16_MMUL_WITH_BFP16
constexpr unsigned audit_M = 8;  // build macro must be defined as 1
#else
constexpr unsigned audit_M = 4;
#endif
using AuditMM = aie::mmul<audit_M, 8, 8,
                          bfloat16, bfloat16, accfloat>;

aie::vector<float, AuditMM::size_C> audit_tile(
    const aie::vector<bfloat16, AuditMM::size_A>& a,
    const aie::vector<bfloat16, AuditMM::size_B>& b) {
#if AIE_API_EMULATE_BFLOAT16_MMUL_WITH_BFP16
  const auto old_round = aie::swap_rounding(aie::rounding_mode::conv_even);
#endif
  AuditMM c;
  c.mul(a, b);                    // first product; no uninitialized C read
  auto out = c.to_vector<float>(); // accfloat output, not native FP32 multiply
#if AIE_API_EMULATE_BFLOAT16_MMUL_WITH_BFP16
  aie::set_rounding(old_round);
#endif
  return out;
}
```

核對：`mmul` template／預設 ownership、`size_A/B/C`、`mul` 的型別／長度要求與 row-major 契約、`to_vector<float>()` 均存在於 [`sources/aie_api/include/aie_api/aie.hpp:6311–6366,6460–6515`][public-mmul]；BF16 shape specialization 見 E06/E07。rounding 函式實體見 [`同檔:8174–8209`][round-api]。未開 macro 時 A=32、B=64、C=32 elements；開 macro=1 時各為64。若改用 `load_v/store_v`，full-width AIE2P 存取須遵守 64-byte 對齊或使用對應 unaligned API。[align]

## 8. 15 列精簡 source-to-claim 證據表

行號為 **1-based、含端點**；路徑相對本工作目錄。每個 source 連結均為上述 SHA 的 immutable GitHub blob。

| ID | 可驗證主張 | 原始碼定位 |
|---|---|---|
| E01 | AIE2P arch=21、model=11500；不等同arch22 | [`sources/llvm-aie/clang/lib/Headers/aie2p/aie2p_version.h:14–20`][version] |
| E02 | i8 原生 builtin；四種 signedness config；signless 預設 signed | [`sources/llvm-aie/clang/lib/Headers/aie2p/aie2p_vmult.h:15–58`][i8-native]；[`sources/mlir-aie/test/Conversion/AIEVecToLLVM/matmul-aie2p.mlir:169–232`][sign-test] |
| E03 | int4 API ≠ single instruction；Peano unpack後兩個i8運算 | [`sources/aie_api/include/aie_api/detail/aie2p/mmul_8_4.hpp:23–44,101–112`][int4-api]；[`sources/llvm-aie/clang/lib/Headers/aie2p/aie2p_vmult.h:39416–39509`][int4-impl]；[`sources/llvm-aie/clang/lib/Headers/aiebase_typedefs.h:117–118`][int4-scalar]、[`同檔:235–270`][int4-storage] |
| E04 | 16×16 shape 決定acc寬度；MLIR i16 sign bits 有靜態風險 | [`sources/aie_api/include/aie_api/detail/aie2p/mmul_16_16.hpp:23–105`][int16-api]；[`sources/mlir-aie/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp:4895–4904`][i16-sign-risk] |
| E05 | 32×16 4×2×8 原生，較大K／32×32由部分乘積合成 | [`sources/llvm-aie/clang/lib/Headers/aie2p/aie2p_vmult.h:37603–37651`][int32-native]、[`同檔:42616–42649`][int32-split]；[`sources/aie_api/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp:10–122`][int32-emul] |
| E06 | BF16 4×8×8 helper=8次32-lane原語；非macro 8×8×8有兩份helper | [`sources/aie_api/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp:207–269`][bf16-helper]；[`sources/aie_api/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp:134–178`][bf16-no-macro] |
| E07 | macro先BF16→BFP16；EBS8 8×8×8為直接matrix builtin／機器pattern | [`sources/aie_api/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp:63–131`][bf16-macro]；[`sources/llvm-aie/clang/lib/Headers/aie2p/aie2p_vmult.h:38830–38885`][bfp-native]；[`sources/llvm-aie/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td:443–460`][bfp-select] |
| E08 | 直接AIEVec BF16 8×8×8／4×8×8轉BFP；8×8×4用8次MAC | [`sources/mlir-aie/test/Conversion/AIEVecToLLVM/matmul-aie2p.mlir:10–166`][matmul-test] |
| E09 | FP32 API為emulation，default32-lane wrapper走safe BF16分解 | [`sources/aie_api/include/aie_api/detail/aie2p/config.hpp:22–24`][fp32-config]；[`sources/llvm-aie/clang/lib/Headers/aie2p/aie2p_vmult.h:53918–53994`][fp32-parts]、[`同檔:54935–54942`][fp32-default] |
| E10 | `_Float16`／float8／bfloat8在arch22 guard；bfp8註解非XDNA2 block type | [`sources/llvm-aie/clang/lib/Headers/aiebase_typedefs.h:580–643`][fp16-fp8-guard]；[`sources/aie_api/include/aie_api/detail/aie2ps/config.hpp:40–48`][arch22-fp] |
| E11 | scalar FP64與FP32 MUL libcall；BF16 scalar MUL以vector做custom legalization | [`sources/llvm-aie/llvm/lib/Target/AIE/aie2p/AIE2PLegalizerInfo.cpp:214–255`][fp-legalizer] |
| E12 | BFP16每block 9／17bytes；EBS16 register exponent重複，不等於memory布局 | [`sources/aie_api/include/aie_api/aie_doc.hpp:229–250`][bfp-layout]；[`sources/llvm-aie/clang/lib/Headers/aiebase_typedefs.h:545–578`][bfp-register] |
| E13 | rounding／saturation枚舉；BFP轉換conf會save/set/restore rounding | [`sources/aie_api/include/aie_api/aie_types.hpp:34–60`][modes]；[`sources/llvm-aie/clang/lib/Headers/aie2p/aie2p_srs.h:1281–1344`][srs] |
| E14 | AIR可發出f32 IR不代表後端native；Triton f32 matmul轉BF16且FP8停用 | [`sources/mlir-air/python/test/api/fma.py:127–137`][air-fma]；[`sources/Triton-XDNA/amd_triton_npu/backend/driver.py:1359–1386`][triton-matmul]；[`sources/Triton-XDNA/amd_triton_npu/backend/compiler.py:131–174`][triton-options] |
| E15 | 64KiB/512KiB、256-bit bus、512-bit alignment、full NPU2 topology與block formats | [`sources/mlir-aie/include/aie/Dialect/AIE/IR/AIETargetModel.h:749–757`][target-memory]、[`830–834`][target-banks]、[`1077–1145`][target-npu2]；[`sources/mlir-aie/lib/Dialect/AIE/IR/AIETargetModel.cpp:1609–1620`][target-block] |

## 9. 出版前保留的限制／待驗證事項

- 本文件的「未見支援」指上述 snapshot 和檢查範圍，**不是對所有未公開硬體／其他 compiler 版本的不存在證明**。不要將 AIE API Doxygen 的無註腳形狀、`INTRINSIC` 巨集名或 Triton 註解當作更高階權威。
- API 模式表的 footnote c 泛稱 32b×16b emulated，但 header/builtin/pattern 明確有 `4×2×8` 直接原語；int4 模式表無 emulation 標記，但此 Peano wrapper 會合成。這兩項應在網站註明工具鏈差異，不應挑一份註解消除矛盾。[api-mode-table]（E03、E05）
- BFP EBS16 有 block-vector storage／conversion、target format，但本 AIE2P `mmul_bfp16_bfp16.hpp` 只找到 EBS8 的 concrete shape 實作；底部 EBS16 forwarding declaration **本身不足以保證 instantiate 成功**。[bfp-api]
- 未測：NPU cycle/throughput、kernel pipeline II、bank conflict、register spill、alignment fault、端到端 DMA／host copy、pack成本、FP邊界值、量化誤差分布、C++編譯與runtime libcall availability。
- 外部主來源交叉查閱：AMD [XDNA 架構頁](https://amd.com/zh-tw/technologies/xdna.html) 只支持 spatial-dataflow、tile-local memory 與 VLIW/SIMD 的一般敘述，沒有本次所需的逐型別 MAC/cycle 表；AMD 2024.2 API網頁擷取失敗，未採為證據。圖像候選是抽象宣傳圖／其他代產品照／repository卡片，與此 source audit 無直接證據價值，未納入。所有具體數值／lowering 結論以本地 source 為準。

**可直接用於網站的短版：**「XDNA2/AIE2P 具有整數與 BF16 向量算術、32/64-bit 整數累加及 FP32 浮點累加；部分 matrix API 由多個原語合成。BF16 的 BFP16 加速路徑會改用共享指數表示，FP32 輸出不代表原生 FP32-input GEMM。型別、形狀、packing、精度及效能均須連同工具鏈版本與實際 lowering 說明。本文為原始碼稽核，非硬體 benchmark。」

<!-- Immutable source links; all line ranges refer to the checked snapshots. -->
[version]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20
[i8-native]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L58
[sign-test]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/test/Conversion/AIEVecToLLVM/matmul-aie2p.mlir#L169-L232
[int4-api]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_8_4.hpp#L23-L112
[int4-impl]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L39416-L39509
[int4-storage]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L235-L270
[int16-api]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_16_16.hpp#L23-L105
[int32-native]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L37603-L37651
[int32-split]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L42616-L42649
[int32-emul]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp#L10-L122
[bf16-helper]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/emulated_mmul_intrinsics.hpp#L207-L269
[bf16-no-macro]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp#L134-L178
[bf16-macro]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp#L63-L131
[bfp-native]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L38830-L38885
[bfp-select]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L443-L460
[matmul-test]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/test/Conversion/AIEVecToLLVM/matmul-aie2p.mlir#L10-L166
[fp32-config]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/config.hpp#L22-L24
[fp32-parts]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L53918-L53994
[fp32-default]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L54935-L54942
[fp16-fp8-guard]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L580-L643
[arch22-fp]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2ps/config.hpp#L40-L48
[fp-legalizer]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PLegalizerInfo.cpp#L214-L255
[bfp-layout]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie_doc.hpp#L229-L250
[bfp-register]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L545-L578
[modes]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie_types.hpp#L34-L60
[srs]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_srs.h#L1281-L1344
[air-fma]: https://github.com/Xilinx/mlir-air/blob/ff95a9b35b692b4cfbdf1d52bf69e6ffe01facde/python/test/api/fma.py#L127-L137
[triton-matmul]: https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/amd_triton_npu/backend/driver.py#L1359-L1386
[triton-options]: https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/amd_triton_npu/backend/compiler.py#L131-L174
[target-memory]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L749-L790
[target-banks]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L830-L834
[target-npu2]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1077-L1145
[target-block]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1609-L1620
[acc-native]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/accum_native_types.hpp#L15-L24
[8x16]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_8_16.hpp#L24-L62
[16x8-native32]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L14539-L14555
[16x8-native64]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L19409-L19425
[16x8-api]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_16_8.hpp#L23-L85
[16x16-native32]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L21815-L21831
[16x16-native64]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L26627-L26643
[sparse-i8]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_8_8.hpp#L106-L124
[sparse-i16]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_16_16.hpp#L108-L157
[kernel-shapes]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/aie_kernels/aie2p/mm.cc#L437-L487
[api-mode-table]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/mmul.hpp#L100-L285
[bf64]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L38673-L38685
[select-wide]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L295-L307
[schedule]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9031-L9064
[air-cost]: https://github.com/Xilinx/mlir-air/blob/ff95a9b35b692b4cfbdf1d52bf69e6ffe01facde/mlir/lib/Util/Runner/Resource.cpp#L172-L181
[public-mmul]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie.hpp#L6295-L6530
[bf16-demote]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIEVec/Transforms/VectorToVectorConversions.cpp#L812-L943
[bf16-demote-test]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/test/Conversion/VectorToAIEVec/test-bf16-emulation.mlir#L10-L100
[bfp-round-kernel]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/aie_kernels/aie2p/mm.cc#L89-L102
[cheatsheet]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/skills/aie-code-creator/references/architecture.md#L39-L142
[target-affinity]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L755-L824
[round-api]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/aie.hpp#L8174-L8209
[align]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/ld_st.hpp#L33-L40
[bfp-api]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bfp16_bfp16.hpp#L17-L104
[i16-sign-risk]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4895-L4904
[i16-rewrite]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4980-L5048
[matmul-lowering]: https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L5048-L5095
[fp32-mmul]: https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_fp32_fp32.hpp#L24-L44
[int4-scalar]: https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L117-L118
