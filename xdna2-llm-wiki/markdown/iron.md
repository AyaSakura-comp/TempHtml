# IRON：以 Worker 與 ObjectFifo 設計資料流

分類：程式設計 · 來源查核 · 來源快照 2026-09-12

從生成式 Python、FIFO 所有權到 Runtime 等待，建立可讀、可查核的 XDNA2 空間程式。

> 公開資料與固定版本原始碼；未執行 NPU 實測。

## Python 是設計生成器

IRON 的 Python 執行在主機上，生成將被降階的 MLIR；不是讓 AIE 核心直接跑 Python。[IRON 結構元件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-1/README.md) 特別區分 `range_` 與 Python `range`：前者建立裝置迴圈，後者在生成時反覆展開敘述。原生 `if` 同樣依生成時條件選擇程式，不應拿來表達未知的裝置端分支。

`Worker` 表示一個計算核心上的程式；指定 `Tile(0,2)` 是固定位置，未指定則留待 placement。`Program.resolve_program()` 將元件關係組合起來，之後仍要配置實體位置、緩衝及路由。這種分層使「能生成 MLIR」與「放得進目標分區」成為可分辨的兩個驗證關卡。

## 元件與資料契約

| 元件 | 契約 | 容易誤解之處 |
|---|---|---|
| Buffer | 核心可見的有型別儲存 | 不等於主機 tensor 的原始指標 |
| ObjectFifo | 有序、固定物件型別的資料流 | depth 是物件數，不是位元組數 |
| Worker | 核心函式及其參數、放置條件 | Python 函式只是生成來源 |
| Runtime | host-facing 引數與搬移序列 | 不等同 XRT／HSA 主機函式庫 |
| Program | 串接 Worker、Runtime、裝置 | resolve 不等於 NPU 已執行 |

依 [ObjectFifo 語意](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2a/README.md)，ObjectFifo 只有一個 producer，可有多個 consumer；預設 depth 為二，表示常見的 ping-pong buffering。對同一 FIFO 呼叫 `prod()` 取得同一 producer handle，`cons()` 則建立對應 consumer 的 handle。若把兩個獨立寫入者當成合法多 producer，問題不是加深 FIFO 就能解決，而是資料流契約本身需重設。

## acquire 與 release 是所有權協定

核心應先取得物件，再計算，最後交還。以下為 [ObjectFifo 語意](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2a/README.md) 的 handle 用法縮寫，僅展示函式內片段，並非完整設計：

```python
item = of_in.acquire(1)
result = of_out.acquire(1)
#在已取得的輸入／輸出物件上計算
of_in.release(1)
of_out.release(1)
```

尚未 release 的物件仍屬於這次持有範圍；連續 acquire 不能想成無限追加新物件。多物件 acquire 的索引零代表最舊的持有物件，release 也依舊到新交還。這是滑動視窗能重用資料的基礎，亦是常見死鎖來源。每個 consumer 的進度都必須與 producer 配合；只看算子數量相等，不能證明資料流能向前推進。連結 [同步](synchronization.md) 可將 FIFO 協定與硬體 lock 區分開。

## Runtime 等待必須覆蓋整條依賴

[IRON Runtime tasks](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2d/RuntimeTasks.md) 的序列以 producer handle `fill(a)` 傳入資料，以 consumer handle `drain(c, wait=True)` 收回結果。Worker 是交給 `Program(..., workers=[...])`，不是在 sequence 內以舊版啟動 API 呼叫。shim 位置如需固定，是放在建立 handle 的 `prod(tile=...)`／`cons(tile=...)`，不是憑空加給 fill。

TaskGroup 結束會等有標記的工作，然後回收整組資源。輸入 fill 可以不單獨等待的前提，是已等待的輸出 drain 必然依賴該輸入完成。若某個旁支沒有通往任何已等待的輸出，就可能先回收仍在使用的 BD。此處的優化問題是依賴證明，不是「wait 越少越快」；主機能讀結果，也不代表所有背景工作皆已安全結束。

## 從單核心例子走向矩陣乘法

[IRON vector_scalar_add 範例](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_examples/basic/vector_scalar_add/vector_scalar_add.py) 使用 `@iron.jit` 加上 `transform(lambda x: x + 1, ...)`，把 FIFO、Worker 與 memtile staging 細節交給演算法輔助層。以下是已核對路徑及參數、但未執行的範例；須先有相符工具環境：

```bash
cd sources/mlir-aie
python3 programming_examples/basic/vector_scalar_add/vector_scalar_add.py \
  --dev npu2 --emit-mlir
```

若要閱讀多核心 GEMM，可參照 [IRON whole_array 矩陣乘法](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_examples/basic/matrix_multiplication/whole_array/whole_array.py#L442-L524)。以下亦未執行；若實際執行將編譯並測試，八欄必須符合可用硬體分區：

```bash
cd sources/mlir-aie/programming_examples/basic/matrix_multiplication/whole_array
python3 whole_array.py --dev npu2 --n-aie-cols 8 \
  -M 512 -K 512 -N 512 -m 64 -k 64 -n 32 \
  --dtype_in bf16 --dtype_out f32 --use-chess 0
```

兩個 `cd` 區塊都以本研究根目錄為起點，不能直接在前一個工作目錄接續貼上。大小寫參數分別描述問題與 tile；改變任一數值都需重新檢查整除、搬移排列及輸出布局，不能只修改 GEMM 的數學形狀。

## 容量與可重現性一起檢查

[核心資料記憶體與 stack](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L9-L153) 明確將 stack、ObjectFifo 的 L1 buffers 以及 `.data/.rodata/.bss` 放在同一個小型資料 SRAM 預算中。雙緩衝會增加物件儲存，常數表與外部核心呼叫也會消耗空間；總剩餘量夠大，不代表存在連結所需的連續區域。

[IRON 編譯階段與產物](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/compilation_stages.md) 提供 `as_mlir()`、`compile()` 與呼叫三個觀察層級。應先保存生成參數與 MLIR，再檢查放置、buffer address、stack 需求，最後才做實際 runtime 驗證。由既有 xclbin／指令流建立 `NPUKernel` 會繞過 JIT 的 tensor-size metadata 檢查，作者須自行保證參數形狀與型別。這正是 IRON「可控制」同時意味「需明確負責」的地方。

## 用小型資料流檢查設計推理

在擴張核心數以前，可先用紙上追蹤表檢查單輸入、單輸出的資料流：第零個輸入物件何時可取得，對應哪個輸出物件，何時 release，以及哪個 drain 證明該批資料完成。這是來源語意導出的設計練習，不是本次執行測試。若每次核心迴圈處理一個物件，主機卻只送出不足的物件數，最後的等待就可能永遠缺資料；若主機送更多，則要釐清額外物件是否仍在佇列中。

接著加入第二個 consumer，分別追蹤兩者的取得與交還，而不要把廣播想成兩份彼此無關的拷貝。深度只能改變可暫存的物件數，不能修復漏掉 release、錯誤的消費比率或互相等待的循環。若引入滑動視窗，還應明列保留的舊物件和新取得物件，讓下一次呼叫的索引具有可檢查的意義。

最後再估算每個 tile 的同時存活資料，而不是把全程所有陣列相加。輸入、輸出、雙緩衝、暫存與 stack 哪些重疊，會影響可行性；把兩個階段融合可能減少跨 tile 搬移，也可能延長中間值的生命週期。這些取捨需要結合生成後的地址與實際工作負載驗證，不能只從 Python 行數變少判斷優化是否成功。

## 來源
- [IRON 結構元件](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-1/README.md) — Worker、Program、range_ 與 placement。
- [ObjectFifo 語意](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2a/README.md) — depth、單一 producer、多 consumer、acquire / release。
- [IRON Runtime tasks](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/section-2/section-2d/RuntimeTasks.md) — fill / drain、TaskGroup、完成依賴與資源回收。
- [IRON vector_scalar_add 範例](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_examples/basic/vector_scalar_add/vector_scalar_add.py) — 查核 CLI 與 JIT generator；命令未執行。
- [IRON whole_array 矩陣乘法](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_examples/basic/matrix_multiplication/whole_array/whole_array.py#L442-L524) — 查核 npu2、8 欄、BF16 / f32 與 Peano 參數。
- [核心資料記憶體與 stack](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/core_data_memory.md#L9-L153) — stack、FIFO buffer、靜態資料共用 SRAM；需連續空間。
- [IRON 編譯階段與產物](https://github.com/Xilinx/mlir-aie/blob/0ed8e7e477fd9094acee8dada7ab81604a7fb07a/programming_guide/compilation_stages.md) — JIT、recipe / artifact hash、核心 ELF 與預設 XRT 載入。

## 關聯
- [compiler](compiler.md)
- [dma](dma.md)
- [synchronization](synchronization.md)
- [memory](memory.md)
- [runtime](runtime.md)
- [gemm](gemm.md)

## 反向連結
- [dma](dma.md)
- [synchronization](synchronization.md)
- [compiler](compiler.md)
- [deployment](deployment.md)
