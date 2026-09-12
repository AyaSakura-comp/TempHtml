# 規格缺口與衝突：哪些已知，哪些不能由 compiler 推成 silicon

分類：架構 · 來源規格／缺口標示 · 來源快照 2026-09-12

把無法核實的cycle、bank、互連與跨世代規格公開列出，避免LLM把推導當成事實。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## 本次能證明的層級

| 層級 | 可回答 | 不可越界 |
|---|---|---|
| 固定Peano TableGen | 指令／operand／register／itinerary／format的來源敘述 | 完整展開opcode數、通用silicon保證 |
| 固定MLIR-AIE model | tile配置、路由合法性、buffer granularity | 全部physical wire／SRAM port實作 |
| 固定AIE-RT regdb/events | 該版本宣告的offset、mask、event名字 | 存取權限、read/write副作用、硬體現況 |
| 具名外部bench | 指定他人機器／設定的觀察 | 本機Strix Halo或所有SKU的結果 |
| 工程推導 | 明示假設的II、容量、下界 | 實測latency／tokens/s |

[Peano README](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L29-L45)、[NPU2模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1077-L1145)與[runtime header](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_params.h#L1-L55)屬相關生態系的不同contract，不冒稱三份完全獨立silicon驗證。

## 尚未核實／不填數字的欄位

- 每一條指令variant在所有mode的silicon latency／throughput；compiler itinerary有值仍須註明來源模型。
- 矽上pipeline級數與每級實體名稱、forwarding拓撲、fetch/decode bandwidth與所有hazard corner cases。
- 每一種stream link的width、clock domain、hop latency、FIFO深度、arbiter fairness與最壞blocking時間。
- SRAM physical bank／port mapping與collision懲罰；allocator partitions不是完整memory microarchitecture。
- SKU-specific可用tile、clock/DVFS/thermal行為、power-gating／reset/recovery時序、完整errata。
- 所有MMIO reserved bits、W1C/read-clear/privilege等副作用；只有mask與DEFVAL不足以安全操作。

「未核實」不等於「不存在」，更不等於0 cycles。本次未取得某手冊，也不能證明AMD從未提供該資訊。

## 保留而不偷偷平均的來源差異

1. **Bank**：compiler core/mem=4/8，runtime event indexes=8/16，見 [模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L830-L835)、[core events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L235-L255)、[mem events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L527-L543)。保留口徑，不硬猜物理配對。
2. **Shim trace input**：compiler=1，[switch模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L971-L994)；runtime=2，[port table](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L346-L384)。當前compiler能否使用第二路未核實。
3. **Mem locks**：local64與DMA192可由鄰接ID視窗解讀，見 [lock local mapping](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1554-L1577)。不是本地容量擴成三倍。
4. **Burst lengths**：compiler64/128/256/512、runtime4/8/16/32，見 [模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1609-L1615)與[check函式](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/dma/xaie_dma_aie2p.c#L27-L50)。仍需caller unit conversion，不直接冒稱兩者衝突。
5. **公開教學簡表**可能寫generic load latency或few cycles；per-variant operand model優先，而且README的exposed-pipeline例子並不是每個AIE2P load的統一8-cycle規格。

## AIE2P 與 AIE2PS 手冊混用風險

[版本header](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20)鎖定arch21。AMD [AM027 portal](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Architecture)是Versal AIE-ML v2；本次抓取僅得到loading頁，未宣稱讀完完整手冊。即使拿到AM027，也須逐項比對AIE2P，而不是搬入FP8/MX6、accumulator數或pipeline圖。

具名外部研究 [Daniel Estévez的Ryzen AI 7 350案例](https://destevez.net/2026/05/getting-peak-tops-on-a-ryzen-ai-7-350-npu/)在更新中指出aie2p/aie2ps與accumulator數差別，但後文仍部分沿用AIE-MLv2資料。本Wiki把它當閱讀assembly／觀測方法的案例，不將其1.8GHz、圖中pipeline或TOPS移植成gfx1151平台保證。附帶的公開assembly圖同样是他人案例，不是本機生成或量測。

## 如何補洞，而不是讓LLM補完

每一缺口建立待驗證項：目標arch/variant、來源檔與SHA、需要的硬體觀察、可否以官方同代文件取代實驗。若未來實驗，先定義可重現kernel、禁止fallback、校準計時、固定partition與clock狀態，再對照compiler模型。沒有實験前保留null與caveat；不讓語言模型因問題要求「所有spec」就填上看似合理的cycle值。

## 維護與交付完整性

本次以固定source snapshots重建資料集，hash見 [manifest](../spec-manifest.json)。全文文章與raw definitions刻意分開：文章回答概念和條件，資料集提供逐record追溯；source catalog不是可離線build的完整toolchain。未下載新模型、未編譯compiler／NPU kernel、未變更driver／服務。出版測試證明網頁連結與匯出一致，不證明晶片效能。

## 來源
- [Peano README](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/README.md#L29-L45) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [NPU2模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L1077-L1145) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [runtime header](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_params.h#L1-L55) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/include/aie/Dialect/AIE/IR/AIETargetModel.h#L830-L835) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [core events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L235-L255) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [mem events](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/events/xaie_events_aie2p.h#L527-L543) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [switch模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L971-L994) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [port table](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/global/xaie2pgbl_reginit.c#L346-L384) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [lock local mapping](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1554-L1577) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [模型](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/lib/Dialect/AIE/IR/AIETargetModel.cpp#L1609-L1615) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [check函式](https://github.com/Xilinx/aie-rt/blob/8849e208bdcc533b20a0ed3f95c1ce961dee9c3a/driver/src/dma/xaie_dma_aie2p.c#L27-L50) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [版本header](https://github.com/Xilinx/llvm-aie/blob/386ca5c6634a84bb224b7248e79df8edabf0722f/clang/lib/Headers/aie2p/aie2p_version.h#L14-L20) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [AM027 portal](https://docs.amd.com/r/en-US/am027-versal-aie-ml-v2/AIE-ML-v2-Architecture) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。
- [Daniel Estévez的Ryzen AI 7 350案例](https://destevez.net/2026/05/getting-peak-tops-on-a-ryzen-ai-7-350-npu/) — 固定原始碼或具名公開文件；來源層級見正文，不是本機硬體量測。

## 關聯
- [spec-index](spec-index.md)
- [instruction-cycles](instruction-cycles.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [interconnect](interconnect.md)
- [dma-registers](dma-registers.md)
- [validation](validation.md)

## 反向連結
- [spec-index](spec-index.md)
- [tile-microarchitecture](tile-microarchitecture.md)
- [interconnect](interconnect.md)
- [dma-registers](dma-registers.md)
- [events-debug](events-debug.md)
