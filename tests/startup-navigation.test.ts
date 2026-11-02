import {expect,test} from 'bun:test';
import {captureActivityNavigation,resolveActivityNavigation,routeMemory,type ActivityRoute} from '../src/navigation/activity-navigation.ts';
import {startupActivityNavigation} from '../src/navigation/startup-navigation.ts';
import {AppResumeStore} from '../src/navigation/resume-state.ts';

const empty=()=>({saved:{},retained:{}});
const pages=(entries:ActivityRoute[]|null)=>(entries??[{page:'home'}]).map(entry=>entry.page);

test('cold launch ignores an old Douyin player and navigation checkpoint left by an upgrade',()=>{
 const durable=new Map<string,unknown>();
 const kv={get:<T>(key:string)=>durable.get(key) as T|undefined,set:<T>(key:string,value:T)=>{durable.set(key,value);},delete:(key:string)=>{durable.delete(key);}};
 const oldPlayer={version:1,kind:'douyin',route:{name:'player',awemeId:'last-video',savedQueue:true,immersive:true}} as const;
 new AppResumeStore(kv).save(oldPlayer);
 durable.set('watchrss.navigation-checkpoint.v1',{version:1,saved:captureActivityNavigation(empty(),[
  {page:'home'},{page:'douyin',douyinRoute:{name:'entry'}},
  {page:'video',videoTarget:{kind:'douyin',awemeId:'last-video',immersive:true}},
 ]).saved});
 const before=structuredClone(durable);
 // No Android Bundle: install-r, force-stop, task removal, launcher, or a
 // cold notification entry all have the same task-state input here.
 expect(pages(startupActivityNavigation(empty()))).toEqual(['home']);
 // Current-startup owners writing state must not authorize an old KV route.
 expect(pages(startupActivityNavigation({saved:{'watchrss.onboarding':{page:2}},retained:{}}))).toEqual(['home']);
 expect(durable).toEqual(before);
});

test('a same-task Bundle restores its own screen and saved scroll, with no retained draft after death',async()=>{
 const reader:ActivityRoute={page:'reader',articleId:'current-task-article'};
 routeMemory(reader).saved['scroll:0']=419;
 routeMemory(reader).retained.draft='configuration-only';
 const task=captureActivityNavigation(empty(),[{page:'home'},reader]);
 const entries=startupActivityNavigation({saved:task.saved,retained:{}})!;
 let reads=0;
 const resolved=await resolveActivityNavigation(entries,{hasChannel:()=>true,article:async id=>{reads++;return {id,title:'current DB record'} as never;}});
 expect(pages(resolved)).toEqual(['home','reader']);
 expect(resolved[1]!.memory!.saved['scroll:0']).toBe(419);
 expect(resolved[1]!.memory!.retained).toEqual({});
 expect(resolved[1]!.readerArticle?.id).toBe('current-task-article');
 expect(reads).toBe(1);
});

for(const target of [
 {kind:'douyin',awemeId:'last-video',immersive:true},
 {kind:'bili',aid:12,cid:34},
 {kind:'rss',articleId:'article',url:'https://example.test/video.mp4'},
] as const)test(`same-task ${target.kind} player restores its parent without a media surface`,()=>{
 const task=captureActivityNavigation(empty(),[
  {page:'home'},{page:'douyin',douyinRoute:{name:'history'}},
  {page:'video',videoTarget:target},{page:'settings'},
 ]);
 const before=structuredClone(task);
 const entries=startupActivityNavigation({saved:task.saved,retained:{}})!;
 expect(pages(entries)).toEqual(['home','douyin']);
 expect(entries.some(entry=>entry.page==='video'||entry.playback!==undefined)).toBe(false);
 expect(task).toEqual(before);
});

test('same-task speech playback resumes the reader without starting a speech session',()=>{
 const task=captureActivityNavigation(empty(),[{page:'home'},{page:'reader',articleId:'article'},{page:'speech-playback'}]);
 expect(pages(startupActivityNavigation(task))).toEqual(['home','reader']);
});

test('malformed content state falls back to home, without a durable last-screen fallback',()=>{
 for(const state of [empty(),{saved:{'watchrss.content-activity':{version:99,entries:[]}},retained:{}},
  {saved:{'watchrss.content-activity':{version:1,entries:[{page:'video'}]}},retained:{}}]){
  expect(pages(startupActivityNavigation(state))).toEqual(['home']);
 }
});
