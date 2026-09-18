export function createDemo() {
  const rate=8000, samples=new Float32Array(rate*6);
  const notes=[220,277.18,329.63,277.18];
  let phase=0;
  for(let i=0;i<samples.length;i++) {
    const t=i/rate, section=Math.min(3,Math.floor(t/1.5)), local=t%1.5;
    const hz=notes[section]*2**((section%2?38:8)*Math.sin(t*2*Math.PI*4)/1200);
    phase+=2*Math.PI*hz/rate;
    const envelope=Math.min(1,local/0.05,(1.5-local)/0.08);
    samples[i]=0.35*envelope*Math.sin(phase);
  }
  return {samples,rate};
}
export function encodeWav(samples,rate) {
  const data=new ArrayBuffer(44+samples.length*2),v=new DataView(data);
  const text=(offset,s)=>{for(let i=0;i<s.length;i++)v.setUint8(offset+i,s.charCodeAt(i));};
  text(0,'RIFF');v.setUint32(4,36+samples.length*2,true);text(8,'WAVE');text(12,'fmt ');
  v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,rate,true);v.setUint32(28,rate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);text(36,'data');v.setUint32(40,samples.length*2,true);
  samples.forEach((x,i)=>v.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,x))*(x<0?32768:32767)),true));
  return data;
}
