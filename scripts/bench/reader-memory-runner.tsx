/** Offline entry for the real Linux PodRuntime/QuickJS probe. Service raster
 * pixels are synthetic; ReaderBody/Solid/HostOps/surface/resource lifetimes
 * are real. The probe keeps no per-frame sample history in the guest heap. */
import {render} from '@pocketjs/framework';
import {setStyleResolver} from '@pocketjs/framework/renderer';
import {getOps} from '@pocketjs/framework/host';
import {__onHostEvent,getFontMetrics} from '@podjs/framework/watch';
import {installDebugMemoryStats,trackDebugMemoryOwner} from '@podjs/framework/debug-memory';
import WatchRSS from '../../src/ui/screen.tsx';
import {activityStateHub} from '../../src/navigation/activity-host.ts';
import {ReaderScreen} from '../../src/ui/ReaderScreen.tsx';
import {ReaderBody} from '../../src/ui/ReaderBody.tsx';
import {parseContent} from '../../src/reader/content.ts';
import {createContentLayouter} from '../../src/reader/content-layout.ts';
import {defaultReaderPreset} from '../../src/reader/preset.ts';

const fixture=(globalThis as any).__readerFixture as {html:string;screen?:boolean;app?:boolean};
let clockMs=0,errors=0;
Date.now=()=>clockMs;
installDebugMemoryStats();
const blocks=parseContent(fixture.html),preset=defaultReaderPreset();
let layout:ReturnType<ReturnType<typeof createContentLayouter>>;
const offlineMedia=Object.fromEntries(blocks.filter(b=>b.type==='image'||b.type==='video').map((b,i)=>[b.url,`fixture/source-${i}`]));
let handle:any,disposed=false;
function seed(){if(fixture.app){
 activityStateHub.seed({saved:{'watchrss.content-activity':{version:1,entries:[
  {page:'home',id:'r1',args:{},ui:{}},{page:'articles',id:'r2',args:{channelId:'1'},ui:{}},{page:'reader',id:'r3',args:{articleId:'1'},ui:{}}
 ]}},retained:{}});
}}
seed();

const mount=()=>render(()=>{
 trackDebugMemoryOwner();
 const ops=getOps();
 layout=createContentLayouter((text,slot)=>ops.measureText(text,slot),(text,slot,max)=>ops.wrapText?.(text,slot,max),getFontMetrics)(blocks,205,16,{},preset,new Map());
 // Use the production class table and the real Rust UI core. Service pixels
 // and text measurement remain synthetic in this offline ownership probe.
 const styles=(globalThis as any).__readerStyles;
 ops.loadStyles?.(new Uint8Array(styles.bin));
 setStyleResolver(cls=>styles.ids[cls]);
 if(fixture.screen||fixture.app){
  const article={id:"1",title:"科技爱好者周刊（离线归属夹具）",content:blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n'),contentBlocks:blocks,offlineMedia};
  const channel={id:'1',title:'Offline reader fixture',url:'fixture',unreadCount:1};
  const services={listChannels:async()=>[channel],listArticles:async()=>[article],getArticle:async()=>article,
   getOriginalArticle:async()=>article,markRead:async()=>{},subscribeChannel:()=>()=>{},readAccountStatus:async()=>null,subscribeAccountStatus:()=>()=>{},
   createSummary:()=>({dispose(){},start:async()=>{}}),hasSummaryAccount:async()=>false} as any;
  if(fixture.app)return <WatchRSS services={services}/>;
  return <ReaderScreen article={article} services={services} width={233} height={233} fontSize={16} lineHeight={24} preset={preset}
   active={true} autoStart={false} speed={1} favorite={false} speaking={false} busy={false}
   llmEnabled={false} llmAutoSummarize={false} llmPromptPreset={0}
   onFavorite={()=>{}} onShare={()=>{}} onSpeak={()=>{}} onSpeechControls={()=>{}} onMedia={()=>{}} onControls={()=>{}}
   onError={()=>{errors++;}} ref={value=>{handle=value;}}/>;
 }
 return <ReaderBody articleId="offline-memory-fixture" text={blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n')}
  blocks={blocks} width={233} height={193} fontSize={16} lineHeight={24} preset={preset} offlineMedia={offlineMedia}
  active={true} autoStart={false} speed={1} progressStore={{load:async()=>({offset:0,progress:0,updatedAt:0}),save:async()=>{}}}
  onMedia={()=>{}} onControls={()=>{}} onError={()=>{errors++;}} ref={value=>{handle=value;}}/>;
});
let stop=mount();
__onHostEvent(event=>{
 if(event.t!=='bench.step')return;
 clockMs=Number(event.clockMs);
 if(fixture.app)handle=(globalThis as any).__readerHandle;
 if(event.phase==='scroll')handle.scroller.scrollTo(Number(event.offset),{immediate:true});
 else if(event.phase==='begin')handle.scroller.beginDrag();
 else if(event.phase==='drag')handle.scroller.drag(Number(event.delta));
 else if(event.phase==='end')handle.scroller.endDrag(Number(event.velocity));
 else if(event.phase==='stop'&&!disposed){disposed=true;stop();handle=undefined;(globalThis as any).__readerHandle=undefined;}
 else if(event.phase==='restart'){seed();disposed=false;stop=mount();}
});
(globalThis as any).pod.emit(JSON.stringify({t:'bench.meta',blocks:blocks.length,rows:layout.rows.length,
 layoutHeight:layout.height,textBlocks:blocks.filter(b=>b.type==='text').length,mediaBlocks:blocks.filter(b=>b.type!=='text').length}));
// Numeric-only extra facts, without capturing a growing result collection.
const base=(globalThis as any).__podMemoryStats as ()=>string;
(globalThis as any).__podMemoryStats=()=>{const stats=JSON.parse(base());stats.bench={...(stats.solid??{}),errors,disposed:disposed?1:0,offset:handle?.scroller.offset()??0,hit:getOps().hitTestBounds?.(116,120)??-1};return JSON.stringify(stats);};
