import WatchRSS from '../../src/ui/screen.tsx';
import {activityStateHub} from '../../src/navigation/activity-host.ts';
import {render} from '@pocketjs/framework';
import {rootMirror,setStyleResolver} from '@pocketjs/framework/renderer';
import {pressNode} from '@pocketjs/framework/input';
import {FEED_KEY,RECENT_KEY,QUEUE_KEY} from '../../src/douyin/feed-store.ts';
const g=globalThis as any,now=g.__benchNow,print=g.__benchPrint;
const nativeGet=g.pod.kvGet,nativeSet=g.pod.kvSet,nativeApply=g.pod.kvApply,nativeDelete=g.pod.kvDelete,nativeKeys=g.pod.kvKeys;
const values=new Map<string,string>(),events:any[]=[],pending=new Map<number,any>();
const writes:{phase:string;units:number}[]=[],counts:Record<string,number>={},spans:any[]=[];
let phase='home',tick=0,clock=0,nodeId=1,stop:()=>void;
Date.now=()=>1791378000000+clock;
// Deterministic lifecycle durations; CPU spans use native __benchNow separately.
g.performance={now:()=>clock};
function seed(key:string,value:any){const encoded=JSON.stringify(value);if(nativeSet){if(nativeSet(key,encoded)!==0)throw Error('scratch seed failed');}else values.set(key,encoded);}
const channels=[{id:'douyin',title:'抖音',url:'builtin:douyin',count:0,unread:0,useOriginalContent:g.__entryOriginal}];
const item=(i:number)=>({awemeId:String(i+1),description:'synthetic '+i,playUrl:'https://fixture.invalid/'+i,authorId:'',authorName:'',createdAtSeconds:0,likeCount:0,commentCount:0,shareCount:0,collectCount:0,durationMs:0,variants:[],opaque:'x'.repeat(4500)});
const snapshot=(count:number)=>({items:Array.from({length:count},(_,i)=>item(i)),anchorAwemeId:'1',cursor:null,hasMore:false,savedAtMillis:1,resolved:{}});
seed('synthetic.unrelated','x'.repeat(830000));seed('watchrss.home.channels.v1',channels);
seed('watchrss.douyin.original-content',g.__entryOriginal);
seed(FEED_KEY,JSON.stringify(snapshot(40)));seed(RECENT_KEY,JSON.stringify(snapshot(4)));seed(QUEUE_KEY,JSON.stringify(snapshot(40)));
function stagedApply(encoded:string){writes.push({phase,units:encoded.length});if(nativeApply)return nativeApply(encoded);const next=new Map(values);for(const row of JSON.parse(encoded)){if(row.op==='set')next.set(row.key,JSON.stringify(row.value));else next.delete(row.key);}values.clear();for(const [k,v]of next)values.set(k,v);return 0;}
Object.assign(g.pod,{
 capabilities:()=>JSON.stringify(['data.kv','data.secure','runtime.timer','host.lifecycle']),
 displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),
 kvGet:(k:string)=>nativeGet?nativeGet(k):values.get(k),
 kvSet:(k:string,v:string)=>{writes.push({phase,units:v.length});if(nativeSet)return nativeSet(k,v);values.set(k,v);return 0;},
 kvDelete:(k:string)=>nativeDelete?nativeDelete(k):values.delete(k)?0:1,kvKeys:()=>nativeKeys?nativeKeys():JSON.stringify([...values.keys()]),
 ...(nativeApply?{kvApply:stagedApply}:{}),
 takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
 emit:(line:string)=>{const r=JSON.parse(line);if(r.t==='diagnostic.serviceWork'){spans.push({phase,completion:g.__entryMethod??'frame',...r});return;}if(r.t==='service.cancel'){pending.delete(r.id);return;}if(r.t!=='service.request')return;
 const {id,method,args}=r;counts[method]=(counts[method]??0)+1;let value:any=null;
 if(method==='runtime.delay'){pending.set(id,{at:clock+args.milliseconds,method,id,ok:true,value});return;}
 if(method==='secure.get')value={exists:args.key==='douyin.cookie',...(args.key==='douyin.cookie'?{value:'sessionid='+ 'x'.repeat(4800)}:{})};
 else if(method==='text.environment')value={density:2,fontScale:1,spValuesPx:[]};
 else if(method.startsWith('file.')||method.startsWith('http.')||method.startsWith('sql.')){pending.set(id,{at:clock+1,method,id,ok:false,error:{code:'fixture',message:'Offline unavailable'}});return;}
 pending.set(id,{at:clock+1,method,id,ok:true,value});}
});
const props=new Map<number,Map<number,number>>();
const ops:any={__viewport:{w:233,h:233},__scrollConfiguration:{touchSlopPx:8,minimumFlingVelocityPx:50,maximumFlingVelocityPx:8000},createNode:()=>nodeId++,loadPakImage:()=>nodeId++,uploadTexture:()=>nodeId++,measureText:(text:string)=>text.length*8,wrapText:()=>[],getLayout:()=>({x:0,y:0,w:233,h:233}),getProp:(id:number,key:number)=>props.get(id)?.get(key)??0,setProp:(id:number,key:number,value:number)=>{let p=props.get(id);if(!p)props.set(id,p=new Map());p.set(key,value);}};
for(const name of ['destroyNode','insertBefore','removeChild','setStyle','setText','replaceText','setImage','setSprite','setFocus','animate','setAccessibility','setNavigationState','freeTexture'])ops[name]=()=>{};
const services:any=new Proxy({listChannels:async()=>channels,listArticles:async()=>[],getChannelOriginalMode:async()=>g.__entryOriginal,getChannelPlaybackSettings:async()=>({hasPlayableMedia:false,continuePlaybackInBackground:false}),subscribeChannel:()=>()=>{},subscribeAccountStatus:()=>()=>{},readAccountStatus:async()=>null,createSummary:()=>({dispose(){},state:{state:'idle'},start:async()=>{},cancel(){}})}, {get:(t,k)=>Reflect.get(t,k)??(k==='inputRecovery'||k==='retryOfflineMedia'||k==='readSummaryUsage'||k==='subscribeSummaryUsage'||k==='loadImportedTextChunk'?undefined:()=>Promise.resolve(null))});
activityStateHub.seed({saved:{},retained:{}});
if(g.__entryTracing)events.push({t:'diagnostic.serviceTrace',enabled:true});
stop=render(()=>{setStyleResolver(c=>g.__entryStyles.ids[c]??0);return <WatchRSS services={services}/>;},{ops});
function nodes(){const result:any[]=[];const walk=(n:any)=>{result.push(n);n.children.forEach(walk);};walk(rootMirror);return result;}
function assert(value:unknown,message:string){if(!value)throw Error(message);}
function pages(){const state:any=activityStateHub.read().saved['watchrss.content-activity'];return state?.entries.map((v:any)=>v.page);}
g.__benchPump=()=>{
 clock+=17;tick++;for(const [id,r]of pending)if(r.at<=clock){pending.delete(id);g.__entryMethod=r.method;events.push({t:'service.result',id:r.id,ok:r.ok,value:r.value,error:r.error});}
 g.__pocketPumpServices();g.frame(0);
 if(tick===30){phase='entry';let card=nodes().find(n=>n.text==='抖音');while(card&&!card.onPress)card=card.parent;assert(card,'Douyin home card missing');const began=now();pressNode(card);print(JSON.stringify({phase:'entry.press',ms:now()-began}));}
 if(tick===150){assert(JSON.stringify(pages())===JSON.stringify(['home','douyin']),'entry route missing');phase='back';events.push({t:'back'});}
 if(tick===230){assert(JSON.stringify(pages())===JSON.stringify(['home']),'BACK restoration differs');
 const get=(key:string)=>JSON.parse(nativeGet?nativeGet(key):values.get(key)!);
 const resume=get('watchrss.resume-state.v1');assert(resume.kind==='home'&&resume.version===1,'durable resume changed');
 const days=JSON.parse(get('watchrss.sync.account-telemetry.v1'));
 assert(days.reduce((n:number,d:any)=>n+(d.screenOpenCounts.DouyinEntryActivity??0),0)===1,'entry telemetry changed');
 assert(g.__entryTracing||spans.length===0,'default-off tracing emitted');
 print(JSON.stringify({phase:'entry.summary',original:g.__entryOriginal,tracing:g.__entryTracing,durable:{resume,telemetry:days,activity:activityStateHub.read()},counts,writes,profile:g.__entryProfile.stats,spans,assertions:4}));stop();g.__benchDone=true;return false;}
 return true;
};
