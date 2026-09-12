# AIE2P 指令族：純量、向量、搬移、控制、串流與矩陣

分類：架構 · 來源查核 · 來源快照 2026-09-12

用完整來源宣告目錄導航主要指令族，追蹤 operand、控制字與 pseudo lowering；以具體範例區分 C helper、編譯器選擇與可編碼形式。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 範圍：ISA 來源參考，不是函式名稱大全

本頁固定 llvm-aie commit `386ca5c6634a84bb224b7248e79df8edabf0722f`，[AIE2P 版本界線](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20)確認 **arch 21 AIE2P**；不引入 AIE2PS arch 22。以下「來源事實」指 TableGen 中明列的 operand、欄位與 pattern；「工程推論」指它們對 LLM kernel 的可能用途。沒有編譯、NPU 執行、cycle timing 或硬體頻率量測。

[完整 SOURCE DEFINITION JSON](../spec-data/isa-source-index.json)涵蓋 16 個相關 `.td` 的全部 2,401 筆詞法宣告，而非只收本文範例。單是 `AIE2PGenInstrInfo.td` 有 879 筆 def；它們是該檔來源宣告，不是整個 silicon 的指令總數。目錄另收 manual pseudo、patterns、register、formats、immediate、calling convention 與 copy materialization；不得把不同層級的筆數相加當 opcode 數。

## 純量算術、邏輯、比較與位元操作

| 族 | 來源可見助記符／形式 | operand／狀態要點 | LLM 工程用途 |
|---|---|---|---|
| 加減與 carry | `add`、`add.nc`、`adc`、`sub`、`sbc` | ADD／ADC 的 eR 與 ADD_NC 的混合目的類別不同；carry 是隱含狀態 | 索引、迴圈及寬算術拆解 |
| 乘加 | `mul`、`mac`、`msc` | scalar operand，不能等同向量矩陣原語 | 控制或地址計算周邊工作 |
| 邏輯／移位 | `and`、`or`、`xor`、`ashl`、`lshl` | 讀實際 eR 與固定欄位 | mask、位元處理 |
| 比較／選擇 | `eq`、`eqz`、`ne`、`nez`、`ge`、`geu`、`lt`、`ltu`、`sel.eqz` | signed 與 unsigned 是不同形式 | 尾塊邊界、條件化 |
| 位元與延伸 | `clb`、`clz`、`popcount`、`extend.s8/u8/s16/u16` | 窄型別延伸不能靠 host dtype 推斷 | 封裝資料、控制 mask |

主要定義見 [純量算術與位元欄位](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L14-L359)，其餘 scalar 乘法與 subtract 可在目錄按 `MUL`／`MAC`／`MSC`／`SUB`／`XOR` 查找；select／popcount 的鄰近來源見 [地址更新、鎖與返回](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4245-L4420)。例如 `add r1,r2,#-1` 對應 `ADD_add_r_ri`，三個 operand 類別依序為 eR、eR、c7s；7-bit −1 與 32-bit r 值不是同一位寬概念。[AIE2P immediate 清單](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PImmOperands.td#L12-L70)和 [編碼頁](isa-encoding.md)提供欄位推導。

補充直接定義：[MAC 純量乘加](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L1037-L1045)、[MSC／MUL 純量乘法](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4147-L4165)、[純量條件選擇](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4431-L4449)、[SUB 純量減法](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4882-L4890)、[XOR 純量位元運算](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L11965-L11973)。

## Load／store 與地址更新：不只是一個指標

[scalar load 的 indexed／post-modify 形式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L706-L1006)中 scalar `lda`、`lda.s8`、`lda.u8`、`lda.s16`、`lda.u16` 有 indexed 與 post-modify 形式；[scalar store 形式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4498-L4881)對應 `st`、`st.s8`、`st.s16` 及 2D／3D。名稱中的 signedness 應與載入延伸一起讀，不能把窄 store 的 `.s8` 名稱解釋成一次有號乘法。

| 搬移族 | 來源名稱例 | 應追蹤的額外狀態 |
|---|---|---|
| Scalar 2D | `LDA_2D_s8`、`LDA_2D_u8` | dst、ptr_out、dc；輸入 ptr、mod |
| Scalar 3D | `lda.3d`／`st.3d` | 兩組 dimension counter 及配對 descriptor |
| Vector load A | `vlda.128`、`vlda`、`vlda.2d`、`vlda.3d` | 視形式選 W／X／BM／FIFO 等目的類別 |
| Load 加轉換 | `vlda.conv.fp32.bf16`、`vlda.ups.2x/4x` | 與控制／shift／accumulator 類別共同閱讀 |
| Vector load B | `vldb`、`vldb.unpack`、2D／3D 變體 | unpack sign 類別，不是假設輸入皆有號 |
| Vector store | `vst`、`vst.pack`、`vst.srs.2x/4x` | pack／SRS 控制與來源容器 |
| FIFO | `vlda.fill.512`、`vlda.pop.512/544/576/640/704`、`vst.push`、`vst.flush` | FIFO 與 metadata／指標狀態，不是一般矩陣 lane 數 |

向量載入來源見 [VLDA、UPS 與 FIFO pop](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L6769-L7425)、[VLDB unpack 與載入](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L8000-L8692)，向量寫出見 [VST pack／SRS／FIFO 寫出](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L10246-L11049)。這些形式提供寬廣導航，並非把所有命名後綴做任意笛卡兒積；只有來源實際列出的組合才有本次證據。

具體例子 `lda.2d.s8 r0,[p0],d0` 的來源 outs 是 `eR:$dst,eP:$ptr_out,eDC:$dc`、ins 是 `eP:$ptr,eD:$mod`，外層約束 `$ptr_out=$ptr`。所以組語表面只有三個參數，編譯器資料相依卻不只寫 r0。[2D load 與 signedness](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L493-L562)的 s8 與 u8 分別以 `00`／`01` 兩位作區分；20-bit LDA slot 公式為 `{ptr(3),mod(3),100,dst(5),00/01,0101}`。這裡描述的是編碼與資料相依，沒有宣稱地址更新遞迴公式、所有邊界行為或固定讀取延遲。

## 向量算術、重排、轉換與非線性

| 類型 | 可查來源形式 | 解讀重點 |
|---|---|---|
| 元素加減 | `vadd.8/.16/.32`、`vsub.8/.16/.32`、`vaddsub` | 512-bit X 類別；與 DM accumulator 的 `vadd` 不同 |
| 比較／選擇 | `vge`、`vlt`、`vmax_lt`、`vmin_ge`、`vsel` | 產生比較結果與選擇所需狀態；BF16 形式另列 |
| 邏輯／廣播 | `vband`、`vbor`、`vbcst`、`vbcstshfl` | 元素寬度、來源類別與模式是必要條件 |
| 元素抽取／插入 | `vextract`、`vextbcst`、`vinsert` | immediate index 與 register index 形式不可混為一筆 |
| 重排 | `vshift`、`vshift.align`、`vshuffle`、`vpush.hi/lo` | 服務 layout，但不自動證明特定矩陣資料順序 |
| 轉換 | `vconv`、`vpack`、`vunpack`、`vups`、`vsrs` | sign、round、saturation／shift 控制需另讀 |
| 非線性 | `vexp2`、`vtanh`；scalar `sqrt`、`inv`、`invsqrt` | 有宣告不等於完整 softmax／activation 或精度誤差保證 |

加法見 [MV 向量加法與 VEC 累加器加法](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L5899-L6022)，broadcast／轉換／VEXP2 見 [廣播、轉換與元素抽取](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L6034-L6436)，比較與插入見 [比較與插入](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L6619-L6767)，重排與 SRS 見 [pack、選擇、shift、shuffle 與 SRS](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L9962-L10244)，VTANH／unpack／UPS 見 [VTANH、unpack 與 UPS](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L11835-L11964)。其餘精確拼字及全 operand 原文可由 JSON 查詢，不能只照表名生成組語。

一個反直覺的具體例子：`VADD_8` 是 `AIE2P_inst_mv_instr32`，payload 為 `{d(4),s1(4),s2(4),0,00,1101011}`；`VADD_16` 將其中尺寸兩位改為 `01`，`VADD_32` 改為 `10`。也就是 v-prefix 並不保證 VEC slot。另一方面不帶 `.8/.16/.32` 的 DM `VADD_vmac_cm2_add_reg` 才是 VEC 形式，且額外讀 eR 控制字。[MV 向量加法與 VEC 累加器加法](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L5899-L6022)

## 控制流、同步、stream 與 cascade

[跳躍與呼叫形式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L432-L491)列直接地址的 LNG `J_lng`／`JL_lng`／`JZ`／`JNZ`，以及 eP 間接目標的 ALU `J_alumv_or`／`JL_alumv_or`；`JNZD` 還有 eR 輸出。[地址更新、鎖與返回](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4245-L4420)列 `RET`（組語使用 lr）、`padda/paddb/padds` 地址更新與 `rel/rel.cond`；[純量算術與位元欄位](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L14-L359)則列 `acq/acq.cond`、`done`、`event`。這些是核心指令層，不等於主機 API 的 dispatch、DMA 路由或整機同步。

| 通道／控制 | 明列形式 | 具體注意事項 |
|---|---|---|
| Scalar input stream | `MOV_nb_lda` → `mov.nb dst,ss` | 來源 Defs 包含 srSS0，hasSideEffects=true |
| Scalar output stream | `mov.nb ms,src`、`mov.nb.tlast ms,src` | ST slot，srMS0 狀態；r28 形式另讀固定 operand |
| Packet header | `mov.ph`、`mov.cph` 與 nb／tlast 變體 | 不把 header 形成操作當 payload 矩陣計算 |
| Cascade | `vmov.0/.1/.2/.3`、部分 `vmov`；`vaddmac … scd[r31]` | accumulator／cascade 路徑，與 ss／ms 分開 |
| Lock | `acq #id,rN`、`acq.cond #id,rN,r26`、`rel` | c6u 或 GPR id 形式；r26 singleton 約束 |

stream 狀態見 [非阻塞串流與 TLAST](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4083-L4146)，packet 見 [串流封包標頭形式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L1220-L1338)，cascade 搬移見 [VMOV cascade 形式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L9131-L9437)，SCD 算術變體見 [VADDMAC 與 SCD 變體](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4946-L5421)。`nb`、TLAST、條件鎖與一般算術的阻塞／狀態契約不同；本文只確認來源欄位，不提供串流有效吞吐量、阻塞等待時間或 DMA 布線保證。

## 矩陣／乘加族：operand 形狀不等於 API 形狀

[VMUL 整數、BF 與 BFP 編碼](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L9606-L9758)列整數 `VMUL_vmul_cm_core_X_X/X_Y/Y_X/Y_Y` 與帶 QX/QY 的稀疏輸入；BF 類型有 X_X、Y_Y，BFP 類型使用 EX_EX、EX_EY、EX_QEY、EY_QEX。[VMAC 輸入與結果](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L8763-L8930)同樣將 VMAC 的舊 accumulator `acc1` 明列為 eDM，而目的 `dst` 也是 eDM；不是從名字推定所有形式都必須與來源同一個暫存器。VADDMAC 還可有兩個 DM 累加輸入或 SCD 來源。[VADDMAC 與 SCD 變體](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4946-L5421)

```text
vmul   dm0, x0, x1, r0       ; X_X 來源形式的 operand 示例
vmac   dm1, dm0, x0, x1, r0  ; dst 與 acc1 在定義中分列
vmul.f dm0, y0, y1, r0       ; BF Y_Y 形式，須先準備相容控制字
```

這三行只示範**來源容許的 operand 結構**，未編譯執行；r0 內容、輸入 layout、模式及可用暫存器仍須正確設定。`VMUL_X_X` 的 VEC 公式是 `{acc(5),dst(3),111,s1(4),s2(4),000,0,1,dontcare(1),0}`；VMAC 將固定 `111` 換成三位 `acc1`。BF X_X 末位改為 1，BFP EX_EX 又有不同固定模式位。這說明模式、容器與 mnemonic 必須一同查核，不能只看 `vmul.f` 字串就等同 FP32 或 FP16 輸入乘法。[VMUL 整數、BF 與 BFP 編碼](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L9606-L9758) [VMAC 輸入與結果](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L8763-L8930)

[IR／intrinsic 到指令的選擇](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L261-L329)把 `int_aie2p_I1024_I1024_ACC2048_bf_mul_conf` 選到 `VMUL_f_vmul_bf_vmul_bf_core_Y_Y`，這是 **compiler selection 證據**；C++ `mmul` 的任意 M×K×N 則未在此獲得單指令保證。對 LLM GEMM，應另外計入 pack、broadcast、shuffle、轉換和累加結果抽取，詳見 [矩陣原語](mma.md)。

## 32-bit 控制字：signedness 是資料，不只是名稱

[VecConf 控制字與 BF16 設定](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L30-L70)的 `VecConf.all` 與 [C helper：控制字與 8×8 wrapper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L37)的 C helper 位移互相對照，控制字欄位如下。此表是已命名欄位的來源映射，不宣稱任意 amode／bmode／cmode 組合皆合法。

| 位元 | 名稱 | 來源含義 |
|---|---|---|
| 0 | dynZeroAccum | 是否用零取代第一 accumulator 輸入 |
| 2:1 | amode | I32=0、I64=1、FP32=2 的 accumulator mode |
| 4:3 | bmode | 精度模式；代碼會依組合重用，不能單欄決定 dtype |
| 7:5 | cmode／variant | 乘法模式 |
| 8、9 | signY、signX | 0 unsigned、1 signed |
| 10 | accShift | accumulator 左移16位 |
| 11、12、13 | dynMulNeg、dynAcc0Neg、dynAcc1Neg | 對乘積及累加輸入的動態符號控制 |
| 15:14 | reserved1 | 預設零，本文不指派新語義 |
| 23:16 | dynTermNeg | 複數乘法 term 的 negation mask |
| 31:24 | reserved2 | 預設零 |

例如來源 `mulbf16_vecconf` 設 amode=2、bmode=3、cmode=1，其餘預設零，故控制字為 `(2<<1)|(3<<3)|(1<<5)=0x3c`。這裡的 FP32 指 accumulator mode；BF16 輸入則由 BF 原語與 pattern 決定。C helper 的 `mul_8x8_8x8(v64uint8,v64uint8)` 設 unsigned／amode0／bmode1／variant0 後呼叫 builtin，展示 API shape 如何先變成控制字再進 compiler；不可把每個 overload 當成不同原生指令。[VecConf 控制字與 BF16 設定](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L30-L70) [C helper：控制字與 8×8 wrapper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L37)

即使來源常數叫 `BMODE_8x4`，單一名字也不足以宣稱任意 native INT4 矩陣 ISA。[C helper：INT4 unpack 展開](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L39416-L39447)的特定 `mul_4x16_16x16(v64int8,v256int4)` 明確先 shuffle、extract、兩次 unpack，再以整數 mul/mac 合成。這個反例只限制該 wrapper 的解讀，不證明所有低位寬模式皆不存在；本頁不虛構原生 FP8、IEEE FP16 或 INT4 能力。

## Pseudo、模式展開與目錄使用方式

[控制流、meta、MOV_OR 與 split pseudo](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrInfo.td#L26-L146)明列 `PseudoRET`、branch pseudo、`ADJCALLSTACKUP/DOWN`、`SCHED_BARRIER`、`PseudoLoopEnd`、`MOV_OR` 與 split 類別；[PADD／MOV 多槽 materialization](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PMultiSlotPseudoInstrInfo.td#L11-L57)則列多槽 PADD／MOV materialization。`PseudoLoopEnd` 是不自行發出的 meta；`MOV_OR` 卻是 compiler-only 但有實際 OR 編碼。`defm`、匿名 `def : Pat` 和 `defset` 都是來源宣告，不能當成獨立執行的 machine instruction。

JSON 每筆提供 `source_path,line_start,line_end,kind,name,raw_text,source_url`，另有 offset 與唯一 id；檔案列 SHA-256、Git blob SHA-1、行數、include 與 record_count。`name=null` 表示匿名宣告，`NAME # ...` 是未求值名字。可先搜尋 `VMUL`、`LDA_2D`、`VST` 或 `RegisterClass`，再依 kind 和檔名判別層級。raw_text **不包含外層 let／foreach 的完整上下文**，請開 immutable URL 查看其上方約束與 Uses／Defs；不可由缺少欄位推定無副作用。

這是 regex-source inventory，**不是 fully instantiated TableGen opcodes、展開 aliases／multiclasses 或 silicon complete ISA**。本次 deliberate omissions 包括四個 schedule／itinerary 檔、其他架構、共用基底的遞迴目錄、完整 C/API 函式目錄、實機語義與 timing。來源檔 include 仍保留便於後續追蹤。下一步應以 [暫存器](isa-registers.md)、[編碼](isa-encoding.md)、[資料型別](datatypes.md)交叉查核，再以實際編譯結果驗證 lowering；不可用本次靜態目錄替代硬體測試。

## 來源
- [AIE2P 版本界線](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20) — C 編譯目標巨集：arch 21；非指令語義。
- [純量算術與位元欄位](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L14-L359) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [地址更新、鎖與返回](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4245-L4420) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [AIE2P immediate 清單](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PImmOperands.td#L12-L70) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [scalar load 的 indexed／post-modify 形式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L706-L1006) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [scalar store 形式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4498-L4881) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [VLDA、UPS 與 FIFO pop](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L6769-L7425) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [VLDB unpack 與載入](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L8000-L8692) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [VST pack／SRS／FIFO 寫出](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L10246-L11049) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [2D load 與 signedness](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L493-L562) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [MV 向量加法與 VEC 累加器加法](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L5899-L6022) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [廣播、轉換與元素抽取](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L6034-L6436) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [比較與插入](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L6619-L6767) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [pack、選擇、shift、shuffle 與 SRS](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L9962-L10244) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [VTANH、unpack 與 UPS](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L11835-L11964) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [跳躍與呼叫形式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L432-L491) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [非阻塞串流與 TLAST](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4083-L4146) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [串流封包標頭形式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L1220-L1338) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [VMOV cascade 形式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L9131-L9437) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [VADDMAC 與 SCD 變體](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4946-L5421) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [VMUL 整數、BF 與 BFP 編碼](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L9606-L9758) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [VMAC 輸入與結果](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L8763-L8930) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [IR／intrinsic 到指令的選擇](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L261-L329) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [VecConf 控制字與 BF16 設定](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L30-L70) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [C helper：控制字與 8×8 wrapper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L37) — 只證明 C helper 如何組控制字及呼叫 builtin；不以函式數量當 ISA 數量。
- [C helper：INT4 unpack 展開](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L39416-L39447) — 特定 wrapper 的拆解反例；不推論所有 INT4 模式不存在，也不聲稱 native INT4 矩陣能力。
- [控制流、meta、MOV_OR 與 split pseudo](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrInfo.td#L26-L146) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [PADD／MOV 多槽 materialization](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PMultiSlotPseudoInstrInfo.td#L11-L57) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [MAC 純量乘加](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L1037-L1045) — 直接的來源定義與 operand／位元式；不推論 timing。
- [MSC／MUL 純量乘法](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4147-L4165) — 直接的來源定義與 operand／位元式；不推論 timing。
- [純量條件選擇](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4431-L4449) — 直接的來源定義與 operand／位元式；不推論 timing。
- [SUB 純量減法](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L4882-L4890) — 直接的來源定義與 operand／位元式；不推論 timing。
- [XOR 純量位元運算](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L11965-L11973) — 直接的來源定義與 operand／位元式；不推論 timing。

## 關聯
- [isa](isa.md)
- [compute](compute.md)
- [datatypes](datatypes.md)
- [mma](mma.md)
- [isa-registers](isa-registers.md)
- [isa-encoding](isa-encoding.md)

## 反向連結
- [spec-index](spec-index.md)
- [isa-registers](isa-registers.md)
- [isa-encoding](isa-encoding.md)
