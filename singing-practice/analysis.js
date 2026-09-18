// Pure DSP functions shared by the module worker and the Node tests.
export const LIMITS = Object.freeze({bytes:25 * 1024 * 1024, seconds:90, rate:8000, frame:512, hop:160});
export function validateBounds(bytes, duration) {
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes > LIMITS.bytes) throw new Error('檔案需大於 0，且不可超過 25 MB。');
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || duration > LIMITS.seconds)) throw new Error('音訊長度需大於 0，且不可超過 90 秒。');
}
export function downsample(input, fromRate, toRate = LIMITS.rate) {
  if (fromRate === toRate) return input;
  if (fromRate < toRate) throw new Error('音訊取樣率需至少 8 kHz。');
  const ratio = fromRate / toRate;
  const result = new Float32Array(Math.floor(input.length / ratio));
  // Box low-pass before decimation; intended for clean monophonic vocal signals.
  for (let i=0;i<result.length;i++) {
    const start=Math.floor(i*ratio), end=Math.floor((i+1)*ratio);
    let sum=0; for(let j=start;j<end;j++) sum+=input[j];
    result[i]=sum/(end-start);
  }
  return result;
}
export function detectPitch(frame, rate = LIMITS.rate) {
  let energy=0, mean=0;
  for(const x of frame) mean+=x;
  mean/=frame.length;
  for(const x of frame) energy+=(x-mean)**2;
  if (Math.sqrt(energy/frame.length)<0.008) return null;
  const half=Math.floor(frame.length/2);
  // Include the last candidate lag AND its right-hand interpolation neighbor.
  const maxTau=Math.min(half-2,Math.ceil(rate/75));
  const minTau=Math.max(2,Math.floor(rate/1000));
  const cmnd=new Float64Array(maxTau+2); cmnd[0]=1;
  const difference=new Float64Array(maxTau+2);
  let running=0;
  for(let tau=1;tau<=maxTau+1;tau++) {
    let sum=0; for(let i=0;i<half;i++) sum+=(frame[i]-frame[i+tau])**2;
    difference[tau]=sum;
    running+=sum; cmnd[tau]=running ? sum*tau/running : 1;
  }
  for(let tau=minTau;tau<=maxTau;tau++) {
    if(cmnd[tau]<0.15) {
      while(tau<maxTau && cmnd[tau+1]<cmnd[tau]) tau++;
      // A descending edge is not a minimum inside the supported range.
      if(cmnd[tau]>cmnd[tau-1] || cmnd[tau]>cmnd[tau+1]) return null;
      // Interpolate the unnormalized difference to avoid CMND's short-lag bias.
      const a=difference[tau-1],b=difference[tau],c=difference[tau+1];
      const correction=(a+c-2*b) ? (a-c)/(2*(a+c-2*b)) : 0;
      // Keep boundary-bin interpolation inside the inclusive supported range.
      const lag=Math.max(rate/1000,Math.min(rate/75,tau+Math.max(-1,Math.min(1,correction))));
      const hz=rate/lag;
      return hz>=75 && hz<=1000 ? hz : null;
    }
  }
  return null;
}
export function analyzeSamples(input, rate = LIMITS.rate) {
  const samples=downsample(input,rate), frames=[];
  for(let i=0;i+LIMITS.frame<=samples.length;i+=LIMITS.hop) {
    frames.push({time:i/LIMITS.rate,hz:detectPitch(samples.subarray(i,i+LIMITS.frame))});
  }
  return {frames, hop:LIMITS.hop/LIMITS.rate, duration:input.length/rate};
}
const median = values => { const s=[...values].sort((a,b)=>a-b); const m=Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; };
const cents = hz => 1200*Math.log2(hz/440);
export function steadiness(analysis) {
  const {frames,hop}=analysis;
  const voicedSeconds=frames.filter(f=>f.hz).length*hop;
  const base={score:null,voicedSeconds,eligibleSeconds:0,spreadCents:null};
  if(voicedSeconds<0.8) return {...base,reason:'可辨識人聲不足：請清唱至少 1 秒的持續長音。'};
  const count=Math.ceil(0.6/hop), deviations=[];
  // Non-overlapping >=600 ms windows. Reject silence and note changes >200 cents.
  for(let i=0;i+count<=frames.length;) {
    const window=frames.slice(i,i+count);
    const values=window.filter(f=>f.hz).map(f=>cents(f.hz));
    if(values.length!==count || Math.max(...values)-Math.min(...values)>200) {i++;continue;}
    const center=median(values);
    deviations.push(...values.map(v=>(v-center)**2)); i+=count;
  }
  if(deviations.length*hop<0.6) return {...base,reason:'長音資料不足：找不到至少 0.6 秒的近似持續音。'};
  const spreadCents=Math.sqrt(deviations.reduce((a,b)=>a+b,0)/deviations.length);
  return {...base,score:Math.round(Math.max(0,100-spreadCents*1.2)),spreadCents,eligibleSeconds:deviations.length*hop};
}
// Offset convention: singingTime = referenceTime + offset (seconds).
// Same tempo only: a single translation, never DTW or score transposition.
const ALIGNMENT = Object.freeze({minSeconds:3, minCoverage:0.65,
  maxResidual:70, minCorrelation:0.9, ambiguityGap:0.18, distinctSeconds:0.5});
export function compareReference(singing, reference, options={}) {
  const manual=Object.hasOwn(options,'offsetSeconds');
  const mode=manual?'manual':'auto';
  if(manual && (typeof options.offsetSeconds!=='number' || !Number.isFinite(options.offsetSeconds) ||
    options.offsetSeconds<=-reference.duration || options.offsetSeconds>=singing.duration))
    throw new Error('偏移秒數必須是有限數值，且介於 −參考長度與錄音長度之間（不含端點）。');
  const none={score:null,medianCents:null,coverage:0,singingCoverage:0,referenceCoverage:0,
    offset:null,pairedSeconds:0,section:null,confidence:null,mode,
    reason:'共同可辨識人聲不足：需至少 3 秒，並涵蓋較短人聲至少 65%。'};
  const a=singing.frames.map(f=>f.hz?cents(f.hz):null), b=reference.frames.map(f=>f.hz?cents(f.hz):null);
  const aSeconds=a.filter(v=>v!==null).length*singing.hop, bSeconds=b.filter(v=>v!==null).length*reference.hop;
  const shorter=Math.min(aSeconds,bSeconds);
  if(shorter<ALIGNMENT.minSeconds) return none;
  // Nearest reference frame; identical mapping for search and final score.
  const refIndex=(time,offset)=>Math.round((time-offset-(reference.frames[0]?.time||0))/reference.hop);
  let offset=options.offsetSeconds, confidence=null;
  if(!manual) {
    const step=Math.min(singing.hop,reference.hop), dt=singing.hop;
    function candidate(offset) {
      let n=0,sx=0,sy=0,sxx=0,syy=0,sxy=0,changesA=0,changesB=0,prevA=null,prevB=null;
      let lastVoice=-Infinity,changeA=-Infinity,changeB=-Infinity;
      for(let i=0;i<a.length;i++) {
        const x=a[i],y=b[refIndex(singing.frames[i].time,offset)];
        if(x===null || y==null)continue;
        const time=singing.frames[i].time;
        // YIN may leave short unvoiced holes at note boundaries. Do not erase
        // melodic evidence at those holes, or count several frames of one transition.
        if(time-lastVoice>0.2){prevA=x;prevB=y;}
        if(Math.abs(x-prevA)>70 && time-changeA>=0.12){changesA++;prevA=x;changeA=time;}
        if(Math.abs(y-prevB)>70 && time-changeB>=0.12){changesB++;prevB=y;changeB=time;}
        lastVoice=time;
        n++;sx+=x;sy+=y;sxx+=x*x;syy+=y*y;sxy+=x*y;
      }
      const shared=n*dt, coverage=Math.min(1,shared/shorter);
      if(shared+1e-9<ALIGNMENT.minSeconds || coverage<ALIGNMENT.minCoverage || changesA<4 || changesB<4)return null;
      const vx=Math.max(0,sxx/n-(sx/n)**2),vy=Math.max(0,syy/n-(sy/n)**2),cov=sxy/n-sx*sy/(n*n);
      if(vx<80**2 || vy<80**2)return null;
      const residual=Math.sqrt(Math.max(0,vx+vy-2*cov)), correlation=cov/Math.sqrt(vx*vy);
      // Relative contour fit locates the phrase. Absolute pitch is NOT removed from the score below.
      return {offset,residual,correlation,loss:residual/100+0.25*(1-coverage)};
    }
    const candidates=[];
    // Evaluate EVERY admissible offset at native frame resolution, including rivals.
    // Coarse-grid-only rivals can miss an equally good repeated phrase one hop away.
    const lo=Math.ceil((-reference.duration+ALIGNMENT.minSeconds)/step);
    const hi=Math.floor((singing.duration-ALIGNMENT.minSeconds)/step);
    for(let k=lo;k<=hi;k++){const c=candidate(k*step);if(c)candidates.push(c);}
    candidates.sort((x,y)=>x.loss-y.loss);
    const best=candidates[0];
    if(!best || best.residual>ALIGNMENT.maxResidual || best.correlation<ALIGNMENT.minCorrelation)
      return {...none,reason:'無法可靠自動對齊：旋律變化不足或輪廓不相符。可人工指定偏移；仍需同速度。'};
    const rival=candidates.find(c=>Math.abs(c.offset-best.offset)>=ALIGNMENT.distinctSeconds);
    const gap=rival?rival.loss-best.loss:Infinity;
    if(gap<ALIGNMENT.ambiguityGap)
      return {...none,reason:'無法可靠自動對齊：有多個相似樂句，位置不明確。請人工指定偏移。'};
    offset=best.offset;
    // Heuristic confidence, not a calibrated probability or singing grade.
    confidence=Math.min(1,Math.max(0,1-best.residual/250),gap===Infinity?1:0.7+0.3*Math.min(1,gap/0.6));
  }
  const differences=[];let first=null,last=null,refFirst=null,refLast=null;
  for(let i=0;i<a.length;i++) {
    const f=singing.frames[i], j=refIndex(f.time,offset);
    if(a[i]===null || b[j]==null)continue;
    differences.push(Math.abs(a[i]-b[j]));
    if(first===null){first=f.time;refFirst=reference.frames[j].time;}
    last=f.time;refLast=reference.frames[j].time;
  }
  const pairedSeconds=differences.length*singing.hop;
  const singingCoverage=Math.min(1,pairedSeconds/aSeconds),referenceCoverage=Math.min(1,pairedSeconds/bSeconds);
  const coverage=Math.max(singingCoverage,referenceCoverage);
  const section=first===null?null:{singingStart:first,singingEnd:last+singing.hop,
    referenceStart:refFirst,referenceEnd:refLast+reference.hop};
  const details={...none,offset,confidence,pairedSeconds,singingCoverage,referenceCoverage,coverage,section};
  if(pairedSeconds+1e-9<ALIGNMENT.minSeconds || coverage+1e-9<ALIGNMENT.minCoverage)
    return {...details,offset:manual?offset:null,confidence:null};
  const medianCents=median(differences);
  return {...details,reason:null,score:Math.round(Math.max(0,100-medianCents/2)),medianCents};
}

// The renderer consumes this model: no independent onset detection/alignment.
export function chartAlignment({singing,reference,metric}) {
  const tracks=[{data:singing,offset:0,color:'#80639e'}];
  if(reference && Number.isFinite(metric.offset))tracks.push({data:reference,offset:metric.offset,color:'#628e85'});
  return {tracks,start:Math.min(0,...tracks.map(t=>t.offset)),
    end:Math.max(1,...tracks.map(t=>t.data.duration+t.offset))};
}
