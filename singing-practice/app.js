import {LIMITS,validateBounds,chartAlignment} from './analysis.js';
import {createDemo,encodeWav} from './audio-utils.js';
const $=id=>document.getElementById(id);
let recording=null, reference=null, generation=0, busy=false, requesting=false;
let stream=null, recorder=null, recordingTimer=null, clockTimer=null, workerJob=null, chartData=null;
const urls={recording:null,reference:null};
function status(message){$('status').textContent=message;}
function clearError(){$('error').hidden=true;$('error').textContent='';}
function showError(error){$('error').textContent=error.message || String(error);$('error').hidden=false;status('暫時無法繼續，請依提示再試一次。');}
function updateControls(){
  const active=busy || requesting || !!recorder;
  for(const id of ['recording-file','reference-file','record','demo','remove-reference']) $(id).disabled=active;
  $('alignment-offset').disabled=active || !reference;
  $('alignment-auto').disabled=active || !reference;
  $('analyze').disabled=active || !recording;
  $('stop').disabled=!recorder || recorder.state!=='recording';
  document.body.classList.toggle('recording',!!recorder);
  $('analyze').textContent=busy?'正在處理音訊…':'開始分析 ↗';
}
function releaseUrl(kind){
  const el=$(kind==='recording'?'preview':'reference-preview');
  el.pause();el.removeAttribute('src');el.load();
  if(urls[kind]) URL.revokeObjectURL(urls[kind]);urls[kind]=null;
}
function setPreview(kind,blob){releaseUrl(kind);urls[kind]=URL.createObjectURL(blob);$(kind==='recording'?'preview':'reference-preview').src=urls[kind];}
function clearResult(){
  chartData=null;$('score').textContent='—';$('metric-title').textContent=reference?'參考音高符合度':'長音穩定度';
  $('mode-label').textContent='等待分析';$('result-description').textContent='這裡沒有標準答案，只有下一次練習的起點。';
  $('result-detail').textContent='分析後，會顯示可辨識人聲與可用長音的長度。';
  $('reference-legend').hidden=true;$('chart-empty').hidden=false;
  $('chart-empty').innerHTML='聲音會在這裡留下軌跡。<br><span>先錄一段，或試試合成示範。</span>';
  $('contour').setAttribute('aria-label','尚無音高資料，上傳或錄音後分析。');
  $('chart-caption').textContent='橫軸：時間（秒） · 縱軸：音高（Hz，對數刻度）';drawChart();
}
function clearSource(kind){
  $('alignment-offset').value='';
  releaseUrl(kind);
  if(kind==='recording'){recording=null;$('source-panel').hidden=true;$('source-name').textContent='尚未選擇錄音';$('recording-file').value='';}
  else {reference=null;$('reference-name').textContent='尚未加入參考音檔';$('reference-file').value='';$('remove-reference').hidden=true;$('reference-preview').hidden=true;}
  clearResult();
}
function cancelWorker(){if(workerJob){workerJob.worker.terminate();workerJob.reject(new Error('已取消分析'));workerJob=null;}}
function stopTracks(){if(stream){stream.getTracks().forEach(t=>t.stop());stream=null;}clearTimeout(recordingTimer);clearInterval(clockTimer);recordingTimer=null;clockTimer=null;}
function reset(){
  generation++;cancelWorker();
  const old=recorder;recorder=null;
  if(old && old.state!=='inactive'){try{old.stop();}catch{/* already stopped */}}
  stopTracks();busy=false;requesting=false;clearSource('recording');clearSource('reference');clearError();$('timer').textContent='00:00';
  status('準備好了，就從一個音開始。');updateControls();
}
async function decode(blob,trimMic=false){
  validateBounds(blob.size);
  // Only internal MediaRecorder blobs bypass metadata: capture is limited by
  // the 90-second stop timer and byte cap. Uploaded WebM may report Infinity.
  if(!trimMic) validateBounds(blob.size,await probeDuration(blob));
  const AudioContext=window.AudioContext || window.webkitAudioContext;
  if(!AudioContext) throw new Error('此瀏覽器不支援 Web Audio，請換用新版瀏覽器。');
  const context=new AudioContext();
  try {
    let buffer;
    try{buffer=await context.decodeAudioData(await blob.arrayBuffer());}
    catch{throw new Error('音訊無法解碼或格式不支援，請改用 WAV 音檔。');}
    // MediaRecorder may stop a few milliseconds late; mic recordings are explicitly trimmed.
    const duration=trimMic?Math.min(LIMITS.seconds,buffer.duration):buffer.duration;
    validateBounds(blob.size,duration);
    const length=Math.min(buffer.length,Math.floor(duration*buffer.sampleRate));
    const samples=new Float32Array(length);
    for(let c=0;c<buffer.numberOfChannels;c++){
      const channel=buffer.getChannelData(c);
      for(let i=0;i<length;i++) samples[i]+=channel[i]/buffer.numberOfChannels;
    }
    return {samples,rate:buffer.sampleRate,duration};
  } finally {await context.close();}
}
async function probeDuration(blob){
  const audio=document.createElement('audio');
  const url=URL.createObjectURL(blob);
  let timer;
  try {
    return await new Promise((resolve,reject)=>{
      const fail=()=>reject(new Error('無法確認音訊長度或格式不支援，請改用 90 秒內的 WAV 音檔。'));
      audio.preload='metadata';
      audio.onloadedmetadata=()=>Number.isFinite(audio.duration)?resolve(audio.duration):fail();
      audio.onerror=fail;
      timer=setTimeout(fail,10000);
      audio.src=url;
    });
  } finally {
    clearTimeout(timer);
    audio.onloadedmetadata=null;audio.onerror=null;
    audio.pause();audio.removeAttribute('src');audio.load();
    URL.revokeObjectURL(url);
  }
}
async function loadFile(file,kind,trimMic=false){
  if(!file)return;
  const token=++generation;cancelWorker();clearError();clearSource(kind);busy=true;updateControls();status('正在裝置內解碼音訊…');
  try {
    const data=await decode(file,trimMic);
    if(token!==generation)return;
    if(kind==='recording'){
      recording={...data,demo:false};$('source-panel').hidden=false;
      $('source-name').textContent=`${file.name || '麥克風錄音'} · ${data.duration.toFixed(1)} 秒`;
    } else {reference=data;$('reference-name').textContent=`${file.name} · ${data.duration.toFixed(1)} 秒`;$('remove-reference').hidden=false;$('reference-preview').hidden=false;}
    // A trimmed mic preview contains exactly the samples being analyzed.
    setPreview(kind,trimMic?new Blob([encodeWav(data.samples,data.rate)],{type:'audio/wav'}):file);
    clearResult();status(trimMic?'已載入麥克風錄音（最長保留 90 秒），可以開始分析。':'已載入音訊，可以開始分析。');
  } catch(error){if(token===generation)showError(error);}
  finally{if(token===generation){busy=false;updateControls();}}
}
function runWorker(){
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./worker.js',import.meta.url),{type:'module'});
    workerJob={worker,reject};
    const finish=()=>{worker.terminate();if(workerJob?.worker===worker)workerJob=null;};
    worker.onmessage=({data})=>{finish();data.error?reject(new Error(data.error)):resolve(data);};
    worker.onerror=()=>{finish();reject(new Error('音高分析無法啟動，請透過本機 HTTP 或 HTTPS 開啟此頁。'));};
    const a={samples:recording.samples.slice(),rate:recording.rate};
    const b=reference?{samples:reference.samples.slice(),rate:reference.rate}:null;
    const alignment=$('alignment-offset').value.trim()===''?{}:{offsetSeconds:Number($('alignment-offset').value)};
    worker.postMessage({recording:a,reference:b,alignment},[a.samples.buffer,...(b?[b.samples.buffer]:[])]);
  });
}
async function analyze(){
  if(!recording || busy || recorder)return;
  const token=++generation;clearError();clearResult();busy=true;updateControls();status('正在裝置內擷取音高，請稍候…');
  try {
    if($('alignment-offset').validity.badInput)throw new Error('偏移秒數必須是有限數值。');
    const result=await runWorker();if(token!==generation)return;
    chartData=result;renderResult(result);drawChart();status('分析完成。聽一遍，再試著唱一次吧。');
  } catch(error){if(token===generation)showError(error);}
  finally{if(token===generation){busy=false;updateControls();}}
}
function renderResult({singing,reference:ref,metric}){
  $('score').textContent=metric.score===null?'—':String(metric.score);
  $('metric-title').textContent=ref?'參考音高符合度':'長音穩定度';
  $('mode-label').textContent=ref?(metric.mode==='manual'?'手動偏移':metric.score===null?'自動未確認':'自動全域對齊'):recording.demo?'合成示範':'僅觀察長音';
  const demo=recording.demo?'合成音示範，非真人演唱。':'';
  $('result-description').textContent=demo+(metric.score===null?metric.reason:ref?'僅供同旋律、同速度的參考比較；不是唱功或歌曲正確性評分。':'僅表示可用長音的音高波動，不代表唱對音，也不評音色或氣息。');
  $('result-detail').textContent=ref?
    `人聲涵蓋：錄音 ${Math.round(metric.singingCoverage*100)}% · 參考 ${Math.round(metric.referenceCoverage*100)}% · 信心：${metric.mode==='manual'?'人工指定（未驗證配對）':metric.confidence===null?'未確認':`${Math.round(metric.confidence*100)}%（啟發式）`}${Number.isFinite(metric.offset)?` · 偏移 ${metric.offset>=0?'+':''}${metric.offset.toFixed(2)} 秒`:''}${metric.section?` · 實際區段：錄音 ${metric.section.singingStart.toFixed(2)}–${metric.section.singingEnd.toFixed(2)} 秒 ↔ 參考 ${metric.section.referenceStart.toFixed(2)}–${metric.section.referenceEnd.toFixed(2)} 秒 · 共同人聲 ${metric.pairedSeconds.toFixed(2)} 秒（區段內靜音不計）`:''}${metric.score!==null?` · 絕對音分差中位數 ${metric.medianCents.toFixed(1)} cents`:''}`:
    `可辨識人聲 ${metric.voicedSeconds.toFixed(1)} 秒 · 可用長音 ${metric.eligibleSeconds.toFixed(1)} 秒${metric.spreadCents!==null?` · 波動 ${metric.spreadCents.toFixed(1)} cents RMS`:''}`;
  const count=singing.frames.filter(f=>f.hz).length;
  $('chart-empty').hidden=count>0;
  if(!count)$('chart-empty').innerHTML='尚無可辨識音高。<br><span>請靠近麥克風，在安靜處清唱。</span>';
  $('reference-legend').hidden=!ref || !Number.isFinite(metric.offset);
  $('chart-caption').textContent=ref?(Number.isFinite(metric.offset)?'錄音時間軸（秒）；參考平移使用上述同一偏移，陰影為比較區段。未伸縮節奏，非 DTW。':'自動對齊未確認，暫不疊加參考。可手動指定偏移；只適用同速度。'):'橫軸：時間（秒） · 縱軸：音高（Hz，對數刻度）';
  $('contour').setAttribute('aria-label',`音高軌跡：${singing.duration.toFixed(1)} 秒，${count} 個可辨識音框。${$('chart-caption').textContent} ${$('result-detail').textContent}`);
}
function drawChart(){
  const canvas=$('contour'),rect=canvas.getBoundingClientRect(),dpr=window.devicePixelRatio||1;
  canvas.width=Math.round(rect.width*dpr);canvas.height=Math.round(rect.height*dpr);
  const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);
  const w=rect.width,h=rect.height,p={left:36,right:13,top:18,bottom:29};
  const plotW=w-p.left-p.right,plotH=h-p.top-p.bottom;
  const y=hz=>p.top+plotH*(1-Math.log(hz/75)/Math.log(1000/75));
  ctx.font='9px system-ui';ctx.fillStyle='#918698';ctx.strokeStyle='#eee8f0';ctx.lineWidth=1;
  for(const hz of [100,200,400,800]){const py=y(hz);ctx.beginPath();ctx.moveTo(p.left,py);ctx.lineTo(w-p.right,py);ctx.stroke();ctx.fillText(String(hz),5,py+3);}
  const {tracks,start,end}=chartData?chartAlignment(chartData):{tracks:[],start:0,end:1};
  const duration=end-start;
  const section=chartData?.metric.section;
  if(section && Number.isFinite(chartData.metric.offset)){
    ctx.fillStyle='#80639e12';
    ctx.fillRect(p.left+(section.singingStart-start)/duration*plotW,p.top,
      (section.singingEnd-section.singingStart)/duration*plotW,plotH);
  }
  ctx.fillStyle='#918698';ctx.textAlign='center';
  for(let i=0;i<=4;i++){const x=p.left+plotW*i/4;ctx.fillText((start+duration*i/4).toFixed(1),x,h-10);}
  ctx.save();ctx.beginPath();ctx.rect(p.left,p.top,plotW,plotH);ctx.clip();
  tracks.forEach((track,index)=>{
    ctx.strokeStyle=track.color;ctx.lineWidth=2;ctx.setLineDash(index?[4,3]:[]);ctx.beginPath();let connected=false;
    for(const frame of track.data.frames){
      if(!frame.hz){connected=false;continue;}
      const x=p.left+(frame.time+track.offset-start)/duration*plotW,py=y(frame.hz);
      if(connected)ctx.lineTo(x,py);else ctx.moveTo(x,py);connected=true;
    }ctx.stroke();
  });ctx.restore();
}
async function demo(){
  if(busy || recorder)return;
  clearSource('recording');clearSource('reference');clearError();
  const data=createDemo();recording={...data,duration:data.samples.length/data.rate,demo:true};
  $('source-panel').hidden=false;$('source-name').textContent='合成示範 · 6.0 秒 · 非真人錄音';
  setPreview('recording',new Blob([encodeWav(data.samples,data.rate)],{type:'audio/wav'}));updateControls();await analyze();
}
async function startRecording(){
  if(busy || requesting || recorder)return;
  clearError();
  if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder){showError(new Error('此環境不支援錄音。請用 HTTPS 或 localhost 與支援 MediaRecorder 的瀏覽器，或改上傳錄音。'));return;}
  const token=++generation;requesting=true;updateControls();status('等待麥克風權限…');
  try {
    const acquired=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
    if(token!==generation){acquired.getTracks().forEach(t=>t.stop());return;}
    stream=acquired;clearSource('recording');
    const mime=['audio/webm;codecs=opus','audio/mp4','audio/ogg;codecs=opus'].find(t=>MediaRecorder.isTypeSupported(t));
    const current=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);recorder=current;
    const chunks=[];let bytes=0;
    current.ondataavailable=e=>{if(e.data.size){chunks.push(e.data);bytes+=e.data.size;if(bytes>LIMITS.bytes && current.state==='recording')stopRecording();}};
    current.onerror=()=>{
      if(token!==generation)return;generation++;recorder=null;stopTracks();requesting=false;
      if(current.state!=='inactive')try{current.stop();}catch{/* stream already closed */}
      showError(new Error('錄音中斷，請檢查麥克風後重試。'));updateControls();
    };
    current.onstop=()=>{
      if(token!==generation)return;
      recorder=null;stopTracks();updateControls();
      loadFile(new Blob(chunks,{type:current.mimeType}), 'recording',true);
    };
    current.start(500);requesting=false;const began=performance.now();$('timer').textContent='00:00';
    clockTimer=setInterval(()=>{const elapsed=Math.min(90,Math.floor((performance.now()-began)/1000));$('timer').textContent=`${String(Math.floor(elapsed/60)).padStart(2,'0')}:${String(elapsed%60).padStart(2,'0')}`;},200);
    recordingTimer=setTimeout(stopRecording,90000);status('錄音中 · 最長 90 秒，到時自動停止。');updateControls();
  }catch(error){
    if(token!==generation)return;stopTracks();recorder=null;requesting=false;
    const message=error.name==='NotAllowedError'?'無法取得麥克風權限。請在瀏覽器允許錄音，或改用上傳音檔。':error.name==='NotFoundError'?'找不到麥克風，請連接裝置或上傳音檔。':'無法啟動麥克風，可能正被其他程式使用。請稍後再試或上傳音檔。';
    showError(new Error(message));updateControls();
  }
}
function stopRecording(){
  if(recorder?.state==='recording'){recorder.stop();stopTracks();status('錄音已停止，正在整理音訊…');updateControls();}
}
function invalidateAlignment(){
  generation++;cancelWorker();busy=false;clearError();clearResult();
  status('對齊設定已變更，請重新分析。');updateControls();
}
$('alignment-offset').addEventListener('input',invalidateAlignment);
$('alignment-auto').addEventListener('click',()=>{$('alignment-offset').value='';invalidateAlignment();});
$('recording-file').addEventListener('change',e=>loadFile(e.target.files[0],'recording'));
$('reference-file').addEventListener('change',e=>loadFile(e.target.files[0],'reference'));
$('record').addEventListener('click',startRecording);$('stop').addEventListener('click',stopRecording);
$('analyze').addEventListener('click',analyze);$('demo').addEventListener('click',demo);$('reset').addEventListener('click',reset);
$('remove-reference').addEventListener('click',()=>{clearSource('reference');clearError();status('已移除參考，可重新分析長音穩定度。');updateControls();});
for(const id of ['preview','reference-preview']) {
  $(id).addEventListener('error',()=>{
    if($(id).getAttribute('src')) showError(new Error(`${id==='preview'?'錄音':'參考音檔'}預覽無法播放，請更換支援的瀏覽器或重新上傳 WAV 音檔。`));
  });
}
window.addEventListener('pagehide',reset);
new ResizeObserver(drawChart).observe($('contour'));
updateControls();drawChart();
