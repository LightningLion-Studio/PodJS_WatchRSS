import {expect,mock,test} from 'bun:test';
import type {ContentBlock} from '../src/reader/content.ts';
import type {ContentLayout,ParagraphLine} from '../src/reader/content-layout.ts';
const events=new Set<(value:Record<string,unknown>)=>void>(),requests:{id:number;method:string;args:{milliseconds?:number}}[]=[],cancels:number[]=[];
mock.module('@podjs/framework/watch',()=>({__onHostEvent:(fn:(value:Record<string,unknown>)=>void)=>{events.add(fn);return ()=>events.delete(fn);},hasCapability:()=>true}));
(globalThis as any).pod={emit:(json:string)=>{const event=JSON.parse(json);if(event.t==='service.request')requests.push(event);else if(event.t==='service.cancel')cancels.push(event.id);}};
const {createContentLayouter,layoutContent,offsetForContentAnchor}=await import('../src/reader/content-layout.ts');
const {prepareTextLayout}=await import('@podjs/framework/text');
const {readerRowKey}=await import('../src/reader/content-layout.ts');
const {defaultReaderPreset}=await import('../src/reader/preset.ts');
const {documentAnchorAt,offsetForDocumentAnchor}=await import('../src/reader/document-layout.ts');
const settle=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
async function nextTurn(){const req=requests.shift()!;expect(req.method).toBe('runtime.delay');expect(req.args.milliseconds).toBe(1);for(const fn of events)fn({t:'service.result',id:req.id,ok:true,value:null});await settle();}
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
 const task=prepareTextLayout(make.steps(blocks,205,16,{},preset,native),{key:readerRowKey,entry:row=>row,publish:value=>{result=value.layout;publishes++;expect(value.indices.size).toBe(value.entries.length);}});
 expect(result).toBeUndefined();let turns=0;
 while(requests.length){await nextTurn();turns++;expect(publishes).toBeLessThanOrEqual(1);}
 await task.done;expect(turns).toBeGreaterThan(10);expect(publishes).toBe(1);expect(result).toEqual(expected);expect(task.stats.rows).toBe(expected.rows.length);
 for(const row of baseline.rows){const match=expected.rows.find(next=>next.blockIndex===row.blockIndex&&next.sourceStart===row.sourceStart&&next.kind===row.kind);if(match)expect(readerRowKey(match)).toBe(readerRowKey(row));}
 for(const row of expected.rows){const offset=30+row.top+row.gap+(row.height-row.gap)*.4,anchor=documentAnchorAt(expected,offset,30);expect(offsetForDocumentAnchor(expected,anchor,30,Infinity)).toBeCloseTo(offset);}
});
test('sliced layout and anchor offsets equal frozen b36e5be geometry for presets, fallback, native boxes and CRLF',async()=>{
 const fixture=await Bun.file(new URL('./fixtures/reader-layout-k15.json',import.meta.url)).json();
 for(const item of fixture.cases){
  const native=new Map<ContentBlock,ParagraphLine[]>(item.native.map(([index,lines]:[number,ParagraphLine[]])=>[item.blocks[index],lines]));
  const make=createContentLayouter(text=>Array.from(text).length*8,undefined,()=>({cellHeight:26,baseline:20}));
  let result:ContentLayout|undefined;
  const task=prepareTextLayout(make.steps(item.blocks,item.width,item.fontSize,item.ratios,item.preset,native),{key:readerRowKey,entry:row=>row,publish:value=>{result=value.layout;}});
  while(requests.length)await nextTurn();await task.done;expect(JSON.parse(JSON.stringify(result))).toEqual(item.layout);
  for(const {anchor,offset} of item.anchors)expect(offsetForContentAnchor(result!,anchor,Infinity)).toBe(offset);
 }
});
