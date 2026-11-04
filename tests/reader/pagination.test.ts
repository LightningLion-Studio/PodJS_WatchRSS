import {expect,test} from 'bun:test';
import {paginateBook,bookPageForAnchor} from '../../src/reader/pagination.ts';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import type {ContentBlock} from '../../src/reader/content.ts';
const preset=defaultReaderPreset();
const options={width:233,height:233,round:true,fontSize:14,preset,measure:(text:string)=>Array.from(text).length*10};

test('book pagination uses the circular chord on each line and keeps complete line rectangles in the circle',()=>{
 const pages=paginateBook([{type:'text',style:'body',text:'圆屏完整文字，测试排版。'.repeat(160)}],options);
 expect(pages.length).toBeGreaterThan(3);
 for(const page of pages)for(const line of page.lines){
  expect(line.row.kind).toBe('text');
  for(const x of [line.left,line.left+line.width])for(const y of [line.top,line.top+line.row.height])expect(Math.hypot(x-116.5,y-116.5)).toBeLessThanOrEqual(110.501);
 }
 const widths=pages[0]!.lines.map(line=>line.width);
 expect(Math.max(...widths)).toBeGreaterThan(215);
 expect(widths[0]).toBeLessThan(Math.max(...widths)*.6);
 expect(widths.at(-1)!).toBeLessThan(Math.max(...widths));
});

test('page transitions neither crop lines nor lose or repeat source characters, words or emoji clusters',()=>{
 const text='第一段 hello world 👩‍👩‍👧‍👦 é 🇨🇳。\r\n第二段 超长超长超长abcdefghijk'.repeat(35);
 const pages=paginateBook([{type:'text',style:'body',text}],options);
 const lines=pages.flatMap(page=>page.lines).map(line=>line.row).filter(row=>row.kind==='text');
 expect(lines.map(row=>row.text).join('')).toBe(text.replace(/\r?\n/g,''));
 for(const row of lines){expect(row.sourceStart).toBeDefined();expect(text.slice(row.sourceStart,row.sourceStart!+row.text.length)).toBe(row.text);expect(row.text.startsWith('\u200d')).toBe(false);}
 for(let i=0;i<pages.length;i++)expect(bookPageForAnchor(pages,pages[i]!.anchor)).toBe(i);
});

test('square pages use full rectangular width and reflow locates the same source anchor',()=>{
 const blocks:ContentBlock[]=[{type:'text',style:'body',text:'中文 English '.repeat(400)}];
 const original=paginateBook(blocks,{...options,round:false});
 expect(original[0]!.lines.every(line=>line.left===14&&line.width===205)).toBe(true);
 const target=original[5]!.anchor;
 const reflowed=paginateBook(blocks,{...options,preset:{...preset,body:{...preset.body,fontSizeSp:22}}});
 const selected=bookPageForAnchor(reflowed,target),page=reflowed[selected]!;
 expect(page.anchor.sourceStart).toBeLessThanOrEqual(target.sourceStart);
 expect(reflowed[selected+1]!.anchor.sourceStart).toBeGreaterThan(target.sourceStart);
});

test('title/actions and final controls are independent bounded pages; unloaded chunks remain reachable',()=>{
 const blocks:ContentBlock[]=[{type:'text',style:'body',text:'首段'.repeat(120)},{type:'text',style:'body',text:''},{type:'text',style:'body',text:'最后一段'}];
 const pages=paginateBook(blocks,{...options,header:[22,40,40,22],footer:[42,32,15],unloaded:index=>index===1});
 expect(pages[0]!.anchor.section).toBe('header');
 expect(pages.at(-1)!.anchor.section).toBe('footer');
 expect(pages.find(page=>page.loading===1)?.anchor.blockIndex).toBe(1);
 expect(pages.some(page=>page.lines.some(line=>line.row.blockIndex===2))).toBe(true);
 const side=Math.floor((233-16)/Math.SQRT2);
 for(const page of pages)if(page.controls)expect(page.controls.reduce((sum,part)=>sum+part.height,0)).toBeLessThanOrEqual(side);
});

test('mode and header changes reuse body geometry without extra native measurements',async()=>{
 const {createBookPaginator}=await import('../../src/reader/pagination.ts');let measurements=0;
 const paginate=createBookPaginator(text=>{measurements++;return Array.from(text).length*10;});
 const blocks:ContentBlock[]=[{type:'text',style:'body',text:'中英文 performance 内容 '.repeat(500)}];
 const first=paginate(blocks,{...options,header:[22,40]});const cold=measurements;expect(cold).toBeGreaterThan(0);
 expect(paginate(blocks,{...options,header:[22,40]})).toBe(first);
 const second=paginate(blocks,{...options,header:[22,22,40]});expect(measurements).toBe(cold);
 expect(first.filter(page=>page.anchor.section==='body')[0]).toBe(second.filter(page=>page.anchor.section==='body')[0]);
 const changed=paginate(blocks,{...options,width:200});expect(changed[0]).not.toBe(first[0]);expect(measurements).toBeGreaterThan(cold);
});


test('speculative page preparation yields before work, keeps exact anchors and cancels without publishing',async()=>{
 const {createBookPaginator,paginateBookSteps}=await import('../../src/reader/pagination.ts');
 const blocks:ContentBlock[]=[{type:'text',style:'body',text:'圆屏 English 👩‍👩‍👧‍👦 é 🇨🇳\r\n'.repeat(30)}];
 const expected=paginateBook(blocks,options),steps=paginateBookSteps(blocks,options);let rows=0;
 for(;;){const next=steps.next();if(next.done){expect(next.value).toEqual(expected);break;}rows++;}
 expect(rows).toBe(expected.reduce((sum,p)=>sum+p.lines.length,0));
 let measures=0;const pending:{resolve:()=>void;reject:(error:Error)=>void}[]=[];
 const yieldTurn=()=>{let current:any;const result=new Promise<void>((resolve,reject)=>{current={resolve,reject};pending.push(current);});return {result,cancel:()=>current.reject(Error('cancelled'))};};
 const cached=createBookPaginator(text=>{measures++;return options.measure(text);});
 const task=cached.prepare(blocks,options,{yieldTurn});expect(measures).toBe(0);
 let ended=false;void task.done.then(()=>{ended=true;});
 while(!ended){pending.shift()?.resolve();for(let i=0;i<8;i++)await Promise.resolve();}
 expect(cached(blocks,options)).toEqual(expected);const before=measures;cached(blocks,options);expect(measures).toBe(before);
 const cancelledBlocks:ContentBlock[]=[{type:'text',style:'body',text:'尚未分页的内容'.repeat(100)}];
 const cancelled=cached.prepare(cancelledBlocks,options,{yieldTurn});cancelled.cancel();await cancelled.done;expect(measures).toBe(before);
});
