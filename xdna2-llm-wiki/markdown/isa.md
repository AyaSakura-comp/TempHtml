# ISA 閱讀：從 AIE2P header 追到後端原語

分類：架構 · 來源查核 · 來源快照 2026-09-12

以架構 guard、wrapper、builtin、instruction pattern 與排程模型建立證據鏈，不用函式名稱冒充矽晶片規格。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 公開原始碼能證明到哪一層

**來源事實：**[Peano README](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L1-L66)將 XDNA2 對應到 AIE2P target；[version header](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20)明列 `__AIE_ARCH__ = 21`。這讓讀者能選對 backend 和 header，但不表示這些檔案是一份涵蓋所有未公開指令、例外與時序的完整矽晶片手冊。

本文把 ISA 理解為機器原語與程式可見契約的查核入口。看到一個功能，應依序問它是儲存型別、C++ 合成、LLVM intrinsic、instruction selection，還是已觀察的機器輸出。本頁只有前述原始碼與測試描述，沒有編譯產物及硬體實驗。

| 查核層 | 可支持的結論 | 不可直接推論 |
|---|---|---|
| 型別與 wrapper | 接受哪些輸入、如何合成 | 必為單一機器指令 |
| Builtin 與 pattern | 後端預定選擇的原語 | 所有前端都會選到 |
| 組語產物 | 特定選項下的實際展開 | 晶片每次都以固定耗時完成 |
| 硬體實驗 | 指定環境與輸入的觀測 | 所有分區及模型都相同 |

## Scalar、SIMD 與 VLIW 的讀法

[README](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L1-L66)說明每個 VLIW bundle 可指定多個功能單元同時開始執行，並由編譯器管理外露管線的讀寫時點。[scalar register class](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L109-L132)和[向量 patterns](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L295-L307)則顯示後端分別處理一般暫存器及向量／累加器操作。這些層次不是互斥：scalar 地址更新可以是 VLIW 排程的一部分，SIMD 算術也可以占用其中的功能資源。

**工程推論：**LLM kernel 若只有一條長累加相依鏈，即使有許多可用資料，也不必然能把每個 bundle 填滿。增加獨立 C 區塊、預先準備地址或移開轉換，都是可能的排程手段；但需以真實組語與資源報告評估，不由語法外觀判定有效。

## 一條可靠的追蹤路徑

```text
API shape / dtype / macro
          ↓
C++ specialization / inline wrapper
          ↓
builtin 與 configuration bits
          ↓
LLVM intrinsic → instruction pattern
          ↓
實際組語與量測（本次未執行）
```

例如[BFP16 header](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L38830-L38885)把 `mul_8x8_8x8T` 送入 `BFP576_BFP576_ACC2048` builtin，再由[BFP pattern](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L443-L460)選到 BFP VMUL／VMAC。這比只看 `mmul` 名稱更強，仍沒有證明每次完整 kernel 呼叫的週期數。

相反地，[INT4 wrapper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L39416-L39509)雖然標為 `INTRINSIC`，函式內仍含 unpack、shuffle 及多次整數原語。巨集名稱只是介面包裝，不是單指令保證；同名 overload 若參數 signedness 或形狀不同，也應逐一追蹤。

## Legalization 可能改變算術路徑

[AIE2P legalizer](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PLegalizerInfo.cpp#L214-L255)讓 scalar BF16 multiply 經向量操作再抽回 scalar，而 scalar FP32／FP64 multiply 有 libcall 路徑。這表明 C 語言能寫某個型別與 NPU 有同型別原生向量乘法，是不同問題。Libcall 被列為 lowering 選項，也不保證每套部署環境都能成功連結它。

[FP32 API config](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/config.hpp#L22-L24)分開 emulation 與 native support；[預設 float wrapper](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L54935-L54942)及[部分積實作](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L53918-L53994)又顯示 BF16 分解式模擬。對 LLM，保留 float 輸出不能當作維持所有 FP32-input 運算精度的證據，應與 [數值型別](datatypes.md) 的表示及誤差契約一起閱讀。

## Configuration 與靜態 signedness 疑點

[i8 header 的 control 組合](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L58)把 signX 放在 bit 9、signY 放在 bit 8；[MLIR 測試](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/test/Conversion/AIEVecToLLVM/matmul-aie2p.mlir#L169-L232)分別檢查四種 signedness，並將 signless i8 預設為 signed。位元容器相同，不代表有號與無號乘法的值相同，量化權重的解碼規則必須一路帶到這裡。

**未執行的靜態疑點：**既有型別稽核指出 [i16 decoder](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4895-L4904)在 `8×2×8` 分支直接回傳 conf=24，而 [rewrite](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4980-L5048)沿用 conf。對照上述 sign bits，這個常數沒有合入 signed 設定，因此需要含負數的 regression 驗證。這不是已展示的晶片 bug，也不是宣稱 C++ signed int16 API 普遍失效；疑點只屬於這份 MLIR 直接路徑。

## 排程表不是延遲保證

[VMAC itinerary](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9031-L9064)的 destination timing、來源 operand timing 與 bypass 各有用途；不能挑出某個欄位，改寫成「每次 mmul 固定耗費若干週期」。同一 helper 可能含多條指令，實際 kernel 還有載入、shuffle、控制及同步。README 的示例延遲也不應轉貼成 AIE2P 的實測規格。

**工程推論：**應先做靜態工作量帳，再取得組語確認展開、寄存器配置與排程，最後才用硬體資料檢查停頓。每一步提升的是不同證據強度。

閱讀 instruction pattern 時，也應區分位元容器與算術解釋。有些 intrinsic signature 為了配合暫存器形式，將資料 bitcast 成另一種向量型別；若只看函式參數的整數寬度，可能誤把傳遞方式當成真正的乘法型別。應沿 configuration、原始輸入與最終原語一起讀，不能任選其中一層作 dtype 結論。

另一個重要問題是前端與後端的責任分界。高階形狀合法，並不證明特定 lowering 已涵蓋所有符號組合；機器原語存在，也不代表每種前端表示都會選到它。對疑似缺陷應寫出最小形狀、預期數學值、符號條件及實際選擇路徑，讓後續驗證能隔離問題，而不是把所有矩陣錯誤歸因為架構限制。

版本比較同樣需要固定觀察層。若更新後只改了 wrapper 的展開，應描述工具鏈路徑變化；若只是測試新增預期，還不能稱硬體新增能力。保存原始連結、編譯選項與輸入契約，才能在下一次查核中辨識究竟哪個假設改變。FileCheck 裡的預期指令數是測試作者的契約，本次只閱讀它，並未證明該測試在這組 snapshots 可通過。

## 架構隔離、陷阱與閱讀檢核

[共用 typedef header](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L580-L643)將 `_Float16`、float8 和 bfloat8 放在 arch 22 guard；它們出現在同一 repository，不代表 arch 21 可用。AIE2PS 的格式與 MX 支援也不應借名移植到 XDNA2。未找到某模式僅代表此查核範圍缺乏證據，不是所有工具鏈或未公開硬體的不存在證明。

- 固定 commit、target triple、arch guard 與 API macro，再選 overload。
- 讀到 builtin 後繼續找 instruction pattern，不以 inline 函式名收工。
- 遇到 conversion、unpack 或部分積，保留其算術與布局成本。
- 對測試標明「已閱讀預期」，對疑點標明「未重現」，對實測才報硬體數據。
- 跨 repository snapshots 未驗證能共同建置，ABI、版本 guard、runtime libcall 及全套 ISA 邊界仍是缺口。

這種讀法適合比較 LLM 後端：先比較真正的數值路徑，再比較工作量與搬移，而不是把前端相同的 `matmul` 字樣當作相同機器程式。

## 來源
- [Peano README：架構與後端](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L1-L66) — XDNA2 target triple、in-order exposed-pipeline VLIW、編譯器責任及成熟度限制。示例 timing 非本次硬體規格。 僅靜態來源查核。
- [AIE2P 版本標頭](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20) — arch 21 與 model 巨集；不可混用 arch 22。 僅靜態來源查核。
- [AIE2P 後端：scalar register class](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PRegisterInfo.td#L109-L132) — 一般暫存器類別存在；不等於獨立 scalar 執行緒或 FP32 原生乘法。 僅靜態來源查核。
- [AIE2P patterns：寬向量 BF16](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L295-L307) — VEC1024／ACC2048 的 BF16 VMUL/VMAC selection，容器位寬不等於矩陣工作量。 僅靜態來源查核。
- [Peano：BFP16 matrix builtin](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L38830-L38885) — 8×8×8T 傳遞 mantissa/exponent 至 BFP576 builtin，回傳 accfloat。 僅靜態來源查核。
- [AIE2P patterns：BFP VMUL／VMAC](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PInstrPatterns.td#L443-L460) — BFP576 intrinsic 到機器 pattern；不是 helper 或 kernel 耗時。 僅靜態來源查核。
- [Peano：8b×4b wrapper 展開](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L39416-L39509) — 4×16×16 先 unpack/shuffle，再兩次 4×8×16 int8 算術；不是單一 INT4 MMA 證據。 僅靜態來源查核。
- [AIE2P legalizer：scalar FP 路徑](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PLegalizerInfo.cpp#L214-L255) — Scalar BF16 MUL 向量化後抽取；FP32/FP64 MUL 有 libcall。不能保證部署可連結。 僅靜態來源查核。
- [AIE API：FP32 feature guards](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/config.hpp#L22-L24) — FP32 emulation guard 與 native support=0 分離；非所有 FP32 表示皆不支援。 僅靜態來源查核。
- [Peano：float wrapper 預設選擇](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L54935-L54942) — mul_elem_32(v32float,...) 預設 accuracy_safe。 僅靜態來源查核。
- [Peano：FP32 的 BF16 部分積](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L53918-L53994) — Safe path 九個部分乘積加總，另有殘差/轉換；與單次 BF16 truncation 不同。 僅靜態來源查核。
- [Peano：i8 matrix builtin 與 sign bits](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L58) — 8×8×8 integer builtin、configuration 的 signX/signY；sign control 與 bit container 分開。 僅靜態來源查核。
- [MLIR FileCheck：i8 signedness 預期](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/test/Conversion/AIEVecToLLVM/matmul-aie2p.mlir#L169-L232) — 四組 configuration 與 signless 預設 signed；只讀預期、未執行測試。 僅靜態來源查核。
- [MLIR i16 decoder：未重現疑點](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4895-L4904) — 8×2×8 回傳固定 conf=24，未像 i8 合入 sign bits；靜態疑點，不是晶片 bug。 僅靜態來源查核。
- [MLIR i16 rewrite：conf 沿用](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4980-L5048) — 取得 decoded conf 並加入 padded operands；用於限定 signedness 疑點所在路徑。 僅靜態來源查核。
- [AIE2P itinerary：VMAC operand timing](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/llvm/lib/Target/AIE/aie2p/AIE2PGenSchedule.td#L9031-L9064) — 來源／目的 operand timing 與 bypass 是 scheduler 模型；不可讀成 mmul 固定耗時或 issue-rate。 僅靜態來源查核。
- [Peano：arch 22 FP16／FP8 guard](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aiebase_typedefs.h#L580-L643) — _Float16、float8、bfloat8 在 arch 22 區塊；不可移植為 arch 21 支援。 僅靜態來源查核。

## 關聯
- [compute](compute.md)
- [datatypes](datatypes.md)
- [mma](mma.md)
- [compiler](compiler.md)
- [validation](validation.md)
- [sources](sources.md)

## 反向連結
- [compute](compute.md)
- [isa-registers](isa-registers.md)
- [vliw-pipeline](vliw-pipeline.md)
- [instruction-cycles](instruction-cycles.md)
- [software-pipelining](software-pipelining.md)
- [isa-encoding](isa-encoding.md)
- [isa-instructions](isa-instructions.md)
- [datatypes](datatypes.md)
- [mma](mma.md)
- [glossary](glossary.md)
