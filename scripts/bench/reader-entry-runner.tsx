import {render} from '@pocketjs/framework';
import {setStyleResolver} from '@pocketjs/framework/renderer';
import {ReaderScreen} from '../../src/ui/ReaderScreen.tsx';
import {ReaderBody} from '../../src/ui/ReaderBody.tsx';
import {NoteDetailScreen} from '../../src/ui/NotesScreen.tsx';
import {parseContent} from '../../src/reader/content.ts';
import {createContentLayouter} from '../../src/reader/content-layout.ts';
import {offsetForDocumentAnchor} from '../../src/reader/document-layout.ts';
import {getFontMetrics} from '@podjs/framework/watch';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import {releaseRetainedRemoteImages} from '../../src/ui/RemoteImage.tsx';
const g=globalThis as any,now=g.__benchNow,print=g.__benchPrint,fixture=g.__entryFixture;
// Optional offline CPU model changes the default scheduler's clock budget;
// actual host IO timers still use unscaled monotonic time. Reported CPU remains raw.
if(fixture.cpuScale!==1){if(!Number.isFinite(fixture.cpuScale)||fixture.cpuScale<1)throw Error('invalid CPU scale');Date.now=()=>Math.floor(now()*fixture.cpuScale);}
const start=now();let firstBody:number|undefined,firstTitle:number|undefined,firstImage:number|undefined,firstRaster:number|undefined,nodeId=1,textureId=1,maxTurn=0,turns=0,stop:()=>void,finished=false;
const nativeArgs=new Map<string,any>();
const events:any[]=[],serviceTurns:any[]=[],pending=new Map<number,{due:number;method:string;event:any}>(),counts:Record<string,number>={},rasterTexts:string[]=[],nodes=new Map<number,string>(),kv=new Map<string,string>();
let phase='mount';const phases:any[]=[];
function record(name:string){phases.push({phase:name,atMs:now()-start});}
function paragraph(args:any){
 const lines:any[]=[];let offset=0;
 while(offset<args.text.length){const end=Math.min(args.text.length,offset+Math.max(1,Math.floor(args.widthPx/14)));
 lines.push({start:offset,end,visibleEnd:end,topPx:lines.length*40,bottomPx:(lines.length+1)*40,baselinePx:lines.length*40+30});offset=end;}
 if(!lines.length)lines.push({start:0,end:0,visibleEnd:0,topPx:0,bottomPx:40,baselinePx:30});
 return {lines};
}
Object.assign(g.pod,{
 capabilities:()=>JSON.stringify(['runtime.timer','text.layout','text.raster','text.environment','data.kv','data.files.chunks','data.images']),
 displayMetrics:()=>JSON.stringify({logicalWidth:233,logicalHeight:233,physicalWidth:466,physicalHeight:466,density:2,shape:'round',safeInsets:{top:0,right:0,bottom:0,left:0}}),fontMetrics:()=>JSON.stringify({cellHeight:26,baseline:20}),
 kvGet:(k:string)=>kv.get(k),kvSet:(k:string,v:string)=>{kv.set(k,v);return 0;},kvDelete:(k:string)=>{kv.delete(k);return 0;},kvKeys:()=>JSON.stringify([...kv.keys()]),uploadTextureFile:()=>textureId++,
 takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
 emit:(json:string)=>{const req=JSON.parse(json);if(req.t==='service.cancel'){pending.delete(req.id);return;}if(req.t!=='service.request')return;
 const {id,method,args}=req;counts[method]=(counts[method]??0)+1;let value:any,delay=fixture.nativeDelay;
 if(method==='text.measure')value={widthPx:args.text.length*14};
 else if(method==='runtime.delay'){if(args.milliseconds<1||args.milliseconds>120000)throw Error('Timer delay must be 1..120000ms');value=null;delay=Math.max(fixture.timerFloor,args.milliseconds);}
 else if(method==='text.layout'){nativeArgs.set(args.text,args);value=paragraph(args);}
 else if(method==='text.layoutBatch'){for(const p of args.paragraphs)nativeArgs.set(p.text,p);value={results:args.paragraphs.map(paragraph)};}
 else if(method==='text.environment')value={density:2,fontScale:1,spValuesPx:[]};
 else if(method==='text.raster'){rasterTexts.push(args.text);if(firstRaster===undefined){firstRaster=now()-start;record('firstRasterRequest');}value={path:`text/${id}`,width:512,height:64,carets:Array.from({length:args.text.length+1},(_,i)=>i*14)};}
 else if(method==='file.stat')value={file:false,size:0};
 else if(method==='file.delete')value={deleted:true};
 else if(method==='image.decode'){if(firstImage===undefined){firstImage=now()-start;record('firstImageRequest');}pending.set(id,{due:now()+delay,method,event:{t:'service.result',id,ok:false,code:'not_found',message:'Fixture has no JPEG'}});return;}
 else if(method==='file.mkdir')value={created:true};
 else if(method.startsWith('http.')||method.startsWith('download.')||method==='file.list'){pending.set(id,{due:now()+delay,method,event:{t:'service.result',id,ok:false,code:'fixture_unavailable',message:'Offline IO boundary'}});return;}
 else throw Error('Unexpected IO '+method);
 pending.set(id,{due:now()+delay,method,event:{t:'service.result',id,ok:true,value}});
 }});
const ops:any={__viewport:{w:233,h:233},__scrollConfiguration:{touchSlopPx:8,minimumFlingVelocityPx:50,maximumFlingVelocityPx:8000},createNode:()=>nodeId++,
 measureText:(text:string)=>text.length*7,wrapText:(text:string,_slot:number,width:number)=>{const out:number[]=[];for(let end=Math.max(1,Math.floor(width/7));end<text.length;end+=Math.max(1,Math.floor(width/7)))out.push(end);return out;},
 getLayout:()=>({x:0,y:0,w:233,h:233}),getProp:()=>0,uploadTexture:()=>textureId++,freeTexture(){},setText:(id:number,text:string)=>{nodes.set(id,text);if(fixture.mode==='note'&&text==='README'&&firstTitle===undefined){firstTitle=now()-start;record('firstTitleMount');}if(fixture.mode==='note'&&text.startsWith('hymission')&&firstBody===undefined){firstBody=now()-start;g.__entryHasBody=true;record('firstBodyMount');}},
};
for(const name of ['destroyNode','insertBefore','removeChild','setStyle','setProp','replaceText','setImage','setSprite','setFocus','animate','setAccessibility','setNavigationState'])ops[name]=()=>{};
if(g.ui){
 g.ui.loadStyles(new Uint8Array(g.__entryStyles.bin));
 for(const name of Object.keys(g.ui))if(typeof g.ui[name]==='function'){
  const native=g.ui[name];ops[name]=(...args:any[])=>g.__entryProfile.time('host.'+name,()=>native(...args));
 }
 const setText=ops.setText;
 ops.setText=(id:number,text:string)=>{setText(id,text);nodes.set(id,text);if(fixture.mode==='note'&&text==='README'&&firstTitle===undefined){firstTitle=now()-start;record('firstTitleMount');}if(fixture.mode==='note'&&text.startsWith('hymission')&&firstBody===undefined){firstBody=now()-start;g.__entryHasBody=true;record('firstBodyMount');}};
}
let handle:any;const preset=defaultReaderPreset();record('presetReady');
const blocks=fixture.mode!=='note'?parseContent(fixture.html):[];record('contentReady');
const markdown=fixture.note,plainText=fixture.notePlain;
const note={noteId:'fixture',folderId:null,title:'README',markdown,plainText,contentHash:'fixture',baseContentHash:'fixture',baseMarkdown:'',pinned:false,createdAt:1,updatedAt:1,modifiedBy:'fixture',deleted:false,deletedAt:0};
kv.set('watchrss.reader.progress.12569',JSON.stringify(JSON.stringify({offset:0,progress:fixture.savedProgress,updatedAt:0})));
const beginMount=now();
stop=render(()=>{setStyleResolver(c=>g.__entryStyles.ids[c]??0);
 return fixture.mode==='screen'?<ReaderScreen article={{id:'12569',title:'科技爱好者周刊（第 411 期）：OpenClaw 2.0 是一个缩影',content:blocks.filter(b=>b.type==='text').map(b=>(b as any).text).join('\n'),contentBlocks:blocks,link:'http://fixture.invalid/411'}} services={{readingProgress:{load:async()=>({offset:0,progress:fixture.savedProgress,updatedAt:0}),save:async()=>{}},createSummary:()=>({dispose(){},start:async()=>{}})} as any} width={233} height={233} fontSize={16} lineHeight={24} preset={preset} mediaCacheMode="关闭" active={true} autoStart={false} speed={1} favorite={false} speaking={false} busy={false} llmEnabled={false} llmAutoSummarize={false} llmPromptPreset={0} onFavorite={()=>{}} onShare={()=>{}} onSpeak={()=>{}} onSpeechControls={()=>{}} onMedia={()=>{}} onControls={()=>{}} onError={v=>{throw Error(v);}} ref={v=>{handle=v;}}/>:fixture.mode==='reader'?<ReaderBody articleId="12569" text={blocks.filter(b=>b.type==='text').map(b=>(b as any).text).join('\n')} blocks={blocks} width={233} height={193} fontSize={16} lineHeight={24} preset={preset} active={true} autoStart={false} speed={1}
 onMedia={()=>{}} onControls={()=>{}} onError={(error)=>{throw Error(error);}} ref={v=>{handle=v;}}/>:
 <NoteDetailScreen width={233} height={233} noteId="fixture" preset={preset} backgroundSnapshot={{state:{presets:[],assets:[]},revision:0} as any} active={true} repository={{get:async()=>note} as any} input={async()=>null} onBack={()=>{}} ref={v=>{handle=v;}}/>;
},{ops});maxTurn=now()-beginMount;record('mounted');
// Real host macrotasks: one pump, drain QuickJS jobs, wait until next due timer.
// __benchSleep belongs exclusively to the Rust offline runner. A slow host-timer
// floor models Choreographer/looper turn cadence independently of CPU scaling.
g.__benchPump=()=>{
 if(!pending.size){finish();return false;}
 const due=Math.min(...[...pending.values()].map(v=>v.due));g.__benchSleep(Math.max(0,due-now()));
 const turnStart=now();for(const [id,v] of pending)if(v.due<=now()){serviceTurns.push({method:v.method,atMs:now()-start});pending.delete(id);events.push(v.event);}
 g.__pocketPumpServices();g.frame(0);maxTurn=Math.max(maxTurn,now()-turnStart);turns++;return true;
};
function finish(){if(finished)return;finished=true;
 if(fixture.mode==='note'&&firstBody===undefined)throw Error('README body never mounted');
 const entryProfile=JSON.parse(JSON.stringify(g.__entryProfile));
 if(fixture.mode==='reader'){
  const native=new Map<any,any>();
  for(const block of blocks)if(block.type==='text'){
   const text=block.text.replace(/\r\n?/g,'\n'),args=nativeArgs.get(text);if(!args)throw Error('missing native fixture input');
   native.set(block,paragraph(args).lines.map((line:any,lineIndex:number)=>({start:line.start,end:line.end,visibleEnd:line.visibleEnd,paragraph:{...args,lineIndex},height:(line.bottomPx-line.topPx)/2,baseline:(line.baselinePx-line.topPx)/2})));
  }
  const expected=createContentLayouter(ops.measureText,ops.wrapText,getFontMetrics)(blocks,205,16,{},preset,native);
  if(JSON.stringify(g.__entryLayout)!==JSON.stringify(expected))throw Error('complete reader geometry differs from synchronous collector');
  const offset=fixture.savedProgress<=0?0:offsetForDocumentAnchor(expected,{character:fixture.savedProgress*blocks.filter(b=>b.type==='text').map(b=>(b as any).text).join('\n').length,fraction:0},0,Math.max(0,expected.height-193));
  if(Math.abs(handle.scroller.offset()-offset)>1e-6)throw Error('saved anchor changed');
  record('readerGeometryAndSavedAnchorEqual');
 }
 phase='cleanup';stop();releaseRetainedRemoteImages();record('disposed');
 print(JSON.stringify({phase:'entry.summary',mode:fixture.mode,htmlUnits:fixture.html.length,blocks:blocks.length,markdownUnits:markdown.length,nativeDelay:fixture.nativeDelay,timerFloor:fixture.timerFloor,cpuScale:fixture.cpuScale,totalMs:now()-start,firstTitleMs:firstTitle,firstImageMs:firstImage,serviceTurns,firstRasterMs:firstRaster,firstBodyMs:firstBody,maxPumpMs:maxTurn,turns,counts,phases,profile:entryProfile.stats,spans:entryProfile.spans,jobs:entryProfile.jobs.map((job:any)=>({...job,startMs:job.startMs-start,endMs:job.endMs-start}))}));g.__benchDone=true;}
