import {plugin} from 'bun';
import {bindPocketModules,bindPocketServicePump} from '@podjs/framework/testing/bun-runtime';
import {mock} from 'bun:test';
import * as solidRuntime from 'solid-js';
for(const base of [Bun.resolveSync('@podjs/framework/watch',import.meta.dir),Bun.resolveSync('@pocketjs/framework',import.meta.dir)])mock.module(Bun.resolveSync('solid-js',base),()=>solidRuntime);
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'rapid-back-solid',setup(b){b.onLoad({filter:/\.tsx$/},async a=>({contents:transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
const mode=process.env.RAPID_BACK_CASE??'4';
const feedEventProbe=mode==='bluetooth-review-feed-event';
const articleActionsBackProbe=mode==='bluetooth-review-article-actions-back';
const settingsBackProbe=mode.startsWith('bluetooth-review-channel-settings-back');
let emitChannel:((event:{kind:string;id:string})=>void)|undefined;
let feedEventReads=0, deferFeedEvent=false;
let releaseEventRead:(()=>void)|undefined;
const modalTakeover=mode==='bluetooth-feed-open-slow-modal-takeover';
const novelProbe=mode==='bluetooth-novel-background';
const bluetoothControl=process.env.REVIEW_BLUETOOTH_CONTROL==='1';
const novelSource='https://watchrss.local/import-txt-novel/review';
let novelReads=0;
let finishNovelRead:(()=>void)|undefined;
const restoredNoteCase=['bluetooth-note-restore','bluetooth-note-body','bluetooth-note-empty','bluetooth-note-leave'].includes(mode);
const noteDownload=mode==='bluetooth-note-download';
const noteListLoad=mode==='bluetooth-note-load';
const noteAction=mode.startsWith('bluetooth-note-action-');
const noteActionLeave=noteAction&&mode.includes('-leave');
const noteActionCancel=noteAction&&mode.endsWith('-cancel');
const revalidation=mode==='bluetooth-revalidation';
const backgroundReplacement=mode==='bluetooth-background-replacement';
const readerTimeout=mode==='reader-timeout-warning'||mode==='reader-background-timeout-warning';
const rssAction=mode.startsWith('bluetooth-rss-action-');
const rssProbe=mode.startsWith('bluetooth-feed-');
const slowArticleOpen=mode.startsWith('bluetooth-feed-open-slow');
const warningThenOpen=mode.startsWith('bluetooth-feed-open-with-warning');
const restoredFeedStall=mode==='bluetooth-feed-restored-stall';
const shareQuery=mode==='bluetooth-share-query';
const listPull=mode==='bluetooth-list-pull';
const listFling=mode==='bluetooth-list-fling';
const swipeMenu=mode==='bluetooth-swipe-menu';
const listProbe=listPull||listFling||swipeMenu;
const writeFailure=process.env.REVIEW_WRITE_FAILURE;
const holdDraft=process.env.REVIEW_HOLD_DRAFT==='1';
const emptyDraft=process.env.REVIEW_EMPTY_DRAFT==='1';
const readerLate=mode==='reader-timeout-late'||mode==='reader-timeout-late-reject';
const hostPending=Number(process.env.REVIEW_HOST_PENDING??0);
const navigationBackground=mode.startsWith('bluetooth-feed-open-slow-background');
const navigationAccount=mode.startsWith('bluetooth-feed-open-slow-account');
const backgroundRead=mode==='bluetooth-safe-settings-background-read';
const settingsQuery=mode==='bluetooth-safe-settings-account-query';
const homeLogin=mode==='bluetooth-home-login-reply';
let loginReads=0;
const stalledFeedReload=mode==='bluetooth-feed-stalled-reload-leave';
const rssFromReader=mode==='bluetooth-feed-reload'||stalledFeedReload;
const videoCase=mode==='bluetooth-video-pan';
const shareSystem=mode==='bluetooth-rss-action-system';
const searchRestore=mode==='bluetooth-search-restore';
const safeRoute=backgroundRead||settingsQuery?'settings':mode.startsWith('bluetooth-safe-') ? mode.slice('bluetooth-safe-'.length) : undefined;
let accountReads=0;
let releaseOperation: (()=>void)|undefined;
let releaseShare: (()=>void)|undefined;
let releaseShareQuery: (()=>void)|undefined;
let releaseRecovery: ((pending:boolean)=>void)|undefined;
let releaseFeed: (()=>void)|undefined;
let releaseNotes: (()=>void)|undefined;
const recoveryDismissals:string[]=[];
const deferOperation=()=>new Promise<void>((resolve,reject)=>{
 releaseOperation=()=>writeFailure?reject(Object.assign(new Error(writeFailure),{code:writeFailure})):resolve();
});
const noteCase=mode==='bluetooth-modal'||mode==='bluetooth-note-close'||restoredNoteCase;
const noteActionsCase=mode==='note-actions';
const rssSaveCase=mode==='bluetooth-rss-save';
const searchCase=mode==='bluetooth-inline'||mode==='bluetooth-search-modal'||searchRestore;
let resolveModal!:(value:string|null)=>void,resolveInlineClose!:()=>void;
let resolveFavorite:(()=>void)|undefined;
let resolveTitlePending:((pending:boolean)=>void)|undefined;
let titleRecoveryKey:string|undefined;
let openedModalKey:string|undefined;
const modalCalls:string[]=[];
let inlineCloses=0,inlineOpens=0,inlineSession=0;
let searchedFor:string|undefined;
let savedDraft:{title:string;markdown:string}|undefined;
let bluetooth=false,validated=true,defaultNetworkId='old';const networkSubscriptions=new Set<number>();
let videoState='stopped';
let releaseVideoStop:(()=>void)|undefined;
const transforms:{scaleMode?:string;panY?:number}[]=[];
let clockMs=0,next=1;Date.now=()=>clockMs;
const kv=new Map<string,string>();
const events:any[]=[],timers=new Map<number,number>();
let sqlCommits=0,completedSaves=0,completedWrites=0;
let backEventsDelivered=0,saveCalls=0;let exitTimerStarted=false;
const props=new Map<number,Map<number,number>>(),texts=new Map<number,string>();
const textures=new Map<number,string>(),images=new Map<number,string>();
const ops:any={__viewport:{w:233,h:233},__scrollConfiguration:{touchSlopPx:8,minimumFlingVelocityPx:50,maximumFlingVelocityPx:8000}};
for(const name of ['destroyNode','insertBefore','removeChild','setStyle','setImage','setSprite','setFocus','animate','setAccessibility','setNavigationState'])ops[name]=()=>{};
ops.createNode=()=>next++;
ops.setProp=(id:number,key:number,value:number)=>{let p=props.get(id);if(!p)props.set(id,p=new Map());p.set(key,value);};
ops.destroyNode=(id:number)=>texts.delete(id);
ops.setText=ops.replaceText=(id:number,text:string)=>texts.set(id,text);
ops.loadPakImage=(source:string)=>{const id=next++;textures.set(id,source);return id;};
ops.setImage=(id:number,handle:number)=>images.set(id,textures.get(handle)??'');ops.uploadTexture=()=>next++;ops.freeTexture=()=>{};ops.measureText=(s:string)=>s.length*8;
ops.wrapText=()=>[];ops.getLayout=()=>({x:0,y:0,w:233,h:193});ops.getProp=(id:number,key:number)=>props.get(id)?.get(key)??0;
(globalThis as any).pod={capabilities:()=>JSON.stringify(['data.kv','runtime.timer','text.layout','net.discovery','input.text','system.share',...(videoCase?['media.video']:[]),...(hostPending?['data.sqlite']:[])]),displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),kvGet:(k:string)=>kv.get(k),kvSet:(k:string,v:string)=>{kv.set(k,v);return 0;},kvDelete:(k:string)=>{kv.delete(k);return 0;},kvKeys:()=>JSON.stringify([...kv.keys()]),takeEvents:()=>JSON.stringify(events.splice(0)),emit:(line:string)=>{const r=JSON.parse(line);if(r.t==='service.cancel'){timers.delete(r.id);return;}if(r.t!=='service.request')return;let value:any=null;const {method,id,args}=r;
 if(method==='runtime.delay'){if(args.milliseconds===2500)exitTimerStarted=true;timers.set(id,clockMs+args.milliseconds);return;}
 if(method==='application.activityState.write'||method==='app.activityState.write'){}
 else if(method==='input.inline.open'){
  inlineOpens++;
  if(mode==='bluetooth-modal'){events.push({t:'service.result',id,ok:false,error:{code:'fixture',message:'inline unavailable'}});return;}
  inlineSession=id;value=id;
 }
 else if(method==='input.inline.close'&&++inlineCloses===1&&(mode==='bluetooth-note-close'||mode==='bluetooth-inline')){
  resolveInlineClose=()=>events.push({t:'service.result',id,ok:true,value:null});
  return;
 }
 else if(method==='sql.query')value=[{article_id:12}];
 else if(method==='sql.transaction'){sqlCommits++;value=[1];}
 else if(method==='share.environment'){
  value={sdkInt:33,wearOs:false};
  if(shareQuery){releaseShareQuery=()=>events.push({t:'service.result',id,ok:true,value});return;}
 }
 else if(method==='share.text'){releaseShare=()=>events.push({t:'service.result',id,ok:true,value:null});return;}
 else if(videoCase&&method.startsWith('video.')){
  if(method==='video.prepare')videoState='ready';
  if(method==='video.play')videoState='playing';
  if(method==='video.pause')videoState='paused';
  if(method==='video.stop'){
   releaseVideoStop=()=>{
    videoState='stopped';
    events.push({t:'service.result',id,ok:true,value:null});
   };
   return;
  }
  if(method==='video.setTransform')transforms.push(args);
  value={ok:true,state:videoState,width:320,height:640,positionMs:0,durationMs:100000,volume:.8,volumeMax:1,hasRenderedFirstFrame:true};
 }
 else if(method==='discovery.networkSnapshot')value={active:true,internet:true,validated,wifi:!bluetooth,cellular:false,bluetooth,...(backgroundReplacement?{defaultNetworkId}:{})};
 else if(method==='discovery.networkSubscribe'){networkSubscriptions.add(args.subscriptionId);value={subscriptionId:args.subscriptionId};}
 else if(method==='discovery.networkUnsubscribe')networkSubscriptions.delete(args.subscriptionId);
 else if(method==='text.environment')value={density:2,fontScale:1,spValuesPx:[]};
 else if(method==='text.layout')value={lines:[{start:0,end:args.text.length,visibleEnd:args.text.length}]};
 else if(method.includes('secure')||method.includes('file')){events.push({t:'service.result',id,ok:false,error:{code:'fixture',message:'unavailable'}});return;}
 events.push({t:'service.result',id,ok:true,value});
 }};
await bindPocketServicePump(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir));
await bindPocketModules(import.meta.dir,Bun.resolveSync('@podjs/framework/watch',import.meta.dir),[
 'solid-js','@pocketjs/framework/renderer','@pocketjs/framework/components','@pocketjs/framework/host',
 '@pocketjs/framework/lifecycle','@pocketjs/framework/gesture','@pocketjs/framework/kinetics','@pocketjs/framework/input'
]);
const {render}=await import('@pocketjs/framework');
const {setStyleResolver,rootMirror}=await import('@pocketjs/framework/renderer');
const {activityStateHub}=await import('../src/navigation/activity-host.ts');
const {captureActivityNavigation}=await import('../src/navigation/activity-navigation.ts');
const {INITIAL_DISCLOSURE_KEY}=await import('../src/announcement/platform.ts');
if(mode!=='bluetooth-home-disclosure')kv.set(INITIAL_DISCLOSURE_KEY,'true');
const article={id:hostPending?'12':'fixture',channelId:'feed',channelTitle:'Test feed',title:'Article',link:'https://example.invalid/article',contentBlocks:videoCase?[{type:'video' as const,url:'https://example.invalid/video.mp4'}]:undefined,content:Array.from({length:30},()=>'<p>Reader regression body line.</p>').join(''),read:true};
let pendingSave:(()=>void)|undefined,rejectPendingSave:(()=>void)|undefined;const services:any=new Proxy({listChannels:async()=>[{id:'feed',title:'Test feed',url:'https://watchrss.local/import-content'}],listArticles:async()=>[article],getArticle:async()=>article,getChannelOriginalMode:async()=>false,getChannelPlaybackSettings:async()=>({hasPlayableMedia:false,continuePlaybackInBackground:false}),subscribeChannel:()=>()=>{},subscribeAccountStatus:()=>()=>{},readingProgress:{load:async()=>({offset:0,progress:0,updatedAt:0}),save:async()=>{saveCalls++;await new Promise<void>((resolve,reject)=>{pendingSave=resolve;rejectPendingSave=()=>reject(Error("fixture late write reject"));});completedSaves++;}},readAccountStatus:async()=>null,createSummary:()=>({dispose(){},state:{state:'idle'},start:async()=>{},cancel(){}})}, {get:(t,k)=>Reflect.get(t,k)??(k==='inputRecovery'||k==='openInlineInput'||k==='retryOfflineMedia'||k==='readSummaryUsage'||k==='subscribeSummaryUsage'||k==='loadImportedTextChunk'?undefined:()=>Promise.resolve(null))});
if(novelProbe){
 services.listChannels=async()=>[{id:'feed',title:'Test feed',url:novelSource}];
 services.listNovelChapters=(source:string)=>{
  if(source!==novelSource)throw new Error('unexpected novel source '+source);
  novelReads++;
  return new Promise(resolve=>{
   finishNovelRead=()=>resolve([{
    ...article,title:'Fixture resume chapter',link:novelSource+'/chapter/1',readingPositionChangedAt:1,
   }]);
  });
 };
}
if(hostPending){
 const {db}=await import('../src/services.ts');
 const {SqlReadingProgressStore}=await import('../src/reader/sql-progress.ts');
 const {ReadingProgressStore}=await import('../src/reader/progress.ts');
 const store=new SqlReadingProgressStore(db,new ReadingProgressStore({get:async()=>null,set:async()=>{}}));
 services.readingProgress={
  load:async()=>({offset:0,progress:0,updatedAt:0}),
  saveSnapshot:store.saveSnapshot.bind(store),
 };
}
if(noteCase||noteActionsCase||noteAction||noteDownload||noteListLoad||safeRoute==='notes'){
 const {memoRepository}=await import('../src/services.ts');
 memoRepository.initialize=async()=>{};
 memoRepository.list=async()=>{
  if(noteListLoad)await new Promise<void>(resolve=>{releaseNotes=resolve;});
  return [existingNote];
 };
 memoRepository.listFolders=async()=>[{folderId:'folder',name:'示例目录',sortOrder:1,updatedAt:1,modifiedBy:'fixture',deleted:false,deletedAt:0}];
 const writeNote=async()=>{await deferOperation();completedWrites++;return existingNote;};
 memoRepository.setPinned=writeNote;
 memoRepository.move=writeNote;
 memoRepository.delete=writeNote;
 const existingNote={
  noteId:'fixture-note',folderId:null,title:'Fixture note',markdown:'Fixture body',plainText:'Fixture body',
  contentHash:'',baseContentHash:'',baseMarkdown:'',createdAt:1,updatedAt:1,modifiedBy:'fixture',
  pinned:false,deleted:false,deletedAt:0,
 };
 memoRepository.get=async()=>existingNote;
 memoRepository.save=async draft=>{
  if(holdDraft&&draft.markdown==='Typed body'&&!releaseOperation)await deferOperation();
  savedDraft={title:draft.title??'',markdown:draft.markdown};
  return {...existingNote,...savedDraft,plainText:draft.markdown};
 };
 services.input=(title:string,_value:string,options?:{restorationKey?:string})=>{
  modalCalls.push(title);
  openedModalKey=options?.restorationKey;
  return new Promise<string|null>(resolve=>{resolveModal=resolve;});
 };
 services.inputRecovery={pending:async()=>false,dismiss:async()=>{}};
 if(restoredNoteCase)services.inputRecovery.pending=(key:string)=>{
  if(!key.endsWith(mode==='bluetooth-note-body'?':note:body':':note:title'))return Promise.resolve(false);
  if(titleRecoveryKey)return Promise.resolve(true);
  titleRecoveryKey=key;
  return new Promise<boolean>(resolve=>{resolveTitlePending=resolve;});
 };
}
if(backgroundRead)services.listChannels=async()=>{
 await deferOperation();
 return [{id:'feed',title:'Test feed',url:'https://watchrss.local/import-content'}];
};
if(homeLogin){
 const {biliClient}=await import('../src/media-services.ts');
 biliClient.getLoginState=async()=>{loginReads++;await deferOperation();return {status:'authenticated'};};
}
if(settingsQuery)services.hasSummaryAccount=async()=>{accountReads++;await deferOperation();return false;};
if(rssSaveCase)services.setSaveState=()=>new Promise<void>(resolve=>{resolveFavorite=resolve;});
if(searchCase||modalTakeover){
 const {textInput}=await import('@podjs/framework/services');
 services.openInlineInput=mode==='bluetooth-inline'?textInput.openInline:undefined;
 services.input=(title:string)=>{modalCalls.push(title);return new Promise<string|null>(resolve=>{resolveModal=resolve;});};
 if(searchRestore)services.inputRecovery={
  pending:(key:string)=>key.endsWith(':rss-search')?new Promise<boolean>(resolve=>{releaseRecovery=resolve;}):Promise.resolve(false),
  dismiss:async(key:string)=>{recoveryDismissals.push(key);},
 };
 services.searchArticles=async(_channelId:string,keyword:string)=>{searchedFor=keyword;return [];};
}
if(rssAction){
 const writeRss=async()=>{await deferOperation();completedWrites++;};
 services.setSaveState=writeRss;
 services.markRead=writeRss;
 services.deleteArticle=writeRss;
}
let releaseSecondOpen:(()=>void)|undefined;
if(mode==='bluetooth-feed-open'||warningThenOpen||slowArticleOpen)services.markRead=()=>{
 if(releaseOperation)return new Promise<void>(resolve=>{releaseSecondOpen=resolve;});
 return new Promise<void>((resolve,reject)=>{
  releaseOperation=mode.endsWith('-fail')||mode.endsWith('-error')
   ?()=>reject(new Error('fixture markRead failed')):resolve;
 });
};
if(articleActionsBackProbe||mode.startsWith('bluetooth-feed-actions'))services.getArticle=async()=>{await deferOperation();return article;};
if(rssFromReader||restoredFeedStall)services.listArticles=async()=>{
 await new Promise<void>(resolve=>{releaseFeed=resolve;});
 return [article];
};
if(listPull)services.refresh=deferOperation;
if(listProbe)services.listArticles=async()=>Array.from({length:10},(_,i)=>({...article,id:'item-'+i,title:'Article '+i}));
if(feedEventProbe){
 services.subscribeChannel=(listener:typeof emitChannel)=>{emitChannel=listener;return ()=>{};};
 services.listArticles=async()=>{
  if(!deferFeedEvent)return [article];
  feedEventReads++;
  if(feedEventReads===1)await new Promise<void>(resolve=>{releaseEventRead=resolve;});
  else return await new Promise(()=>{});
  return [{...article,id:'fixture-from-event',title:'Fresh article'}];
 };
}
if(settingsBackProbe)services.getChannelOriginalMode=async()=>{await deferOperation();return false;};
if(shareSystem)new (await import('../src/settings/store.ts')).SettingsStore().update({shareUseSystem:true});
activityStateHub.seed(captureActivityNavigation({saved:{},retained:{}},noteCase
 ?[{page:'home'},{page:'notes'},{page:'note-detail',noteId:restoredNoteCase?'fixture-note':undefined}]
 :noteActionsCase||noteAction?[{page:'home'},{page:'notes'},{page:'note-actions',noteId:'fixture-note'}]
 :rssSaveCase||rssAction||shareQuery?[{page:'home'},{page:'articles',channelId:'feed'},{page:'rss-actions',articleId:article.id}]
 :settingsBackProbe?[{page:'home'},{page:'articles',channelId:'feed'},{page:'channel-detail',channelId:'feed'}]
 :searchCase?[{page:'home'},{page:'search',channelId:'feed'}]
 :noteDownload||noteListLoad||safeRoute==='notes'?[{page:'home'},{page:'notes'}]
 :safeRoute==='settings'?[{page:'home'},{page:'settings'}]
 :homeLogin||safeRoute==='home'||revalidation||backgroundReplacement||mode==='bluetooth-home-disclosure'?[{page:'home'}]
 :mode.startsWith('bluetooth')&&!rssFromReader&&!videoCase
   ?[{page:'home'},{page:'articles',channelId:'feed'}]
 :[{page:'home'},{page:'articles',channelId:'feed'},{page:'reader',readerArticle:article}]));
const {connectCloudAccountStatus,notifyCloudAccountStatus}=await import('../src/cloud/status.ts');
let accountRevision=1,ownerChoiceRequired=false;
let disconnectAccount=navigationAccount?connectCloudAccountStatus(()=>({
 accountId:`fixture-${accountRevision}`,accountScope:`scope-${accountRevision}`,accountRevision,ownerChoiceRequired,
 message:'fixture',usedBytes:0,quotaBytes:0,
})):undefined;
const WatchRSS=(await import('../src/ui/screen.tsx')).default;
const stop=render(()=>{setStyleResolver(()=>0);return WatchRSS({services});},{ops});
const frame=(globalThis as any).frame;const watch=await import('@podjs/framework/watch');
const {__packTouch}=await import('../node_modules/@pocketjs/framework/framework/src/touch.ts');
async function tick(dt=17,touches:number[]=[],hits?:number[],buttons=0){clockMs+=dt;for(const [id,at]of timers)if(at<=clockMs){timers.delete(id);events.push({t:'service.result',id,ok:true,value:null});}frame(buttons,undefined,touches,hits);for(let n=0;n<25;n++)await Promise.resolve();}

const connected=()=>{const nodes:any[]=[];const walk=(n:any)=>{nodes.push(n);n.children.forEach(walk);};walk(rootMirror);return nodes;};
const state=()=>{const data:any=activityStateHub.read().saved['watchrss.content-activity'];return data?.entries?.map((e:any)=>e.page) as string[];};
const visible=()=>connected().filter(n=>props.get(n.id)?.has(128)).map(n=>({offset:props.get(n.id)!.get(128)!,opacity:props.get(n.id)!.get(69)??1}));
const {expect,test}=await import('bun:test');
const removeEventProbe=watch.__onHostEvent(event=>{if(event.t==='back')backEventsDelivered++;});
if(mode.startsWith('bluetooth')||noteActionsCase)test(`production route: ${mode}`,async()=>{
 const pump=async(count=190)=>{for(let i=0;i<count;i++)await tick();};
 const network=async(value:boolean,frames=190,reason='capabilities')=>{
  bluetooth=value;
  for(const subscriptionId of networkSubscriptions)events.push({t:'network.changed',subscriptionId,value:{source:'default',reason}});
  await pump(frames);
 };
 const warnings=()=>connected().filter(node=>node.domAttrs?.accessibilityLabel==='继续');
 const warning=()=>warnings()[0];
 const pressHandler=(label:string)=>{
  let node=connected().find(node=>node.domAttrs?.accessibilityLabel===label&&node.onPress)
    ?? connected().find(node=>texts.get(node.id)===label);
  while(node&&!node.onPress)node=node.parent;
  expect(node?.onPress,label).toBeDefined();
  return node.onPress as ()=>void;
 };
 const press=(label:string)=>{
  events.push({t:'accessibility.action',nodeId:-1,action:'activate'});
  pressHandler(label)();
 };
 const back=async()=>{events.push({t:'back'});await pump();};
 const displayed=(text:string)=>connected().some(node=>{
  if(texts.get(node.id)!==text&&node.domAttrs?.accessibilityLabel!==text)return false;
  for(let ancestor=node;ancestor;ancestor=ancestor.parent)if(props.get(ancestor.id)?.get(69)===0)return false;
  return true;
 });
 const assertOnce=async(page:string)=>{
  await pump();
  expect(state().at(-1)).toBe(page);
  expect(warnings()).toHaveLength(1);
  await pump();
  expect(warnings()).toHaveLength(1);
  press('继续');
  await network(true);
  expect(warning()).toBeUndefined();
  expect(state().at(-1)).toBe(page);
  await network(false);
  await network(true);
  expect(warnings()).toHaveLength(1);
 };
 try{
  await pump(50);

  if(homeLogin){
   expect(state()).toEqual(['home']);
   const readsBeforeWarning = loginReads;
   expect(readsBeforeWarning).toBeGreaterThan(0);
   expect(releaseOperation).toBeDefined();
   await network(!bluetoothControl);
   expect(warnings()).toHaveLength(bluetoothControl?0:1);
   releaseOperation!();
   await pump();
   if(!bluetoothControl)press('继续');
   await pump();
   expect(loginReads).toBe(readsBeforeWarning);
   expect(state()).toEqual(['home']);
   return;
  }
  if(feedEventProbe){
   expect(state()).toEqual(['home','articles']);
   expect(displayed('Article')).toBe(true);
   deferFeedEvent=true;
   emitChannel!({kind:'refresh',id:'feed'});
   await pump(10);
   expect(feedEventReads).toBe(1);
   expect(releaseEventRead).toBeDefined();
   await network(!bluetoothControl);
   expect(warnings()).toHaveLength(bluetoothControl?0:1);
   releaseEventRead!();
   await pump(10);
   if(!bluetoothControl)press('继续');
   await pump(20);
   const visibleResult=displayed('Fresh article');
   console.log(JSON.stringify({feedEventReads,visibleResult,stack:state()}));
   expect({feedEventReads,visibleResult}).toEqual({feedEventReads:1,visibleResult:true});
   return;
  }
  if(articleActionsBackProbe){
   expect(state()).toEqual(['home','articles']);
   const title=connected().find(node=>texts.get(node.id)==='Article');
   expect(title).toBeDefined();
   for(let i=0;i<60;i++)await tick(17,[__packTouch(1,116,130)],[title!.id]);
   await tick();
   await pump(5);
   expect(releaseOperation).toBeDefined();
   await network(!bluetoothControl);
   expect(warnings()).toHaveLength(bluetoothControl?0:1);
   releaseOperation!();
   await pump();
   expect(displayed('标为未读')).toBe(true);
   expect(warnings()).toHaveLength(0);
   return;
  }
  if(settingsBackProbe){
   expect(state()).toEqual(['home','articles','channel-detail']);
   press('设置');
   await pump(10);
   expect(releaseOperation).toBeDefined();
   await tick(17,[__packTouch(1,46,46)]);
   await tick(17,[__packTouch(1,165,46)]);
   expect(visible().some(v=>v.offset===119&&v.opacity===1)).toBe(true);
   await tick();
   const afterPop=mode.endsWith('-after-pop');
   if(afterPop){
    await pump(80);
    await network(!bluetoothControl);
    expect(warnings()).toHaveLength(bluetoothControl?0:1);
   }
   releaseOperation!();
   await pump(2);
   if(!afterPop)expect(state().at(-1)).toBe('channel-detail');
   await pump(80);
   expect(state()).toEqual(['home','articles']);
   if(afterPop)expect(warnings()).toHaveLength(bluetoothControl?0:1);
   return;
  }
  if(novelProbe){
   expect(state()).toEqual(['home','articles']);
   const readsBeforeWarning=novelReads;
   expect(readsBeforeWarning).toBeGreaterThan(0);
   expect(finishNovelRead).toBeDefined();
   await network(!bluetoothControl);
   expect(warnings()).toHaveLength(bluetoothControl?0:1);
   finishNovelRead!();
   await pump(15);
   if(!bluetoothControl)press('继续');
   await pump(20);
   const resume=displayed('继续阅读：Fixture resume chapter');
   expect(state().at(-1)).toBe('articles');
   expect({novelReads,resume}).toEqual({novelReads:readsBeforeWarning,resume:true});
   return;
  }
  if(modalTakeover){
   expect(state()).toEqual(['home','articles']);
   press('Article');
   await pump(20);
   expect(releaseOperation).toBeDefined();
   if(!bluetoothControl){
    await network(true);
    expect(warnings()).toHaveLength(1);
    press('继续');
    await pump(20);
   }
   let header=connected().find(node=>images.get(node.id)?.endsWith('info-hint.svg'));
   while(header&&!header.onPress)header=header.parent;
   expect(header?.onPress).toBeDefined();
   header.onPress();
   await pump(20);
   expect(state().at(-1)).toBe('channel-detail');
   press('搜索');
   await pump(20);
   expect(state().at(-1)).toBe('search');
   press('输入关键词开始搜索');
   await pump(20);
   expect(modalCalls).toEqual(['搜索文章']);
   releaseOperation!();
   await pump(20);
   const whileInput=state().at(-1);
   resolveModal('Fixture keyword');
   await pump(20);
   expect({whileInput,searchedFor}).toEqual({whileInput:'search',searchedFor:'Fixture keyword'});
   return;
  }
  if(swipeMenu){
   const target=connected().find(node=>texts.get(node.id)==='Article 0');
   expect(target).toBeDefined();
   for(const x of [180,155,130,105,80])await tick(17,[__packTouch(1,x,130)],[target!.id]);
   await tick();
   await pump();
   const offset=()=>connected().map(node=>props.get(node.id)?.get(128)??0).find(offset=>offset<-20);
   expect(offset()).toBeDefined();
   await network(true);
   expect(warnings()).toHaveLength(0);
   expect(offset()).toBeDefined();
   press('Article 0');
   await pump();
   expect(warnings()).toHaveLength(1);
   return;
  }
  if(listProbe){
   expect(state().at(-1)).toBe('articles');
   await network(true,30);
   expect(warnings()).toHaveLength(0);
   const target=connected().find(node=>texts.get(node.id)==='Article 0');
   expect(target).toBeDefined();
   const contact=(y:number)=>[__packTouch(1,116,y)];
   const translated=()=>connected().map(node=>props.get(node.id)?.get(129)??0).filter(offset=>offset!==0).sort((a,b)=>a-b);
   let retainedOffset:number[]|undefined;
   if(mode==='bluetooth-list-pull'){
    await tick(17,contact(75),[target!.id]);
    for(const y of [100,120,144,163])await tick(17,contact(y),[target!.id]);
    await tick();
    expect(releaseOperation).toBeDefined();
    await pump();
    expect(warnings()).toHaveLength(1);
    releaseOperation!();
   }else{
    await tick(17,contact(185),[target!.id]);
    for(const y of [165,140,115,90,65])await tick(17,contact(y),[target!.id]);
    await tick();
    const atRelease=translated();
    await pump(4);
    const afterRelease=translated();

    expect(afterRelease).not.toEqual(atRelease);
    expect(warnings()).toHaveLength(0);
    let previous=afterRelease, stableFrames=0;
    for(let i=0;i<220&&stableFrames<6;i++){
     await tick();
     const now=translated();
     if(JSON.stringify(previous)!==JSON.stringify(now))expect(warnings()).toHaveLength(0);
     stableFrames=JSON.stringify(previous)===JSON.stringify(now)?stableFrames+1:0;
     previous=now;
    }
    expect(stableFrames).toBe(6);
    retainedOffset=previous;
    expect(retainedOffset.some(offset=>offset<0)).toBe(true);


   }
   await pump();
   expect(warnings()).toHaveLength(1);
   press('继续');
   await pump();
   expect(warnings()).toHaveLength(0);
   expect(state().at(-1)).toBe('articles');
   if(retainedOffset)expect(translated()).toEqual(retainedOffset);
   return;
  }
  if(mode==='bluetooth-home-disclosure'){
   await network(true);
   expect(warning()).toBeUndefined();
   events.push({t:'axis',axis:0,delta:12000});
   await pump();
   press('我已了解');
   await assertOnce('home');
   return;
  }
  if(backgroundReplacement){
   expect(state()).toEqual(['home']);
   const background=async()=>{
    events.push({t:'lifecycle',state:'background'});
    await pump();
    expect(networkSubscriptions.size).toBe(0);
   };
   const foreground=async()=>{
    events.push({t:'lifecycle',state:'active'});
    await pump(4);
    await network(true,0,'available');
   };
   await network(true,190,'available');
   expect(warnings()).toHaveLength(1);
   press('继续');
   await pump();
   await background();
   await foreground();
   await pump();
   expect(warnings()).toHaveLength(0);

   await background();
   await network(false,80,'lost');
   defaultNetworkId='replacement';
   await network(true,80,'available');
   await foreground();
   await pump();
   expect(warnings()).toHaveLength(1);
   const previous=warning()!.id;
   await background();
   defaultNetworkId='replacement-while-visible';
   await foreground();
   await pump();
   expect(warnings()).toHaveLength(1);
   expect(warning()!.id).not.toBe(previous);
   press('继续');
   await pump();
   await background();
   await foreground();
   await pump();
   expect(warnings()).toHaveLength(0);
   return;
  }
  if(revalidation){
   expect(state()).toEqual(['home']);
   await network(true);
   expect(warnings()).toHaveLength(1);
   press('继续');
   await pump();

   validated=false;
   await network(true);
   expect(warnings()).toHaveLength(0);
   validated=true;
   await network(true);
   expect(warnings()).toHaveLength(0);

   await network(false);
   await network(true,80,'available');
   expect(warnings()).toHaveLength(1);
   press('继续');
   await pump();

   // The default network can be replaced without an intervening non-Bluetooth snapshot.
   await network(true,80,'available');
   expect(warnings()).toHaveLength(1);
   press('继续');
   await pump();
   events.push({t:'lifecycle',state:'background'});
   await pump();
   events.push({t:'lifecycle',state:'active'});
   await pump();
   // The first available callback after resubscribing describes the current default.
   await network(true,80,'available');
   expect(warnings()).toHaveLength(0);
   return;
  }
  if(backgroundRead||settingsQuery){
   expect(state()).toEqual(['home','settings']);
   expect(releaseOperation).toBeDefined();
   await network(!bluetoothControl,50);
   expect(warnings()).toHaveLength(0);
   await pump();
   expect(warnings()).toHaveLength(bluetoothControl?0:1);
   releaseOperation!();
   await pump();
   if(!bluetoothControl)press('继续');
   await pump();
   if(settingsQuery)expect(accountReads).toBe(1);
   expect(state()).toEqual(['home','settings']);
   return;
  }
  if(mode==='bluetooth-idle-input'){
   await network(true,2);
   await tick(17,[__packTouch(1,116,130)]);
   await tick(3100,[__packTouch(1,116,130)]);
   expect(warning()).toBeUndefined();
   await tick();
   await tick(2999);
   expect(warning()).toBeUndefined();
   events.push({t:'axis',axis:0,delta:0});
   await tick();
   await tick(2999);
   expect(warning()).toBeUndefined();
   await tick(1,[],undefined,1);
   await tick();
   await tick(2999);
   expect(warning()).toBeUndefined();
   await tick(1);
   expect(state().at(-1)).toBe('articles');
   expect(warnings()).toHaveLength(1);
   return;
  }
  if(safeRoute){
   await network(true,50);
   expect(warning()).toBeUndefined();
   if(safeRoute==='settings'){
    events.push({t:'axis',axis:0,delta:12000});
    await pump(50);
    expect(warning()).toBeUndefined();
    await network(false);
    expect(warning()).toBeUndefined();
   }
   await network(true);
   await assertOnce(safeRoute);
   return;
  }
  if(noteListLoad){
   expect(releaseNotes).toBeDefined();
   await network(!bluetoothControl);
   expect(warnings()).toHaveLength(bluetoothControl?0:1);
   releaseNotes!();
   await pump();
   if(!bluetoothControl)press('继续');
   await pump();
   expect(displayed('Fixture note')).toBe(true);
   expect(state().at(-1)).toBe('notes');
   return;
  }
  if(shareQuery){
   expect(releaseShareQuery).toBeDefined();
   press('分享');
   await back();
   expect(state().at(-1)).toBe('articles');
   await network(!bluetoothControl);
   expect(warnings()).toHaveLength(bluetoothControl?0:1);
   releaseShareQuery!();
   await pump();
   expect(displayed(article.link)).toBe(false);
   if(!bluetoothControl)await assertOnce('articles');
   expect(state().at(-1)).toBe('articles');
   return;
  }
  if(restoredFeedStall){
   expect(state()).toEqual(['home','articles']);
   expect(releaseFeed).toBeDefined();
   await back();
   expect(displayed('Test feed')).toBe(true);
   await network(true);
   expect(warnings()).toHaveLength(1);
   releaseFeed!();
   await assertOnce('home');
   return;
  }
  if(noteDownload){
   press('下载手机端app以在手机上编辑和同步内容');
   await network(true);
   expect(displayed('下载手机端App')).toBe(true);
   expect(warning()).toBeUndefined();
   press('关闭下载提示');
   await assertOnce('notes');
   return;
  }
  if(noteAction||rssAction){
   const operation=mode.split('-')[3];
   const destination=noteAction?'notes':'articles';
   if(operation==='confirm'||operation==='delete'){
    press('删除');
    await pump();
    expect(displayed('确认删除')).toBe(true);
    if(operation==='confirm'){
     await network(true);
     expect(warning()).toBeUndefined();
     press('取消删除');
     await pump();
     expect(displayed('确认删除')).toBe(false);
     expect(warning()).toBeUndefined();
     await back();
     await assertOnce(destination);
     return;
    }
    press('确认删除');
   }else if(operation==='move'){
    press('移动到…');
    await pump();
    press('示例目录');
   }else if(operation==='system'||operation==='qr'){
    press('分享');
    await pump();
    if(operation==='qr'){
     expect(displayed(article.link)).toBe(true);
     await network(true);
     expect(warning()).toBeUndefined();
     expect(displayed(article.link)).toBe(true);
     await back();
     expect(displayed(article.link)).toBe(false);
    }else{
     expect(releaseShare).toBeDefined();
     await back();
     expect(state().at(-1)).toBe('articles');
     await network(true);
     expect(warning()).toBeUndefined();
     releaseShare!();
    }
    await assertOnce(destination);
    return;
   }else{
    press(({pin:'置顶',unread:'标为未读',later:'稍后再看',leave:'收藏',cancel:'收藏'} as Record<string,string>)[operation!]);
   }
   await pump();
   expect(releaseOperation).toBeDefined();
   if(noteActionLeave){
    // Delete and move each have an inner confirmation or picker to close first.
    if(operation==='delete'||operation==='move')await back();
    await back();
    expect(state().at(-1)).toBe(destination);
   }else if(operation==='leave'||(rssAction&&writeFailure)){
    if(operation==='delete')await back();
    await back();
   }
   await network(true);
   expect(warnings()).toHaveLength(state().at(-1)===destination?1:0);
   const cancel=noteActionCancel||operation==='cancel';
   if(cancel)await network(false);
   releaseOperation!();
   await pump();
   expect(completedWrites).toBe(writeFailure?0:1);
   if(writeFailure){
    for(let i=0;i<2&&state().at(-1)!==destination;i++)await back();
   }
   if(cancel){
    expect(state().at(-1)).toBe(destination);
    expect(warning()).toBeUndefined();
    await network(true);
   }
   await assertOnce(destination);
   return;
  }
  if(videoCase){
   const pressIcon=(name:string)=>{
    let icon=connected().find(node=>images.get(node.id)?.endsWith('/'+name+'.svg'));
    while(icon&&!icon.onPress)icon=icon.parent;
    expect(icon?.onPress,name).toBeDefined();
    icon.onPress();
   };
   pressIcon('play-circle');
   await pump();
   expect(videoState).toBe('playing');
   await network(true);
   expect(warning()).toBeUndefined();
   pressIcon('player-pause');
   await pump();
   expect(videoState).toBe('paused');
   expect(warning()).toBeUndefined();
   pressIcon('player-fullscreen');
   await pump();
   expect(transforms.at(-1)?.scaleMode).toBe('expanded');
   await tick(17,[__packTouch(1,115,100)]);
   for(let i=0;i<70;i++)await tick(17,[__packTouch(1,115,150)]);
   expect(transforms.at(-1)?.panY).not.toBe(0);
   expect(warning()).toBeUndefined();
   await tick();
   await back();
   expect(state().at(-1)).toBe('reader');
   expect(warning()).toBeUndefined();
   await back();
   expect(releaseVideoStop).toBeDefined();
   expect(warnings()).toHaveLength(1);
   releaseVideoStop!();
   await assertOnce('articles');
   return;
  }
  if(warningThenOpen){
   const open=pressHandler('Article');
   await network(true);
   expect(warnings()).toHaveLength(1);
   const close=pressHandler('继续');
   open();
   await pump();
   expect(releaseOperation).toBeDefined();
   const dragging=mode.endsWith('-dragging');
   const settling=mode.endsWith('-settling');
   if(dragging||settling||mode.endsWith('-after-swipe')){
    await tick(17,[__packTouch(1,46,46)]);
    await tick(17,[__packTouch(1,165,46)]);
    expect(visible().some(v=>v.offset===119&&v.opacity===1)).toBe(true);
    if(!dragging)await tick();
    if(mode.endsWith('-after-swipe'))await pump();
   }
   if(mode.endsWith('-continue'))close();
   releaseOperation!();
   if(dragging){
    await tick(17,[__packTouch(1,165,46)]);
    expect(state().at(-1)).toBe('reader');
    await tick();
   }
   await pump();
   if(mode.endsWith('-error')){
    expect(warnings()).toHaveLength(1);
    close();
    await pump();
    expect(displayed('Error: fixture markRead failed')).toBe(true);
   }else{
    expect(state().at(-1)).toBe('reader');
    if(mode.endsWith('-stale-continue'))close();
    await pump();
    expect(state().at(-1)).toBe('reader');
    await back();
   }
   expect(state().at(-1)).toBe('articles');
   expect(warnings()).toHaveLength(0);
   await network(true);
   expect(warnings()).toHaveLength(0);
   return;
  }
  if(slowArticleOpen){
   const open=pressHandler('Article');
   press('Article');
   await pump(10);
   expect(releaseOperation).toBeDefined();
   if(mode.endsWith('-cloud-init'))disconnectAccount=connectCloudAccountStatus(()=>({
    accountId:'',accountScope:'',accountRevision:0,message:'',usedBytes:0,quotaBytes:0,
   }));
   const rebound=mode.endsWith('-rebound');
   if(rebound){
    await tick(17,[__packTouch(1,46,46)]);
    const held=[__packTouch(1,76,46)];
    await network(true,0);
    await tick(17,held);
    for(let i=0;i<190;i++)await tick(17,held);
    expect(visible().some(v=>v.offset===30&&v.opacity===1)).toBe(true);
    expect(warnings()).toHaveLength(0);
    releaseOperation!();
    for(let i=0;i<10;i++)await tick(17,held);
    expect(state().at(-1)).toBe('articles');
    await tick();
    await pump();
    expect(state()).toEqual(['home','articles']);
    await assertOnce('articles');
    return;
   }
   if(navigationBackground){
    events.push({t:'lifecycle',state:'background'});
    await network(true);
    expect(warnings()).toHaveLength(0);
    events.push({t:'lifecycle',state:'active'});
   }else if(navigationAccount){
    accountRevision++;
    ownerChoiceRequired=true;
    notifyCloudAccountStatus();
    await network(true);
    expect(warnings()).toHaveLength(0);
    ownerChoiceRequired=false;
    notifyCloudAccountStatus();
   }
   await network(true);
   expect(warnings()).toHaveLength(1);
   if(mode==='bluetooth-feed-open-slow'){
    await tick(31_000);
    expect(warnings()).toHaveLength(1);
   }
   if(mode.endsWith('-destroy')){
    stop();
    releaseOperation!();
    await pump();
    expect(warnings()).toHaveLength(0);
    expect(state()).toEqual(['home','articles']);
    return;
   }
   if(mode.endsWith('-back')||mode.endsWith('-reenter')){
    await back();
    await back();
    expect(state().at(-1)).toBe('home');
    if(mode.endsWith('-reenter')){
     press('Test feed');
     await pump();
     expect(state().at(-1)).toBe('articles');
     press('Article');
     await pump();
     expect(releaseSecondOpen).toBeDefined();
    }
   }
   if(mode.endsWith('-retry')){
    open();
    await pump();
    expect(releaseSecondOpen).toBeDefined();
   }
   const leftSource = mode.endsWith('-back');
   if(leftSource){
    expect(warnings()).toHaveLength(0);
    await network(false);
    await network(true);
    expect(warnings()).toHaveLength(1);
   }
   releaseOperation!();
   await pump();
   if(leftSource){
    expect(state()).toEqual(['home']);
    expect(warnings()).toHaveLength(1);
    press('继续');
    await pump();
   }else if(mode.endsWith('-fail')){
    expect(warnings()).toHaveLength(1);
    press('继续');
    await pump();
    expect(displayed('Error: fixture markRead failed')).toBe(true);
   }else{
    if(releaseSecondOpen){
     expect(state().at(-1)).toBe('articles');
     expect(warnings()).toHaveLength(mode.endsWith('-reenter')?0:1);
     releaseSecondOpen();
     await pump();
    }
    expect(state().at(-1)).toBe('reader');
    expect(state().filter(page=>page==='reader')).toHaveLength(1);
    expect(warnings()).toHaveLength(0);
    await back();
   }
   await network(true);
   expect(warnings()).toHaveLength(0);
   return;
  }
  if(rssProbe){
   if(rssFromReader){
    await back();
    expect(releaseFeed).toBeDefined();
    if(stalledFeedReload){
     await back();
     await network(true);
     await assertOnce('home');
     return;
    }
    await network(!bluetoothControl);
    expect(warnings()).toHaveLength(bluetoothControl?0:1);
    releaseFeed!();
    if(!bluetoothControl)press('继续');
    await pump();
    expect(displayed('Article')).toBe(true);
   }else{
    if(mode.startsWith('bluetooth-feed-actions')){
     const title=connected().find(node=>texts.get(node.id)==='Article');
     expect(title).toBeDefined();
     for(let i=0;i<60;i++)await tick(17,[__packTouch(1,116,130)],[title!.id]);
     await tick();
    }else press('Article');
    await pump();
    expect(releaseOperation).toBeDefined();
    await network(!bluetoothControl);
    expect(warnings()).toHaveLength(bluetoothControl?0:1);
    const leave=mode==='bluetooth-feed-actions-leave';
    if(leave){
     await back();
     await back();
     expect(state()).toEqual(['home']);
    }
    releaseOperation!();
    await pump();
    if(leave){
     expect(state()).toEqual(['home']);
     expect(warnings()).toHaveLength(0);
     return;
    }
    if(mode.startsWith('bluetooth-feed-actions'))expect(displayed('标为未读')).toBe(true);
    else expect(state().at(-1)).toBe('reader');
    expect(warning()).toBeUndefined();
    await back();
   }
   expect(state().at(-1)).toBe('articles');
   expect(warnings()).toHaveLength(0);
   return;
  }
  if(noteActionsCase){
   expect(state().at(-1)).toBe('note-actions');
   expect(connected().some(node=>node.domAttrs?.accessibilityLabel==='置顶')).toBe(true);
   return;
  }
  if(rssSaveCase){
   expect(state().at(-1)).toBe('rss-actions');
   let button=connected().find(node=>texts.get(node.id)==='收藏');
   while(button&&!button.onPress)button=button.parent;
   expect(button?.onPress).toBeDefined();
   button.onPress();
   await pump();
   expect(resolveFavorite).toBeDefined();
   await network(true);
   const warningWhileSaving=Boolean(warning());
   resolveFavorite!();
   await pump();
   expect(state()).toEqual(['home','articles']);
   expect(warningWhileSaving).toBe(false);
   expect(warning()).toBeDefined();
   events.push({t:'back'});
   await pump();
   expect(warning()).toBeUndefined();
   expect(state()).toEqual(['home','articles']);
   return;
  }
  if(restoredNoteCase){
   expect(state().at(-1)).toBe('note-detail');
   expect(resolveTitlePending).toBeDefined();
   await network(true);
   expect(warning()).toBeUndefined();
   if(mode==='bluetooth-note-leave'){
    await back();
    resolveTitlePending!(true);
    await assertOnce('notes');
    expect(modalCalls).toEqual([]);
    return;
   }
   resolveTitlePending!(mode!=='bluetooth-note-empty');
   await pump();
   if(mode==='bluetooth-note-empty'){
    expect(modalCalls).toEqual([]);
    expect(warning()).toBeUndefined();
    await back();
    await assertOnce('notes');
    return;
   }
   if(mode==='bluetooth-note-body'){
    expect(modalCalls).toEqual(['备忘录正文']);
    expect(warning()).toBeUndefined();
    resolveModal('Restored body');
    await pump();
    expect(savedDraft?.markdown).toBe('Restored body');
    expect(warning()).toBeUndefined();
    await back();
    await assertOnce('notes');
    return;
   }
   expect(modalCalls).toEqual(['备忘录标题']);
   expect(openedModalKey).toBe(titleRecoveryKey);
   expect(warning()).toBeUndefined();
   resolveModal('Restored title');
   await pump();
   expect(modalCalls).toEqual(['备忘录标题','备忘录正文']);
   expect(warning()).toBeUndefined();
   resolveModal('Restored body');
   await pump();
   expect(savedDraft).toEqual({title:'Restored title',markdown:'Restored body'});
   expect(state().at(-1)).toBe('note-detail');
   expect(warning()).toBeUndefined();
   await back();
   await assertOnce('notes');
   return;
  }
  if(noteCase){
   expect(state().at(-1)).toBe('note-detail');
   if(mode==='bluetooth-modal'){
    expect(modalCalls).toEqual(['备忘录标题']);
    await network(true);
    expect(warning()).toBeUndefined();
    resolveModal(emptyDraft?null:'Typed title');
    await pump();
    expect(modalCalls).toEqual(['备忘录标题','备忘录正文']);
    expect(warning()).toBeUndefined();
    resolveModal(emptyDraft?null:'Typed body');
    await pump();
    if(holdDraft){
     expect(releaseOperation).toBeDefined();
     expect(warning()).toBeUndefined();
     releaseOperation!();
     await pump();
     if(writeFailure){
      expect(state().at(-1)).toBe('note-detail');
      expect(warning()).toBeUndefined();
      press('关闭编辑，保存失败，请重试');
      await pump();
     }
    }
   }else{
    events.push({t:'back'});
    await pump(5);
    expect(inlineCloses).toBe(1);
    await network(true);
    expect(warning()).toBeUndefined();
    resolveInlineClose();
    await pump();
   }
   expect(warning()).toBeDefined();
   if(mode==='bluetooth-modal')expect(savedDraft).toEqual(emptyDraft?undefined:{title:'Typed title',markdown:'Typed body'});
   expect(state().at(-1)).toBe('notes');
   events.push({t:'back'});
   await pump();
   expect(warning()).toBeUndefined();
   expect(state()).toEqual(['home','notes']);
   return;
  }
  if(searchCase){
   if(searchRestore){
    expect(releaseRecovery).toBeDefined();
    await network(true);
    expect(warning()).toBeUndefined();
    const dismissalsBeforeRecovery=recoveryDismissals.length;
    releaseRecovery!(true);
    await pump();
    expect(modalCalls).toEqual(['搜索文章']);
    expect(recoveryDismissals).toHaveLength(dismissalsBeforeRecovery);
   }else{
    const trigger=connected().find(node=>node.domAttrs?.accessibilityLabel==='输入关键词开始搜索');
    expect(trigger).toBeDefined();
    events.push({t:'accessibility.action',nodeId:trigger!.id,action:'activate'});
    await pump();
    await network(true);
   }
   expect(warning()).toBeUndefined();
   if(mode==='bluetooth-inline'){
    expect(inlineOpens).toBe(1);
    expect(inlineCloses).toBe(0);
    events.push({t:'input.inline.submit',session:inlineSession,value:'Fixture keyword'});
    await pump();
    expect(inlineCloses).toBe(1);
    expect(warning()).toBeUndefined();
    resolveInlineClose();
   }else{
    resolveModal('Fixture keyword');
   }
   await pump();
   expect(warning()).toBeUndefined();
   expect(searchedFor).toBe('Fixture keyword');
   await back();
   await assertOnce('home');
   return;
  }
  if(mode==='bluetooth-transition'||mode==='bluetooth-cancel'){
   // Leftward pan keeps BackMotion at zero offset throughout drag and settle.
   await tick(17,[__packTouch(1,150,80)]);
   await tick(17,[__packTouch(1,100,80)]);
   await network(true,0);
   for(let i=0;i<70;i++)await tick(17,[__packTouch(1,100,80)]);
   expect(warning()).toBeUndefined();
   if(mode==='bluetooth-cancel'){
    await network(false,0);
    for(let i=0;i<10;i++)await tick(17,[__packTouch(1,100,80)]);
   }
   await tick();
   await pump();
   expect(!!warning()).toBe(mode==='bluetooth-transition');
   expect(state().at(-1)).toBe('articles');
   return;
  }
  expect(state()).toEqual(['home','articles']);
  expect(warning()).toBeUndefined();
  await network(true);
  expect(watch.navigationStateSnapshot().canGoBack).toBe(true);
  expect(warning()).toBeDefined();
  for(const contacts of [[__packTouch(1,166,46)],[__packTouch(1,166,46),__packTouch(2,90,130)]]){
   await tick(17,[__packTouch(1,46,46)]);
   await tick(17,contacts);
   expect(visible().some(v=>v.offset===120&&v.opacity===1)).toBe(true);
   expect(visible().some(v=>v.offset===0&&v.opacity===1)).toBe(true);
   await tick();
   await pump();
   expect(warning()).toBeUndefined();
   expect(state()).toEqual(['home','articles']);
   await network(true);
   expect(warning()).toBeUndefined();
   if(contacts.length===1){
    await network(false);
    await network(true);
    expect(warning()).toBeDefined();
   }
  }

  await network(false);await network(true);
  expect(warning()).toBeDefined();
  events.push({t:'accessibility.action',nodeId:warning()!.id,action:'activate'});
  await pump();
  expect(warning()).toBeUndefined();
  await network(true);
  expect(warning()).toBeUndefined();

  await network(false);await network(true);
  expect(warning()).toBeDefined();
  events.push({t:'back'});
  await pump();
  expect(warning()).toBeUndefined();
  expect(state().at(-1)).toBe('articles');

  await network(false);await network(true);
  expect(warning()).toBeDefined();
  await tick(17,[__packTouch(1,46,46)]);
  await tick(17,[__packTouch(1,126,46)]);
  await network(false,0);
  for(let i=0;i<4;i++)await tick(17,[__packTouch(1,126,46)]);
  await tick();
  await pump();
  expect(warning()).toBeUndefined();
  expect(state().at(-1)).toBe('articles');
 }finally{disconnectAccount?.();removeEventProbe();stop();}
});
else if(hostPending)test(`reader saves with ${hostPending} occupied host operations`,async()=>{
 const {delay,serviceResourceCounts}=await import('@podjs/framework/services');
 for(let i=0;i<50;i++)await tick(8);
 expect(state()).toEqual(['home','articles','reader']);
 events.push({t:'axis',axis:0,delta:12000});
 for(let i=0;i<6;i++)await tick(8);
 const occupied=Array.from({length:hostPending-serviceResourceCounts().pending},()=>delay(90_000));
 for(const request of occupied)void request.result.catch(()=>{});
 try{
  expect(serviceResourceCounts().pending).toBe(hostPending);
  events.push({t:'back'});
  for(let i=0;i<31;i++)await tick(8);
  expect(exitTimerStarted).toBe(true);
  expect(sqlCommits).toBe(1);
 }finally{
  for(const request of occupied)request.cancel();
  removeEventProbe();
  stop();
 }
});
else test(`production WatchRSS routes and BackMotion survive ${mode}`,async()=>{
 for(let i=0;i<50;i++)await tick();
 expect(state()).toEqual(['home','articles','reader']);
 // Move the real reader so final progress is dirty before the BACK burst.
 events.push({t:'axis',axis:0,delta:12000});
 for(let i=0;i<12;i++)await tick();
 if(mode==='reader-background-timeout-warning'){
  events.push({t:'lifecycle',state:'background'});
  await tick();
  expect(exitTimerStarted).toBe(true);
  expect(pendingSave).toBeDefined();
  events.push({t:'lifecycle',state:'active'});
  await tick();
 }
 const count=mode==='8'?8:4;
 events.push(...Array.from({length:count},()=>({t:'back'})));
 await tick();
 for(let i=0;i<8;i++)await tick(); // more hardware BACK during settling
 events.push(...Array.from({length:count},()=>({t:'back'})));
 if(mode==='lifecycle'){
  events.push({t:'lifecycle',state:'inactive'});await tick();
  events.push({t:'lifecycle',state:'background'});await tick();
  events.push({t:'lifecycle',state:'active'});await tick();
  events.push({t:'back'});
 }
 for(let i=0;i<30;i++)await tick();
 if(mode==='delayed'){
  expect(state().at(-1)).toBe('reader');
  events.push(...Array.from({length:8},()=>({t:'back'})));
  for(let i=0;i<20;i++)await tick();
 }
 expect(state().at(-1)).toBe('reader');
 expect(backEventsDelivered).toBeGreaterThanOrEqual(count*2);
 expect(exitTimerStarted).toBe(true);
 expect(saveCalls).toBe(1);
 expect(pendingSave).toBeDefined();
 if(mode!=='timeout'&&!readerTimeout&&!readerLate)pendingSave!();
 for(let i=0;i<180;i++)await tick();
 expect(state()).toEqual(['home','articles']);
 expect(visible().some(v=>v.opacity===1&&v.offset===0)).toBe(true);
 if(readerTimeout||readerLate){
  bluetooth=true;
  for(const subscriptionId of networkSubscriptions)events.push({t:'network.changed',subscriptionId,value:{source:'default',reason:'available'}});
  for(let i=0;i<190;i++)await tick();
  expect(connected().filter(node=>node.domAttrs?.accessibilityLabel==='继续')).toHaveLength(1);
  if(readerLate){
   if(mode.endsWith('-reject'))rejectPendingSave!();
   else pendingSave!();
   for(let i=0;i<10;i++)await tick();
   expect(completedSaves).toBe(mode.endsWith('-reject')?0:1);
   expect(saveCalls).toBe(1);
   expect(connected().filter(node=>node.domAttrs?.accessibilityLabel==='继续')).toHaveLength(1);
  }
  events.push({t:'back'});
  for(let i=0;i<30;i++)await tick();
  expect(state()).toEqual(['home','articles']);
 }
 // List -> home, with another burst arriving while its animation settles.
 events.push(...Array.from({length:8},()=>({t:'back'})));await tick();
 for(let i=0;i<8;i++)await tick();
 events.push(...Array.from({length:8},()=>({t:'back'})));
 for(let i=0;i<30;i++)await tick();
 expect(state()).toEqual(['home']);
 // At root the Android host handles BACK. Even already-queued guest events
 // cannot move or remove the last route.
 events.push(...Array.from({length:8},()=>({t:'back'})));
 for(let i=0;i<30;i++)await tick();
 expect(state()).toEqual(['home']);
 expect(visible()).toEqual([{offset:0,opacity:1}]);
 removeEventProbe();stop();expect(watch.watchResourceCounts().back).toBe(0);
});
