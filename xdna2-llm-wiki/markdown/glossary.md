# 術語辭典：同一個字，在不同層可能不同意思

分類：驗證與知識庫 · 術語整理 · 來源快照 2026-09-12

快速對照 XDNA2、AIE2P、tile、buffer、MMA、BF16/BFP16 與 LLM 推論常用語，並連回完整條目。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 裝置與架構

| 術語 | 本 Wiki 的意思 | 延伸 |
|---|---|---|
| XDNA 2 | Ryzen AI 平台的一代 NPU 架構 | [系統](system.md) |
| AIE2P / arch21 | 本次 source 查核的 XDNA2 core target | [ISA](isa.md) |
| AIE2PS / arch22 | 不同 target，不能移植其 FP8/FP16 支援結論 | [資料型別](datatypes.md) |
| gfx1151 | Strix Halo iGPU 的 ROCm GPU target，不是 NPU | [分工](heterogeneous.md) |
| NPU2 | MLIR-AIE device model 家族名稱 | [系統](system.md) |
| Partition | Runtime 分配的 array 區域，不一定等於整顆硬體 | [runtime](runtime.md) |

架構命名依 [Devices.md](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/docs/Devices.md) 與固定版本 backend；勿把 API 文件中所有世代的同名型別合併成一張 XDNA2 能力表。

## Tile、記憶體與資料流

| 術語 | 重點 |
|---|---|
| Compute tile | 執行本地 scalar/vector 程式，搭配 data/program memory |
| Memory tile / MemTile | staging、重排、分配資料，不是透明一般 CPU L2 cache |
| Shim tile | Host 與 array 的資料入口/出口與相關連接 |
| Scratchpad | 軟體顯式管理的 SRAM，不是硬體自動替換cache |
| Bank | 影響存取衝突與配置的記憶體分區，不能僅靠總容量判斷速度 |
| DMA / BD | 搬運引擎與其 buffer descriptor；descriptor 不是資料本身 |
| ObjectFifo | 編譯器可 lowering 的資料生命週期抽象，不是 Python queue 在 NPU 裡跑 |
| Lock / token | 協調可用資料與可用空間，錯誤 acquire 順序會阻塞 |
| Cascade | 傳遞特定資料／部分累加值的專用路徑；可用性與例子需分開查 |

更多細節見 [記憶體](memory.md)、[DMA](dma.md)、[同步](synchronization.md)；精確數量與地址不可只從這張辭典推導。[core_data_memory](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md) 是 SRAM 的原始閱讀入口。

## 算术與格式

| 術語 | 容易混淆之處 |
|---|---|
| SIMD | 多 lanes 執行相同類別向量計算；不等於 GPU warp |
| VLIW | Compiler 將多種操作排入 instruction bundle；AIE2P 的外露管線由編譯器安排指令相依與讀寫時點，不靠一般指令相依性 stall 邏輯；lock／stream 等資料流等待是另一層問題。見 [Peano README](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L29-L45)。 |
| MMA / MAC | 矩陣或向量乘加；API call 可能展開多條 primitives |
| Accumulator | 中間累加表示，寬度不是輸出dtype |
| BF16 | 每個元素具有自己的 exponent |
| BFP16 | Block floating point，共享 exponent；不是 BF16/IEEE FP16 |
| EBS | Exponent block size，不是單個數值的 bit width |
| Packing | 把資料排成 kernel operand layout，可能包含轉置與量化封装 |
| Emulation | 以其他算術路徑合成；成本與精度要看實作 |

[BF16 helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp) 顯示 macro/specialization 對實作的影響。看「支援」時要問：可表示、可搬運、可做單一primitive、API有組合，還是 frontend已有測試？

## Compiler 與 runtime

IRON 是 Python dataflow programming 入口；MLIR-AIE 是 array 配置與 lowering 基礎；Peano 是 LLVM-AIE core backend；Triton-XDNA 把高階 kernel 經 triton-shared、Transform、AIR 與 AIE stack 降到裝置。[compiler](compiler.md) 串起各層。

XRT 與 HSA 是不同 runtime 路徑；ELF、xclbin、PDI、instruction stream 是不同 artifact，不能只按副檔名交換。Zero-copy 是避免特定 staging copy，不是零交通、零同步或零映射。Fallback 是改由其他 backend 執行；編譯器成功 return 不一定代表所有工作真的在 NPU。

## LLM 與量測

Prefill 處理 prompt 並建立 cache；decode 依賴上一 token 逐步生成；KV cache 保存 keys/values；GQA 共享較少的 KV heads。[GQA 論文](https://arxiv.org/abs/2305.13245v3) 是 query/KV分組的來源。TTFT 是到第一 token 的延遲；TPOT 是後續 token 間隔；tokens/s 可是 batch aggregate 或單序列，必須寫清。

Roofline 用 arithmetic intensity 連接頻寬與算力上界；本 Wiki 工具顯示的是理想時間下界，不是硬體實測。KiB/MiB/GiB 用2的冪，GB/s和TOPS用10的冪。「固定source快照」表示版本可追溯，不代表相互相容可建置的 dependency lock。

## 來源
- [NPU device models](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/docs/Devices.md) — 裝置型號與 partition 描述，不能直接推出效能。
- [Core data memory guide](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md) — SRAM 配置、bank 與 linker context。
- [AIE2P BF16 MMUL helper](https://github.com/Xilinx/aie_api/blob/bec000fd312b407c61f25ef86fd582042e42d28a/include/aie_api/detail/aie2p/mmul_bf16_bf16.hpp) — macro 與 specialization 決定 emulation 路徑。
- [GQA paper v3](https://arxiv.org/abs/2305.13245v3) — query / KV heads 分組與品質權衡。
- [Triton-XDNA README](https://github.com/amd/Triton-XDNA/blob/5c33df1263f29de30f71616780c2e8a88e623782/README.md) — 實驗性 compiler；上游效能數字不代表本機量測。
- [Peano README：外露管線 VLIW](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L29-L45) — 固定 SHA；編譯器安排指令相依與暫存器讀寫時點，不是 lock／stream 等資料流等待的說明。

## 關聯
- [system](system.md)
- [datatypes](datatypes.md)
- [compiler](compiler.md)
- [llm-graph](llm-graph.md)
- [wiki-method](wiki-method.md)

## 反向連結
- [wiki-method](wiki-method.md)
