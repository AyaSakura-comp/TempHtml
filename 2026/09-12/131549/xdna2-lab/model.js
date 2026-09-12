/* Original educational estimator; not an NPU simulator or performance model. */
(function(root) {
  'use strict';
  const modes = {
    i8: {name:'INT8 × INT8',shape:[8,8,8],inputBytes:1,outputBytes:4,acc:'acc32 → INT32',note:'512 MAC／此邏輯 microtile。對應原生整數矩陣路徑；本工具固定用 INT32 輸出。'},
    i16: {name:'INT16 × INT16',shape:[4,4,8],inputBytes:2,outputBytes:4,acc:'acc64 → INT32',note:'128 MAC／此邏輯 microtile。累加與輸出寬度不同；INT32 寫回須考慮縮位、飽和與溢位。'},
    bf16: {name:'BF16 × BF16',shape:[4,8,8],inputBytes:2,outputBytes:4,acc:'accfloat → FP32',note:'256 MAC／此邏輯 microtile。這是 IRON kernel 選用的形狀，不代表恰好一條硬體指令。'},
    bfp: {name:'BF16 → BFP16 路徑',shape:[8,8,8],inputBytes:2,outputBytes:4,acc:'accfloat → FP32',note:'512 MAC／此邏輯 microtile。先從 BF16 轉成共享 exponent 的 BFP16；以精度換吞吐。本估算仍計 BF16 輸入 buffer。'}
  };
  function estimate(mode,m,k,n) {
    if(!Object.hasOwn(modes,mode) || [m,k,n].some(v=>!Number.isInteger(v)||v<1||v>4096)) throw new RangeError('請輸入 1–4096 的整數。');
    const d=modes[mode], [r,s,t]=d.shape;
    const bytes=2*(m*k+k*n)*d.inputBytes+m*n*d.outputBytes+1024;
    return {bytes,fits:bytes<=65536,geometry:m%r===0&&k%s===0&&n%t===0,ops:2*m*k*n};
  }
  const api={modes,estimate};
  if(typeof module!=='undefined' && module.exports) module.exports=api;
  else root.XdnaModel=api;
})(typeof globalThis!=='undefined'?globalThis:this);
