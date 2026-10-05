import {describe,test,expect} from 'bun:test';
import {AppLogger,MAX_LOG_BYTES,redactSensitiveLogContent,type LogFile} from '../../src/logs/app-logger.ts';
import {diagnosticLogSource} from '../../src/logs/upload.ts';
import {SyncDiagnosticLog} from '../../src/sync/diagnostic-log.ts';
import {createApplicationActionHandler} from '../../src/sync/application-actions.ts';
function memory(initial=''){
 let text=initial,active=0,maxActive=0;
 const writes:string[]=[];
 const op=async<T>(fn:()=>T)=>{active++;maxActive=Math.max(maxActive,active);await Promise.resolve();try{return fn();}finally{active--;}};
 const file:LogFile={read:()=>op(()=>text||null),size:()=>op(()=>Buffer.byteLength(text)),replace:value=>op(()=>{text=value;writes.push(value);}),append:(value,offset)=>op(()=>{expect(offset).toBe(Buffer.byteLength(text));text+=value;writes.push(value);})};
 return {file,writes,text:()=>text,maxActive:()=>maxActive};
}
describe('AppLogger native persistence and privacy',()=>{
 test('local timestamp, levels, tag and redacted multiline exception stack',async()=>{
  const m=memory(),consoleLines:string[]=[];const log=new AppLogger(m.file,()=>new Date(2026,0,2,3,4,5,6),(_,line)=>consoleLines.push(line));
  log.v('Tag','verbose');log.d('Tag','debug');log.i('Tag','info');log.w('Tag','warn');
  const error=Error('token=HIDDEN');error.stack='Error: token=HIDDEN\n at https://example.com/a?key=QUERY:12:1';log.e('Tag','failed',error);
  await log.flush();expect(m.text()).toContain('[2026-01-02 03:04:05.006] [V] [Tag] verbose\n');
  for(const level of ['V','D','I','W','E'])expect(m.text()).toContain(`[${level}]`);
  expect(m.text()).toContain('failed\nError: token=<redacted>\n at https://example.com/a?<redacted>');
  expect(m.text()).not.toContain('HIDDEN');expect(consoleLines.join()).not.toContain('QUERY');
 });
 test('native cookie keys, headers, bearer and pairing plus JSON and query secrets never reach writes',async()=>{
  const keys='access_token api_key apiKey appRefreshToken bili_jct csrf_session_id DedeUserID DedeUserID__ckMd5 msToken n_mh odin_tt passport_csrf_token passport_csrf_token_default refresh_token refreshToken SESSDATA sessionid sessionid_ss sid sid_guard sid_tt sid_ucp_v1 s_v_web_id ssid_ucp_v1 ttwid uid_tt uid_tt_ss watchrss_pair token'.split(' ');
  const rows=[...keys.map(k=>`${k}=SECRET`),'signature=Cookie=sessionid=SECRET; sid_guard=SECRET; Referer=https://www.douyin.com/',...['Set-Cookie','Authorization','Proxy-Authorization','X-WatchRSS-Pairing-Auth'].map(k=>`${k}: SECRET`),'upstream=Bearer SECRET','{"apiKey":"SECRET WITH SPACE","token":"SECRET"}','https://user:SECRET@example.com/a?anything=SECRET&foo=SECRET#SECRET','https://x/a?unlisted=SECRET','/relative/path?unlisted=SECRET','authToken=SECRET'];
  const m=memory(),log=new AppLogger(m.file);for(const row of rows)log.d('privacy',row);await log.flush();
  expect(m.writes.join()).not.toContain('SECRET');expect(m.text()).toContain('<redacted>');
  for(const row of rows)expect(redactSensitiveLogContent(redactSensitiveLogContent(row))).toBe(redactSensitiveLogContent(row));
 });
 test('initialization cleans historical file before appending and survives restart',async()=>{
  const m=memory('old SESSDATA=SECRET\nhttps://x/?x=QUERY\n');const log=new AppLogger(m.file);await log.init();await log.flush();
  expect(m.text()).not.toContain('SECRET');expect(m.text()).not.toContain('QUERY');
  expect(await new AppLogger(m.file).readLogs()).toBe(m.text());
 });
 test('imports the previous sync timeline only when the application file is empty',async()=>{
  const m=memory(),log=new AppLogger(m.file);await log.init('[old] bluetooth state=listening\n');await log.flush();
  const before=await log.readLogs();expect(before).toContain('[old] bluetooth state=listening');
  await new AppLogger(m.file).init('must not duplicate');expect(await log.readLogs()).not.toContain('must not duplicate');
 });
 test('native strict byte threshold and once-per-append 20 percent line trimming',async()=>{
  // Keep the timestamp that exposed the flake: its minutes contain the old row marker '0:'.
  const now=()=>new Date(2026,9,5,2,40,0,404);
  const exact=memory('a'.repeat(MAX_LOG_BYTES-1)+'\n'),log=new AppLogger(exact.file,now);
  log.d('T','cross');await log.flush();expect(exact.text().startsWith('a'.repeat(100))).toBe(true);expect(exact.writes.length).toBe(1);
  const rows=Array.from({length:10},(_,i)=>`${i}:`+'中'.repeat(180000));const m=memory(rows.join('\n')+'\n');expect(Buffer.byteLength(m.text())).toBeGreaterThan(MAX_LOG_BYTES);
  const rotated=new AppLogger(m.file,now);rotated.d('T','new');await rotated.flush();
  // Compare retained lines, not substrings that can also occur in a valid timestamp.
  expect(m.text().split('\n')).toEqual([...rows.slice(2),'[2026-10-05 02:40:00.404] [D] [T] new','']);
  expect(m.writes[0]).toBe(rows.slice(2).join('\n')+'\n');
 });
 test('concurrent producers and read/clear barriers cannot race or lose entries',async()=>{
  const m=memory(),log=new AppLogger(m.file);
  await Promise.all(Array.from({length:200},async(_,i)=>{await Promise.resolve();log.i('Concurrent',`event=${i}`);}));
  const text=await log.readLogs();expect(text?.split('\n').filter(Boolean).length).toBe(200);expect(m.maxActive()).toBe(1);
  expect(Array.from(text?.match(/event=\d+/g)??[])).toEqual(Array.from({length:200},(_,i)=>`event=${i}`));
  await log.clearLogs();expect(await log.readLogs()).toContain('日志已清空');expect(await log.readLogs()).not.toContain('event=');
 });
 test('failed write and console never throw into caller or poison queue',async()=>{
  const m=memory();let fail=true;const log=new AppLogger({...m.file,append:async(s,n)=>{if(fail){fail=false;throw Error('SECRET');}return m.file.append(s,n);}},undefined,()=>{throw Error('console');});
  expect(()=>log.e('T','first')).not.toThrow();log.d('T','second');expect(await log.readLogs()).toContain('second');
 });
 test('complete upload source includes sync and other subsystems; pull preserves M2 UTF-16 tail and count',async()=>{
  const m=memory(),log=new AppLogger(m.file);const timeline=new SyncDiagnosticLog({get:()=>undefined,set:()=>{throw Error('must not write old KV');}},undefined,message=>log.d('WatchSync',message));
  log.i('Network','x'.repeat(710000));timeline.action('syncLibrary',true);log.d('ReadAloudController','😀');
  const source=await diagnosticLogSource(log)();expect(source!.length).toBeGreaterThan(700000);expect(source).toContain('action=syncLibrary success=true');expect(source).toContain('ReadAloudController');
  const handler=createApplicationActionHandler({notes:{} as never,deviceId:async()=>'',notesChanged:()=>{},readDebugLog:max=>log.pull(max)});
  for(const maxChars of [1,0,-1,5,700001,'5','invalid',1.5]){
   const result=await handler({action:'pullDebugLog',maxChars});const length=typeof maxChars==='number'&&Number.isInteger(maxChars)?Math.max(1,Math.min(700000,maxChars)):maxChars==='5'?5:maxChars===1.5?1:700000;
   expect(result).toEqual({success:true,action:'pullDebugLog',log:source!.slice(-length),truncated:true,totalChars:source!.length});
  }
 });
});
