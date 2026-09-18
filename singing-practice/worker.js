import {analyzeSamples,steadiness,compareReference} from './analysis.js';
self.onmessage = ({data}) => {
  try {
    const singing=analyzeSamples(data.recording.samples,data.recording.rate);
    const reference=data.reference ? analyzeSamples(data.reference.samples,data.reference.rate) : null;
    self.postMessage({singing,reference,metric:reference?compareReference(singing,reference):steadiness(singing)});
  } catch(error) {self.postMessage({error:error.message});}
};
