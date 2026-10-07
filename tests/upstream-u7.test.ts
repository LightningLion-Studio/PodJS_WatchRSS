import {expect,test} from 'bun:test';
import {qrPixels} from '../src/ui/qr-pixels';
import {qrPixels as oldQr} from './fixtures/upstream-u7/ui/qr-pixels';
import * as preview from '../src/ui/image-preview';
import * as oldPreview from './fixtures/upstream-u7/ui/image-preview';
import * as tiles from '../src/ui/image-tiles';
import * as oldTiles from './fixtures/upstream-u7/ui/image-tiles';
import {RawTextHistory} from '../src/notes/raw-text-history';
import {RawTextHistory as OldHistory} from './fixtures/upstream-u7/notes/raw-text-history';
import {AutoScrollController} from '../src/reader/autoscroll';
import {AutoScrollController as OldScroll} from './fixtures/upstream-u7/reader/autoscroll';
import {ReadingProgressWriteQueue} from '../src/reader/progress-write-queue';
import {ReadingProgressWriteQueue as OldQueue} from './fixtures/upstream-u7/reader/progress-write-queue';
import {NoteDraftAutosave} from '../src/notes/draft-autosave';
import {NoteDraftAutosave as OldAutosave} from './fixtures/upstream-u7/notes/draft-autosave';
import type {MemoNote} from '../src/notes/types';
const capture=(fn:()=>unknown)=>{try{return fn();}catch(e){return String(e);}};
let seed=718;const random=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/2**32;
test('QR bytes and error strings match frozen da18c00 profiles',()=>{
 for(const value of ['', 'hello','中文🙂\u0000', 'https://example.test/a?b=你好','x'.repeat(2049)])for(const size of [16,128,233,256])for(const native of [false,true])for(const bitmap of [0,400,401])expect(capture(()=>qrPixels(value,size,native,bitmap))).toEqual(capture(()=>oldQr(value,size,native,bitmap)));
});
test('preview transforms, threshold transitions, edge tiles and halo match frozen oracle',()=>{
 for(let i=0;i<180;i++){
  const g={width:233,height:233,imageWidth:[510,3072,4096,8000][i%4]!,imageHeight:1+Math.floor(random()*8000),density:[1,2,3][i%3]!};
  const s={scale:.5+random()*20,x:random()*1000-500,y:random()*1000-500};
  for(const name of ['previewBase','previewMaxScale','previewPlacement'] as const)expect(preview[name](g)).toEqual(oldPreview[name](g));
  for(const name of ['clampPreview','previewAllowsBack'] as const)expect(preview[name](g,s)).toEqual(oldPreview[name](g,s));
  expect(preview.previewRange(g,s.scale)).toEqual(oldPreview.previewRange(g,s.scale));
  expect(preview.nextPreviewScale(g,s.scale)).toEqual(oldPreview.nextPreviewScale(g,s.scale));
  expect(preview.zoomPreview(g,s,2,90,70)).toEqual(oldPreview.zoomPreview(g,s,2,90,70));
  expect(preview.pinchPreviewStep(g,s,1.2,33,67,12,-20)).toEqual(oldPreview.pinchPreviewStep(g,s,1.2,33,67,12,-20));
  expect(preview.previewScaleDecayStep(g,s,100,.016)).toEqual(oldPreview.previewScaleDecayStep(g,s,100,.016));
  expect(preview.previewPanDecayStep(g,s,100,-100,.016)).toEqual(oldPreview.previewPanDecayStep(g,s,100,-100,.016));
  expect(preview.previewCanStartBack(g,s,50,20,4)).toEqual(oldPreview.previewCanStartBack(g,s,50,20,4));
  const list=tiles.visibleImageTiles(g,s);expect(list).toEqual(oldTiles.visibleImageTiles(g,s));
  for(const t of list)expect(tiles.imageTileRegion(t,g.imageWidth,g.imageHeight)).toEqual(oldTiles.imageTileRegion(t,g.imageWidth,g.imageHeight));
 }
});
test('history random edits, grouping, undo/redo and capacity match frozen oracle',()=>{
 let now=0;const a=new RawTextHistory('',()=>now,7,500),b=new OldHistory('',()=>now,7,500);
 for(let i=0;i<1000;i++){now+=Math.floor(random()*700);const op=random();if(op<.2){a.undo();b.undo();}else if(op<.4){a.redo();b.redo();}else{const next=random()<.5?a.value+'中':a.value.slice(1);a.record(next);b.record(next);}expect([a.value,a.canUndo,a.canRedo]).toEqual([b.value,b.canUndo,b.canRedo]);}
 expect(new RawTextHistory('default').record('default!')).toBe('default!');
});
test('scroll bounds, background request and invalid numbers match frozen oracle',()=>{
 const x:number[]=[],y:number[]=[];const a=new AutoScrollController(3,v=>x.push(v)),b=new OldScroll(3,v=>y.push(v));
 for(let i=0;i<200;i++){const value=[NaN,Infinity,-1,0,500,17][i%6]!;for(const c of [a,b]){switch(i%7){case 0:c.setBounds(value);break;case 1:c.setSpeed(value);break;case 2:c.start();break;case 3:c.setBackground(i%2===0);break;case 4:c.setOffset(value);break;case 5:c.tick(value);break;case 6:c.pause();}}expect([a.getOffset(),a.isRequested(),a.isRunning(),x]).toEqual([b.getOffset(),b.isRequested(),b.isRunning(),y]);}
 new AutoScrollController().tick(1);
});
test('queue rejects failing caller, continues and flush retains captured tail',async()=>{
 async function run(C:new()=>Pick<OldQueue,'enqueue'|'flush'>){const q=new C(),events:string[]=[];let finish!:()=>void;const first=q.enqueue(()=>new Promise<void>(r=>{finish=r;}));const tail=q.flush();const fail=q.enqueue(async()=>{events.push('fail');throw Error('write');});const caught=fail.catch(e=>events.push(e.message));const last=q.enqueue(async()=>{events.push('last');});await Promise.resolve();await Promise.resolve();finish();await tail;events.push('tail');await Promise.all([first,caught,last]);return events;}
 expect(await run(ReadingProgressWriteQueue)).toEqual(await run(OldQueue));
});
function note(title:string,markdown:string):MemoNote{return {noteId:'1',folderId:null,title,markdown,plainText:markdown,contentHash:'h',baseContentHash:'h',baseMarkdown:markdown,pinned:false,createdAt:1,updatedAt:1,modifiedBy:'watch',deleted:false,deletedAt:0};}
test('autosave slow result, newer edits, normalization, errors and due time match frozen oracle',async()=>{
 async function run(C:new(...args:ConstructorParameters<typeof OldAutosave>)=>Pick<OldAutosave,'flush'|'setTitle'|'setMarkdown'|'tick'|'dispose'|'state'|'title'|'markdown'|'note'>){let now=0,finish!:(n:MemoNote)=>void,count=0;const events:unknown[]=[];const d=new C({save:async value=>{events.push(['write',value]);count++;if(count===1)return new Promise<MemoNote>(r=>{finish=r;});if(count===3)throw Error('failed');return note(value.title??'',value.markdown);}},null,s=>events.push(s),n=>events.push(['saved',n.markdown]),e=>events.push(String(e)),600,()=>now);
  await d.flush();d.setTitle('title');d.setMarkdown('a\r\nb');now=599;d.tick();events.push(d.state);now=600;d.tick();await Promise.resolve();d.setMarkdown('new');finish(note('title','a\nb'));await d.flush();events.push([d.title,d.markdown,d.note,d.state]);d.setMarkdown('error');try{await d.flush();}catch(e){events.push(String(e));}await d.flush();d.dispose();return events;
 }
 expect(await run(NoteDraftAutosave)).toEqual(await run(OldAutosave));
 const d=new NoteDraftAutosave({save:async value=>note(value.title??'',value.markdown)},null);d.setTitle('default');expect((await d.flush())?.title).toBe('default');
});
