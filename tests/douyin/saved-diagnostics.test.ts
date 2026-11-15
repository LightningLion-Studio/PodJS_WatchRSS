import {afterEach,expect,test} from 'bun:test';
import {AppLogger,installAppLogger} from '../../src/logs/app-logger.ts';
import {DouyinClient} from '../../src/douyin/client.ts';
import {DouyinRssRecovery} from '../../src/douyin/rss-recovery.ts';
import {DouyinSavedPlaybackDiagnostic,savedAgeBucket,savedPlaybackContext,type ResolutionObservation} from '../../src/douyin/saved-playback-diagnostics.ts';
import {analyzeSavedPlayback,renderSavedPlaybackAnalysis} from '../../scripts/douyin-saved-analysis.ts';
import type {DouyinSavedEntry} from '../../src/douyin/types.ts';
const DAY=86400000,now=1800000000000;
afterEach(()=>installAppLogger(undefined));
function logger(){let log='';const value=new AppLogger({read:async()=>log,size:async()=>log.length,replace:async s=>{log=s;},append:async s=>{log+=s;}});installAppLogger(value);return {async text(){await value.flush();return log;}};}
const response=(body:unknown,status=200)=>({status,headers:{},body:new TextEncoder().encode(JSON.stringify(body))});
const video=(url='https://cdn.invalid/new?secret=private')=>({aweme_detail:{aweme_id:'7',video:{play_addr:{url_list:[url]}}}});
function client(replies:ReturnType<typeof response>[]){return new DouyinClient({now:()=>now,secureStorage:{get:async()=> 'sessionid=private',set:async()=>{},remove:async()=>{}},signer:{sign:()=> 'private'},transport:{request:async()=>{const r=replies.shift();if(!r)throw Error('unexpected_request');return r;}}});}
test('age cohorts use saved timestamp, preserve the two-week boundary and prefer favorite over watch-later time',async()=>{
 expect([7*DAY-1,7*DAY,14*DAY-1,14*DAY,30*DAY].map(savedAgeBucket)).toEqual(['under_7d','7_to_14d','7_to_14d','14_to_30d','over_30d']);
 expect(savedAgeBucket(-1)).toBe('unknown');
 const entries=[{kind:'favorite',savedAtMillis:now-20*DAY,item:{awemeId:'7'}},{kind:'watchLater',savedAtMillis:now-DAY,item:{awemeId:'7'}}] as DouyinSavedEntry[];
 expect(savedPlaybackContext(entries,'7')).toEqual({kind:'both',savedAtMillis:now-20*DAY});
 const log=logger();const trace=new DouyinSavedPlaybackDiagnostic({kind:'favorite',savedAtMillis:now+DAY,url:'https://private/?x-expires=1700000000'},()=>now);trace.end();const text=await log.text();
 expect(text).toContain('"ageBucket":"unknown"');expect(text).toContain('"savedUrlExpiry":"expired"');expect(text).not.toContain('https://');
 const near=new DouyinSavedPlaybackDiagnostic({kind:'favorite',savedAtMillis:now-DAY,url:`https://fixture/?expires=${now/1000+20}`},()=>now);near.end();
 expect(await log.text()).toContain('"savedUrlExpiry":"unexpired"');
});
test('resolver exposes numeric HTTP/API facts and missing detail separately without changing result shape',async()=>{
 const c=client([response({},410),response({status_code:123}),response({status_code:0})]),observed:ResolutionObservation[]=[];
 const one=await c.resolvePlayback('7',{forceRefresh:true,observeResolution:v=>observed.push(v)});
 const two=await c.resolvePlayback('7',{forceRefresh:true,observeResolution:v=>observed.push(v)});
 const three=await c.resolvePlayback('7',{forceRefresh:true,observeResolution:v=>observed.push(v)});
 expect(one).toMatchObject({ok:false,code:'REQUEST_FAILED'});expect(two).toMatchObject({ok:false,code:'REQUEST_FAILED'});expect(three).toMatchObject({ok:false,code:'PARSE_FAILED'});
 expect(observed[0]).toMatchObject({httpStatus:410,requestReason:'http'});expect(observed[1]).toMatchObject({httpStatus:200,apiStatus:123,requestReason:'api_status'});expect(observed[2]).toMatchObject({httpStatus:200,apiStatus:0,detailShape:'missing'});
 expect(Object.keys(one).sort()).toEqual(['code','message','ok']);
});
test('coalesced detail callers each receive their own observation; diagnostics throwing cannot fail resolution',async()=>{
 const c=client([response(video())]),observed:ResolutionObservation[]=[];
 const results=await Promise.all([c.resolvePlayback('7',{forceRefresh:true,observeResolution:v=>observed.push(v)}),c.resolvePlayback('7',{forceRefresh:true,observeResolution:v=>observed.push(v)})]);
 expect(results.every(r=>r.ok)).toBe(true);expect(observed).toHaveLength(2);expect(observed[0]).toMatchObject({httpStatus:200,detailShape:'video',source:'network'});
 expect((await c.resolvePlayback('7',{observeResolution:()=>{throw Error('observer_error');}})).ok).toBe(true);
});
test('real RSS recovery correlates an expired saved URL, forced refresh, URL change and actual recovered frame',async()=>{
 const log=logger(),trace=new DouyinSavedPlaybackDiagnostic({kind:'favorite',savedAtMillis:now-15*DAY,url:'https://cdn.invalid/old?x-expires=1700000000'},()=>now);
 const c=client([response(video())]),recovery=new DouyinRssRecovery(c,'7',undefined,trace);
 trace.playbackFailure({code:'source_expired',message:'https://private/?token=private'});
 const source=await recovery.recover({title:'private',url:'https://cdn.invalid/old'},()=>true,false,{code:'source_expired'});
 expect(source?.url).toContain('/new');trace.firstFrame();trace.end();trace.firstFrame();
 const text=await log.text(),s=analyzeSavedPlayback(text);
 expect(s.local).toHaveLength(1);expect(s.groups[2]).toMatchObject({opens:1,played:1,failed:0});expect(s).toMatchObject({refreshes:1,recovered:1,changedAndRecovered:1});
 const diagnosticLines=text.split('\n').filter(s=>s.includes('[DouyinSavedPlayback]')).join('\n');expect(diagnosticLines).not.toMatch(/private|https:|awemeId|sessionid|Cookie|title/);
});
test('a resolved refresh without first frame is not recovery, and leaving during recovery is not a final failure',async()=>{
 const log=logger(),trace=new DouyinSavedPlaybackDiagnostic({kind:'favorite',savedAtMillis:now-10*DAY,url:''},()=>now);
 trace.playbackFailure({code:'source_expired'});trace.recovery(false);trace.resolution('refresh',{ok:true,forceRefresh:true,source:'network'});trace.end();
 const s=analyzeSavedPlayback(await log.text());expect(s.recovered).toBe(0);expect(s.groups[1]).toMatchObject({opens:1,played:0,failed:0,pending:1});
});
test('failed refresh remains a failure and report compares both sides of fourteen days without declaring deletion',async()=>{
 const log=logger(),old=new DouyinSavedPlaybackDiagnostic({kind:'favorite',savedAtMillis:now-20*DAY,url:''},()=>now);
 old.resolution('initial',{ok:false,code:'PARSE_FAILED',forceRefresh:false,httpStatus:200,apiStatus:0,detailShape:'missing'});old.end();
 const fresh=new DouyinSavedPlaybackDiagnostic({kind:'favorite',savedAtMillis:now-DAY,url:''},()=>now);fresh.firstFrame();fresh.end();
 const text=await log.text(),s=analyzeSavedPlayback(text),html=renderSavedPlaybackAnalysis(text);
 expect(s.groups[2]).toMatchObject({failed:1});expect(s.groups[0]).toMatchObject({played:1});expect(html).toContain('失败 1/1（100.0%）');expect(html).toContain('失败 0/1（0.0%）');expect(html).toContain('不等于已删除');
 expect(analyzeSavedPlayback(text+text).local).toHaveLength(2);
});
test('truncated logs and process-local attempt IDs restarting do not merge unrelated openings',()=>{
 const line=(row:unknown)=>'[DouyinSavedPlayback] '+JSON.stringify({version:1,attempt:1,...row as {}})+'\n';
 const text=line({stage:'failure'})+line({stage:'open',kind:'favorite',ageBucket:'under_7d'})+line({stage:'end',outcome:'resolve_failed'})+line({stage:'open',kind:'favorite',ageBucket:'over_30d',ageDays:40})+line({stage:'first_frame'});
 const s=analyzeSavedPlayback(text);expect(s.unmatched).toBe(1);expect(s.local).toHaveLength(2);expect(s.groups[0].failed).toBe(1);expect(s.groups[3].played).toBe(1);
});
