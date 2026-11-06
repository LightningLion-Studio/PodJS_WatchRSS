import {expect,test} from 'bun:test';
import {adjacentPageTextOptions} from '../src/reader/page-text-prefetch.ts';
import {readerTextLineOptions} from '../src/reader/system-text.ts';
import {defaultReaderPreset} from '../src/reader/preset.ts';
import type {BookPage} from '../src/reader/pagination.ts';
import type {ContentBlock} from '../src/reader/content.ts';

const blocks:ContentBlock[]=[{type:'text',style:'body',text:'正文'}];
const page=(text:string,width=128):BookPage=>({anchor:{section:'body',character:0,blockIndex:0,sourceStart:0,sectionOffset:0},lines:[{row:{kind:'text',text,top:0,height:23,lineHeight:23,gap:0,blockIndex:0,character:0,fontSlot:2,scale:1,color:'#ffffffff',nativeBaseline:18},left:12,top:12,width}]});
const environment={rasterSupported:true,pixelScale:2,fontMetrics:()=>({cellWidth:14,cellHeight:18,baseline:14,lineHeight:23,rasterDensity:2})};
const fonts=()=>({fontPath:'reader_assets/fonts/font.ttc',fontFaceIndex:2,variationSettings:"'wght' 630",fontRevision:'revision-1'});
test('adjacent pages use exactly the visible line raster identity and geometry',()=>{
 const preset=defaultReaderPreset(),pages=[page('前'),page('中'),page('后',117),page('远')];
 const options=adjacentPageTextOptions(pages,1,blocks,14,preset,fonts,environment);
 expect(options.map(o=>o.text)).toEqual(['后','前']);
 for(const [i,p]of [[0,pages[2]!],[1,pages[0]!]]as const){const row=p.lines[0]!.row;if(row.kind!=='text')throw Error('text fixture');expect(options[i]).toEqual(readerTextLineOptions(row,'body',14,p.lines[0]!.width,2,preset,environment.fontMetrics(),fonts));}
 expect(options[0]).toMatchObject({heightPx:46,widthPx:234,fontPath:'reader_assets/fonts/font.ttc',fontFaceIndex:2,fontRevision:'revision-1'});
});
test('prefetch skips missing pages, unloaded chunks and unsupported raster hosts',()=>{
 const pages=[page('甲'),{...page(''),lines:[],loading:4},page('乙')];
 expect(adjacentPageTextOptions(pages,0,blocks,14,defaultReaderPreset(),fonts,environment)).toEqual([]);
 expect(adjacentPageTextOptions(pages,1,blocks,14,defaultReaderPreset(),fonts,{...environment,rasterSupported:false})).toEqual([]);
 expect(adjacentPageTextOptions([page('甲')],0,blocks,14,undefined,fonts,environment)).toEqual([]);
});
