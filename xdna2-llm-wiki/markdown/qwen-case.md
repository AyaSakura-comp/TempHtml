# Qwen2.5 案例：CPU＋NPU、GPU 與異質路由

分類：LLM推論 · 來源查核 · 來源快照 2026-09-12

以固定 model.py 裁決 README 舊段落，逐項追蹤注意力、LM head、fused MLP、fallback 與計時邊界。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 先固定來源，再裁決文件矛盾

本機 Triton-XDNA HEAD 已核對為 `5c33df1263f29de30f71616780c2e8a88e623782`。[Qwen2.5 README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/README.md) 前段及路由表寫明 `npu` 是 CPU＋NPU、`hetero-fast` 的 decode 是 GPU，後方卻殘留把注意力與 LM head 概括為 always iGPU 的舊段落。本頁不複製該句，而以 [Qwen 注意力與 forward 路由](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L826-L977) 和 [Qwen final norm / LM head](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L1106-L1144) 的條件分支為準；沒有再次開 live 網頁或宣稱已比較遠端 HEAD。

同樣要警覺程式註解：初始化附近仍說 npu 的 LM head 在 NPU，但 forward 實作明確用 CPU torch matmul。可執行分支的證據優先於說明文字，且本次只是靜態查核，不是模型推論結果。

## 路由表應讀作預期主算子位置

| 工作 | gpu | npu | hetero | hetero-fast 的 S=1 |
|---|---|---|---|---|
| input／final norm | GPU | NPU bare norm＋CPU gamma | NPU／主機輔助 | GPU |
| QKV 與 O 投影 | GPU | NPU | GPU | GPU |
| RoPE、分數、softmax、乘 V | GPU | CPU | GPU | GPU |
| MLP 與殘差主算子 | GPU | NPU | NPU | GPU |
| LM head | GPU | CPU | GPU | GPU |

表依 [Qwen2Model 實作](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py)、[Qwen RMSNorm wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/rmsnorm.py)；融合時 gamma 處理會改變。`hetero-fast` 的 S 大於一走 hetero 分支，`hetero` 不會因 decode 自動全換 GPU。`reference` 是另外的 HuggingFace 路徑，不列入四種 Triton 路由比較。GPU 列也不能解讀成整個 Python 程序沒有 CPU 工作或拷貝。

## 注意力核心與主機工作不能藏起來

`_attention()` 在 npu 模式把 QKV／O 的 backend 設為 npu，取得 CPU 可見的投影結果，RoPE 隨 tensor 裝置執行，分數與 softmax 用 CPU f32。[Qwen RoPE 實作](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/rope.py) 的實作依 `q.device` 放置表格，故檔頭 GPU 敘述已不適用所有 backend。GPU／hetero 則呼叫 [Qwen GPU fused attention](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/attention.py) 的 fused attention；先把 GQA 的 KV heads 展開，不表示已有原生 GQA NPU attention。

另外，model.py 的一般 gpu／npu 共用分支會無條件 `_to_cpu(attn_out)`，再由 [Qwen residual add](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/add.py) 的 GPU wrapper 將 CPU operand 搬回 GPU。這是 fullGPU 標籤仍可能含主機往返的靜態證據，不能稱為零搬移 GPU baseline；此處未實測其代價。hetero 分支也明列 `_to_gpu`／`_to_cpu`，所以共享 DRAM 不代表模型自動使用 zero_copy 範例。

## 融合預設值與 fallback 的邊界

[Qwen2Model 實作](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) 的環境讀取是 `AMD_TRITON_NPU_FUSED_MLP` 預設字串 `"1"`，即使旁邊註解寫 opt-in，本快照符合 npu／hetero 條件時預設會建立鏈。BM 為一百二十八，真實 `B×S` 超過此值走未融合分支；不是 README 所述所有情況都使用獨立二百五十六列 block。

[Qwen linear wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/matmul.py) 的獨立 linear 是 BF16 輸入、full-K 一次 launch、f32 輸出；[Qwen RMSNorm wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/rmsnorm.py) 的 bare norm 回來再乘 gamma。融合鏈則串接殘差、正規化、MLP 並折入 gamma，故不能把每個名稱視為一個獨立 dispatch。

[Qwen helper 例外與 fallback](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L732-L824) 的 linear、norm、SwiGLU、add、softmax helper 捕捉例外後記錄 warning 並以 PyTorch 備援。檔案層級 kernel wrappers 不都自帶 try／except；fused chain 的 `run()` 與直接 fused attention 呼叫也沒有同樣保護。fallback 的裝置取決於當下 tensor，可能仍失敗，不能宣稱所有編譯錯誤都會安全退回 CPU。成功產生文字更不能證明 NPU 主算子真的執行。

## 驗證與計時不是同一條 CLI 路徑

[Qwen CLI 與正確性閘門](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/qwen_inference.py#L349-L443) 預設 `--backend npu --max-tokens 0`，單次 forward 會比較 logits，僅以 cosine 不低於零點九五作為退出閘門，不要求 top-1 一致。最大／平均誤差與 top-k 另行印出，這不等於 token 完全一致、任務品質相同或所有值有限的完整證明。生成路徑主要輸出文字及計時，不具備同樣的錯誤輸出 assertion。

以下參數已查核，但未執行；若執行會載入模型並可能下載權重，本次不做：

```bash
cd sources/Triton-XDNA/examples/qwen2_5
python qwen_inference.py --model qwen2.5-0.5b \
  --backend npu --max-tokens 0 --profile
```

[Qwen 生成計時呈現](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/qwen_inference.py#L167-L241) 把 prefill forward 時間稱為 TTFT，decode 平均稱 TPOT；總 TPS 包含 prefill，steady TPOT 另排除第一次 decode。模型載入、tokenization 和 cache 配置不全在這個 TTFT 內；首次 JIT 與暖機狀態也須另記。不能用 hetero-fast 的 GPU decode TPOT 當成 NPU decode 成績，再與 CPU＋NPU 的端到端平均直接比較。

## 可成立的結論與待驗證事項

來源支持的是：此範例具備 CPU＋NPU 路徑、GPU 路徑與按形狀切換的異質策略，並有可讀的 KV cache、補齊、融合及容錯實作。不支持的是：全模型純 NPU、任意 prompt 品質無損、所有 fallback 都被統計、或任何模式普遍最快。

重現報告應列模型尺寸、prompt 長度、精度、融合開關、每階段 backend、warning、實際 dispatch 與拷貝，再附 logits／token 檢查。本頁沒有下載模型、變更 ROCm 或執行 NPU；註解內的毫秒或每 token 數字只能標為上游背景敘述。與 [驗證方法](validation.md) 及 [效能比較](performance.md) 合讀，才能避免把功能跑通當成加速證明。

## 案例重現紀錄的具體欄位

以五億與十五億參數版本比較時，應保存設定表中的層數、隱藏寬度、注意力頭與中間寬度，而不是只記權重檔名。相同 kernel 程式服務多種模型，仍可能因補齊後的尺寸不同而產生不同產物和記憶體成本；中間寬度增大也會放大 gate／up 暫存與 down projection 的歸約長度。這些是來源形狀導出的差異，本文不從參數數量直接推算速度。

每次實驗再分成冷啟動與重用兩組，明列哪些時間包含權重放置、編譯、硬體 context 建立，以及首次特定形狀的 dispatch。若只報穩態，應同時交代排除哪些樣本；若包含首次開銷，就不要把結果稱為純核心吞吐。尤其不同 prompt 長度可能落在融合條件的兩側，或讓首次 decode 產生另一套快取，必須把這些條件放在表格中才有可比性。

數值欄位則分別保留 logits 的有限值檢查、最大與平均誤差、餘弦相似度、下一 token 及後續生成差異。不同精度路徑可能在接近的候選分數間翻轉首選 token，不能把所有差異都當成程式錯誤，也不能因餘弦過關就忽略任務品質。只有把容忍的差異事先定義清楚，才能判斷融合、補齊或異質切分是否仍滿足使用目的。

最後另外列出預期 NPU 節點與確實觀察到的 dispatch，不把 CPU 注意力、CPU 輸出頭或例外備援算進 NPU 覆蓋率。若沒有足夠的活動紀錄，應誠實填寫尚未確認，而非用 backend 名稱代替證據。

## 來源
- [Qwen2.5 README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/README.md) — 路由表已更新但其後仍有 always iGPU 舊段落；採 model.py 分支裁決。
- [Qwen 注意力與 forward 路由](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L826-L977) — npu 注意力核心 CPU；hetero-fast 按 S==1 切換。
- [Qwen final norm / LM head](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L1106-L1144) — npu 的 LM head 明確用 CPU torch matmul。
- [Qwen2Model 實作](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) — 模型形狀、配置、fused chain、KV cache 與主機搬移。
- [Qwen RMSNorm wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/rmsnorm.py) — bare NPU norm 使用真實欄數；獨立 gamma 乘法在 CPU。
- [Qwen RoPE 實作](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/rope.py) — apply_rope 依 q.device 放置 cos/sin；檔頭 GPU 敘述已過時。
- [Qwen GPU fused attention](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/attention.py) — online softmax 與 BF16 dot；wrapper 固定 cuda。
- [Qwen residual add](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/add.py) — NPU f32 路徑與補齊；GPU wrapper 搬移 CPU 輸入。
- [Qwen linear wrapper](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/kernels/matmul.py) — NPU M/N 補齊 256、full-K launch、BF16 入 f32 出；GPU 權重快取。
- [Qwen helper 例外與 fallback](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py#L732-L824) — linear / norm / SwiGLU / add / softmax helper 的 try / except。
- [Qwen CLI 與正確性閘門](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/qwen_inference.py#L349-L443) — 預設 npu / max-tokens=0；cosine 0.95，不要求 top-1；generation 不同。
- [Qwen 生成計時呈現](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/qwen_inference.py#L167-L241) — TTFT、TPOT、含 prefill TPS 與排除首次 decode 的 steady 統計。

## 關聯
- [llm-graph](llm-graph.md)
- [triton](triton.md)
- [runtime](runtime.md)
- [prefill-decode](prefill-decode.md)
- [validation](validation.md)
- [performance](performance.md)

## 反向連結
- [triton](triton.md)
- [llm-graph](llm-graph.md)
- [attention](attention.md)
- [prefill-decode](prefill-decode.md)
- [heterogeneous](heterogeneous.md)
- [deployment](deployment.md)
- [validation](validation.md)
- [debug](debug.md)
- [sources](sources.md)
