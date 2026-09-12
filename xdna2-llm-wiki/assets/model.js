(function(root){
 'use strict';
 function positive(v,label,integer=false,max=1e9){
  if(typeof v!=='number'||!Number.isFinite(v)||v<=0||v>max||(integer&&!Number.isInteger(v)))throw new RangeError(`${label} 請輸入 0 以上、${max} 以下的${integer?'整數':'數值'}（不含 0）。`);
  return v;
 }
 function safe(v){if(!Number.isSafeInteger(v))throw new RangeError('計算結果超出安全整數範圍，請縮小輸入。');return v;}
 function search(records,query='',category='全部'){
  const terms=query.toLocaleLowerCase().trim().split(/\s+/u).filter(Boolean);
  return records.filter(r=>(category==='全部'||r.category===category)&&terms.every(t=>[r.title,r.summary,r.body,...(r.tags||[])].join(' ').toLocaleLowerCase().includes(t)));
 }
 function kv(o){
  for(const key of ['batch','layers','heads','dim','tokens'])positive(o[key],key,true,1e6);
  if(![1,2,4].includes(o.bytes))throw new RangeError('KV 元素位元組僅支援 1、2、4。');
  const perToken=safe(2*o.batch*o.layers*o.heads*o.dim*o.bytes);
  return {perToken,total:safe(perToken*o.tokens)};
 }
 function weights(billions,bits){positive(billions,'參數十億數',false,1000);if(![4,8,16,32].includes(bits))throw new RangeError('權重 bits 必須為 4、8、16、32。');return billions*1e9*bits/8;}
 function gemm(o){
  for(const key of ['m','k','n'])positive(o[key],key,true,65536);
  for(const key of ['inputBytes','outputBytes'])if(![1,2,4].includes(o[key]))throw new RangeError('元素 bytes 必須為 1、2、4。');
  positive(o.tops,'假設算力',false,1e6);positive(o.bandwidth,'假設頻寬',false,1e6);
  if(o.tops<0.1||o.bandwidth<0.1)throw new RangeError('假設算力與假設頻寬必須至少為 0.1。');
  const ops=safe(2*o.m*o.k*o.n),bytes=safe((o.m*o.k+o.k*o.n)*o.inputBytes+o.m*o.n*o.outputBytes);
  const computeSeconds=ops/(o.tops*1e12),memorySeconds=bytes/(o.bandwidth*1e9);
  if(!Number.isFinite(computeSeconds)||!Number.isFinite(memorySeconds))throw new RangeError('計算時間超出有限數值範圍，請調整輸入。');
  return {ops,bytes,intensity:ops/bytes,computeSeconds,memorySeconds,lowerSeconds:Math.max(computeSeconds,memorySeconds),bottleneck:computeSeconds>=memorySeconds?'compute':'memory'};
 }
 const api={search,kv,weights,gemm};
 if(typeof module==='object'&&module.exports)module.exports=api;else root.WikiModel=api;
})(typeof globalThis==='object'?globalThis:this);
