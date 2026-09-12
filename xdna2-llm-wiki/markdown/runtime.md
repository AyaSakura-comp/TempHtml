# 執行期與共享緩衝：格式、ABI、可見性

分類：程式設計 · 來源查核 · 來源快照 2026-09-12

比較 XRT、IRON HRX 與 HSA，並以零拷貝範例解釋映射、同步、生命週期和 dispatch 證據。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## Runtime 接受的是契約，不只是檔案

主機 runtime 必須知道載入何種產物、如何解讀指令流、引數的順序與大小，以及哪個緩衝對裝置可見。共享 DRAM 只描述物理記憶體背景，不保證 CPU、GPU、NPU 的虛擬位址、allocator、handle 或同步協定互通。把 PyTorch tensor 的數字指標直接塞進另一個 runtime，並沒有完成映射與權限設定。

[IRON 編譯階段與產物](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/compilation_stages.md) 說明 IRON JIT 可從 runtime_sequence metadata 檢查 tensor 大小；直接建立 `NPUKernel` 載入外部產物則沒有同樣的配方與檢查。即使檔案能載入，作者仍要核對形狀、dtype、引數位置及讀寫方向。副檔名不是完整 ABI，必須連生成工具與 host 呼叫一起保存。

## 三種後端，兩套選擇變數

| 使用流程 | 選擇方式 | 本快照主要載入物 |
|---|---|---|
| IRON XRT | `NPU_RUNTIME=xrt` | xclbin 與 insts.bin |
| IRON HRX | `NPU_RUNTIME=hrx` | 相同 xclbin 與 insts.bin |
| IRON HSA | `NPU_RUNTIME=hsa` | PDI 與 insts.bin |
| Triton XRT | `NPUDriver("xrt")` | npu2 預設 ELF，npu1 預設 xclbin |
| Triton HSA | `NPUDriver("hsa")` | PDI 與 insts.bin |

此表交叉依據 [IRON HRX runtime](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/hrx_runtime.md)、[IRON HSA runtime](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/hsa_runtime.md)、[Triton runtime 與格式選擇](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/amd_triton_npu/backend/driver.py#L1093-L1133)。Triton 裸 `NPUDriver()` 另讀 `AMD_TRITON_NPU_RUNTIME`，不要與 IRON 的 `NPU_RUNTIME` 混用。IRON 文件的「PDI 不是 standalone run input」描述預設 XRT 路徑；不能用它否定另一份文件明確實作的 HSA PDI consumer。逐核心 ELF、指令 ELF、完整裝置 ELF 也需區分。

## HSA 不是任何 ROCm 都有的能力

[IRON HSA runtime](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/hsa_runtime.md) 要求 ROCR 具有 AIE agent 與 AIE dispatch packet 支援，且依賴 amdxdna 核心驅動；無 XRT userspace 不等於無驅動。[Triton-XDNA：編譯與 runtime](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) 還要求 AIE extension header 和相符的 `libhsa-runtime64`，並記載與 ROCm PyTorch 共存時，先載入的同名函式庫可能壓過後續 rpath 搜尋。

這些是環境條件，不是本機能力宣告。本頁未偵測、未安裝、未替換 ROCm，也不建議照搬 nightly 安裝或 preload 命令。將來實驗應在受控環境記錄實際載入的函式庫、AIE agent、標頭與編譯器版本。路徑找得到只能證明 discovery，不能證明 ABI 完整或 dispatch 已成功。

## 零拷貝要同時證明三件事

[共享緩衝測試來源](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/zero_copy/shared_buffer_test.py) 測試 NPU 擁有頁面而 HIP 映射，以及 HIP 擁有頁面而 NPU 映射的兩個方向。buffer 指定一種 NPU runtime，不能同時要求 XRT 與 HSA 映射彼此的頁面；同一程序使用兩種 runtime 的不同 buffers，是另一回事。HSA 下，HIP 配置時還必須先說明要分享給 NPU，普通 pinned allocation 不能事後任意升級。

工程上應把條件拆為：一、映射與權限讓 consumer 能存取；二、producer 的寫入已完成且可見；三、直到所有 consumer 結束前都保留儲存與相關 handle。DLPack 能描述某個 tensor view，不會自動把任意配置變成 NPU 可用緩衝。關閉物件與釋放記憶體也不總是同一件事，因為 pool 可能保留頁面供重用。

## 等待、可見性與生命週期

[零拷貝分階段基準](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/zero_copy/zero_copy_benchmark.py) 的 shared 路徑讓 GPU `torch.matmul(..., out=...)` 直接寫入共享頁面，仍保留 GPU stream synchronize，之後才讓 NPU 讀取。零拷貝減少的是 staging，不是資料依賴。若移除 fence，只因測量程式前一步恰好同步而「看來正確」，移植到其他排程便可能讀到未完成內容。

IRON HRX 文件明列 host-mapped buffer 的 flush／invalidate，以及 chain 內 execution 加 memory barrier；IRON HSA 則使用 in-order queue 和 system-scope acquire／release fences，並記載其 ROCR doorbell 在該實作中阻塞至完成。兩者的單一程序 dispatch 都要求序列化呼叫。這些條件不能泛化為每個 HSA 實作皆同步，也不能因某個 sync hook 是空操作就推論沒有順序需求。

[共享緩衝測試來源](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/zero_copy/shared_buffer_test.py) 另檢查逃逸的 torch、NumPy、DLPack view 與 pool 重用。應讓所有 view 和執行中的工作有明確生命週期；避免把已關閉 buffer 的裸指標留下，等待另一個配置重用相同頁面。

## 如何公平閱讀零拷貝結果

[零拷貝分階段基準](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/zero_copy/zero_copy_benchmark.py) 在同一 runtime 內比較 copy 與 shared，分列 GPU 計算、handoff、NPU dispatch 與回傳。跨 runtime 時，XRT 把兩個 add 接成一次 multi-launch ELF，HSA 則提交兩次；XRT 又可宣告固定 addends，HSA 普通 ABI 不具有相同靜態引數提示。因此總時間差不是純粹的記憶體拷貝差。

[零拷貝共用 add chain](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/zero_copy/common/add_chain.py) 提供相同 f32 add 核心與配方，讓算術可對照，但不消除提交方式差異。HSA 測試以 `hsa_dispatch_counts()` 的差值確認三個運算元 in-place、零個 staged；數值相同本身不足以排除 staging。這些測試在本次僅閱讀，沒有執行；退出碼七十七代表環境不具備而跳過，不可記為通過。延伸比較應參考 [異質推論](heterogeneous.md) 與 [效能](performance.md)，而不是從共享記憶體名稱直接推算加速比。

## 將共享緩衝契約寫進介面

對需要跨裝置交接的函式，文件應明列誰配置、誰寫入、誰等待、誰回收，並說明回傳的是值的拷貝，還是仍依附原始儲存的 view。若回傳的是 view，呼叫端就不能只保留 tensor 的形狀資訊，而把其背後資源視為可立即重用。緩衝池雖可攤薄映射成本，也會讓「同一數字地址再次出現」失去診斷意義；地址相同不證明同一次配置仍然有效。

主機可見性和跨裝置完成順序也應分開寫。例如 producer 的非同步工作尚未結束時，consumer 即使具有合法映射仍可能讀到舊資料；反過來，已等待 producer 完成，也不代表 consumer 使用的是同一批實體頁面。測試需要把相同頁面、完成事件與正確結果串成證據鏈，而不是只檢查其中一項。

錯誤處理也要遵守相同契約：如果提交失敗，不可在未釐清仍在執行的工作之前，把相關緩衝交給下一個請求；如果只完成部分 chain，則不能把最後輸出標為有效。這些是一般工程約束，實際可用的取消、等待與釋放 API 仍須由所選 runtime 的固定版本查證。本文刻意不提供跨 runtime 通用的裸指標互傳技巧，因為那會跳過最重要的安全條件。

## 來源
- [IRON 編譯階段與產物](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/compilation_stages.md) — JIT、recipe / artifact hash、核心 ELF 與預設 XRT 載入。
- [IRON HRX runtime](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/hrx_runtime.md) — libhrx / amdxdna HAL、xclbin + insts、flush / invalidate。
- [IRON HSA runtime](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/hsa_runtime.md) — PDI + insts、AIE ROCR、queue fences、同步與限制。
- [Triton runtime 與格式選擇](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/amd_triton_npu/backend/driver.py#L1093-L1133) — HSA 強制 PDI；XRT 自動選 npu2 ELF、npu1 xclbin。
- [Triton-XDNA：編譯與 runtime](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) — 固定快照的流程、依賴與 runtime 條件；不是本機驗證。
- [共享緩衝測試來源](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/zero_copy/shared_buffer_test.py) — 雙向 mapping、DLPack、pool lifetime、in-place / staged 計數與 skip。
- [零拷貝分階段基準](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/zero_copy/zero_copy_benchmark.py) — 同 runtime 內比較 copy / shared；跨 runtime dispatch 次數不同。
- [零拷貝共用 add chain](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/zero_copy/common/add_chain.py) — 兩個 f32 adds；單 op chain 重複呼叫問題僅為上游註解記載。

## 關聯
- [compiler](compiler.md)
- [memory](memory.md)
- [synchronization](synchronization.md)
- [heterogeneous](heterogeneous.md)
- [performance](performance.md)
- [debug](debug.md)

## 反向連結
- [dma](dma.md)
- [compiler](compiler.md)
- [iron](iron.md)
- [triton](triton.md)
- [qwen-case](qwen-case.md)
- [heterogeneous](heterogeneous.md)
- [deployment](deployment.md)
- [debug](debug.md)
- [glossary](glossary.md)
