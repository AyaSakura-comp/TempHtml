# 除錯與證據分級：不要把 fallback 當 NPU 成功

分類：程式設計 · 來源查核 · 來源快照 2026-09-12

建立從生成、編譯、載入、同步到數值的檢查順序，記錄 signedness 舊路徑風險及測試未執行的邊界。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 先為失敗定位層級

「結果不對」可能源於生成式 Python、Transform 匹配、buffer 配置、核心連結、runtime ABI、資料可見性或數值策略。應先保留第一個失敗訊息與來源快照，不要一開始就更換驅動、清除全部環境或提高容差。[IRON 編譯階段與產物](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/compilation_stages.md) 的階段圖提供從配方、MLIR、磁碟產物到 NPUKernel 的檢查順序；每一層成功只表示可以繼續往下查。

| 層級 | 保存的證據 | 不能單憑它宣稱 |
|---|---|---|
| 原始碼／配方 | commit、Transform、形狀與 dtype | 硬體支援已驗證 |
| 編譯 | 完整命令、IR、連結產物 | 已提交 NPU |
| 執行期 | runtime、ABI、完成／錯誤狀態 | 數學結果正確 |
| 數值 | 參考值、容差、有限值、邊界輸入 | 未測形狀亦正確 |
| 效能 | 暖機、同步、階段時間與裝置 | 普遍最快或純 NPU |

本頁命令都只是查核過的示例，沒有執行編譯、模型或 NPU 測試。

## 先看 IR，再看產物與快取

[IRON vector_scalar_add 範例](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_examples/basic/vector_scalar_add/vector_scalar_add.py) 可在指定目標後輸出 MLIR。以下以研究根目錄為起點，未執行：

```bash
cd sources/mlir-aie
python3 programming_examples/basic/vector_scalar_add/vector_scalar_add.py \
  --dev npu2 --emit-mlir
```

檢查 `aie.device` 的世代、runtime_sequence 引數、FIFO 深度及 core 位置，能先發現錯誤的假設。[aiecc 產物與建置圖](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/tools/aiecc/README.md#L29-L49) 另提供 `--emit-dot` 顯示建置圖而不編譯，以及 checkpoint／resume 保存失敗邊界；這些是編譯工具功能，不是要求在本次工作重建工具鏈。

[IRON 編譯階段與產物](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/compilation_stages.md) 說明 recipe 與 artifact freshness 分開判斷，應保存 cache 位置與命中訊息，而不是認為舊產物一定對應新程式。繞過 JIT metadata 的外部產物載入，也須由作者核對 tensor 大小與 dtype。npu2 的 Triton ELF 和 IRON 預設 xclbin／insts 不能按副檔名猜測互通，需對照 [runtime](runtime.md)。

## Timeout 與 NaN 未必是算術指令問題

[核心資料記憶體與 stack](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L9-L153) 的核心 SRAM 同時容納 stack、FIFO buffers 和靜態資料。stack 太小可能覆寫 buffer；靜態資料則需要連續空間，不能只加總碎片。應讀 linked core 的 measured stack／data 資訊與連結配置；無法測量的外部物件也不能假設需求為零。

[Triton 的 Peano 版本鎖](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/utils/peano-requirements.txt) 註解記載工具鏈混版曾使 stack 問題表現成 NaN，這是版本配對的重要警示，不是本機重現。遇到等待不結束，還要檢查 FIFO acquire／release、輸入及輸出物件數、DMA 邊界與 TaskGroup 回收；[IRON Runtime tasks](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2d/RuntimeTasks.md) 要求未等待的工作必須受已等待工作依賴覆蓋。單純提高 timeout 或刪掉 wait 可能只是掩蓋錯誤。

## 舊式 signedness 路徑列為靜態風險

[AIEVec 舊式直接 matmul lowering](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4849-L5048) 保留的 `aievec.matmul_aie2p` 直接 lowering 中，i8 分支把 signX、signY 放入控制字；i16 的 `8×2×8 → acc32` 分支卻回傳固定 `24`，rewrite 沿用該值。[Peano AIE2P 控制字](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L22) 定義 signX 在 bit 九、signY 在 bit 八，因此這個固定值未帶兩個 signed 位元；相同基本模式的雙 signed 控制字應為 `24 | 512 | 256 = 792`。

這是來源交叉檢查的風險，不是已動態重現的缺陷，更不證明所有 IRON／AIR 路徑都經過這個 legacy conversion。C++ API 有 signed overload，不能替這條 MLIR 路徑背書；也不能反向宣稱硬體沒有 signed i16 乘法。後續獨立驗證宜用負數、正負交錯與相同 bit pattern 的 unsigned 輸入，並核對實際產生的控制字。

即使 signedness 正確，累加寬度也可能溢位。例如兩項 `(-32768)×(-32768)` 相加達到二的三十一次方，超出 signed acc32 正值範圍。數學參考值、模數截斷、飽和與輸出轉型需分開定義，不能只寫「支援 INT16」。

## 排除假陽性：勾選、fallback 與 skip

[Dashboard 勾選產生邏輯](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/generate_readme.py#L187-L239) 的 dashboard 勾號來自 transform 檔存在，並非測試執行。[Qwen helper 例外與 fallback](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L732-L824) 又顯示模型 helper 在 Triton 失敗後可 fallback 到 PyTorch；必須保存 warning 及實際裝置，不能因正常退出便填上「NPU 通過」。融合鏈與 fused attention 並非全部由相同例外處理包住，錯誤也可能直接往外傳。

[Qwen CLI 與正確性閘門](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/qwen_inference.py#L349-L443) 的單次 forward 只用 cosine 零點九五閘門，top-1 不一致不會自動判失敗；generation 路徑又沒有同樣斷言。工程上應另查有限值、逐層差異及 token／任務品質，尤其純粹 `cos_sim < threshold` 不是對 NaN 的完整拒絕條件。

[共享緩衝測試來源](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/zero_copy/shared_buffer_test.py) 的七十七退出碼表示環境不足而跳過；零拷貝還需看 in-place／staged 計數，值相同無法排除內部拷貝。因此證據表應保留未執行、跳過、失敗、符合門檻四種狀態，不能把它們都折成一個綠勾。

## Trace 是解釋工具，不是萬用保證

[IRON trace 設定](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-4/section-4b/README.md#L17-L120) 以 `Program.enable_trace` 配置選定 Worker、事件路由與主機 trace buffer。觀察 lock stall、stream stall 或向量活動，可用來追問資料流哪個環節受阻，但需匹配 AIE2P 事件定義；不能把另一世代的原始事件編號直接搬入。trace 本身也佔資源，應記錄 buffer 大小與是否截斷。

[IRON HSA runtime](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/hsa_runtime.md) 明列 IRON HSA 尚不支援 trace capture，且單一 queue 需由呼叫者序列化；不能把 XRT 的 trace 教學直接套到 HSA。最終報告應同時附 host 時間、完成同步、數值比較與裝置活動，而不是只截一張有波形的圖。這次僅整理來源與待驗證事項，未產生 NPU trace，也未動到來源、服務或相依套件。

## 讓問題報告能由下一位讀者接手

最小重現紀錄應包含固定來源版本、完整相依版本、目標世代、輸入生成方式、真實與補齊形狀、型別、選定分支、錯誤原文及第一個不符合預期的階段。若只附模型最後輸出的文字，接手者無法判斷是位置偏移、數值累積、fallback 還是同步問題。若只附執行時間，亦無法排除測到的是編譯或主機 staging。

縮小問題時保留原本的資料符號、尾端形狀與等待關係，不要把引發問題的負數全部換成正數，或把非整除尺寸換成漂亮的整數倍後便宣告正常。可將較小輸入的參考結果和每階段中間值保存為獨立證據，並清楚區分哪些來自實際執行、哪些只是原始碼推導。這樣的報告比籠統的「支援／不支援」更能指出下一個驗證步驟。

## 來源
- [IRON 編譯階段與產物](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/compilation_stages.md) — JIT、recipe / artifact hash、核心 ELF 與預設 XRT 載入。
- [IRON vector_scalar_add 範例](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_examples/basic/vector_scalar_add/vector_scalar_add.py) — 查核 CLI 與 JIT generator；命令未執行。
- [aiecc 產物與建置圖](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/tools/aiecc/README.md#L29-L49) — xclbin 指令流與 full-ELF 為不同輸出方案。
- [核心資料記憶體與 stack](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L9-L153) — stack、FIFO buffer、靜態資料共用 SRAM；需連續空間。
- [Triton 的 Peano 版本鎖](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/utils/peano-requirements.txt) — 指定 wheel 版本；註解記載混版曾使 stack 問題表現成 NaN。
- [IRON Runtime tasks](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2d/RuntimeTasks.md) — fill / drain、TaskGroup、完成依賴與資源回收。
- [AIEVec 舊式直接 matmul lowering](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Conversion/AIEVecToLLVM/AIEVecToLLVM.cpp#L4849-L5048) — i16 8×2×8 固定 conf=24 的 signedness 靜態風險；未動態重現。
- [Peano AIE2P 控制字](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_vmult.h#L15-L22) — signX / signY 位於 bit 9 / 8；API 不等於所有 lowering 已驗證。
- [Dashboard 勾選產生邏輯](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/generate_readme.py#L187-L239) — exists() 檢查 transform 檔案，不執行 NPU 測試。
- [Qwen helper 例外與 fallback](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L732-L824) — linear / norm / SwiGLU / add / softmax helper 的 try / except。
- [Qwen CLI 與正確性閘門](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/qwen_inference.py#L349-L443) — 預設 npu / max-tokens=0；cosine 0.95，不要求 top-1；generation 不同。
- [共享緩衝測試來源](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/zero_copy/shared_buffer_test.py) — 雙向 mapping、DLPack、pool lifetime、in-place / staged 計數與 skip。
- [IRON trace 設定](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-4/section-4b/README.md#L17-L120) — enable_trace、事件與 DDR trace buffer；不可混用不同世代事件值。
- [IRON HSA runtime](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/hsa_runtime.md) — PDI + insts、AIE ROCR、queue fences、同步與限制。

## 關聯
- [compiler](compiler.md)
- [runtime](runtime.md)
- [qwen-case](qwen-case.md)
- [validation](validation.md)
- [datatypes](datatypes.md)
- [synchronization](synchronization.md)

## 反向連結
- [memory](memory.md)
- [synchronization](synchronization.md)
- [compiler](compiler.md)
- [triton](triton.md)
- [runtime](runtime.md)
- [performance](performance.md)
- [validation](validation.md)
