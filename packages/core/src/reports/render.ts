import type {FaultlineReport} from '../../../contracts/src/generated.js';
import {demand} from '../errors.js';
const escape=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
export function renderReport(value:FaultlineReport,format:string){
 const structured=JSON.stringify(value,null,2);
 if(format==='json')return {bytes:Buffer.from(structured),media_type:'application/json',extension:'json'};
 const lines=[value.title,...value.findings.map(f=>f.text),...value.alternatives,...value.limitations,...value.recommended_actions,'Aggregate causal effect: not established.'];
 if(format==='html')return {bytes:Buffer.from('<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>Investigation report</title></head><body>'+lines.map(x=>'<p>'+escape(x)+'</p>').join('')+'<h2>Frozen report, claim and citation metadata</h2><pre>'+escape(structured)+'</pre></body></html>'),media_type:'text/html',extension:'html'};
 demand(format==='markdown','UNSUPPORTED_EXPORT','Choose JSON, safe HTML, Markdown or a signed ZIP package.',422);
 return {bytes:Buffer.from(lines.map(s=>s.replaceAll(/([\\\x60*_{}\[\]<>#|])/g,'\\$1')).join('\n\n')+'\n\n## Frozen report, claim and citation metadata\n\n```json\n'+structured+'\n```\n'),media_type:'text/markdown',extension:'md'};
}
