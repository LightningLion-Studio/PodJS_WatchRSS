import {test,expect} from 'bun:test';
import {ActivityStateHub} from '../src/navigation/activity-state.ts';
import {captureActivityNavigation,restoreActivityNavigation,resolveActivityNavigation,routeMemory,CONTENT_ACTIVITY_KEY as KEY,type ActivityRoute} from '../src/navigation/activity-navigation.ts';
import {ScrollRestoration} from '../src/navigation/scroll-restoration.ts';
const empty=()=>({saved:{},retained:{}});

test('saved stack survives process loss; ViewModel drafts survive configuration only',()=>{
 const entries:ActivityRoute[]=[{page:'home'},{page:'settings'},{page:'settings-advanced'},{page:'add-rss',addUrl:'original intent URL'}];
 routeMemory(entries[0]!).saved['scroll:0']=72;
 routeMemory(entries[3]!).retained['add-url']='in progress draft';
 const state=captureActivityNavigation(empty(),entries);
 const config=restoreActivityNavigation(state)!;
 expect(config.map(e=>e.page)).toEqual(entries.map(e=>e.page));
 expect(config[3]!.memory!.retained['add-url']).toBe('in progress draft');
 const process=restoreActivityNavigation({saved:state.saved,retained:{}})!;
 expect(process[3]!.memory!.retained).toEqual({});
 expect(process[3]!.addUrl).toBe('original intent URL');
 expect(process[0]!.memory!.saved['scroll:0']).toBe(72);
});

test('activity snapshot excludes handles, payload bodies, signed media URLs and headers',()=>{
 const entry:ActivityRoute={page:'video',videoTarget:{kind:'bili',aid:12,cid:34,headers:{Cookie:'SECRET'},url:'SECRET'} as never,playback:{title:'Title',url:'signed secret stream',headers:{Cookie:'SECRET'}},player:{onCrown:()=>true}};
 const media:ActivityRoute={page:'douyin',douyinRoute:{name:'detail',awemeId:'a',item:{awemeId:'a',playUrl:'SECRET'} as never,playlist:[{awemeId:'b',playUrl:'SECRET'} as never]}};
 const reader:ActivityRoute={page:'reader',readerArticle:{id:'x',content:'large body'} as never};
 const snapshot=captureActivityNavigation(empty(),[{page:'home'},reader,media,entry]);
 const serialized=JSON.stringify(snapshot);
 expect(serialized).not.toContain('SECRET');expect(serialized).not.toContain('large body');expect(serialized).not.toContain('signed secret');
 expect(restoreActivityNavigation(snapshot)!.at(-1)!.videoTarget).toMatchObject({kind:'bili',aid:12,cid:34});
});

test('log upload consent is one-shot and never restored with the route',()=>{
 const state=captureActivityNavigation(empty(),[{page:'home'},{page:'log-upload',logUploadConsent:true},{page:'log-upload-history'}]);
 expect(JSON.stringify(state)).not.toContain('logUploadConsent');
 expect(restoreActivityNavigation(state)?.map(entry=>entry.page)).toEqual(['home','log-upload','log-upload-history']);
 expect(restoreActivityNavigation(state)?.[1]?.logUploadConsent).toBeUndefined();
});

test('invalid versions, duplicate identities, debug gate and malformed arguments safely trim/fallback',()=>{
 expect(restoreActivityNavigation({saved:{[KEY]:{version:99,entries:[]}},retained:{}})).toBeNull();
 const original=captureActivityNavigation(empty(),[{page:'home'},{page:'settings'},{page:'debug-tools'}]);
 expect(restoreActivityNavigation(original)?.map(e=>e.page)).toEqual(['home','settings']);
 expect(restoreActivityNavigation(original,true)?.at(-1)?.page).toBe('debug-tools');
 for(const mutation of [
  (entries:any[])=>entries[1].id=entries[0].id,
  (entries:any[])=>entries[1].id='r'+'9'.repeat(100),
  (entries:any[])=>entries[1].page='obsolete-page',
  (entries:any[])=>entries[1].ui={'scroll:0':NaN},
 ]){
  const raw=structuredClone(original);mutation((raw.saved[KEY] as any).entries);
  expect(restoreActivityNavigation(raw)?.map(e=>e.page)).toEqual(['home']);
 }
 const unsupported=captureActivityNavigation(empty(),[{page:'home'},{page:'video',playback:{url:'SECRET',title:'unsupported'}}]);
 expect(restoreActivityNavigation(unsupported)?.map(e=>e.page)).toEqual(['home']);
});

test('restore resolves real entities, does not mark read and trims deleted targets',async()=>{
 const entries:ActivityRoute[]=[{page:'home'},{page:'articles',channelId:'present'},{page:'reader',readerArticle:{id:'article'} as never},{page:'channel-settings',channelId:'deleted'}];
 const state=captureActivityNavigation(empty(),entries);let reads=0;
 const restored=await resolveActivityNavigation(restoreActivityNavigation(state)!,{hasChannel:id=>id==='present',article:async id=>{reads++;return {id,title:'from current DB'} as never;}});
 expect(restored.map(e=>e.page)).toEqual(['home','articles','reader']);expect(reads).toBe(1);
 expect(restored[2]!.readerArticle?.title).toBe('from current DB');
});

test('large state stays within Bundle bound and retains unrelated owners',()=>{
 const entries:ActivityRoute[]=[{page:'home'}];for(let i=0;i<23;i++){const e:ActivityRoute={page:'add-rss'};routeMemory(e).saved.test='汉'.repeat(7000);entries.push(e);}
 const state=captureActivityNavigation({saved:{other:{keep:true}},retained:{other:2}},entries);
 expect(new TextEncoder().encode(JSON.stringify(state.saved[KEY])).length).toBeLessThan(64*1024);
 expect(state.saved.other).toEqual({keep:true});expect(state.retained.other).toBe(2);
});

test('namespace merges preserve deletion and dispatch order despite delayed acknowledgements',async()=>{
 const writes:any[]=[],pending:Array<()=>void>=[];
 const hub=new ActivityStateHub(value=>{writes.push(structuredClone(value));return new Promise(resolve=>pending.push(resolve));});
 hub.seed({saved:{intro:1,other:2},retained:{intro:3}});
 const a=hub.write({saved:{intro:4},retained:{intro:5}},['intro']);
 const b=hub.write({saved:{content:6},retained:{}},['content']);
 const c=hub.write({saved:{},retained:{}},['intro']);
 expect(writes[2]).toEqual({saved:{other:2,content:6},retained:{}});
 pending[2]!();pending[0]!();pending[1]!();await Promise.all([a,b,c]);
 expect(hub.read()).toEqual(writes[2]);
});

test('scroll target survives late rows, clamps, and yields to user input',()=>{
 const restore=new ScrollRestoration(300);
 expect(restore.target(0)).toBe(0);expect(restore.snapshot(0)).toBe(300);
 expect(restore.target(0)).toBeUndefined();expect(restore.target(120)).toBe(120);
 expect(restore.snapshot(120)).toBe(300);expect(restore.target(500)).toBe(300);
 expect(restore.snapshot(300)).toBe(300);
 const user=new ScrollRestoration(300);user.target(20);user.cancel();
 expect(user.target(500)).toBeUndefined();expect(user.snapshot(33)).toBe(33);
});


test('a transient preview without a live source restores the usable task prefix',async()=>{
 const state=captureActivityNavigation(empty(),[{page:'home'},{page:'settings-reader-presets'},{page:'reader-preview'}]);
 const entries=restoreActivityNavigation(state)!;
 const restored=await resolveActivityNavigation(entries,{hasChannel:()=>true,article:async()=>null,canRestore:e=>e.page!=='reader-preview'});
 expect(restored.map(e=>e.page)).toEqual(['home','settings-reader-presets']);
});
