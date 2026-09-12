# Triton-XDNA：算子、Transform 與支援證據

分類：程式設計 · 來源查核 · 來源快照 2026-09-12

拆解 Linalg／AIR 映射、補齊與快取，說明 dashboard 勾選、數值測試與模型覆蓋為何不能互相代替。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 實驗性前端的真正範圍

[Triton-XDNA：編譯與 runtime](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) 把 Triton-XDNA 定義為實驗性、由編譯器產生 XDNA kernel 的專案。它先經 triton-shared 形成 Linalg 計算，再利用 Transform dialect 選定分塊、bufferization 與向量化，接往 AIR／AIE。寫成 `@triton.jit` 不代表既有 GPU kernel 不經調整即可映射到空間陣列；記憶體階層、靜態形狀與 DMA 排列仍需可降階的設計。

同一個 Triton 語法在 GPU 與 NPU 的 dispatch 語意也不能混同。GPU 的 `cuda` 名稱在 ROCm PyTorch 中是 API 裝置命名，不表示 NVIDIA 硬體；NPU 則需要明確的 NPUDriver 與其產物、參數橋接。工具名稱相同，並不消除後端 ABI 差異。

## Dashboard 勾選不是測試結果

[Dashboard 勾選產生邏輯](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/generate_readme.py#L187-L239) 的 `get_device_support()` 只檢查 `transform_aie2.mlir` 與 `transform_aie2p.mlir` 是否存在，接著把布林值顯示成勾號。因此勾選可以精確讀作「這個目錄有對應架構的映射檔」，不能改寫成所有尺寸、型別或硬體均已通過。

| 所見證據 | 可以說 | 不可以說 |
|---|---|---|
| transform 檔存在 | 有可閱讀的映射配方 | 硬體測試通過 |
| 編譯產物存在 | 某次編譯產生了檔案 | 本次輸入真的 dispatch |
| assertion 測試程式存在 | 上游定義了數值比較 | 本機已執行並通過 |
| 已執行且附來源的測試紀錄 | 該配置在該環境符合門檻 | 完整 LLM／所有形狀皆支援 |

本頁停在來源查核層級。README 的矩陣乘法對照成績也是特定測試集合的上游敘述，不能提升成普遍 SOTA 或完整模型加速保證。

## 從配方看記憶體與平行度

[AIE2P matmul Transform IR](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/matmul_bf16_m64_n64_k64/transform_aie2p.mlir) 先切 L3 至 L2 的 copy，再將輸出提升到 L2、打包矩陣，接著對 K reduction 分塊，最後建立多核心 herd。配方將 `memory_space = 1` 用於 L2，`memory_space = 2` 用於 L1；這是該流程的 IR 標記，不能視為所有 runtime 中通用的記憶體枚舉。

其核心片段如下，省略相依 handle 定義，僅供閱讀：

```mlir
%packed = transform.structured.pack %matmul_to_pack packed_sizes = [8, 8, 8]
  : (!transform.any_op) -> (!transform.any_op)
transform.annotate %outer_for_loop "k_reduction_loop" : !transform.any_op
```

打包與轉置決定 A、B 如何送進內核，K 迴圈決定累加跨多少個資料塊。外層分塊不等於硬體 matrix primitive 的微形狀；某個 API 呼叫亦可能降為多個指令。應把 [GEMM](gemm.md) 的運算量、工作集、DMA 流量分開列出，才能解釋為何相同算術有不同執行成本。

## 路徑已查核的示例

以下以研究根目錄為起點；是來源核對後的命令範例，未執行，且需另行準備版本相符的編譯與執行環境：

```bash
cd sources/Triton-XDNA/examples/matmul_bf16_m64_n64_k64
AIR_TRANSFORM_TILING_SCRIPT=transform_aie2p.mlir \
  python matmul_bf16_m64_n64_k64.py
```

[Triton BF16 matmul 範例](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/matmul_bf16_m64_n64_k64/matmul_bf16_m64_n64_k64.py) 會掃描多組 M、N、K，不是目錄名稱所暗示的一次六十四階小測試。其 BF16 結果以 `atol=1e1, rtol=1e-1` 比較參考值；這是該範例容差，不適合直接當作所有神經網路的品質門檻。改為 AIE2 的 transform 也不是替 XDNA2「換個最佳化開關」，而是換目標架構。

## 補齊與快取不會憑空消失

[Qwen linear wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/matmul.py) 的 Qwen NPU linear 將 M、N 補到二百五十六的倍數，K 補成二的冪；Triton 程式一次描述完整 K，實際 K 分塊由 Transform 放到裝置端，而非主機逐塊 dispatch。輸入採 BF16，輸出緩衝為 f32，最後再裁回真實尺寸。這可減少主機 K 迴圈，但 decode 的真實 M 為一時，補齊浪費仍然存在。

[Qwen CachedNPUKernel](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/backend_utils.py) 首次呼叫走 JIT，後續以 grid 與 keyword constexpr 建立的 key 找到已編譯 launcher。它並不是完整張量語意雜湊；移植時須核對實際被專門化的尺寸是否都由 key 區分。修改形狀、stride 或映射後不能憑「有快取」就假定重用安全，亦不能把註解內單次 dispatch 數字當成本機量測。

## 覆蓋宣稱必須回到呼叫圖

[Qwen softmax wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/softmax.py) 確實定義 NPU softmax，包含四列一組及最少一百二十八欄的補齊策略；但 [Qwen 注意力與 forward 路由](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L826-L977) 的 Qwen `npu` 注意力核心呼叫的是 CPU `torch.softmax`。算子存在，不表示模型用到它。檔案註解中較小 buffer 的 timeout，也是該範例路徑的觀察，不能擴張為所有 DMA 的通用最小長度規格。

相同原則適用 fallback：模型 helper 捕捉例外後改用 PyTorch，代表維持功能的備援，不等於 NPU 執行成功。完整判讀須同時看 backend、實際分支、呼叫紀錄、數值與搬移；[Qwen 案例](qwen-case.md) 進一步整理文件矛盾與裝置路由。依賴版本則以 [Triton 的 AIR 版本鎖](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/utils/mlir-air-hash.txt)、[Triton 的 Peano 版本鎖](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/utils/peano-requirements.txt) 為準，不建議為追逐某段上游成績而改動本機 ROCm。

## 移植算子時的最小檢查表

移植應先固定數學定義，再處理裝置映射。對矩陣乘法，列出輸入的行列主序、轉置、stride、累加初值及輸出裁切；對 reduction，列出歸約軸、真實長度、補齊值與空列處理。補零適合某些線性運算，卻不可以不加思索地套到 softmax，因為新增的零分數會參與指數和，改變有效元素的機率。這是數學與原始碼策略的交叉檢查，不是對硬體指令的額外宣稱。

接著把代表性形狀分成整除、尾端不足、單列、長歸約及多個批次，逐一檢查 wrapper 有沒有遮罩或配置足夠儲存。不能把某個 block 的無遮罩載入直接搬到另一個 wrapper，仍假設尾端會自動補齊。若結果比對只含正數，也可能漏掉符號延伸或飽和規則的差異，因此整數與浮點測試輸入需分別設計。

最後記錄「原 kernel、所選 Transform、實際生成圖」三者的對應關係。當配方匹配的是某一種 Linalg 結構，前端重排或融合後即使數學等價，也可能不再符合原先的 handle 匹配。遇到這種情況，應保留失敗的中間 IR 並確認第一個不符合預期的操作，不要直接把問題歸因於整種資料型別不受支援。

## 來源
- [Triton-XDNA：編譯與 runtime](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) — 固定快照的流程、依賴與 runtime 條件；不是本機驗證。
- [Dashboard 勾選產生邏輯](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/generate_readme.py#L187-L239) — exists() 檢查 transform 檔案，不執行 NPU 測試。
- [AIE2P matmul Transform IR](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/matmul_bf16_m64_n64_k64/transform_aie2p.mlir) — pack、K reduction、memory space 與 herd mapping。
- [Triton BF16 matmul 範例](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/matmul_bf16_m64_n64_k64/matmul_bf16_m64_n64_k64.py) — 尺寸掃描與 torch assert_close；測試存在不表示本次通過。
- [Qwen linear wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/matmul.py) — NPU M/N 補齊 256、full-K launch、BF16 入 f32 出；GPU 權重快取。
- [Qwen CachedNPUKernel](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/backend_utils.py) — 首次 JIT、後續直接 launcher；快取 key 是 grid 與 keyword constexpr。
- [Qwen softmax wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/softmax.py) — 四列 chunk、最小補齊 128 欄；主模型 attention 未走此 NPU wrapper。
- [Qwen 注意力與 forward 路由](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L826-L977) — npu 注意力核心 CPU；hetero-fast 按 S==1 切換。
- [Triton 的 AIR 版本鎖](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/utils/mlir-air-hash.txt) — 指定 AIR 6746658；不能拿獨立下載的 AIR HEAD 代替。
- [Triton 的 Peano 版本鎖](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/utils/peano-requirements.txt) — 指定 wheel 版本；註解記載混版曾使 stack 問題表現成 NaN。

## 關聯
- [compiler](compiler.md)
- [gemm](gemm.md)
- [datatypes](datatypes.md)
- [runtime](runtime.md)
- [qwen-case](qwen-case.md)
- [debug](debug.md)

## 反向連結
- [compiler](compiler.md)
- [qwen-case](qwen-case.md)
- [deployment](deployment.md)
