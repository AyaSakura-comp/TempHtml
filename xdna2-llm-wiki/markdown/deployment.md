# LLM 部署生態：研究 compiler 與成品 runtime

分類：程式設計 · 來源查核 + 部署界線 · 來源快照 2026-09-12

IRON／Triton 適合研究 kernel，FastFlowLM／Lemonade 著重模型部署；「可免費用」與「所有核心原始碼公開」必須分開。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 先分清你要改哪一層

若要研究 MMA 展開、DMA placement 或自訂算子，從 [IRON](iron.md)、[Triton](triton.md) 與 Peano 看得最清楚。若目標是用已支援模型提供本地推論服務，模型 runtime 和 serving 介面才是主要入口。這兩條路可以共享部分底層技術，但不代表相同公開範圍或同一套 binary ABI。

## 部署路線圖

| 路線 | 適合目的 | 必須確認 |
|---|---|---|
| IRON / MLIR-AIE / Peano | 學習與自訂 dataflow / kernels | 相符 source、wheel、driver 與 runtime |
| Triton-XDNA / AIR | compiler-generated kernels / 研究性 LLM graph | transform、fallback、per-op routing |
| FastFlowLM | 已支援 LLM / multimodal 模型部署 | model list、kernel binary、runtime 版本與 license |
| Lemonade + FLM | 管理模型與 API 使用體驗 | 實際 backend、請求參數、log 與 NPU 驗證 |

[FastFlowLM 官方 repository](https://github.com/ROCm/FastFlowLM/blob/089e56d29416990e168abed43aff88fc0ad664f3/README.md) 明列 XDNA2 家族支援與 CLI/模型下載流程；[Lemonade 指南](https://lemonade-server.ai/flm_npu_linux.html) 說明 Linux NPU 整合。這些是上游文件陳述，本機沒有安裝或 benchmark。

## 開源範圍不能只看 repository badge

FLM 的 README 區分 MIT orchestration / CLI 與 NPU-accelerated binary kernels；binary kernels 不等於所有 source 與重建流程公開。**同版文件另有實際授權矛盾**：README 說 kernels 免費供任何用途（含商用），但 [TERMS.md](https://github.com/ROCm/FastFlowLM/blob/089e56d29416990e168abed43aff88fc0ad664f3/TERMS.md) 明列 proprietary binaries，且對公司年營收超過 USD 10 million 的商用要求另外授權。這份 Wiki 不能裁決哪個文字是最新有效授權，亦不提供「無條件免費商用」保證。商業部署前須向權利人確認，保留採用版本與授權文件；不能只看 README 或 MIT badge。

同樣地，compiler 是開源不代表 BIOS、firmware、所有驅動包與模型授權都開源。第三方量化模型還有其自身 license，應列入 deployment manifest。

## Linux 需求是 runtime-specific

[FLM Linux 指南](https://fastflowlm.com/docs/install_lin/) 與 [Lemonade Linux NPU 指南](https://lemonade-server.ai/flm_npu_linux.html) 在查閱快照中列出 firmware 1.1.0.0+、kernel 7.0+ 配合 amdxdna 或相應 DKMS 路線，以及 memlock 條件。這不代表先前 IRON 的每個版本也要求同一組版本；不同文章可能對不同發行版、backport 與 firmware 協定作假設。

不要依一篇 gist 直接改 BIOS、替換 kernel、覆蓋 ROCm 或放寬全系統 limits。先核對自己的 SKU、發行版、既有 GPU 工作、driver path 與 rollback 計畫；系統修改應是另一次明確授權的任務。

## Validation 通過還不代表模型能執行

官方指南指出 `flm validate` 與實際 `flm run` 所走的檢查路徑不同：前者可能確認 kernel DRM 裝置，而執行還需要 XRT 能看到裝置。因此驗證成功但模型啟動失敗時，還要看 `xrt-smi examine`、plugin 與 runtime log。沒有在這裡執行上述命令；它們是依官方文件列出的查核入口。

對服務化 LLM，另外記錄真正的 backend、模型 artifact、context 配置、tokenizer/chat template、冷暖狀態與 resource limits。生成文字成功不是無 fallback 的證明；NPU utilization 閃一下也不是端到端所有算子都在 NPU 的證明。

## 不移植宣傳效能

官方 README 的功耗效率、最大 context 與安裝時間陳述有自己的測試條件，不能用來推估這台主機的 TPOT。社群「CPU/GPU 幾乎零負載」也不能當硬體事實。請依 [驗證流程](validation.md) 收集 per-op 路徑與完整 latency，再決定研究 compiler 或成品 runtime 是否符合需求。

## 來源
- [FastFlowLM README 固定快照](https://github.com/ROCm/FastFlowLM/blob/089e56d29416990e168abed43aff88fc0ad664f3/README.md) — 固定 SHA；README 的商用敘述與同版 TERMS.md 不一致，不能當成無條件商用授權。
- [FastFlowLM proprietary binary 條款](https://github.com/ROCm/FastFlowLM/blob/089e56d29416990e168abed43aff88fc0ad664f3/TERMS.md) — 同版條款列公司年營收 USD 10 million 門檻，與 README 免費任何商用的敘述有衝突；部署前須向權利人確認。
- [FastFlowLM Linux 安裝指南](https://fastflowlm.com/docs/install_lin/) — 外部可變來源；2026-09-12 查閱。需求專屬於此 runtime，不是所有 IRON 版本的要求。
- [Lemonade Linux NPU guide](https://lemonade-server.ai/flm_npu_linux.html) — 外部可變來源；2026-09-12 查閱，未執行安裝。
- [Triton-XDNA README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) — 實驗性 compiler；上游效能數字不代表本機量測。

## 關聯
- [compiler](compiler.md)
- [runtime](runtime.md)
- [qwen-case](qwen-case.md)
- [validation](validation.md)
- [sources](sources.md)

## 反向連結
- [quantization](quantization.md)
- [sources](sources.md)
