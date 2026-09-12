# AIE2P 編碼：16–128-bit VLIW、slot 欄位與立即數

分類：架構 · 來源查核 · 來源快照 2026-09-12

從 composite 與 slot 的兩層編碼推導真實 bit 位置，列出變長 bundle、operand 限制、signed／scaled immediate 與 pseudo 的邊界。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 先分清 bundle、slot 與來源宣告

本頁只讀固定版本 AIE2P（**arch 21**；[AIE2P 版本界線](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20)），不使用 AIE2PS arch 22。公開 TableGen 提供可核對的格式定義，但「類別數」「指令定義數」「助記符數」是不同統計；本頁不聲稱完整矽晶解碼空間。

編碼有兩層：slot instruction 定義 `alu`、`mv`、`vec` 等 payload，composite 再包入長度／格式選擇位元，形成完整 `Inst`。[Slot payload 與 Size](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSlots.td#L13-L113)為每種 slot 設獨立 `DecoderNamespace`，避免不同槽的相同位元互相衝突；[Composite 格式長度標記](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L12-L78)另以 `Formats` 解碼 namespace 表示 bundle。不能從單條 slot 的 `Size=4` 斷言它在所有組合中都獨占四 bytes。

## 所有變長 bundle 寬度與尾端標記

以下按來源 concatenation 的低位端列出；不是主機記憶體中的 byte dump。[Composite 格式長度標記](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L12-L78)與 [16-bit NOP 格式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormatsInclude.td#L11-L29)

| 完整 Inst 寬度 | Size（bytes） | 來源低位固定標記 | 讀法 |
|---|---|---|---|
| 16 | 2 | bits 3:0 = `0000` | NOP 專用，其他位元含 dontcare |
| 32 | 4 | bits 3:0 = `1000` | 28-bit instr32 再帶子格式 |
| 48 | 6 | bits 2:0 = `100` | 45-bit instr48；不是固定四位標記 |
| 64 | 8 | bits 3:0 = `0010` | 60-bit instr64 |
| 80 | 10 | bits 3:0 = `1010` | 76-bit instr80 |
| 96 | 12 | bits 3:0 = `0110` | 92-bit instr96 |
| 112 | 14 | bits 3:0 = `1110` | 108-bit instr112 |
| 128 | 16 | bit 0 = `1` | 127-bit instr128；不能把其低四位整組固定 |

例如 `AIE2P_instr48_Composite` 的 `Inst={instr48,0b100}` 只先決定長度族，仍須內層格式識別究竟是 LNG，或 LDA+LDB 等。16-bit NOP 則為 `{instr16,dontcare{11-1},0b0000}` 且 `instr16` 只佔一位：本頁保留 don't-care，不替它們編造唯一 canonical 機器碼。

## Slot payload 寬度與可用組合

| Slot 名 | payload bits | 最小獨立格式 | 不能從名字推論的事 |
|---|---|---|---|
| LDB | 17 | 32 bits | 名稱不是負載資料匯流排寬度 |
| ALU | 20 | 32 bits | 不等於只能做純量加法 |
| LNG | 42 | 48 bits | 長格式 slot，並非額外第七條可任意共發的 ALU |
| LDA | 20 | 32 bits | 可承載多種 load／地址／stream 形式 |
| MV | 22 | 32 bits | 包含部分向量算術 |
| ST | 20 | 32 bits | store 之外也有 stream／地址操作 |
| VEC | 26 | 32 bits | 不是所有 v-prefix 指令的唯一位置 |
| NOP | 1 | 16 bits | 特殊空操作格式 |

來源見 [Slot payload 與 Size](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSlots.td#L13-L113)與 [Pseudo 與 MultiSlot 屬性](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrFormats.td#L14-L43)。[128-bit 組合與全部 Ixx 格式清單](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L1109-L1216)列出 `I32_LDA/LDB/ALU/MV/ST/VEC`、`I48_LNG`、`I48_LDA_LDB`，一直到 `I128_LDA_LDB_ST_LNG_VEC` 與 `I128_LDA_LDB_ST_ALU_MV_VEC`。後兩者示範 LNG 與 ALU+MV 的格式替換關係，而不是把七種 payload 一次全塞進 128 bits。

128-bit 六槽格式原文是 `instr128={lda,ldb,st,0b0,alu,mv,0b1,vec}`，再接低位 `1`。位元數核算為 20+17+20+1+20+22+1+26+1=128。五槽長格式則以 42-bit LNG 取代 20+22 的 ALU/MV 部分，並更換辨識位元。這只證明格式存在；資料相依、register bank 限制及資源衝突仍可能禁止某個實際組合，本文不接管 cycle／itinerary 時序分析。

## 具體推導：add r1, r2, r3

[純量算術與位元欄位](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L14-L359)中 `ADD_alu_r_rr` 使用 `(outs eR:$d0)`、`(ins eR:$s0,eR:$s1)`，`alu={s0,d0,s1,0b0000,0b1}`。將 r2、r1、r3 的五位編號代入，得到 **20-bit slot payload**：

```text
s0      d0      s1      opcode
00010 | 00001 | 00011 | 0000 | 1
alu = (2<<15) | (1<<10) | (3<<5) | 1 = 0x10461
```

GPR 編號依 [暫存器寬度與 GPR](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L82-L238)。再由 [32-bit 單槽與 48-bit 組合](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L80-L204)的 `inst_alu={0b00010,alu,0b001}` 與 `Inst={instr32,0b1000}` 可推得獨立格式：

| Inst 位元 | 內容 | 此例 |
|---|---|---|
| 31:27 | ALU 子格式前綴 | `00010` |
| 26:7 | alu payload | `0x10461` |
| 6:4 | ALU 子格式尾綴 | `001` |
| 3:0 | 32-bit 長度標記 | `1000` |

```text
Inst = (2<<27) | (0x10461<<7) | (1<<4) | 8
     = 0x10823098
```

這是逐欄拼接的**靜態推導值**，未經 assembler／disassembler 執行驗證，不宣稱 bytes 的檔案排列或 relocation 規則。若同一 ADD 被包進較寬 bundle，payload 仍可查同一來源，但在完整 Inst 的位元位置會改變。`ADC` 的額外 carry Uses／Defs 在宣告外層 let，不能只讀 raw def 就漏掉隱含狀態。

## Signedness、縮放與立即數例子

[AIE2P immediate 清單](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PImmOperands.td#L12-L70)把 `c7s` 寫成 `txxs<7,i32>`、`c6u` 寫成 `txxu<6,i32>`；[signed 與 scaled immediate 基底](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.td#L34-L159)分別以 `isInt<n>`／`isUInt<n>` 與 signed／unsigned decoder 解讀。`i32` 是 operand 的編譯器型別，不代表 machine encoding 一定有 32-bit immediate。

| Operand | 編碼意義 | 可核對例子／邊界 |
|---|---|---|
| `c7s` | signed 7-bit | −64…63；−1 的七位表示為 `1111111` |
| `c6u` | unsigned 6-bit | 0…63；用於 ACQ immediate lock id 形式 |
| `c8s` | signed 8-bit | −128…127；ADD_NC 的 MV 形式 |
| `c7s_negated` | 取負後須符合 signed 7-bit | predicate 檢查 −Imm；不可沿用一般 c7s 邊界 |
| `c10s_step64` | 4-bit signed 商數，低六位為零 | −512…448、步長64；128→商2，96不合法 |
| `c6s_step4` | 4-bit signed 商數，低兩位為零 | −32…28、步長4 |
| `c19s_step64` | 13-bit signed 商數，stack adjustment | −262144…262080、步長64 |
| `c12n_step4` | 9-bit 負向 stack spill 縮放形式 | 有固定負號語義，不能當成一般 signed 9-bit offset |

以上數值範圍為 predicate 與縮放參數的算術推導。`ADD_add_r_ri` 的 immediate 是 7 bits，slot 排列 `{s0,d0,imm,0b110}`；`ADD_NC_mv_add_ri` 則是 `{dst(7),s0(5),imm(8),0b00}`。[純量算術與位元欄位](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L14-L359)同樣顯示「add-like」操作因 operand 類別、carry 行為及 slot 不同，不能只靠助記符前綴決定 encoding。

## Pseudo、alias 與 compiler-only 不是同義詞

[Pseudo 與 MultiSlot 屬性](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrFormats.td#L14-L43)把 `MultiSlot_Pseudo` 標為 `isPseudo=1`、`isCodeGenOnly=1`，並給 `materializableInto`。[PADD／MOV 多槽 materialization](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PMultiSlotPseudoInstrInfo.td#L11-L57)的 `PADD_imm_pseudo` 可選 PADDA、PADDB、PADDS 形式；一筆 pseudo 不應額外計為一條原生 opcode，也不保證一定只選第一個候選。

[控制流、meta、MOV_OR 與 split pseudo](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrInfo.td#L26-L146)區分 `PseudoRET→RET`、`PseudoJL→JL_lng`、`PseudoJZ→JZ` 等 pre-scheduling expansion；`PseudoLoopEnd` 則是 meta，註解明說不自行發出。另一方面，`MOV_OR` 雖為 `isCodeGenOnly=1`，卻直接具有 ALU 位元式 `{s0,d0,s0,0b0101,0b1}`，實作 `or dst,src,src`。因此 compiler-only 不必然等於沒有編碼，pseudo 名稱也不等於組語 alias 全集。

`OP_` operand wrapper 還可能使用 class-specific encoder（[Operand wrapper 定義](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegOperandDef.td#L12-L69)、[共用 operand encoder 規則](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseRegisterInfo.td#L15-L39)），不能把 X 暫存器名字中的十進位數無條件塞到任意欄位。此頁的 ADD 範例刻意只用直接 GPR 編號，未替複合 operand 省略 encoder 驗證。

## 來源索引、重現與未完成驗證

[完整 JSON 來源目錄](../spec-data/isa-source-index.json)保留 2,401 筆 lexical source records：class 167、def 2,163、defm 59、defset 6、multiclass 6。它們不是 fully instantiated TableGen opcodes、展開 aliases／multiclasses，亦不是 silicon complete ISA。檔案與每筆宣告都有 immutable URL；所有選定 `.td` 的 bytes 必須與 pinned Git blob 一致才可生成。

命令為 `python3 wiki/extract_isa.py --output wiki/spec-data/isa-source-index.json`。工具唯讀來源樹，不執行 TableGen 或 toolchain 安裝；JSON 順序固定且無時間戳，方便 byte-for-byte 重現。regex 會略過註解、字串與 code literal，保留巢狀、匿名宣告，但不求值外層 let／foreach；完整語义仍須回到連結的檔案上下文。

尚未驗證所有 emitter／decoder C++、relocation、bundle 合法性與 silicon reserved encoding。本文不提供可直接刷入核心的 binary、所有 don't-care 的標準填值、排程延遲或硬體時脈。請接著讀 [暫存器](isa-registers.md)與 [指令族](isa-instructions.md)，將來源結構、compiler lowering 與晶片行為分開。

## 來源
- [AIE2P 版本界線](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20) — C 編譯目標巨集：arch 21；非指令語義。
- [Slot payload 與 Size](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PSlots.td#L13-L113) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [Composite 格式長度標記](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L12-L78) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [16-bit NOP 格式](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormatsInclude.td#L11-L29) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [Pseudo 與 MultiSlot 屬性](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrFormats.td#L14-L43) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [128-bit 組合與全部 Ixx 格式清單](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L1109-L1216) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [純量算術與位元欄位](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenInstrInfo.td#L14-L359) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [暫存器寬度與 GPR](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L82-L238) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [32-bit 單槽與 48-bit 組合](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PCompositeFormats.td#L80-L204) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [AIE2P immediate 清單](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PImmOperands.td#L12-L70) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [signed 與 scaled immediate 基底](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseInstrInfo.td#L34-L159) — 共用編碼／解碼 predicate；不是另一個架構的 ISA 清單。
- [PADD／MOV 多槽 materialization](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PMultiSlotPseudoInstrInfo.td#L11-L57) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [控制流、meta、MOV_OR 與 split pseudo](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrInfo.td#L26-L146) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [Operand wrapper 定義](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegOperandDef.td#L12-L69) — 固定版本 TableGen 來源定義；不是硬體實測或完整 ISA 保證。
- [共用 operand encoder 規則](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/AIEBaseRegisterInfo.td#L15-L39) — 共用 AIE 基底，只用於解讀 AIE2P 引用；不將其他 target 指令混入目錄。

## 關聯
- [isa](isa.md)
- [compute](compute.md)
- [isa-registers](isa-registers.md)
- [isa-instructions](isa-instructions.md)

## 反向連結
- [spec-index](spec-index.md)
- [isa-registers](isa-registers.md)
- [isa-instructions](isa-instructions.md)
