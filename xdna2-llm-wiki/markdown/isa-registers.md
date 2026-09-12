# AIE2P 暫存器：類別、寬度、編碼與重疊視圖

分類：架構 · 來源查核 · 來源快照 2026-09-12

以固定 LLVM 後端逐層查核 GPR、地址、向量、累加器、mask、BFP 及特殊狀態，分開硬體編號、operand 類別與編譯器合成視圖。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 範圍與讀表方法

本系列固定在 llvm-aie `386ca5c6634a84bb224b7248e79df8edabf0722f`。[AIE2P 版本界線](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20)將 AIE2P 定為 **arch 21**，不是 arch 22 的 AIE2PS。本頁是公開編譯器來源的 ISA 參考，不是晶片完整程式設計手冊。下表的「數量」依明列成員或 `foreach` 範圍人工核對；不同類別常共用底層暫存器，不能逐列加總成硬體容量。

閱讀時分開三件事：`Register` 的名字與 `HWEncoding`、`RegisterClass` 的可用成員與容器／spill 位寬、指令 operand 的限定集合。[暫存器寬度與 GPR](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L82-L238)的 `AIE2PGPReg<bits<5>>` 是 **5-bit 暫存器選擇碼**，而 `AIE2PScalarRegisterClass` 的值寬是 **32 bits**。`bf16`、`f32` 出現在類別可承載型別中，只證明儲存／選擇模型，不能單憑它證明某種原生算術。

## 純量、地址與維度狀態

| 來源名稱／類別 | 來源展開後的命名視圖數 | 值／組合位寬 | 重要限制與例子 |
|---|---|---|---|
| `r0…r31`／`eR` | 32 | 32 | r3 的 GPR 編號為二進位 `00011` |
| `l0…l15`／`eL` | 16 組 | 64 | l0 的列印名是 `r1:r0`，不是新增 16 個獨立 64-bit 儲存體 |
| `p0…p7`／`eP` | 8 | 20，spill 32 | pointer operand 類別不是主機 64-bit 指標 |
| `m0…m7`、`dn0…dn7`、`dj0…dj7`、`dc0…dc7` | 各 8 | 各 20，spill 32 | modifier、dimension size、stride、count 分開 |
| `d0…d7`／`eD` | 8 組 | 80，spill 128 | d0 = m0、dn0、dj0、dc0 |
| `d0_3d…d3_3d`／`eDS` | 4 組 | 160，spill 256 | d0_3d = d0 與 d4；組語仍列印 d0 |
| `s0…s3`／`eS` | 4 | 32 | shift／conversion 專用類別不是任意 GPR |

GPR 與 spill 位寬見 [暫存器寬度與 GPR](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L82-L238)，地址組成與數量見 [地址、維度與 shift 暫存器](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L471-L601)。20-bit 類別的 `RegInfo<size=20, spill size=32, spill alignment=32>` 特別說明：有效位元與堆疊存放單位不同，不能把 spill 大小當成地址空間證明。2D／3D 描述符也不是 80／160-bit 整數 ALU 運算能力。

來源有一處易誤讀：GPR pair 上方註解說「starting at R16」，但實際迴圈是 `i=0…15`、子暫存器 `2*i` 與 `2*i+1`，且 eL 明列 l0 至 l15；本頁依 **定義** 而不是該註解計數。[固定用途與 GPR 配對](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L140-L191)

## W、X、Y：三種寬度，同一組向量內容

| 類別／視圖 | 數量 | 每個位寬 | 子暫存器關係 |
|---|---|---|---|
| `wl0…wl11`、`wh0…wh11`／`VEC256` | 各 12，共 24 個半部 | 256 | 同索引 low／high 合成 X |
| `x0…x11`／`VEC512` | 12 | 512 | x0 = wl0 + wh0 |
| `y0…y5`／`VEC1024` | 6 | 1024 | y0 = x0 + x1 |
| `q0…q3`／128-bit mask | 4 | 128 | ql／qh 是來源標註的 synthetic 64-bit 子視圖 |

數量、偶奇集合與別名關係見 [W／X／Y 與 mask 別名](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L603-L698)；精確位元位置見 [子暫存器位元切片](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L18-L80)：`sub_256_lo=<256,0>`、`sub_256_hi=<256,256>`，`sub_512_lo=<512,0>`、`sub_512_hi=<512,512>`。因此 y0 的 bits 0–255 對應 wl0、256–511 對應 wh0、512–767 對應 wl1、768–1023 對應 wh1。這是來源子暫存器映射的推導，不是記憶體 endian 或 lane 排列保證。

**工程推論：**若 x0 仍保存下一步輸入，就不能把 y0 當作不相干的暫存目的地。12×512、6×1024 與 24×256 都是同一份向量內容的不同分組；同時計入會三重計算。512-bit 可承載 64 個 i8 或 32 個 BF16 是位寬算術，不等於一條指令的矩陣形狀或有效乘加數。更多型別限制見 [資料型別](datatypes.md)。

## BM、CM、DM：累加器視圖與子集合

[BM／CM／DM 累加器別名](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L403-L469)以索引 0…4 建立四種 BM 半部：`bmll`、`bmlh`、`bmhl`、`bmhh`。結合 [暫存器寬度與 GPR](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L82-L238)的類別位寬可得：

| 累加器視圖 | 數量 | 每個位寬 | 關係與限制 |
|---|---|---|---|
| BM 四組半部 | 4×5 = 20 | 512 | mBMm 收集四組；不是向量 X 的別名 |
| `cml0…cml4`、`cmh0…cmh4` | 10 | 1024 | cml0 = bmll0 + bmlh0；cmh0 = bmhl0 + bmhh0 |
| `dm0…dm4`／`eDM`、`ACC2048` | 5 | 2048 | dm0 = cml0 + cmh0 |
| `eBMSLL/LH/HL/HH` | 各 4 | 512 | 此受限集合只取索引 0…3，不包含索引 4 |

`ACC2048` 可表示 `v64i32`、`v32i64` 或 `v64f32`，而非單 lane 2048-bit 精度。不要把有 3-bit 選擇欄位理解成八個可配置 DM：明列 eDM 只有五個。同樣地，mBMS 子集合與完整 mBMm 不同；指令使用哪個 operand class，決定可接受哪些寄存器。[通用類別與 spill 輔助模型](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L902-L977)。

## Mask、稀疏與 BFP 組合容器

[稀疏組合暫存器](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L700-L763)的 `qx0…qx3` 將 X 與 Q 組成 640-bit 視圖，`qy0…qy1` 組成 1280-bit 視圖。[指數與 BFP 組合暫存器](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L766-L900)另列 12 個 64-bit 指數視圖 `e0…e11`、12 個 576-bit `ex0…ex11` 與 6 個 1152-bit `ey0…ey5`；EX 組合 512-bit X 和 64-bit E，EY 再配對 EX。稀疏 mask 加指數的 `qex0…qex3` 為 704 bits，`qey0…qey1` 為 1408 bits。

這些非二次方位寬表示**資料加 metadata 的編譯器容器**，不能將 576 bits 說成 36 個原生 FP16 lane，也不能將 exponent byte 稱為一般原生 FP8 浮點乘法。它們與 X、Q、E 有重疊；配置稀疏或 BFP kernel 時，生命週期必須一起追蹤。BFP 格式名稱、API 型別、實際乘法 mode 仍要沿 [指令頁](isa-instructions.md)查核。

## 特殊狀態、固定 operand 與配置陷阱

| 狀態族 | 來源例子 | 讀法 |
|---|---|---|
| 程式／迴圈 | `lr`、`ls`、`le`、`lc`、`sp`、`core_id` | eSpecial20 明列 ls/lr/le/sp/core_id，不能把 lc 也默默列入該 20-bit 類別 |
| FIFO | `lf0`、`lf1`、`sf` 各為 1024-bit 組合；另有 `lfe` 512-bit | low/high 視圖共用內容，不是任意一般向量 bank |
| 控制 | `crSat`、`crRnd`、`crFPMask`、`crSRSMode`、`crUPSMode`、`crPackSize` | 來源類別不是各控制暫存器完整有效位元手冊 |
| 狀態 | `srCarry`、`srSS0`、`srMS0`、`srFPFlags` 等 | 必須回到指令的 Uses／Defs 及外層 let |
| 固定 GPR | r26 lock／FIFO、r28 TLAST、r31 SCD、r30 shiftx 等 singleton | 固定用途類別不是額外的實體暫存器 |

特殊、FIFO 與控制狀態見 [特殊、FIFO、控制與狀態暫存器](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L240-L400)；singleton 見 [固定用途與 GPR 配對](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L140-L191)。控制／狀態段註解還明說某些 `HWEncoding` 已不具決定性，由 operand encoder 生成固定 singleton 編碼；因此不能把列出的七位二進位值直接當作任何指令皆通用的編號。[Operand wrapper 定義](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegOperandDef.td#L12-L69)與 [共用 operand encoder 規則](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseRegisterInfo.td#L15-L39)顯示 `OP_mXv` 等 wrapper 會選擇依 class 命名的 encoder。

另有 `AIE2PVector1076FifoRegisterClass`，名稱含 1076，但實際 `AIE2PRegisterClass<1088,...>`；其 sub_ptr 20 + sub_fifo 1024 + sub_avail 32 = 1076。本文保留「1088-bit 編譯器配置容器／1076-bit 子欄位總和」的差別，不發明 1088-bit 實體 FIFO。[通用類別與 spill 輔助模型](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L902-L977)

## 可重現來源目錄與下一步

[下載完整 SOURCE DEFINITION 目錄](../spec-data/isa-source-index.json)：本版 16 個 `.td`、2,401 筆，包含來源路徑、起訖行、原文、commit、檔案 SHA-256 與 Git blob SHA-1。`def r #i` 是一筆來源宣告，不是 extractor 自動展開出的 32 個 opcode。目錄不展開 TableGen inheritance、foreach、multiclass 或 alias，也不是完整矽晶 ISA；本文表格的命名數量是另行人工解讀。

查詢順序建議為 operand 名稱 → wrapper → register class → 實際成員 → SubRegs → 指令 bit 欄位。再讀 [編碼](isa-encoding.md)與 [計算核心](compute.md)。本頁不給 ABI 可配置總量、保留暫存器完整清單、詳細延遲、硬體頻率或峰值；calling convention 與 spill 輔助宣告雖納入來源目錄，仍屬編譯器政策，不升格為物理規格。

## 來源
- [AIE2P 版本界線](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20) — C 編譯目標巨集：arch 21；非指令語義。
- [暫存器寬度與 GPR](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L82-L238) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [地址、維度與 shift 暫存器](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L471-L601) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [固定用途與 GPR 配對](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L140-L191) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [W／X／Y 與 mask 別名](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L603-L698) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [子暫存器位元切片](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L18-L80) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [BM／CM／DM 累加器別名](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L403-L469) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [通用類別與 spill 輔助模型](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L902-L977) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [稀疏組合暫存器](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L700-L763) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [指數與 BFP 組合暫存器](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L766-L900) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [特殊、FIFO、控制與狀態暫存器](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L240-L400) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [Operand wrapper 定義](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegOperandDef.td#L12-L69) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [共用 operand encoder 規則](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseRegisterInfo.td#L15-L39) — 共用 AIE 基底，只用於解讀 AIE2P 引用；不將其他 target 指令混入目錄。

## 關聯
- [isa](isa.md)
- [compute](compute.md)
- [datatypes](datatypes.md)
- [isa-encoding](isa-encoding.md)
- [isa-instructions](isa-instructions.md)

## 反向連結
- [spec-index](spec-index.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [isa-encoding](isa-encoding.md)
- [isa-instructions](isa-instructions.md)
