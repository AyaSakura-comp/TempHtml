# 來源地圖、證據等級與未解問題

分類：驗證與知識庫 · 來源登錄與缺口 · 來源快照 2026-09-12

主張要能回到原始文件與固定 source；公共架構介紹、API 表、compiler 實作和 benchmark 各有不同證明力。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 這份 Wiki 能做到的完整性

這是依公共文件、下載 source snapshots 與演算法文獻整理的廣泛技術知識庫，不是 AMD 保密設計文件或逐一列出所有 opcode 的正式 ISA 手冊。沒有公開或沒有查核的 latency、bus width、clock、firmware 排程與全部 SKU差異會留白；不以「完整」之名補猜測。

每頁提供來源與 related/backlinks；首頁可下载 source-register.json，列出唯一 URL 與引用條目。knowledge.json 保留結構化內容，Markdown 與 llms-full.txt 保留來源文字和界線。另可直接開啟 [原始 manifest](../research-manifest.json)、[型別／MMA 稽核](../type-mma-audit.md)、[原始長篇指南](../guide/index.html)。

## 證據分層

| 等級 | 能支持什麼 | 不可替代 |
|---|---|---|
| 廠商公開架構文件 | 大方向、產品級設計與其限定規格 | 每個compiler實際lowering |
| 固定source/header | 這個版本的型別、primitive wrapper、配置與分支 | silicon實測或所有版本行為 |
| 上游測試/範例 | 預定支援範圍與驗證方法 | 本機重現；存在文件不等於測試已pass |
| 論文 | 演算法與論文條件下的結果 | 自動移植到XDNA2的加速比 |
| 工程推導 | 由明確假設推導的容量/成本 | 實際配置器大小或throughput |
| 本機量測 | 若真的執行才可如此標記 | 本Wiki尚無NPU量測 |

[AMD XDNA 公共頁](https://www.amd.com/en/technologies/xdna.html) 同時談不同世代，引用時須切分範圍。多個 AMD/Xilinx repositories 互相一致可提高解讀把握，仍不是三份獨立 silicon validation。

## 固定快照與可變文件

MLIR-AIE、Peano、AIR、Triton-XDNA、AIE API 與 IREE-AMDAIE 的 SHA 可在原始 manifest 找到。這些 snapshot 是分別取得，**未驗證組成同一套可建置工具鏈**。LLVM-AIE 是指定範圍的 sparse checkout，不是完整離線 LLVM bundle。

新增的 FLM/Lemonade 官方網站與論文頁以查閱日期和版本標記；動態安裝需求應部署前再核對。[FLM Linux](https://fastflowlm.com/docs/install_lin/) 和 IRON guide 可能針對不同runtime/firmware協定，不能選一個版本號就當整個XDNA2平台的唯一要求。

## 已發現的矛盾

- AIE API 模式名不一定代表一條 native matrix instruction；INT4 wrapper 可展開成 INT8，BF16 helper 可展開成多次向量原語。
- AIE2P arch21 與 AIE2PS arch22 的 FP16/FP8 型別不能混用。
- [Qwen README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/README.md) 的舊 prose 與新 routing table 有不同裝置描述；[model.py](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) 的分支是本版本查核的優先依據。
- [FLM官方README](https://github.com/ROCm/FastFlowLM/blob/089e56d29416990e168abed43aff88fc0ad664f3/README.md) 區分 CLI/orchestration 與 binary kernels；它的「任何用途含商用免費」又與同版 [TERMS.md](https://github.com/ROCm/FastFlowLM/blob/089e56d29416990e168abed43aff88fc0ad664f3/TERMS.md) 的年營收授權門檻矛盾。不可裁定無条件商用，也不可把binary runtime當完整可重建開源stack。

不能解決的矛盾應留在條目，不應刪掉不利證據讓敘述更順。

## 尚未建立的證據

沒有量到本機 NPU 的時脈、真實可用partition、頻寬、每指令週期與功耗。沒有證實本環境可編譯所有範例、完整NPU attention、任意GGUF直接執行、無fallback的所有LLM或最高context。純capacity/roofline計算器不回答這些問題。

AM027 portal 先前只取得 loading頁，沒有假裝下載完整手冊；而且不同target的手冊不能直接拿來證明Ryzen AIE2P的所有指令能力。

## 擴充來源的規則

先保存來源身份、版本/日期、精確段落或行號與hash；將一句主張縮到可驗證範圍；找不同層的反例；決定是事實、推導、待測還是已過期。更新相關條目、backlinks、log与exports，最後跑網站與連結測試。更多維護方式見 [Wiki方法](wiki-method.md)。

## 來源
- [AMD XDNA architecture](https://www.amd.com/en/technologies/xdna.html) — 廠商公共架構介紹，包含不同世代內容，不能視為完整 AIE2P ISA 規格。
- [NPU device models](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/docs/Devices.md) — 裝置型號與 partition 描述，不能直接推出效能。
- [Qwen2.5 model.py](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/model.py) — 固定 source snapshot；裝置分支必須以實際程式為準，未在本機執行。
- [Qwen2.5 README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/examples/qwen2_5/README.md) — 部分敘述與 routing table 有差異，須交叉閱讀 model.py。
- [FastFlowLM README 固定快照](https://github.com/ROCm/FastFlowLM/blob/089e56d29416990e168abed43aff88fc0ad664f3/README.md) — 固定 SHA；README 的商用敘述與同版 TERMS.md 不一致，不能當成無條件商用授權。
- [FastFlowLM proprietary binary 條款](https://github.com/ROCm/FastFlowLM/blob/089e56d29416990e168abed43aff88fc0ad664f3/TERMS.md) — 同版條款列公司年營收 USD 10 million 門檻，與 README 免費任何商用的敘述有衝突；部署前須向權利人確認。
- [FastFlowLM Linux 安裝指南](https://fastflowlm.com/docs/install_lin/) — 外部可變來源；2026-09-12 查閱。需求專屬於此 runtime，不是所有 IRON 版本的要求。
- [Triton-XDNA README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) — 實驗性 compiler；上游效能數字不代表本機量測。

## 關聯
- [wiki-method](wiki-method.md)
- [validation](validation.md)
- [qwen-case](qwen-case.md)
- [datatypes](datatypes.md)
- [deployment](deployment.md)

## 反向連結
- [isa](isa.md)
- [deployment](deployment.md)
- [wiki-method](wiki-method.md)
