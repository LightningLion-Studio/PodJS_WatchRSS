type Row=Record<string,unknown>;
type Attempt={open:Row;events:Row[];end?:Row};
const ages=['under_7d','7_to_14d','14_to_30d','over_30d','unknown'] as const;
const labels=['不足 7 天','7 天至不足 14 天','14 天至不足 30 天','30 天及以上','收藏时间未知'];
const escaped=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const rate=(n:number,total:number)=>total?`${(n/total*100).toFixed(1)}%`:'暂无结果';
function facts(a:Attempt){
 const played=a.events.some(e=>e.stage==='first_frame');
 const failed=!played&&(a.end?.outcome==='resolve_failed'||a.end?.outcome==='playback_failed');
 return {played,failed,decided:played||failed,recovered:a.events.some(e=>e.stage==='first_frame'&&e.recovered===true),refreshed:a.events.some(e=>e.stage==='resolve'&&e.phase==='refresh'),changed:a.events.some(e=>e.stage==='address'&&e.phase==='recovery'&&e.changed==='yes')};
}
/** Correlate within each opening. A new open also handles process-local IDs
 * restarting at 1; unmatched/truncated records never become fabricated opens. */
export function analyzeSavedPlayback(log:string){
 const attempts:Attempt[]=[],active=new Map<number,Attempt>(),seen=new Set<string>();let unmatched=0;
 for(const line of log.split(/\r?\n/)){
  const m=line.match(/\[DouyinSavedPlayback\]\s+(\{.*\})\s*$/);if(!m||seen.has(line))continue;
  seen.add(line);
  try{
   const r=JSON.parse(m[1]) as Row;
   if(r.version!==1||!Number.isSafeInteger(r.attempt)||Number(r.attempt)<1)continue;
   const id=Number(r.attempt);
   if(r.stage==='open'){
    const a={open:r,events:[]} as Attempt;attempts.push(a);active.set(id,a);
   }else{
    const a=active.get(id);if(!a){unmatched++;continue;}
    a.events.push(r);if(r.stage==='end'){a.end=r;active.delete(id);}
   }
  }catch{/* unrelated or incomplete records */}
 }
 const local=attempts.filter(a=>a.open.kind==='favorite'||a.open.kind==='both');
 const groups=ages.map((age,i)=>{
  const selected=local.filter(a=>a.open.ageBucket===age),fs=selected.map(facts);
  return {age,label:labels[i],opens:selected.length,played:fs.filter(f=>f.played).length,failed:fs.filter(f=>f.failed).length,pending:fs.filter(f=>!f.decided).length};
 });
 const reasons=new Map<string,number>();
 for(const a of local){
  const found=new Set<string>();
  for(const e of a.events){
   if(e.stage==='resolve'&&e.ok===false){
    if(e.detailShape==='missing')found.add('详情响应缺少视频字段（不等于已删除）');
    else if(e.requestReason==='api_status')found.add(`详情接口非零状态 ${Number.isSafeInteger(e.apiStatus)?e.apiStatus:'未知'}`);
    else if(e.httpStatus!==0&&Number.isInteger(e.httpStatus)&&Number(e.httpStatus)>=400&&Number(e.httpStatus)<=599)found.add(`详情 HTTP ${e.httpStatus}`);
    else found.add(`解析/请求失败：${['NOT_LOGGED_IN','REQUEST_FAILED','PARSE_FAILED','UNSUPPORTED','RATE_LIMITED','TEMPORARILY_UNAVAILABLE','CANCELLED'].includes(String(e.code))?String(e.code):'UNKNOWN'}`);
   }
   if(e.stage==='failure'){
    found.add(`播放器：${['source_expired','restricted','network_error','cdn_error','decode_error','timeout','prepare_failed'].includes(String(e.code))?String(e.code):'其他'}`);
    if(Number.isInteger(e.httpStatus)&&Number(e.httpStatus)>=400&&Number(e.httpStatus)<=599)found.add(`媒体地址 HTTP ${e.httpStatus}`);
   }
  }
  for(const reason of found)reasons.set(reason,(reasons.get(reason)??0)+1);
 }
 const refreshed=local.filter(a=>facts(a).refreshed),recovered=refreshed.filter(a=>facts(a).recovered);
 return {attempts,local,groups,unmatched,otherOpens:attempts.length-local.length,expiredSavedUrls:local.filter(a=>a.open.savedUrlExpiry==='expired').length,initialChangedAndPlayed:local.filter(a=>facts(a).played&&a.events.some(e=>e.stage==='address'&&e.phase==='initial'&&e.changed==='yes')).length,refreshes:refreshed.length,recovered:recovered.length,changedAndRecovered:recovered.filter(a=>facts(a).changed).length,reasons:[...reasons].map(([reason,count])=>({reason,count}))};
}
export function renderSavedPlaybackAnalysis(log:string){
 const s=analyzeSavedPlayback(log);
 const old=s.groups.slice(2,4),recent=s.groups.slice(0,2);
 const total=(rows:typeof old)=>rows.reduce((n,r)=>n+r.played+r.failed,0),failed=(rows:typeof old)=>rows.reduce((n,r)=>n+r.failed,0);
 const comparison=total(old)&&total(recent)?`收藏满 14 天：失败 ${failed(old)}/${total(old)}（${rate(failed(old),total(old))}）；不足 14 天：失败 ${failed(recent)}/${total(recent)}（${rate(failed(recent),total(recent))}）。这是观测对比，尚不能证明两周会导致失效。`:'目前缺少两侧都有明确结果的样本，尚不能判断“收藏超过两周更容易失败”。';
 const table=s.groups.map(g=>`<tr><td>${g.label}</td><td>${g.opens}</td><td>${g.played}</td><td>${g.failed}</td><td>${rate(g.failed,g.played+g.failed)}</td><td>${g.pending}</td></tr>`).join('');
 return `<section class="saved-analysis"><h2>抖音本地收藏：时长与播放可用性</h2><p>${comparison}</p><table><thead><tr><th>收藏时长</th><th>打开次数</th><th>成功出首帧</th><th>未出帧并最终失败</th><th>失败率</th><th>中途退出/结果未定</th></tr></thead><tbody>${table}</tbody></table><p>保存的地址明确过期 ${s.expiredSavedUrls} 次；初次解析地址变化且成功播放 ${s.initialChangedAndPlayed} 次。</p><p>触发强制刷新 ${s.refreshes} 次；刷新后真正出首帧恢复 ${s.recovered} 次；其中地址变化且恢复 ${s.changedAndRecovered} 次。地址变化并恢复支持地址或缓存问题这一可能性，不能排除同时发生的网络变化。仅接口解析成功不会记为恢复。</p><h3>已观测的错误线索</h3>${s.reasons.length?`<ul>${s.reasons.map(r=>`<li>${escaped(r.reason)}：${r.count} 次打开</li>`).join('')}</ul>`:'<p>尚无收藏播放失败记录。</p>'}<p class="note">一次打开及其所有重试只计一次；收藏和稍后再看的时间分别保存，本表仅统计本地收藏。其他来源 ${s.otherOpens} 次；缺少开头而不能关联的日志 ${s.unmatched} 条。时间未知的条目单列，失败率分母排除未定结果。成功标准是实际首帧；出帧后的卡顿或失败需结合播放器错误线索分析。缺少视频字段、HTTP 404 或地址过期都不能单独证明原视频被永久删除。本统计不读取抖音账号线上收藏列表。</p></section>`;
}
