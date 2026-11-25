import {plugin} from 'bun';
import {bindPocketModules,bindPocketServicePump} from '@podjs/framework/testing/bun-runtime';
import {mock} from 'bun:test';
import * as solidRuntime from 'solid-js';
for(const base of [Bun.resolveSync('@podjs/framework/watch',import.meta.dir),Bun.resolveSync('@pocketjs/framework',import.meta.dir)])mock.module(Bun.resolveSync('solid-js',base),()=>solidRuntime);
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'rapid-back-solid',setup(b){b.onLoad({filter:/\.tsx$/},async a=>({contents:transformSync(await Bun.file(a.path).text(),{filename:a.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
const mode=process.env.RAPID_BACK_CASE??'4';
const restoredNoteCase=['bluetooth-note-restore','bluetooth-note-body','bluetooth-note-empty','bluetooth-note-leave'].includes(mode);
const noteDownload=mode==='bluetooth-note-download';
const noteListLoad=mode==='bluetooth-note-load';
const noteAction=mode.startsWith('bluetooth-note-action-');
const rssAction=mode.startsWith('bluetooth-rss-action-');
const rssProbe=mode.startsWith('bluetooth-feed-');
const rssFromReader=mode==='bluetooth-feed-reload';
const videoCase=mode==='bluetooth-video-pan';
const shareSystem=mode==='bluetooth-rss-action-system';
const searchRestore=mode==='bluetooth-search-restore';
const safeRoute=mode.startsWith('bluetooth-safe-') ? mode.slice('bluetooth-safe-'.length) : undefined;
let releaseOperation: (()=>void)|undefined;
let releaseShare: (()=>void)|undefined;
let releaseRecovery: ((pending:boolean)=>void)|undefined;
let releaseFeed: (()=>void)|undefined;
let releaseNotes: (()=>void)|undefined;
const recoveryDismissals:string[]=[];
const deferOperation=()=>new Promise<void>(resolve=>{releaseOperation=resolve;});
const noteCase=mode==='bluetooth-modal'||mode==='bluetooth-note-close'||restoredNoteCase;
const noteActionsCase=mode==='note-actions';
const rssSaveCase=mode==='bluetooth-rss-save';
const searchCase=mode==='bluetooth-inline'||mode==='bluetooth-search-modal'||searchRestore;
let resolveModal!:(value:string)=>void,resolveInlineClose!:()=>void;
let resolveFavorite:(()=>void)|undefined;
let resolveTitlePending:((pending:boolean)=>void)|undefined;
let titleRecoveryKey:string|undefined;
let openedModalKey:string|undefined;
const modalCalls:string[]=[];
let inlineCloses=0,inlineOpens=0,inlineSession=0;
let searchedFor:string|undefined;
let savedDraft:{title:string;markdown:string}|undefined;
let bluetooth=false;const networkSubscriptions=new Set<number>();
let videoState='stopped';
let releaseVideoStop:(()=>void)|undefined;
const transforms:{scaleMode?:string;panY?:number}[]=[];
let clockMs=0,next=1;Date.now=()=>clockMs;
const kv=new Map<string,string>();
const events:any[]=[],timers=new Map<number,number>();
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
(globalThis as any).pod={capabilities:()=>JSON.stringify(['data.kv','runtime.timer','text.layout','net.discovery','input.text','system.share',...(videoCase?['media.video']:[])]),displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),kvGet:(k:string)=>kv.get(k),kvSet:(k:string,v:string)=>{kv.set(k,v);return 0;},kvDelete:(k:string)=>{kv.delete(k);return 0;},kvKeys:()=>JSON.stringify([...kv.keys()]),takeEvents:()=>JSON.stringify(events.splice(0)),emit:(line:string)=>{const r=JSON.parse(line);if(r.t!=='service.request')return;let value:any=null;const {method,id,args}=r;
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
 else if(method==='share.environment')value={sdkInt:33,wearOs:false};
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
 else if(method==='discovery.networkSnapshot')value={active:true,internet:true,validated:true,wifi:!bluetooth,cellular:false,bluetooth};
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
const article={id:'fixture',channelId:'feed',channelTitle:'Test feed',title:'Article',link:'https://example.invalid/article',contentBlocks:videoCase?[{type:'video' as const,url:'https://example.invalid/video.mp4'}]:undefined,content:Array.from({length:30},()=>'<p>Reader regression body line.</p>').join(''),read:true};
let pendingSave:(()=>void)|undefined;const services:any=new Proxy({listChannels:async()=>[{id:'feed',title:'Test feed',url:'https://watchrss.local/import-content'}],listArticles:async()=>[article],getArticle:async()=>article,getChannelOriginalMode:async()=>false,getChannelPlaybackSettings:async()=>({hasPlayableMedia:false,continuePlaybackInBackground:false}),subscribeChannel:()=>()=>{},subscribeAccountStatus:()=>()=>{},readingProgress:{load:async()=>({offset:0,progress:0,updatedAt:0}),save:async()=>{saveCalls++;await new Promise<void>(r=>{pendingSave=r;});}},readAccountStatus:async()=>null,createSummary:()=>({dispose(){},state:{state:'idle'},start:async()=>{},cancel(){}})}, {get:(t,k)=>Reflect.get(t,k)??(k==='inputRecovery'||k==='openInlineInput'||k==='retryOfflineMedia'||k==='readSummaryUsage'||k==='subscribeSummaryUsage'||k==='loadImportedTextChunk'?undefined:()=>Promise.resolve(null))});
if(noteCase||noteActionsCase||noteAction||noteDownload||noteListLoad||safeRoute==='notes'){
 const {memoRepository}=await import('../src/services.ts');
 memoRepository.initialize=async()=>{};
 memoRepository.list=async()=>{
  if(noteListLoad)await new Promise<void>(resolve=>{releaseNotes=resolve;});
  return [existingNote];
 };
 memoRepository.listFolders=async()=>[{folderId:'folder',name:'示例目录',sortOrder:1,updatedAt:1,modifiedBy:'fixture',deleted:false,deletedAt:0}];
 const writeNote=async()=>{await deferOperation();return existingNote;};
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
  savedDraft={title:draft.title??'',markdown:draft.markdown};
  return {...existingNote,...savedDraft,plainText:draft.markdown};
 };
 services.input=(title:string,_value:string,options?:{restorationKey?:string})=>{
  modalCalls.push(title);
  openedModalKey=options?.restorationKey;
  return new Promise<string>(resolve=>{resolveModal=resolve;});
 };
 services.inputRecovery={pending:async()=>false,dismiss:async()=>{}};
 if(restoredNoteCase)services.inputRecovery.pending=(key:string)=>{
  if(!key.endsWith(mode==='bluetooth-note-body'?':note:body':':note:title'))return Promise.resolve(false);
  if(titleRecoveryKey)return Promise.resolve(true);
  titleRecoveryKey=key;
  return new Promise<boolean>(resolve=>{resolveTitlePending=resolve;});
 };
}
if(rssSaveCase)services.setSaveState=()=>new Promise<void>(resolve=>{resolveFavorite=resolve;});
if(searchCase){
 const {textInput}=await import('@podjs/framework/services');
 services.openInlineInput=mode==='bluetooth-inline'?textInput.openInline:undefined;
 services.input=(title:string)=>{modalCalls.push(title);return new Promise<string>(resolve=>{resolveModal=resolve;});};
 if(searchRestore)services.inputRecovery={
  pending:(key:string)=>key.endsWith(':rss-search')?new Promise<boolean>(resolve=>{releaseRecovery=resolve;}):Promise.resolve(false),
  dismiss:async(key:string)=>{recoveryDismissals.push(key);},
 };
 services.searchArticles=async(_channelId:string,keyword:string)=>{searchedFor=keyword;return [];};
}
if(rssAction){
 services.setSaveState=deferOperation;
 services.markRead=deferOperation;
 services.deleteArticle=deferOperation;
}
if(mode==='bluetooth-feed-open')services.markRead=deferOperation;
if(mode==='bluetooth-feed-actions')services.getArticle=async()=>{await deferOperation();return article;};
if(rssFromReader)services.listArticles=async()=>{
 await new Promise<void>(resolve=>{releaseFeed=resolve;});
 return [article];
};
if(shareSystem)new (await import('../src/settings/store.ts')).SettingsStore().update({shareUseSystem:true});
activityStateHub.seed(captureActivityNavigation({saved:{},retained:{}},noteCase
 ?[{page:'home'},{page:'notes'},{page:'note-detail',noteId:restoredNoteCase?'fixture-note':undefined}]
 :noteActionsCase||noteAction?[{page:'home'},{page:'notes'},{page:'note-actions',noteId:'fixture-note'}]
 :rssSaveCase||rssAction?[{page:'home'},{page:'articles',channelId:'feed'},{page:'rss-actions',articleId:article.id}]
 :searchCase?[{page:'home'},{page:'search',channelId:'feed'}]
 :noteDownload||noteListLoad||safeRoute==='notes'?[{page:'home'},{page:'notes'}]
 :safeRoute==='settings'?[{page:'home'},{page:'settings'}]
 :safeRoute==='home'||mode==='bluetooth-home-disclosure'?[{page:'home'}]
 :mode.startsWith('bluetooth')&&!rssFromReader&&!videoCase
   ?[{page:'home'},{page:'articles',channelId:'feed'}]
 :[{page:'home'},{page:'articles',channelId:'feed'},{page:'reader',readerArticle:article}]));
const WatchRSS=(await import('../src/ui/screen.tsx')).default;
const stop=render(()=>{setStyleResolver(()=>0);return WatchRSS({services});},{ops});
const frame=(globalThis as any).frame;const watch=await import('@podjs/framework/watch');
const {__packTouch}=await import('../node_modules/@pocketjs/framework/framework/src/touch.ts');
async function tick(dt=17,touches:number[]=[],hits?:number[]){clockMs+=dt;for(const [id,at]of timers)if(at<=clockMs){timers.delete(id);events.push({t:'service.result',id,ok:true,value:null});}frame(0,undefined,touches,hits);for(let n=0;n<25;n++)await Promise.resolve();}

const connected=()=>{const nodes:any[]=[];const walk=(n:any)=>{nodes.push(n);n.children.forEach(walk);};walk(rootMirror);return nodes;};
const state=()=>{const data:any=activityStateHub.read().saved['watchrss.content-activity'];return data?.entries?.map((e:any)=>e.page) as string[];};
const visible=()=>connected().filter(n=>props.get(n.id)?.has(128)).map(n=>({offset:props.get(n.id)!.get(128)!,opacity:props.get(n.id)!.get(69)??1}));
const {expect,test}=await import('bun:test');
const removeEventProbe=watch.__onHostEvent(event=>{if(event.t==='back')backEventsDelivered++;});
if(mode.startsWith('bluetooth')||noteActionsCase)test(`production route: ${mode}`,async()=>{
 const pump=async(count=80)=>{for(let i=0;i<count;i++)await tick();};
 const network=async(value:boolean,frames=80)=>{
  bluetooth=value;
  for(const subscriptionId of networkSubscriptions)events.push({t:'network.changed',subscriptionId,value:{source:'default',reason:'capabilities'}});
  await pump(frames);
 };
 const warnings=()=>connected().filter(node=>node.domAttrs?.accessibilityLabel==='继续');
 const warning=()=>warnings()[0];
 const press=(label:string)=>{
  let node=connected().find(node=>node.domAttrs?.accessibilityLabel===label&&node.onPress)
    ?? connected().find(node=>texts.get(node.id)===label);
  while(node&&!node.onPress)node=node.parent;
  expect(node?.onPress,label).toBeDefined();
  node.onPress();
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

  if(mode==='bluetooth-home-disclosure'){
   await network(true);
   expect(warning()).toBeUndefined();
   events.push({t:'axis',axis:0,delta:12000});
   await pump();
   press('我已了解');
   await assertOnce('home');
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
    await network(true,50);
    expect(warning()).toBeUndefined();
   }
   await assertOnce(safeRoute);
   return;
  }
  if(noteListLoad){
   expect(releaseNotes).toBeDefined();
   await network(true);
   expect(warning()).toBeUndefined();
   releaseNotes!();
   await assertOnce('notes');
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
   const operation=mode.split('-').at(-1);
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
   if(operation==='leave')await back();
   await network(true);
   expect(warning()).toBeUndefined();
   if(operation==='cancel')await network(false);
   releaseOperation!();
   await pump();
   if(operation==='cancel'){
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
   expect(warning()).toBeUndefined();
   releaseVideoStop!();
   await assertOnce('articles');
   return;
  }
  if(rssProbe){
   if(rssFromReader){
    await back();
    expect(releaseFeed).toBeDefined();
    await network(true);
    expect(warning()).toBeUndefined();
    releaseFeed!();
    await pump(10);
    expect(displayed('Article')).toBe(true);
   }else{
    if(mode==='bluetooth-feed-actions'){
     const title=connected().find(node=>texts.get(node.id)==='Article');
     expect(title).toBeDefined();
     for(let i=0;i<60;i++)await tick(17,[__packTouch(1,116,130)],[title!.id]);
     await tick();
    }else press('Article');
    await pump();
    expect(releaseOperation).toBeDefined();
    await network(true);
    expect(warning()).toBeUndefined();
    releaseOperation!();
    await pump();
    if(mode==='bluetooth-feed-actions')expect(displayed('标为未读')).toBe(true);
    else expect(state().at(-1)).toBe('reader');
    expect(warning()).toBeUndefined();
    await back();
   }
   await assertOnce('articles');
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
    resolveModal('Typed title');
    await pump();
    expect(modalCalls).toEqual(['备忘录标题','备忘录正文']);
    expect(warning()).toBeUndefined();
    resolveModal('Typed body');
    await pump();
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
   if(mode==='bluetooth-modal')expect(savedDraft).toEqual({title:'Typed title',markdown:'Typed body'});
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
 }finally{removeEventProbe();stop();}
});
else test(`production WatchRSS routes and BackMotion survive ${mode}`,async()=>{
 for(let i=0;i<50;i++)await tick();
 expect(state()).toEqual(['home','articles','reader']);
 // Move the real reader so final progress is dirty before the BACK burst.
 events.push({t:'axis',axis:0,delta:12000});
 for(let i=0;i<12;i++)await tick();
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
 if(mode!=='timeout')pendingSave!();
 for(let i=0;i<180;i++)await tick();
 expect(state()).toEqual(['home','articles']);
 expect(visible().some(v=>v.opacity===1&&v.offset===0)).toBe(true);
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
