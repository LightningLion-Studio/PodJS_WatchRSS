import {expect,mock,test} from 'bun:test';
import type {ContentBlock} from '../src/reader/content.ts';
import type {ContentLayout,ParagraphLine} from '../src/reader/content-layout.ts';
const events=new Set<(value:Record<string,unknown>)=>void>(),requests:{id:number;method:string;args:{milliseconds?:number}}[]=[],cancels:number[]=[];
mock.module('@podjs/framework/watch',()=>({__onHostEvent:(fn:(value:Record<string,unknown>)=>void)=>{events.add(fn);return ()=>events.delete(fn);},hasCapability:()=>true}));
(globalThis as any).pod={emit:(json:string)=>{const event=JSON.parse(json);if(event.t==='service.request')requests.push(event);else if(event.t==='service.cancel')cancels.push(event.id);}};
const {createContentLayouter,layoutContent,offsetForContentAnchor}=await import('../src/reader/content-layout.ts');
const {prepareReaderLayout,readerRowKey}=await import('../src/reader/layout-slices.ts');
const {defaultReaderPreset}=await import('../src/reader/preset.ts');
const {documentAnchorAt,offsetForDocumentAnchor}=await import('../src/reader/document-layout.ts');
const {createWindowRows}=await import('../src/ui/windowed-rows.ts');
const settle=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
async function nextTurn(){const req=requests.shift()!;expect(req.method).toBe('runtime.delay');expect(req.args.milliseconds).toBe(0);for(const fn of events)fn({t:'service.result',id:req.id,ok:true,value:null});await settle();}
function fixture(){
 const blocks:ContentBlock[]=[{type:'text',style:'title',text:'标题\r\n\r\nABC😀'},...Array.from({length:50},(_,i):ContentBlock=>i%10===0?{type:'image',url:`image-${i}`,width:400,height:200}:{type:'text',style:i%3===0?'quote':'body',text:'甲乙丙丁\r\n'.repeat(12)+'尾'})];
 const native=new Map<ContentBlock,ParagraphLine[]>();
 for(const block of blocks)if(block.type==='text'){
  const normalized=block.text.replace(/\r\n?/g,'\n');let start=0;
  const lines=normalized.split('\n').map((text,i)=>{const end=start+text.length+(start+text.length<normalized.length?1:0),line={start,end,visibleEnd:start+text.length,height:20+i%3,baseline:15+i%2};start=end;return line;});native.set(block,lines);
 }
 return {blocks,native};
}
test('production defaults use real host delay(0), publish once, and preserve every row metric and key',async()=>{
 const {blocks,native}=fixture(),preset=defaultReaderPreset(),make=createContentLayouter(text=>text.length*7,undefined,()=>({cellHeight:26,baseline:20}));
 const expected=layoutContent(blocks,205,16,text=>text.length*7,{},undefined,undefined,preset,native,()=>({cellHeight:26,baseline:20}));
 const baseline=make(blocks,205,16,{},preset);let result:ContentLayout|undefined,publishes=0;
 // No clock, transport, yield or budget injection: this is the production constructor.
 const task=prepareReaderLayout(make.steps(blocks,205,16,{},preset,native),row=>row,value=>{result=value.layout;publishes++;expect(value.indices.size).toBe(value.entries.length);});
 expect(result).toBeUndefined();let turns=0;
 while(requests.length){await nextTurn();turns++;expect(publishes).toBeLessThanOrEqual(1);}
 await task.done;expect(turns).toBeGreaterThan(10);expect(publishes).toBe(1);expect(result).toEqual(expected);expect(task.stats.rows).toBe(expected.rows.length);
 for(const row of baseline.rows){const match=expected.rows.find(next=>next.blockIndex===row.blockIndex&&next.sourceStart===row.sourceStart&&next.kind===row.kind);if(match)expect(readerRowKey(match)).toBe(readerRowKey(row));}
 for(const row of expected.rows){const offset=30+row.top+row.gap+(row.height-row.gap)*.4,anchor=documentAnchorAt(expected,offset,30);expect(offsetForDocumentAnchor(expected,anchor,30,Infinity)).toBeCloseTo(offset);}
});
test('mid-slice cancellation cancels the real outstanding delay and never publishes late replies',async()=>{
 const {blocks,native}=fixture(),make=createContentLayouter(text=>text.length*7);let published=0;
 const task=prepareReaderLayout(make.steps(blocks,205,16,{},undefined,native),row=>row,()=>published++);
 await nextTurn();expect(task.stats.rows).toBeGreaterThan(0);expect(task.stats.rows).toBeLessThan(600);
 const late=requests.shift()!;task.cancel();expect(cancels).toContain(late.id);
 for(const fn of events)fn({t:'service.result',id:late.id,ok:true,value:null});await task.done;
 expect(published).toBe(0);expect(requests).toHaveLength(0);
});
test('keyed source replacement preserves retained history, updates geometry and visits only a bounded window',()=>{
 const scope={},make=(height:number)=>{const rows=Array.from({length:10000},(_,i)=>({key:`text:${i}:0`,top:i*height,height,retain:true}));let reads=0;return {length:rows.length,scope,at:(i:number)=>{reads++;return rows[i];},indexOfKey:(key:unknown)=>typeof key==='string'?Number(key.split(':')[1]):undefined,reads:()=>reads};};
 const before=make(20),after=make(21),window=createWindowRows<ReturnType<typeof before.at>>(24);
 window(before,0,100);window(before,200,300);
 const previous=window(before,200,300),next=window(after,210,315);
 for(const row of previous)expect(next.some(value=>value.key===row.key)).toBe(true);
 expect(next.every(row=>row.top===Number((row.key as string).split(':')[1])*21)).toBe(true);
 expect(after.reads()).toBeLessThan(100);
 expect(window({...after,scope:{}},210,315).every(row=>row.top+row.height>=210&&row.top<=315)).toBe(true);
});

test('Solid keeps line owners on native arrival, updates their data, and disposes once on exit',async()=>{
 const {createRoot,createSignal,createEffect,mapArray,onCleanup}=await import('solid-js');
 const {createLiveWindowRows}=await import('../src/ui/live-window-rows.ts');
 let mounts=0,disposed=0,readings:{top:number;baseline:number;caret:number}[]=[],stop!:()=>void;
 createRoot(dispose=>{
  stop=dispose;
  type Entry={key:string;top:number;height:number;data:{baseline:number;caret:number}};
  const reconcile=createLiveWindowRows<Entry>(read=>({key:read().key,get top(){return read().top;},get height(){return read().height;},get data(){return read().data;}}),(a,b)=>a.top===b.top&&a.data===b.data);
  const scope={},[selected,setSelected]=createSignal(reconcile([{key:'text:0:0',top:0,height:20,data:{baseline:15,caret:8}}],scope));
  const map=mapArray(selected,row=>{mounts++;onCleanup(()=>disposed++);createEffect(()=>readings.push({top:row.top,baseline:row.data.baseline,caret:row.data.caret}));return row;});
  createEffect(()=>{map();});
  queueMicrotask(()=>{
   const original=selected()[0];setSelected(reconcile([{key:'text:0:0',top:3,height:22,data:{baseline:17,caret:9}}],scope));expect(selected()[0]).toBe(original);
   // Equal source data makes crossing a viewport boundary a no-op for the row.
   const last=readings.length;setSelected(reconcile([{key:'text:0:0',top:3,height:22,data:selected()[0]!.data}],scope));expect(readings.length).toBe(last);
  });
 });
 await settle();expect(mounts).toBe(1);expect(disposed).toBe(0);expect(readings).toEqual([{top:0,baseline:15,caret:8},{top:3,baseline:17,caret:9}]);stop();expect(disposed).toBe(1);
});


test('sliced layout and anchor offsets equal frozen b36e5be geometry for presets, fallback, native boxes and CRLF',async()=>{
 const fixture=await Bun.file(new URL('./fixtures/reader-layout-k15.json',import.meta.url)).json();
 for(const item of fixture.cases){
  const native=new Map<ContentBlock,ParagraphLine[]>(item.native.map(([index,lines]:[number,ParagraphLine[]])=>[item.blocks[index],lines]));
  const make=createContentLayouter(text=>Array.from(text).length*8,undefined,()=>({cellHeight:26,baseline:20}));
  let result:ContentLayout|undefined;
  const task=prepareReaderLayout(make.steps(item.blocks,item.width,item.fontSize,item.ratios,item.preset,native),row=>row,value=>{result=value.layout;});
  while(requests.length)await nextTurn();await task.done;expect(JSON.parse(JSON.stringify(result))).toEqual(item.layout);
  for(const {anchor,offset} of item.anchors)expect(offsetForContentAnchor(result!,anchor,Infinity)).toBe(offset);
 }
});
