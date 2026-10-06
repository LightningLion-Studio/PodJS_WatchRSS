/** Offline entry for the real Linux PodRuntime/QuickJS probe. Service raster
 * pixels are synthetic; ReaderBody/Solid/HostOps/surface/resource lifetimes
 * are real. The probe keeps no per-frame sample history in the guest heap. */
import {render} from '@pocketjs/framework';
import {setStyleResolver} from '@pocketjs/framework/renderer';
import {getOps} from '@pocketjs/framework/host';
import {__onHostEvent,getFontMetrics} from '@podjs/framework/watch';
import {installDebugMemoryStats} from '@podjs/framework/debug-memory';
import {ReaderBody} from '../../src/ui/ReaderBody.tsx';
import {parseContent} from '../../src/reader/content.ts';
import {createContentLayouter} from '../../src/reader/content-layout.ts';
import {defaultReaderPreset} from '../../src/reader/preset.ts';

const fixture=(globalThis as any).__readerFixture as {html:string};
let clockMs=0,errors=0;
Date.now=()=>clockMs;
installDebugMemoryStats();
const blocks=parseContent(fixture.html),preset=defaultReaderPreset();
let layout:ReturnType<ReturnType<typeof createContentLayouter>>;
const offlineMedia=Object.fromEntries(blocks.filter(b=>b.type==='image'||b.type==='video').map((b,i)=>[b.url,`fixture/source-${i}`]));
let handle:any,disposed=false;
const stop=render(()=>{
 const ops=getOps();
 layout=createContentLayouter((text,slot)=>ops.measureText(text,slot),(text,slot,max)=>ops.wrapText?.(text,slot,max),getFontMetrics)(blocks,205,16,{},preset,new Map());
 // This harness exercises ownership, not visual parity: classes resolve to
 // style 0, dynamic style/retained layout still use the real Rust UI core.
 setStyleResolver(()=>0);
 return <ReaderBody articleId="offline-memory-fixture" text={blocks.filter(b=>b.type==='text').map(b=>b.text).join('\n')}
  blocks={blocks} width={233} height={193} fontSize={16} lineHeight={24} preset={preset} offlineMedia={offlineMedia}
  active={true} autoStart={false} speed={1} progressStore={{load:async()=>({offset:0,progress:0,updatedAt:0}),save:async()=>{}}}
  onMedia={()=>{}} onControls={()=>{}} onError={()=>{errors++;}} ref={value=>{handle=value;}}/>;
});
__onHostEvent(event=>{
 if(event.t!=='bench.step')return;
 clockMs=Number(event.clockMs);
 if(event.phase==='scroll')handle.scroller.scrollTo(Number(event.offset),{immediate:true});
 else if(event.phase==='begin')handle.scroller.beginDrag();
 else if(event.phase==='drag')handle.scroller.drag(Number(event.delta));
 else if(event.phase==='end')handle.scroller.endDrag(Number(event.velocity));
 else if(event.phase==='stop'&&!disposed){disposed=true;stop();}
});
(globalThis as any).pod.emit(JSON.stringify({t:'bench.meta',blocks:blocks.length,rows:layout.rows.length,
 layoutHeight:layout.height,textBlocks:blocks.filter(b=>b.type==='text').length,mediaBlocks:blocks.filter(b=>b.type!=='text').length}));
// Numeric-only extra facts, without capturing a growing result collection.
const base=(globalThis as any).__podMemoryStats as ()=>string;
(globalThis as any).__podMemoryStats=()=>{const stats=JSON.parse(base());stats.bench={errors,disposed:disposed?1:0,offset:handle?.scroller.offset()??0};return JSON.stringify(stats);};
