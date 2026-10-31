import {performance} from "node:perf_hooks";
import {createHash} from "node:crypto";

const arg=(name:string,fallback:string)=>process.argv.find(v=>v.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
type Sample={totalMs:number;phases:Record<string,number>;counts:Record<string,number>;offset:number};
let current:Sample|undefined;
const profile={
 time<T>(name:string,fn:()=>T):T {if(!current)return fn();profile.count(`phase.${name}`);const began=performance.now();try{return fn();}finally{current.phases[name]=(current.phases[name]??0)+performance.now()-began;}},
 count(name:string){if(current)current.counts[name]=(current.counts[name]??0)+1;},
};
(globalThis as any).__readerProfile=profile;
(globalThis as any).__simHz=60;
let clockMs=0;
const realDateNow=Date.now;Date.now=()=>clockMs;
let nextNode=1,nextTexture=1;
const textures=new Set<number>(),textTextures=new Set<number>();let peakTextures=0,peakTextTextures=0;
const allocateTexture=(text=false)=>{const handle=nextTexture++;textures.add(handle);if(text)textTextures.add(handle);peakTextures=Math.max(peakTextures,textures.size);peakTextTextures=Math.max(peakTextTextures,textTextures.size);return handle;};
const ops:any={__viewport:{w:233,h:233},__scrollConfiguration:{touchSlopPx:8,minimumFlingVelocityPx:50,maximumFlingVelocityPx:8000}};
for(const name of ["destroyNode","insertBefore","removeChild","setStyle","setProp","setText","replaceText","setImage","setSprite","setFocus","animate","setAccessibility","setNavigationState"]){ops[name]=()=>{profile.count(`host.${name}`);};}
ops.createNode=()=>{profile.count("host.createNode");return nextNode++;};
ops.uploadTexture=()=>{profile.count("host.uploadTexture");return allocateTexture();};
ops.freeTexture=(handle:number)=>{profile.count("host.freeTexture");textTextures.delete(handle);if(!textures.delete(handle))throw new Error(`Unknown/double texture release ${handle}`);};
const width=(text:string)=>Array.from(text).reduce((n,c)=>n+(c.charCodeAt(0)>255?14:7),0);
ops.measureText=(text:string)=>profile.time("measureText",()=>{profile.count("host.measureText");return width(text);});
ops.wrapText=(text:string,_slot:number,max:number)=>profile.time("wrapText",()=>{profile.count("host.wrapText");const breaks:number[]=[];let row="",offset=0;for(const c of text){if(row&&width(row+c)>max){breaks.push(offset);row=c;}else row+=c;offset+=c.length;}return breaks;});
ops.getLayout=()=>({x:0,y:40,w:233,h:193});
ops.getProp=()=>0;
const kv=new Map<string,string>(),events:any[]=[],serviceCounts:Record<string,number>={};
const mediaDimensions=new Map<string,{width:number;height:number}>();
const caps=["text.raster","data.files.chunks","data.kv","runtime.timer","data.images"];
const metrics={logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:1.75,shape:"round",safeInsets:{top:0,right:0,bottom:0,left:0}};
(globalThis as any).pod={
 capabilities:()=>JSON.stringify(caps),displayMetrics:()=>JSON.stringify(metrics),fontMetrics:()=>JSON.stringify({cellHeight:26,baseline:20}),
 kvGet:(key:string)=>kv.get(key),kvSet:(key:string,value:string)=>{kv.set(key,value);return 0;},kvDelete:(key:string)=>{kv.delete(key);return 0;},kvKeys:()=>JSON.stringify([...kv.keys()]),
 uploadTextureFile:(path:string)=>{profile.count("host.uploadTextureFile");return allocateTexture(path.startsWith("text/"));},
 takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
 emit:(line:string)=>{
  const request=JSON.parse(line);if(request.t!=="service.request")return;
  const {id,method,args}=request;profile.count(`service.${method}`);serviceCounts[method]=(serviceCounts[method]??0)+1;
  let value:any;
  if(method==="text.raster")value={path:`text/line-${id}.rgba`,width:512,height:64,carets:Array.from({length:args.text.length+1},(_,i)=>i*14)};
  else if(method==="text.environment")value={density:1.75,fontScale:1,spValuesPx:[]};
  else if(method==="image.decode"){const source=mediaDimensions.get(args.path)??{width:512,height:256};value={path:`images/decoded-${id}.rgba`,width:256,height:128,sourceWidth:source.width,sourceHeight:source.height};}
  else if(method==="file.delete")value={deleted:true};
  else if(method==="file.stat")value={file:true,size:512};
  else if(method==="file.mkdir")value={created:true};
  else if(method==="runtime.delay")value=null;
  else {events.push({t:"service.result",id,ok:false,error:{code:"mock-unavailable",message:"Unsupported fixture service"}});return;}
  events.push({t:"service.result",id,ok:true,value});
 },
};
// Dynamic imports ensure global host/profiler state exists before SDK initialization.
const {render}=await import("@pocketjs/framework");
const {setStyleResolver}=await import("@pocketjs/framework/renderer");
const {ReaderBody}=await import("../../src/ui/ReaderBody.tsx");
const {systemTextResourceCounts}=await import("@podjs/framework/text");
const {parseContent}=await import("../../src/reader/content.ts");
const {createContentLayouter}=await import("../../src/reader/content-layout.ts");
const {defaultReaderPreset}=await import("../../src/reader/preset.ts");
const html=await Bun.file(arg("html","/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/k9-profile/article.html")).text();
const blocks=parseContent(html),preset=defaultReaderPreset();
const dimensionFile=arg("dimensions","");
const sourceDimensions:Record<string,{width:number;height:number}>=dimensionFile?await Bun.file(dimensionFile).json():{};
const offlineMedia=Object.fromEntries(blocks.filter(b=>b.type==="image"||b.type==="video").map((b,i)=>{const path=`fixture/source-${i}`;mediaDimensions.set(path,sourceDimensions[b.url]??{width:b.type==="image"?b.width??512:512,height:b.type==="image"?b.height??256:256});return [b.url,path];}));
const layout=createContentLayouter(ops.measureText,ops.wrapText,()=>({cellHeight:26,baseline:20}))(blocks,205,16,{},preset,new Map());
let handle:any;
const errors:string[]=[];
const stop=render(()=>{
 setStyleResolver(()=>0); // No native style/layout engine; source component props remain real.
 return ReaderBody({articleId:"1",text:blocks.filter(b=>b.type==="text").map(b=>b.text).join("\n"),blocks,width:233,height:193,fontSize:16,lineHeight:24,preset,offlineMedia,active:true,autoStart:false,speed:1,
  progressStore:{load:async()=>({offset:0,progress:0,updatedAt:0}),save:async()=>{}},onMedia(){},onControls(){},onError:message=>errors.push(message),ref:value=>{handle=value;}});
},{ops});
const microtasks=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
const frame=(globalThis as any).frame;
if(typeof frame!=="function")throw new Error("PocketJS frame handler missing");
for(let i=0;i<2000&&!handle.ready();i++){clockMs=i*1000/60;frame(0,undefined);await microtasks();}
const timing=await Bun.file(arg("timing","/home/wilf/data/OPPO_Develop/PodJS_WatchRSS/.codex-tmp/device/t04-scroll-timing.json")).json();
if(!handle.ready())throw new Error("Reader benchmark started before complete geometry / restore");
const samples:Sample[]=[];const repeats=Number(arg("repeats","5"));
let peakTextCached=0;
for(let round=0;round<repeats;round++){
 handle.scroller.scrollTo(Number(arg("start",String(Math.max(0,layout.height-2200)))),{immediate:true});
 for(let warm=0;warm<60;warm++){clockMs+=1000/60;frame(0,undefined);await microtasks();}
 let gesture=-1,dragging=false;
 for(let tick=0;tick<Math.ceil(timing.elapsedSeconds*60);tick++){
  const elapsed=tick/60;clockMs+=1000/60;
  const sample:Sample={totalMs:0,phases:{},counts:{},offset:0};current=sample;const began=performance.now();
  const next=timing.gestures.findIndex((g:any)=>elapsed>=g.startSeconds&&elapsed<g.startSeconds+.25);
  if(next!==gesture){if(dragging){handle.scroller.endDrag(timing.gestures[gesture].direction==="up"?500:-500);dragging=false;}gesture=next;if(next>=0){handle.scroller.beginDrag();dragging=true;}}
  if(dragging)handle.scroller.drag(timing.gestures[gesture].direction==="up"?500/60:-500/60);
  frame(0,undefined);await microtasks();sample.totalMs=performance.now()-began;sample.offset=handle.scroller.offset();current=undefined;samples.push(sample);
  peakTextCached=Math.max(peakTextCached,systemTextResourceCounts().cached);
 }
}
// Optional untimed long traversal exercises history eviction and async cleanup.
let sweepPeakTextCached=0;
if(arg("verify-sweep","0")==="1"){
 const positions=Array.from({length:100},(_,i)=>layout.height*i/99);
 for(const offset of [...positions,...positions.toReversed()]){
  handle.scroller.scrollTo(offset,{immediate:true});
  for(let warm=0;warm<4;warm++){clockMs+=1000/60;frame(0,undefined);await microtasks();}
  sweepPeakTextCached=Math.max(sweepPeakTextCached,systemTextResourceCounts().cached);
 }
}
stop();await microtasks();
const released=systemTextResourceCounts();
const afterStop:Sample={totalMs:0,phases:{},counts:{},offset:0};current=afterStop;clockMs+=1000/60;frame(0,undefined);await microtasks();current=undefined;Date.now=realDateNow;
if(released.active||released.queued||released.cached||textTextures.size)throw new Error(`Reader cleanup leaked text resources: ${JSON.stringify({released,textTextures:textTextures.size})}`);
if(afterStop.counts.onFrameCallbacks)throw new Error("Reader cleanup leaked frame callbacks");
if(errors.length)throw new Error(`Reader fixture errors: ${errors.join("; ")}`);
const dist=(values:number[])=>{values.sort((a,b)=>a-b);return {p50:values[Math.floor(values.length*.5)],p95:values[Math.ceil(values.length*.95)-1],max:values.at(-1),sum:values.reduce((a,b)=>a+b,0)};};
const phases=[...new Set(samples.flatMap(s=>Object.keys(s.phases)))],counts=[...new Set(samples.flatMap(s=>Object.keys(s.counts)))];
const result={host:"Linux Bun mock HostOps; actual Solid/PocketJS/ReaderBody/SystemTextLine; no native layout/raster/GPU timing",htmlSha256:createHash("sha256").update(html).digest("hex"),blocks:blocks.length,textBlocks:blocks.filter(b=>b.type==="text").length,mediaBlocks:blocks.filter(b=>b.type!=="text").length,rows:layout.rows.length,layoutHeight:layout.height,repeats,frames:samples.length,
 resources:{peakTextCached,sweepPeakTextCached,peakTextTextures,peakTextures,textTexturesAfterStop:textTextures.size,mediaCacheTexturesAfterStop:textures.size,textAfterStop:released,callbacksAfterStop:afterStop.counts.onFrameCallbacks??0},
 total:dist(samples.map(s=>s.totalMs)),phases:Object.fromEntries(phases.map(k=>[k,dist(samples.map(s=>s.phases[k]??0))])),counts:Object.fromEntries(counts.map(k=>[k,samples.reduce((n,s)=>n+(s.counts[k]??0),0)])),serviceCounts,errors,samples};
await Bun.write(arg("out","/tmp/reader-scroll.json"),JSON.stringify(result,null,2)+"\n");
console.log(JSON.stringify({...result,samples:undefined},null,2));
