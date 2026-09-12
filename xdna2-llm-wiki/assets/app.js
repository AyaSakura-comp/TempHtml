'use strict';
const menu=document.getElementById('nav-menu');
const desktop=matchMedia('(min-width:980px)');
const sizeMenu=()=>{menu.open=desktop.matches;};
sizeMenu();desktop.addEventListener('change',sizeMenu);
const search=document.getElementById('wiki-search');
if(search){
 const category=document.getElementById('category'),status=document.getElementById('search-status');
 const params=new URLSearchParams(location.search);search.value=params.get('q')||'';
 const initialCategory=params.get('category');if([...category.options].some(o=>o.value===initialCategory))category.value=initialCategory;
 const update=()=>{
  const matches=WikiModel.search(window.WIKI_SEARCH,search.value,category.value),slugs=new Set(matches.map(r=>r.slug));
  for(const card of document.querySelectorAll('.wiki-card'))card.hidden=!slugs.has(card.dataset.slug);
  status.textContent=`顯示 ${matches.length} / ${window.WIKI_SEARCH.length} 篇條目 · 多個關鍵字須同時符合`;
  document.getElementById('no-results').hidden=matches.length!==0;
  const url=new URL(location.href);url.searchParams.delete('q');url.searchParams.delete('category');
  if(search.value.trim())url.searchParams.set('q',search.value.trim());
  if(category.value!=='全部')url.searchParams.set('category',category.value);
  try{history.replaceState(null,'',url);}
  catch(error){if(error.name!=='SecurityError')throw error;}
 };
 search.addEventListener('input',update);category.addEventListener('change',update);
 document.querySelector('.searchbar').addEventListener('submit',e=>{e.preventDefault();update();});
 document.getElementById('reset-search').addEventListener('click',e=>{e.preventDefault();search.value='';category.value='全部';update();search.focus();});
 update();
}
function number(id){return Number(document.getElementById(id).value);}
function bindCalculator(name,calculate){
 const form=document.getElementById(name+'-form');if(!form)return;
 const output=document.getElementById(name+'-result');
 const update=()=>{try{output.textContent=calculate();output.classList.remove('error');}catch(error){output.textContent=error.message;output.classList.add('error');}};
 form.addEventListener('input',update);form.addEventListener('change',update);form.addEventListener('submit',e=>e.preventDefault());update();
}
bindCalculator('kv',()=>{
 const data={};for(const key of ['batch','layers','heads','dim','tokens','bytes'])data[key]=number('kv-'+key);
 const r=WikiModel.kv(data);
 return `理想 KV payload：${(r.total/2**30).toFixed(4)} GiB\n${r.total.toLocaleString('en-US')} bytes\n每新增一個 token / 各序列：${r.perToken.toLocaleString('en-US')} bytes（已含 batch）\n不含權重、scales、padding、分頁或運算暫存。`;
});
bindCalculator('gemm',()=>{
 const data={inputBytes:2,outputBytes:4};for(const key of ['m','k','n','tops','bandwidth'])data[key]=number('gemm-'+key);
 const r=WikiModel.gemm(data);
 return `算術強度：${r.intensity.toFixed(2)} ops/byte\n理想最少流量：${(r.bytes/2**20).toFixed(2)} MiB\n算力下界：${(r.computeSeconds*1000).toFixed(4)} ms\n頻寬下界：${(r.memorySeconds*1000).toFixed(4)} ms\n樂觀整體下界：${(r.lowerSeconds*1000).toFixed(4)} ms（${r.bottleneck==='memory'?'頻寬':'算力'}約束較大）\n這不是 NPU 實測，也不是可達成的延遲保證。`;
});
for(const button of document.querySelectorAll('.copy-code')){
 button.addEventListener('click',async()=>{
  const code=button.nextElementSibling;
  try{await navigator.clipboard.writeText(code.textContent);button.textContent='已複製';}
  catch{button.textContent='請選取下方程式碼複製';}
  button.setAttribute('aria-label',button.textContent);
 });
}
