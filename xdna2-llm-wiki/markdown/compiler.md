# 編譯器分工：從資料流到 XDNA2 產物

分類：程式設計 · 來源查核 · 來源快照 2026-09-12

辨別 IRON／Peano、Triton／AIR 與 host runtime 的責任，避免把編譯成功、產物格式與 NPU 實測混為一談。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 先分清三種責任

XDNA2 程式不是把一般 Python 交給 NPU 解譯。IRON 描述空間資料流，MLIR-AIE 配置核心、記憶體、DMA 與連線；Peano 是擴充 LLVM 的逐核心編譯器，能編譯 C++ 向量核心。主機 runtime 則負責載入配置、提供緩衝與提交工作，並不代替編譯器決定矩陣分塊。這些界線由 [IRON / MLIR-AIE 專案說明](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/README.md) 與 [IRON 編譯階段與產物](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/compilation_stages.md) 交叉說明。選工具時，應先問要手控資料流，還是以高階算子配合映射配方產生核心。

本系列查核固定來源，沒有建置工具鏈或執行 NPU。原始碼可證明某條轉換路徑存在，不能證明特定模型在本機已成功編譯，更不能直接推出效能排名。硬體 primitive、C++ API、MLIR lowering 與前端測試，是四個不同的支援層級。

## 兩條入口不是兩套互斥硬體

| 入口或階段 | 使用者提供 | 主要責任 |
|---|---|---|
| IRON | Worker、ObjectFifo、Runtime | 明確描述計算與資料移動 |
| Peano | 核心程式或降階 LLVM IR | 逐核心指令選擇、配置與連結 |
| Triton-XDNA | Triton kernel 與 Transform 配方 | 從張量計算推導分塊與平行映射 |
| MLIR-AIR／AIE | 分層資料流與陣列描述 | 降階為核心、DMA、配置與指令流 |
| host runtime | 編譯產物及參數緩衝 | ABI 配對、提交、等待與回收 |

[Triton-XDNA：編譯與 runtime](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) 的路徑是 Triton → triton-shared → Linalg → Transform → AIR → AIE。不能把 AIR 說成另一個 GPU runtime，也不能把 Peano 說成整張 LLM 計算圖的自動切分器。IRON 的控制較直接，代價是資料搬移與同步設計責任也較清楚地落在作者身上；兩條入口都有值得研究的工作負載，沒有普遍最佳解。

## 用映射 IR 讀懂分塊

以下節錄 [AIE2P matmul Transform IR](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/matmul_bf16_m64_n64_k64/transform_aie2p.mlir)，是「改寫計算的配方」，不是 AIE 機器指令，也不是完整可獨立執行模組：

```mlir
%packed = transform.structured.pack %matmul_to_pack packed_sizes = [8, 8, 8]
  : (!transform.any_op) -> (!transform.any_op)
%tiled_reduction, %outer_for_loop =
  transform.structured.tile_using_for %packed_c tile_sizes [0, 0, 8]
  : (!transform.any_op) -> (!transform.any_op, !transform.any_op)
```

第一段改變運算所見的打包形狀，後續還有 A、B、C 的轉置；第二段切的是打包後的 K，配方註明八個打包單位對應六十四個原始 K 元素。其後才分派多核心 herd、配置記憶體空間與向量化。故 `[8,8,8]` 不表示整個 kernel 只計算八階矩陣，更不能從一行 pack 推算每週期乘法數。解讀需同時看外層 tile、內層向量形狀、累加型別與 DMA 順序。

## 產物名稱相似，角色不相同

[aiecc 產物與建置圖](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/tools/aiecc/README.md#L29-L49) 區分配置 xclbin 加獨立指令流，以及包含 PDI／指令流的 full-ELF。[IRON 編譯階段與產物](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/compilation_stages.md) 又列出逐核心 ELF、核心物件、PDI、指令 ELF；看到副檔名 `.elf`，必須追問是核心可執行檔，還是主機載入的封裝。

預設 IRON XRT 文件以 `final.xclbin + insts.bin` 為輸入。Triton 的 [Triton runtime 與格式選擇](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/amd_triton_npu/backend/driver.py#L1093-L1133) 則在 XRT 下自動選 npu2 的 ELF、npu1 的 xclbin，在 HSA 下強制 PDI 加指令 sidecar。不能把這幾種檔案任意更名互換，或將 IRON 預設流程的限制套到所有後端。另見 [執行期與 ABI](runtime.md)。

## 版本鎖比下載時間重要

Triton 的 [Triton 的 AIR 版本鎖](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/utils/mlir-air-hash.txt) 指定 AIR commit `6746658`；[Triton 的 Peano 版本鎖](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/utils/peano-requirements.txt) 指定 `llvm-aie==22.0.0.2026090201+a36c62b9`，並由 AIR wheel 的相依資訊間接鎖定 AIE。這不是本機另外下載的 AIR、AIE、Peano HEAD 自動構成的相容組合。保存來源快照有助閱讀，卻不等於取得可直接組裝的離線建置套件。

實務上應記錄前端、Transform、AIR、AIE、核心 compiler、runtime ABI 與目標世代，避免只寫「最新版」。IRON 與 Triton 的環境宜分開管理；本頁不要求安裝、更新 ROCm 或變更驅動。將來重現時先依所選專案的版本鎖建立隔離環境，而不是混用全域 Python 套件。

## 編譯成功之後仍有驗證工作

[IRON 編譯階段與產物](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/compilation_stages.md) 的 recipe hash 描述生成配方，artifact hash 還考慮工具與檔案的新鮮度；快取命中只代表可重用產物，不代表新輸入通過數值檢查。對每個 kernel，還應保存真實尺寸、補齊尺寸、輸入／累加／輸出型別、誤差門檻及主機呼叫方式。

若錯誤出現在 linked core、DMA 配置或提交階段，分別保留對應 IR、連結報告與 runtime 訊息，不要統稱「NPU 不支援」。特別是 f32 結果不證明原生 f32 乘法；整數也需核對 signedness 與溢位。下一步可依 [IRON 入門](iron.md)、[Triton 映射](triton.md) 或 [除錯](debug.md) 選擇最小證據鏈，再擴張到模型。

## 建立跨階段的診斷紀錄

可以把一次未來實驗的紀錄拆成四張表：生成表寫問題形狀與資料排列；編譯表寫目標、版本鎖和各階段產物；執行表寫載入方式、引數與同步；驗證表寫輸入分布、比較方法與結果。這是工程建議，並非本次已完成的測試。四張表透過同一個實驗識別碼相連，才能避免拿另一個分塊方案的速度，搭配目前方案的正確性結果。

例如數學輸入只有一列，但 wrapper 為映射補出許多零列，生成表應同時列真實列數與編譯列數；輸出裁切亦應記錄，因為忽略它可能把補齊區的錯誤當成有效輸出，或反過來把未寫入的有效區藏起來。若改變資料型別，除了前端 tensor 宣告，還要核對內核輸入、累加器、輸出儲存與主機參考計算的型別，不能只看最後印出的 dtype。

對配置式陣列而言，計算和通訊常由不同產物描述。核心反組譯能幫助確認指令選擇，卻無法單獨證明主機送進來的資料順序；DMA 的圖也無法單獨證明內核乘法的精度。因此一次成功的端到端驗證，必須讓形狀、布局、型別、配置和呼叫方式同時吻合。這也說明為何換前端或 runtime 後，不能只沿用某個核心測試的結論。

## 來源
- [IRON / MLIR-AIE 專案說明](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/README.md) — Python 空間資料流、Peano 與版本配對原則。
- [IRON 編譯階段與產物](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/compilation_stages.md) — JIT、recipe / artifact hash、核心 ELF 與預設 XRT 載入。
- [Triton-XDNA：編譯與 runtime](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) — 固定快照的流程、依賴與 runtime 條件；不是本機驗證。
- [AIE2P matmul Transform IR](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/matmul_bf16_m64_n64_k64/transform_aie2p.mlir) — pack、K reduction、memory space 與 herd mapping。
- [aiecc 產物與建置圖](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/tools/aiecc/README.md#L29-L49) — xclbin 指令流與 full-ELF 為不同輸出方案。
- [Triton runtime 與格式選擇](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/amd_triton_npu/backend/driver.py#L1093-L1133) — HSA 強制 PDI；XRT 自動選 npu2 ELF、npu1 xclbin。
- [Triton 的 AIR 版本鎖](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/utils/mlir-air-hash.txt) — 指定 AIR 6746658；不能拿獨立下載的 AIR HEAD 代替。
- [Triton 的 Peano 版本鎖](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/utils/peano-requirements.txt) — 指定 wheel 版本；註解記載混版曾使 stack 問題表現成 NaN。

## 關聯
- [iron](iron.md)
- [triton](triton.md)
- [runtime](runtime.md)
- [datatypes](datatypes.md)
- [debug](debug.md)

## 反向連結
- [vliw-pipeline](vliw-pipeline.md)
- [instruction-cycles](instruction-cycles.md)
- [software-pipelining](software-pipelining.md)
- [isa](isa.md)
- [iron](iron.md)
- [triton](triton.md)
- [runtime](runtime.md)
- [deployment](deployment.md)
- [debug](debug.md)
- [glossary](glossary.md)
