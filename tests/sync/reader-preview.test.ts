import {test,expect} from 'bun:test';
import {ReaderPreviewSession,applyReaderPresetChanges,type PreviewClock} from '../../src/reader/preview-session.ts';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import {handleReaderPreview} from '../../src/sync/reader-preview.ts';
import {ReaderSyncActions} from '../../src/sync/reader-actions.ts';
function clock(){let time=1000;const timers=new Set<{at:number;run:()=>void}>();const port:PreviewClock={now:()=>time+10000,monotonic:()=>time,after(ms,run){const timer={at:time+ms,run};timers.add(timer);return()=>{timers.delete(timer);};}};return {port,timers,tick(ms:number){const end=time+ms;while(true){const next=[...timers].sort((a,b)=>a.at-b.at)[0];if(!next||next.at>end)break;time=next.at;timers.delete(next);next.run();}time=end;}};}
test('preview accepts newer updates, coalesces deltas and leaves published sequence behind heartbeat/empty deltas',()=>{
 const c=clock(),session=new ReaderPreviewSession(c.port);const frames:number[]=[];session.subscribe(s=>{if(s)frames.push(s.sequence);});const base=defaultReaderPreset('p','base');
 expect(session.update('s',1,base)).toBe(true);expect(session.update('s',1,base)).toBe(false);expect(session.updateDelta('s',2,{body:{fontSizeSp:20}})).toBe(true);expect(session.updateDelta('s',3,{name:'new'})).toBe(true);expect(session.state()?.preset.name).toBe('base');c.tick(32);expect(frames).toEqual([1]);c.tick(1);expect(frames).toEqual([1,3]);expect(session.state()?.preset.body.fontSizeSp).toBe(20);
 expect(session.updateDelta('s',4,{},true)).toBe(true);expect(session.heartbeat('s',7)).toBe(7);expect(session.state()?.sequence).toBe(3);expect(session.updateDelta('s',7,{name:'stale'})).toBe(false);c.tick(20000);expect(session.state()).toBeNull();expect(c.timers.size).toBe(0);
});
test('preview replaces session ownership, cancels pending frames and renews only the matching session',()=>{
 const c=clock(),s=new ReaderPreviewSession(c.port),base=defaultReaderPreset('p','p');s.update('a',10,base);s.updateDelta('a',11,{name:'pending'});s.update('b',0,{...base,name:'b'});c.tick(40);expect(s.state()?.preset.name).toBe('b');expect(s.stop('a')).toBe(false);expect(s.heartbeat('a',50)).toBeNull();expect(()=>s.updateDelta('a',100,{name:'a'})).toThrow('基线');c.tick(19960);expect(s.state()).toBeNull();
 s.update('b',0,base);s.updateDelta('b',1,{name:'pending'});expect(s.stop('b')).toBe(true);c.tick(100);expect(s.state()).toBeNull();expect(c.timers.size).toBe(0);
});
test('resource handoff extends timeout but heartbeat and empty deltas restore the normal timeout',()=>{
 const c=clock(),s=new ReaderPreviewSession(c.port),base=defaultReaderPreset();s.update('s',0,base,true);c.tick(110000);expect(s.refreshResourceTransfer()).toBe(true);c.tick(110000);expect(s.state()).not.toBeNull();expect(s.heartbeat('s',0)).toBe(0);c.tick(20000);expect(s.state()).toBeNull();
 s.update('s',1,base,true);s.updateDelta('s',2,{},true);c.tick(20000);expect(s.state()).toBeNull();
 s.update('s',3,base);s.updateDelta('s',4,{name:'transfer'},true);expect(s.refreshResourceTransfer()).toBe(false);c.tick(33);expect(s.refreshResourceTransfer()).toBe(true);s.dispose();expect(c.timers.size).toBe(0);expect(()=>s.update('s',5,base)).toThrow('关闭');
});
test('native delta replaces nested objects, ignores unknown keys and consumes failed delta sequence',()=>{
 const base=defaultReaderPreset('p','p');base.body.fontSizeSp=22;base.body.fontWeight=700;const next=applyReaderPresetChanges(base,{schemaVersion:1,body:{fontSizeSp:18},unknown:'ignored'});expect(next.body.fontSizeSp).toBe(18);expect(next.body.fontWeight).toBe(400);expect(next.categoryTypographyEnabled).toBe(false);expect(base.body.fontSizeSp).toBe(22);
 const c=clock(),s=new ReaderPreviewSession(c.port);s.update('s',0,base);expect(()=>s.updateDelta('s',1,{body:null})).toThrow();expect(s.updateDelta('s',1,{body:{fontSizeSp:19}})).toBe(false);expect(s.heartbeat('s',0)).toBe(1);expect(s.state()?.preset.body.fontSizeSp).toBe(22);
});
test('preview wire response honors both versions, open behavior, trimmed IDs and absent appliedSequence',()=>{
 const c=clock(),s=new ReaderPreviewSession(c.port);let opened=0;const handle=(r:any)=>handleReaderPreview({version:2,sessionId:' s ',...r},s,()=>opened++);
 expect(handle({phase:'heartbeat',sequence:1})).toEqual({success:true,action:'previewReader',phase:'heartbeat',sessionId:'s',sequence:1});
 expect(handle({phase:'resourceHandoff',sequence:0,preset:defaultReaderPreset()})).toMatchObject({applied:true});expect(opened).toBe(0);
 expect(handle({phase:'update',sequence:1,changes:{name:'new'}})).toMatchObject({applied:true});expect(opened).toBe(1);expect(handle({phase:'update',sequence:1,changes:{name:'old'}})).toMatchObject({applied:false});expect(opened).toBe(1);
 expect(handle({phase:'stop'})).toMatchObject({applied:true});expect(handle({phase:'stop'})).toMatchObject({applied:false});expect(handle({phase:'update',version:1,sequence:0,presetJson:JSON.stringify(defaultReaderPreset())})).toMatchObject({applied:true});
 for(const request of [{phase:'update',version:3},{phase:'nope'},{phase:'update',sessionId:' '},{phase:'update',sequence:1,preset:null}])expect(()=>handle(request)).toThrow();
});
test('background and variant pushes refresh preview resource timeout before receiving the resource',async()=>{
 const kinds:string[]=[];const actions=new ReaderSyncActions({mergeManifest:()=>({presets:[],fonts:[],backgrounds:[],deletions:[]})},{missing:async()=>[],push:async request=>{kinds.push('push:'+request.kind);return {applied:false};},pull:async()=>({})},()=>{},()=>{kinds.push('refresh');});for(const kind of ['font','background','variant'])await actions.apply({phase:'pushResource',kind});expect(kinds).toEqual(['push:font','refresh','push:background','refresh','push:variant']);
});

test('preview wire and accepted/published states match the unmodified native session',async()=>{
 const native=await import('../fixtures/reader-preview-native.json');const c=clock(),s=new ReaderPreviewSession(c.port,10000,0);
 for(const row of native.cases){if('error' in row)expect(()=>handleReaderPreview(row.request,s,()=>{})).toThrow();else expect(handleReaderPreview(row.request,s,()=>{})).toEqual(row.response);const state=s.state();expect(state?{sessionId:state.sessionId,sequence:state.sequence,name:state.preset.name,fontSizeSp:state.preset.body.fontSizeSp,resourceTransferInProgress:state.resourceTransferInProgress}:null).toEqual(row.state);}
});
