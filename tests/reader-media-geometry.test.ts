import {expect,test} from 'bun:test';
import {parseContent,extractReadableHtml} from '../src/reader/content.ts';
import {createContentLayouter,contentAnchorAt,offsetForContentAnchor} from '../src/reader/content-layout.ts';
import {readerMediaRatio,readerMediaHeight} from '../src/reader/media-geometry.ts';
import type {ContentBlock} from '../src/reader/content.ts';
test('real-world lazy, percentage, CSS, srcset, WeChat and declared shapes reach reader blocks',()=>{
 const blocks=parseContent(`<img src="1x1.gif" data-src="portrait.jpg" width="1" height="1" data-w="900" data-ratio="1.5">
 <img src="square.jpg" width="100%" style="aspect-ratio: 1 / 1">
 <img src="panorama.jpg" style="width: 3000px; height: 300px">
 <img srcset="small.jpg 400w, big.jpg 1200w"><img data-original="36kr.jpg">`);
 expect(blocks.map(block=>block.type==='image'?readerMediaRatio(block):0)).toEqual([2/3,1,10,1,1]);
 expect(blocks.map(block=>block.type!=='text'?block.url:'')).toEqual(['portrait.jpg','square.jpg','panorama.jpg','big.jpg','36kr.jpg']);
 const readable=extractReadableHtml('<article><img src="loading.gif" data-src="/real.jpg" data-w="800" data-ratio="2"></article>','https://fixture.test/a')!;
 expect(parseContent(readable)[0]).toMatchObject({url:'https://fixture.test/real.jpg',width:800,height:1600});
});
test('decoded portrait, square, panorama and unknown dimensions override hints with viewport bounds',()=>{
 const shapes=[{width:900,height:1600},{width:900,height:900},{width:4000,height:200},{}];
 const blocks:ContentBlock[]=shapes.map(size=>({type:'image',url:'fixture.jpg',...size}));
 const layout=createContentLayouter(text=>text.length*8);
 const initial=layout(blocks,205,16,{},undefined,undefined,193);
 expect(initial.rows.map(row=>row.height-row.gap)).toEqual([193,193,32,193]);
 const actual=layout(blocks,205,16,{0:4,1:.5,2:1,3:2},undefined,undefined,193);
 expect(actual.rows.map(row=>row.height-row.gap)).toEqual([51.25,193,193,102.5]);
 expect(readerMediaRatio({type:'video',url:'v'})).toBe(16/9);
 expect(readerMediaHeight(blocks[0] as any,205,Infinity,193)).toBe(193);
 expect(readerMediaHeight(blocks[0] as any,205,1e100,193)).toBe(32);
});
test('ratio reflow preserves text and media anchors without wrapping text again',()=>{
 const blocks:ContentBlock[]=[{type:'image',url:'a'},{type:'text',style:'body',text:'Reading position '.repeat(200)},{type:'image',url:'b'}];
 let measurements=0;const layout=createContentLayouter(text=>{measurements++;return text.length*8;});
 const before=layout(blocks,205,16),calls=measurements,anchor=contentAnchorAt(before,400);
 const after=layout(blocks,205,16,{0:4});
 expect(measurements).toBe(calls);expect(contentAnchorAt(after,offsetForContentAnchor(after,anchor,Infinity))).toEqual(anchor);
 const media=contentAnchorAt(before,80);expect(contentAnchorAt(after,offsetForContentAnchor(after,media,Infinity))).toEqual(media);
});
