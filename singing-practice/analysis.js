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
export function compareReference(singing, reference) {
  const first=singing.frames.findIndex(f=>f.hz), refFirst=reference.frames.findIndex(f=>f.hz);
  const none={score:null,medianCents:null,coverage:0,reason:'共同可辨識人聲不足：需至少 0.8 秒，並涵蓋雙方至少 60% 的人聲。'};
  if(first<0 || refFirst<0) return none;
  const start=singing.frames[first].time, refStart=reference.frames[refFirst].time;
  const differences=[];
  for(const f of singing.frames.slice(first)) {
    const j=Math.round((f.time-start+refStart)/reference.hop);
    const r=reference.frames[j];
    if(f.hz && r?.hz) differences.push(Math.abs(1200*Math.log2(f.hz/r.hz)));
  }
  const denominator=Math.max(singing.frames.filter(f=>f.hz).length,reference.frames.filter(f=>f.hz).length);
  const coverage=differences.length/denominator;
  if(differences.length*singing.hop<0.8 || coverage<0.6) return {...none,coverage};
  const medianCents=median(differences);
  return {score:Math.round(Math.max(0,100-medianCents/2)),medianCents,coverage,offset:start-refStart,pairedSeconds:differences.length*singing.hop};
}
