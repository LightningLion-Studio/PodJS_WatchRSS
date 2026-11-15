import {readFile,writeFile} from 'node:fs/promises';
import {renderSavedPlaybackAnalysis} from './douyin-saved-analysis.ts';

type Sample={platform:string;session:number;windowMs:number;elapsedMs:number;bytesLoaded:number};
const buckets=[
  {label:'偏慢 <100 KB/s',min:0,max:100,color:'#e76f51',experience:'更容易出现等待和卡顿；通常需要降低清晰度。'},
  {label:'一般 100–300 KB/s',min:100,max:300,color:'#f4a261',experience:'适合低码率或标清播放；高码率视频可能缓冲。'},
  {label:'较稳 300–800 KB/s',min:300,max:800,color:'#2a9d8f',experience:'多数标清和部分高清视频可较顺畅播放，仍受码率波动影响。'},
  {label:'较快 ≥800 KB/s',min:800,max:Infinity,color:'#457b9d',experience:'通常有较充足的高清视频带宽余量；网络波动或高码率仍可能造成缓冲。'},
];
const arg=process.argv[2];
if(!arg){console.error('用法: bun scripts/video-speed-report.ts <app_log.txt> [report.html]');process.exit(2);}
const output=process.argv[3]??'video-speed-report.html';
const sampleDescription=process.argv[4]??'输入日志中的播放样本';
const text=await readFile(arg,'utf8');
const samples:Sample[]=[];
for(const line of text.split(/\r?\n/)){
  const match=line.match(/\[VideoOpt\]\s+(\{.*\})\s*$/);if(!match)continue;
  try{
    const row=JSON.parse(match[1]);
    if(row.stage!=='early_window'||![3000,5000,10000].includes(row.windowMs))continue;
    if(![row.session,row.elapsedMs,row.bytesLoaded].every((n:unknown)=>typeof n==='number'&&Number.isFinite(n))||row.elapsedMs<=0||row.bytesLoaded<0)continue;
    const sample:Sample={platform:String(row.platform??'unknown'),session:row.session,windowMs:row.windowMs,elapsedMs:row.elapsedMs,bytesLoaded:row.bytesLoaded};
    samples.push(sample);
  }catch{/* ignore unrelated or malformed log lines */}
}
const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const pie=(counts:number[],total:number)=>{
  if(!total)return '<div class="empty">没有该区间的有效样本</div>';
  let angle=-Math.PI/2;
  const labels:string[]=[];
  const wedges=counts.map((count,i)=>{
    if(!count)return '';
    const next=angle+2*Math.PI*count/total;
    const middle=(angle+next)/2;
    if(count/total>=.05)labels.push(`<text x="${(100+61*Math.cos(middle)).toFixed(2)}" y="${(100+61*Math.sin(middle)+4).toFixed(2)}" text-anchor="middle" fill="white" font-size="12" font-weight="700">${(count*100/total).toFixed(1)}%</text>`);
    let path:string;
    if(count===total)path=`<circle cx="100" cy="100" r="94" fill="${buckets[i].color}"/>`;
    else{const x1=100+94*Math.cos(angle),y1=100+94*Math.sin(angle),x2=100+94*Math.cos(next),y2=100+94*Math.sin(next),large=next-angle>Math.PI?1:0;path=`<path d="M 100 100 L ${x1.toFixed(2)} ${y1.toFixed(2)} A 94 94 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z" fill="${buckets[i].color}"/>`;}
    angle=next;return path;
  }).join('');
  return `<svg viewBox="0 0 200 200" role="img" aria-label="速度区间样本占比饼图">${wedges}${labels.join('')}</svg>`;
};
const panels=[3000,5000,10000].map(windowMs=>{
  const subset=samples.filter(s=>s.windowMs===windowMs),speeds=subset.map(s=>s.bytesLoaded*1000/s.elapsedMs/1024);
  const mean=speeds.length?speeds.reduce((a,b)=>a+b,0)/speeds.length:undefined;
  const counts=buckets.map(bucket=>speeds.filter(speed=>speed>=bucket.min&&speed<bucket.max).length);
  const legend=buckets.map((bucket,i)=>`<li><span class="swatch" style="background:${bucket.color}"></span><b>${bucket.label}</b><span>${subset.length?`${(counts[i]*100/subset.length).toFixed(1)}% (${counts[i]}/${subset.length})`:'暂无数据'}</span><small>${bucket.experience}</small></li>`).join('');
  const rows=subset.map(s=>`<tr><td>${escape(s.platform)}</td><td>${s.elapsedMs}</td><td>${s.bytesLoaded}</td><td>${(s.bytesLoaded*1000/s.elapsedMs/1024).toFixed(1)}</td></tr>`).join('');
  return `<section class="panel"><h2>首 ${windowMs/1000} 秒</h2><div class="summary">平均网速：<strong>${mean===undefined?'暂无数据':`${mean.toFixed(1)} KB/s`}</strong><span>${subset.length} 个有效播放样本</span></div><div class="chart">${pie(counts,subset.length)}<ul>${legend}</ul></div>${subset.length?`<details><summary>查看样本明细</summary><table><thead><tr><th>平台</th><th>实际采样时长(ms)</th><th>累计网络字节(B)</th><th>平均速度(KB/s)</th></tr></thead><tbody>${rows}</tbody></table></details>`:''}</section>`;
}).join('');
const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>视频播放早期网速统计</title><style>
*{box-sizing:border-box}body{margin:0;padding:24px;background:#f4f6f8;color:#17212b;font:15px/1.55 system-ui,-apple-system,"PingFang SC",sans-serif}main{max-width:1100px;margin:auto}h1{font-size:25px;margin:0 0 8px}.note{color:#596775;margin:0 0 20px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px}.panel{background:white;border-radius:16px;padding:18px;box-shadow:0 2px 12px #14223512}.panel h2{margin:0 0 8px;font-size:20px}.summary{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}.summary strong{font-size:21px}.summary span{color:#687783;font-size:13px}.chart{margin:12px 0}.chart svg{display:block;width:200px;max-width:100%;margin:0 auto 14px}.chart ul{list-style:none;padding:0;margin:0;flex:1}.chart li{display:grid;grid-template-columns:12px 1fr auto;gap:5px 8px;align-items:center;margin:9px 0}.chart li small{grid-column:2/4;color:#65727e;line-height:1.35}.swatch{width:12px;height:12px;border-radius:3px}details{border-top:1px solid #e7ebef;padding-top:10px}summary{cursor:pointer;color:#425466}table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px}th,td{text-align:left;padding:5px;border-bottom:1px solid #edf0f2}.empty{color:#75818b;padding:30px 8px}.saved-analysis{background:white;border-radius:16px;padding:20px;margin-top:20px;overflow:auto}.foot{font-size:12px;color:#65727e;margin:16px 0}</style><main><h1>视频播放早期网速统计</h1><p class="note">${escape(sampleDescription)}</p><p class="note">网速按累计网络下载字节 ÷ 实际采样时长计算，单位 KB/s（1 KB = 1024 B）。3/5/10 秒取目标边界后首次状态采样，明细保留实际时长。速度分区百分比按该时间段内有有效读数的播放会话计算。</p><div class="grid">${panels}</div>${text.includes("[DouyinSavedPlayback]")?renderSavedPlaybackAnalysis(text):""}<p class="foot">同一会话在每个区间最多记录一次。统计反映播放器报告的网络传输字节，不代表整个网络接口流量。尚未到达目标时长便结束或未取得有效播放器状态的播放不会进入对应区间分母。分区体验是参考：视频所需码率、缓存和网络波动都会影响实际播放，下载为 0 也可能来自缓存或已缓冲完成。</p></main></html>`;
await writeFile(output,html,'utf8');
console.log(`已生成 ${output}；3/5/10 秒有效样本数：${[3000,5000,10000].map(ms=>samples.filter(s=>s.windowMs===ms).length).join('/')}`);
