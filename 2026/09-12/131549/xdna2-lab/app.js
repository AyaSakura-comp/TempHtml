'use strict';
const tileInfo = {
 compute: ['Compute tile：算，也負責本地控制','Scalar control + SIMD/vector 計算 + VLIW 指令 bundle。從本地 SRAM 載入向量，送入 multiply/accumulate 路徑；與 DMA、鄰近 tile、stream switch 配合。每核 L1 64 KiB，stack、FIFO 與 globals 共用容量。'],
 memory: ['Memory tile：512 KiB staging 與 layout 轉換','位於 row 1。使用 DMA 將大矩陣切成 microtile layout，分發或廣播到 compute tiles，也收集輸出。MemTile 的 4D buffer descriptor 可表達比 core/shim 更多的 addressing dimensions；它不是一般透明 L2 cache。'],
 shim: ['Shim tile：整座工廠的 host 入口','位於 row 0。Shim DMA 連接 system DRAM 與 array 的 streaming fabric。Runtime 的 fill/drain 設定主機與 NPU 的資料轉移；descriptor 數量、傳輸模式與 launch/sync overhead 都可能限制端到端速度。']
};
for (const button of document.querySelectorAll('[data-tile]')) {
 button.addEventListener('click', () => {
  for (const b of document.querySelectorAll('[data-tile]')) b.setAttribute('aria-pressed',String(b === button));
  const [title,text]=tileInfo[button.dataset.tile];
  const panel=document.getElementById('tile-detail');
  panel.replaceChildren();
  const h=document.createElement('h3');h.textContent=title;
  const p=document.createElement('p');p.textContent=text;
  panel.append(h,p);
 });
}
function update() {
 const mode=document.getElementById('dtype').value;
 const d=XdnaModel.modes[mode], [r,s,t]=d.shape;
 const detail=document.getElementById('mma-detail');
 detail.replaceChildren();
 for(const [tag,content,cls] of [['div',`[${r} × ${s}] · [${s} × ${t}] + [${r} × ${t}]`,'math'],['p',d.acc,''],['p',d.note,'small']]){
  const node=document.createElement(tag);node.textContent=content;node.className=cls;detail.append(node);
 }
 const panel=document.getElementById('estimate');panel.replaceChildren();
 try{
  const result=XdnaModel.estimate(mode,...['dim-m','dim-k','dim-n'].map(id=>Number(document.getElementById(id).value)));
  const big=document.createElement('b');big.textContent=`${(result.bytes/1024).toFixed(1)} / 64 KiB`;
  const p=document.createElement('p');p.className=result.fits?'native':'emul';p.textContent=result.fits?'容量初篩：低於 L1 上限（非編譯保證）。':'容量超限：需要縮小 tile 或修改 buffering。';
  const g=document.createElement('p');g.className=result.geometry?'small':'emul';g.textContent=result.geometry?'Microtile 整除：通過；仍須检查 outer expansion 與 array tiling。':'Microtile 整除：不通過。m、k、n 必須分別為 r、s、t 的倍數。';
  const o=document.createElement('p');o.className='small';o.textContent=`每個 core tile 的數學工作量：${result.ops.toLocaleString('en-US')} operations（2 / MAC），不是量測 TOPS。`;
  panel.append(big,p,g,o);
 }catch(error){const p=document.createElement('p');p.className='emul';p.textContent=error.message;panel.append(p);}
}
document.getElementById('dtype').addEventListener('change',update);
for(const id of ['dim-m','dim-k','dim-n'])document.getElementById(id).addEventListener('input',update);
update();
