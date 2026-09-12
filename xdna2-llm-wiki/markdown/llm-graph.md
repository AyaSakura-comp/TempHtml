# LLM 計算圖：算子、狀態與裝置邊界

分類：LLM推論 · 來源查核 · 來源快照 2026-09-12

以 Qwen2.5 原始碼分解 Transformer 圖，追蹤 KV cache、補齊、精度與融合，區分算子存在和實際模型路由。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 計算圖不只是 GEMM 清單

LLM 的數學圖包含正規化、投影、位置編碼、注意力、殘差、非線性和輸出頭；執行圖還包含型別轉換、補齊、主機搬移、快取寫入、分配與等待。[Qwen2Model 實作](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) 的 forward 與 generate 把這兩層放在同一份程式，適合用來查核，但不能把模型名稱等同於某個固定硬體部署。

閱讀時應為每條邊標記真實形狀、實際儲存形狀、dtype、所在裝置，以及誰最後寫入。權重在 CPU 保存不表示矩陣乘法一定在 CPU：NPU wrapper 可以暫存並 dispatch；反過來，backend 名字含 NPU 也不表示所有 PyTorch 工作都移到裝置。此處以固定 Qwen 範例說明方法，而非宣稱所有模型都採相同圖。

## 一個 Decoder block 的資料路徑

設輸入為 `(B,S,D)`，MLP 中間寬度為 H。以下是 [Qwen2Model 實作](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) 的數學流程摘要，不是可執行 Python：

```text
x1 = x + O(Attention(RoPE(Q(Norm(x))), RoPE(K(Norm(x))), V(Norm(x))))
x2 = x1 + Down(SiLU(Gate(Norm(x1))) * Up(Norm(x1)))
logits = FinalNorm(x_last) @ EmbeddingWeight^T
```

| 階段 | 主要資料／運算 | 查核焦點 |
|---|---|---|
| RMSNorm | 每列平方和、倒平方根與 gamma | reduction 真實寬度、精度 |
| QKV 投影 | 同一輸入的線性變換 | 合併權重、bias、KV head 數 |
| 注意力核心 | 分數、遮罩、softmax、乘 V | causal offset、暫存量、裝置 |
| MLP | gate／up 分支再匯合 | 中間張量、SwiGLU 與 down |
| 殘差、輸出頭 | 逐元素加法、大詞彙矩陣 | 累積誤差與額外 dispatch |

程式把 Q/K/V 權重和 bias 拼成一次投影，再分割 Q 與較窄的 K/V；這是圖層融合，不代表注意力核心也包含在該矩陣 kernel 中。

## GQA 與 KV cache 是持久狀態

[Qwen 注意力與 forward 路由](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L826-L977) 先對新 Q/K 套 RoPE，再將 K/V 寫入預先配置 cache 的 `[seq_pos:seq_pos+S]`，更新有效長度。cache 保留較少的 KV heads，送入注意力前卻以 `repeat_interleave` 擴為 query heads。因此「GQA cache 節省容量」與「該 kernel 的工作張量沒有展開」是不同命題。

[Qwen RoPE 實作](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/rope.py) 的 cos／sin 依 `pos_offset` 切片，再移至 `q.device`；檔頭說 GPU 並不能取代實際裝置推導。CPU 注意力分支也能使用此函式。未擴張 KV 的理想資料量可寫成 `2×layers×B×T×KV_heads×head_dim×element_bytes`，但這只是由形狀推導的 payload，不含頭展開、allocator、RoPE 表、權重及中間結果。詳見 [KV cache](kv-cache.md)。

## Prefill 和 decode 是不同執行形狀

多 token prefill 可把同一權重攤在較多輸入列上；單 token decode 的 M 很小，卻仍須讀取權重並使用逐漸增長的 KV。[Qwen linear wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/matmul.py) 把獨立 NPU matmul 的 M／N 補齊至二百五十六倍數，K 補成二的冪。以模型中 H 等於四千八百六十四的 down projection 為例，full-K 描述仍會包含補齊的 K，不能拿真實 FLOPs 除以時間就宣稱完全有效利用。

[Qwen 注意力與 forward 路由](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L826-L977) 的 `hetero-fast` 不是以使用者叫它「decode」就切換，而是 `S == 1`。單 token prompt 也會符合該條件；因此測試計畫應同時記錄 prompt token 數與每次 forward 的形狀。與其他 backend 對比時，須把 prefill、第一次 decode 與後續步驟分開，而非只報一個含糊的 tokens/s。

## 融合與精度必須一起讀

[Qwen RMSNorm wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/rmsnorm.py) 的獨立 NPU RMSNorm 做 bare normalization，再在 CPU 乘 gamma；平方和除以真實欄數，而不是補齊欄數，這是補零後維持數學定義的必要條件。[Qwen SwiGLU wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/swiglu.py) 的獨立 NPU SwiGLU 是 SiLU 與 multiply 兩段，不能與 GPU 單 kernel 直接按「一個算子」計提交成本。[Qwen residual add](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/add.py) 又提供 f32 殘差路徑，避免每層都先把殘差壓回 BF16。

[Qwen2Model 實作](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) 的 `_FusedMLP` 進一步串接 add、norm、gate／up、SwiGLU、down 與殘差；gamma 可折入權重，鏈中的中間資料也不必每個算子回主機。這是多次裝置工作打包成一條鏈，不是所有運算變成一條機器指令。其 BM 是一百二十八，長輸入超過單塊條件會回到未融合路徑；每層權重不同但共用 chain，亦需分開管理靜態 BO。

## 以實際呼叫圖定義覆蓋率

[Qwen GPU fused attention](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/attention.py) 是 GPU-only fused attention；[Qwen softmax wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/softmax.py) 雖有 NPU softmax wrapper，主模型的 `npu` 注意力核心仍直接使用 CPU matmul／softmax。這是一個重要反例：把目錄中的所有 NPU kernel 名稱打勾，無法證明整張圖已移植。也不能把獨立 norm 的 gamma 乘法、bias 或主機裁切成本從圖中抹去。

對每個節點，建議建立「預期裝置、實際分支、fallback、搬移、數值門檻」五欄紀錄；對每條狀態邊，另記 producer 完成與 consumer 可見的時點。再以相同模型、輸入與精度設定比較 [異質推論](heterogeneous.md)。這是工程推導的驗證方法，本頁沒有模型下載、NPU 執行或實測吞吐；具體分支與 README 矛盾則集中於 [Qwen 案例](qwen-case.md)。

## 圖切分的成本要沿邊計算

假設把某個線性層從 GPU 移到 NPU，不能只替換該節點的計算時間。必須追蹤輸入是否已在 NPU 可見緩衝、權重是否需要重排與 staging、輸出是否需要裁切、後繼正規化或殘差在哪個裝置，以及跨界後是否增加等待。若搬移的是逐層激活而不是固定權重，費用還會隨生成步驟反覆出現。這是圖層成本模型的必要項，不是本頁預測的毫秒數。

融合的評估也應沿相同方法進行。消除中間結果回主機，可能減少拷貝與提交；但若融合使同時存活的暫存更多，或限制可支援的列數，就可能需要額外補齊或另一條長序列路徑。只用「融合算子數」當成優化指標，無法反映這些條件。應保留未融合版本作數學與資料流對照，並為不同形狀記錄實際選中的分支。

對有狀態的生成，更應檢查 cache 是否在每一步只寫入新增位置、有效長度是否正確更新，以及位置偏移是否與遮罩一致。單次 prefill 的 logits 相近，只驗證了其中一部分圖；連續多步之後的錯位，可能直到較長上下文才顯現。將狀態邊納入測試，是從算子展示走向完整推論系統所不能省略的工作。

## 來源
- [Qwen2Model 實作](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) — 模型形狀、配置、fused chain、KV cache 與主機搬移。
- [Qwen 注意力與 forward 路由](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L826-L977) — npu 注意力核心 CPU；hetero-fast 按 S==1 切換。
- [Qwen RoPE 實作](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/rope.py) — apply_rope 依 q.device 放置 cos/sin；檔頭 GPU 敘述已過時。
- [Qwen linear wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/matmul.py) — NPU M/N 補齊 256、full-K launch、BF16 入 f32 出；GPU 權重快取。
- [Qwen RMSNorm wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/rmsnorm.py) — bare NPU norm 使用真實欄數；獨立 gamma 乘法在 CPU。
- [Qwen SwiGLU wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/swiglu.py) — 獨立 NPU SiLU + multiply 兩段；與 fused chain 不同。
- [Qwen residual add](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/add.py) — NPU f32 路徑與補齊；GPU wrapper 搬移 CPU 輸入。
- [Qwen GPU fused attention](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/attention.py) — online softmax 與 BF16 dot；wrapper 固定 cuda。
- [Qwen softmax wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/softmax.py) — 四列 chunk、最小補齊 128 欄；主模型 attention 未走此 NPU wrapper。

## 關聯
- [qwen-case](qwen-case.md)
- [attention](attention.md)
- [kv-cache](kv-cache.md)
- [prefill-decode](prefill-decode.md)
- [heterogeneous](heterogeneous.md)
- [quantization](quantization.md)

## 反向連結
- [system](system.md)
- [qwen-case](qwen-case.md)
- [attention](attention.md)
- [glossary](glossary.md)
- [wiki-method](wiki-method.md)
