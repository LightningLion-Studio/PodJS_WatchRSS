import {createHash} from "node:crypto";

// Actual renderer/ReaderBody/adapter with deterministic service and HostOps ports.
(globalThis as any).__simHz=60;
let clockMs=0;
Date.now=()=>clockMs;
let nextNode=1,nextTexture=1;
const textures=new Set<number>(),textTextures=new Set<number>();
const allocateTexture=(text=false)=>{const handle=nextTexture++;textures.add(handle);if(text)textTextures.add(handle);return handle;};
const ops:any={__viewport:{w:233,h:233},__scrollConfiguration:{touchSlopPx:8,minimumFlingVelocityPx:50,maximumFlingVelocityPx:8000}};
for(const name of ["destroyNode","insertBefore","removeChild","setStyle","setProp","setText","replaceText","setImage","setSprite","setFocus","animate","setAccessibility","setNavigationState"]){ops[name]=()=>{};}
ops.createNode=()=>{return nextNode++;};
ops.uploadTexture=()=>{return allocateTexture();};
ops.freeTexture=(handle:number)=>{textTextures.delete(handle);if(!textures.delete(handle))throw new Error(`Unknown/double texture release ${handle}`);};
const width=(text:string)=>Array.from(text).reduce((n,c)=>n+(c.charCodeAt(0)>255?14:7),0);
ops.measureText=(text:string)=>width(text);
ops.wrapText=(text:string,_slot:number,max:number)=>{const breaks:number[]=[];let row="",offset=0;for(const c of text){if(row&&width(row+c)>max){breaks.push(offset);row=c;}else row+=c;offset+=c.length;}return breaks;};
ops.getLayout=()=>({x:0,y:40,w:233,h:193});
ops.getProp=()=>0;
const kv=new Map<string,string>(),events:any[]=[],serviceCounts:Record<string,number>={};
const {PROP}=await import("@test/spec");
const propNames=Object.fromEntries(Object.entries(PROP).map(([key,value])=>[value,key]));
const bindings=new Map<number,number>(), styles=new Map<number,any>(), deleted:string[]=[];
ops.setProp=(id:number,key:number,value:number)=>styles.set(id,{...styles.get(id),[propNames[key]]:value});
ops.setImage=(id:number,texture:number)=>{bindings.set(id,texture);};

const stored=new Map<string,number>(),awakeOwners=new Set<string>();
const caps=[...(process.env.NATIVE_LAYOUT==='0'?[]:["text.layout"]),"crypto.basic","net.download","text.raster","data.files.chunks","data.kv","runtime.timer","data.images","display.power"];
const metrics={logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:1.75,shape:"round",safeInsets:{top:0,right:0,bottom:0,left:0}};
(globalThis as any).pod={
 capabilities:()=>JSON.stringify(caps),displayMetrics:()=>JSON.stringify(metrics),fontMetrics:()=>JSON.stringify({cellHeight:26,baseline:20}),
 kvGet:(key:string)=>kv.get(key),kvSet:(key:string,value:string)=>{kv.set(key,value);return 0;},kvDelete:(key:string)=>{kv.delete(key);return 0;},kvKeys:()=>JSON.stringify([...kv.keys()]),
 uploadTextureFile:(path:string)=>{return allocateTexture(path.startsWith("text/"));},
 takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
 emit:(line:string)=>{
  const request=JSON.parse(line);if(request.t!=="service.request")return;
  const {id,method,args}=request;serviceCounts[method]=(serviceCounts[method]??0)+1;
  let value:any;
  if(method==="display.keepAwake"){if(args.active)awakeOwners.add(args.owner);else awakeOwners.delete(args.owner);value={interactive:true,resumed:true,applied:awakeOwners.size>0,windowKeepScreenOn:awakeOwners.size>0,owners:[...awakeOwners]};}
  else if(method==="text.raster")value={path:`text/line-${id}.rgba`,width:512,height:64,carets:Array.from({length:args.text.length+1},(_,i)=>i*14)};
  else if(method==="text.environment")value={density:1.75,fontScale:1,spValuesPx:[]};
  else if(method==="image.decode"){value={path:`images/decoded-${id}.rgba`,width:256,height:128,sourceWidth:100,sourceHeight:400};}
  else if(method==="file.delete"){deleted.push(args.path);stored.delete(args.path);value={deleted:true};}
  else if(method==="file.stat")value={file:stored.has(args.path)||args.path.startsWith('fixture/'),size:stored.get(args.path)??0};
  else if(method==="file.list")value={entries:[...stored].filter(([p])=>p.startsWith(args.path+'/')).map(([path,size])=>({path,size,file:true,modified:1}))};
  else if(method==="file.touch")value={modified:1};
  else if(method==="http.download"){stored.set(args.path,512);value={path:args.path};}
  else if(method==="crypto.hash")value={digestBase64:createHash('sha256').update(Buffer.from(args.dataBase64,'base64')).digest('base64')};
  else if(method==="file.mkdir")value={created:true};
  else if(method==="runtime.delay")value=null;
 else if(method==="text.layout"){const lines=[];for(let start=0;start<args.text.length;start+=12){const end=Math.min(start+12,args.text.length);lines.push({start,end,visibleEnd:end});}value={lines:lines.length?lines:[{start:0,end:0,visibleEnd:0}]};}
  else {events.push({t:"service.result",id,ok:false,error:{code:"mock-unavailable",message:"Unsupported fixture service"}});return;}
  events.push({t:"service.result",id,ok:true,value});
 },
};
// Dynamic imports ensure global host state exists before SDK initialization.
const {render}=await import("@pocketjs/framework");
const {setStyleResolver}=await import("@pocketjs/framework/renderer");
const {installAppLogger}=await import('../../src/logs/app-logger.ts');installAppLogger({i:console.log,w:console.log,d:console.log,e:console.log} as any);
const {ReaderBody}=await import("../../src/ui/ReaderBody.tsx");
const {parseContent}=await import("../../src/reader/content.ts");
const blocks=parseContent('<img src="https://example.com/body.png"><p>'+('测试正文'.repeat(400))+'</p>');
const offlineMedia=process.env.LOCAL==='1'?{'https://example.com/body.png':'fixture/source-0'}:undefined;
const {createSignal}=await import("solid-js");
const [readerActive,setReaderActive]=createSignal(true),[keepAwake,setKeepAwake]=createSignal(false);
let handle:any;const errors:string[]=[];
const stop=render(()=>{setStyleResolver(()=>0);return ReaderBody({articleId:"image-repro",text:"测试正文",blocks,width:233,height:193,fontSize:16,lineHeight:24,offlineMedia,get active(){return readerActive();},get keepAwake(){return keepAwake();},autoStart:false,speed:1,
progressStore:{load:async()=>({offset:0,progress:0,updatedAt:0}),save:async()=>{}},onMedia(){},onControls(){},onError:e=>errors.push(e),ref:v=>handle=v});},{ops});
const frame=(globalThis as any).frame;
for(let i=0;i<500;i++){clockMs=i*17;frame(0,undefined);for(let n=0;n<12;n++)await Promise.resolve();}
const {releaseRetainedRemoteImages,remoteImageResourceCounts}=await import("../../src/ui/RemoteImage.tsx");
const assert=(ok:unknown,message:string)=>{if(!ok)throw new Error(message);};
const live=()=>[...bindings].filter(([,texture])=>texture>0&&textures.has(texture));
assert(live().length>0,"inline contain image has no texture after intrinsic-size relayout");
const first=live()[0],rect=styles.get(first[0]);
assert(Math.abs(rect?.width-205)<1e-6&&Math.abs(rect?.height-820)<1e-6,"contain did not adopt 100x400 intrinsic source dimensions: "+JSON.stringify(rect));
const decodes=serviceCounts['image.decode'];
handle.scroller.scrollTo(2500,{immediate:true});
for(let i=0;i<100;i++){clockMs+=17;frame(0,undefined);for(let n=0;n<12;n++)await Promise.resolve();}
assert(remoteImageResourceCounts().cached>0,"scroll-out lost retained media");
handle.scroller.scrollTo(0,{immediate:true});
for(let i=0;i<100;i++){clockMs+=17;frame(0,undefined);for(let n=0;n<12;n++)await Promise.resolve();}
assert(live().some(([,texture])=>texture===first[1]),"scroll-back failed to reuse retained texture");
assert(serviceCounts['image.decode']===decodes,"scroll-back decoded a retained image again");
assert((serviceCounts['http.download']??0)===(offlineMedia?0:1),"local source downloaded or remote source bypassed inline cache");
assert(offlineMedia||[...stored.keys()].some(path=>path.endsWith('.inline.img')),"remote body source did not use inline bucket");
assert(!deleted.includes('fixture/source-0'),"loader deleted caller-owned offline image");
assert(errors.length===0,"reader reported errors: "+errors.join(';'));
// Exercise the actual ReaderBody Solid effects, frame/controller and host lifecycle wiring.
const pump=async()=>{for(let i=0;i<5;i++){clockMs+=17;frame(0,undefined);for(let n=0;n<12;n++)await Promise.resolve();}};
setKeepAwake(true);await pump();assert(awakeOwners.size===0,"paused reader acquired display lease");
handle.setPlaying(true);await pump();assert(awakeOwners.size===1,"running reader did not acquire display lease");
handle.pause();await pump();assert(awakeOwners.size===0,"pause leaked display lease");
handle.setPlaying(true);await pump();setReaderActive(false);await pump();assert(awakeOwners.size===0,"inactive reader leaked display lease");
setReaderActive(true);await pump();assert(awakeOwners.size===1,"visible running reader did not reacquire");
events.push({t:"lifecycle",state:"background"});await pump();assert(awakeOwners.size===0,"background leaked display lease");
events.push({t:"lifecycle",state:"active"});await pump();assert(awakeOwners.size===1,"foreground reader did not reacquire");
setKeepAwake(false);await pump();assert(awakeOwners.size===0,"preference off leaked display lease");
setKeepAwake(true);await pump();clockMs+=10000000;frame(0,undefined);await pump();
assert(!handle.playing()&&awakeOwners.size===0,"bottom completion leaked display lease");
handle.scroller.scrollTo(0,{immediate:true});handle.setPlaying(true);await pump();assert(awakeOwners.size===1,"reader failed to restart");
stop();releaseRetainedRemoteImages();
for(let i=0;i<10;i++){frame(0,undefined);for(let n=0;n<12;n++)await Promise.resolve();}
assert(awakeOwners.size===0,"reader cleanup leaked display lease");
assert(remoteImageResourceCounts().cached===0&&textures.size===0,"reader cleanup leaked textures");
console.log(JSON.stringify({mode:offlineMedia?'filePath':'inline remote',rect,decodes,serviceCounts}));
