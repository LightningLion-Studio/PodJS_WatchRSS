import {expect,test} from 'bun:test';
import {readerFontResolver} from '../src/reader/font-assets.ts';
import {defaultReaderPreset,resolvedReaderStyle} from '../src/reader/preset.ts';
import {requestReaderLayout} from '../src/reader/platform-layout.ts';
import {systemTextOptions,requiresReaderSystemText} from '../src/reader/system-text.ts';
import {requestWatchTitleLines} from '../src/reader/platform-title.ts';
import {watchTitleLines} from '../src/reader/measured-text.ts';
import type {ContentBlock} from '../src/reader/content.ts';
const assets={fonts:[{id:'serif',fileName:'serif.ttc',sha256:'one',updatedAt:1,deleted:false},{id:'gone',fileName:'gone.ttf',deleted:true},{id:'bad',fileName:'../outside.ttf',deleted:false}],backgrounds:[],deletions:[]};
test('live fonts resolve safely by asset identity and resource changes invalidate line caching',()=>{
 const p=defaultReaderPreset();p.body.fontAssetId='serif';p.body.fontFaceIndex=2;p.body.variationSettings="'wght' 650";
 const resolve=readerFontResolver({assets});expect(resolve(p.body)).toMatchObject({fontPath:'reader_assets/fonts/serif.ttc',fontFaceIndex:2,variationSettings:"'wght' 650"});
 expect(readerFontResolver({assets},1)(p.body).fontRevision).not.toBe(resolve(p.body).fontRevision);
 for(const id of ['gone','bad','missing'])expect(resolve({...p.body,fontAssetId:id}).fontPath).toBeUndefined();
 p.categoryTypographyEnabled=true;p.title={useOwnFont:true,fontAssetId:null};expect(resolve(resolvedReaderStyle(p,'title')).fontPath).toBeUndefined();
});
test('native paragraph and pixel requests select identical category font properties',async()=>{
 const p=defaultReaderPreset();p.body.fontAssetId='serif';p.body.fontFaceIndex=1;p.body.variationSettings="'wght' 600";p.body.underline=true;p.body.strikethrough=true;p.categoryTypographyEnabled=true;p.title={fontWeight:650,fontSizeSp:22};
 const resolve=readerFontResolver({assets}),block:ContentBlock={type:'text',style:'title',text:'Font title'},requests:any[]=[];
 await requestReaderLayout([block],200,14,2,p,args=>{requests.push(args);return {result:Promise.resolve({lines:[{start:0,end:10,visibleEnd:10}]}),cancel(){}};},()=>{},error=>{throw error;},resolve).done;
 expect(requests).toHaveLength(1);expect(requests[0]).toMatchObject({fontPath:'reader_assets/fonts/serif.ttc',fontFaceIndex:1,variationSettings:"'wght' 600",fontWeight:650,fontSizePx:44});
 const pixels=systemTextOptions({kind:'text',text:'Font title',top:0,height:30,lineHeight:30,gap:0,blockIndex:0,character:0,fontSlot:1,scale:1,color:'#ffffffff'},'title',14,200,2,p,undefined,resolve);
 expect(pixels).toMatchObject({underline:true,strikethrough:true});
 for(const key of ['fontPath','fontFaceIndex','variationSettings','fontWeight','fontSizePx'] as const)expect(pixels[key]).toBe(requests[0][key]);
 expect(requiresReaderSystemText('plain Latin',p,'title')).toBe(true);p.body.fontAssetId=null;p.body.variationSettings='';expect(requiresReaderSystemText('plain Latin',p)).toBe(true);expect(requiresReaderSystemText('plain Latin')).toBe(false);
});
test('asynchronous title font measurements preserve synchronous native-title planning',async()=>{
 for(const text of ['阅读 让时间慢下来','Variable Font WWW iii','A😀B👩‍💻 title','甲乙丙丁戊己庚辛壬癸']){
  const measure=(s:string)=>Array.from(s).reduce((n,c)=>n+(c==='W'?21:c==='i'?4:13),0);let result:string[]=[];
  await requestWatchTitleLines(text,180,2,t=>({result:Promise.resolve({widthPx:measure(t)*2}),cancel(){}}),v=>result=v,error=>{throw error;}).done;
  expect(result).toEqual(watchTitleLines(text,180,measure));
 }
});
test('cancelled title measurement cannot publish or continue its plan',async()=>{
 let resolve!:(value:{widthPx:number})=>void,cancelled=0,calls=0,published=0;
 const task=requestWatchTitleLines('ABCDEFGHIJKLMN',100,1,()=>{calls++;return {result:new Promise(r=>resolve=r),cancel(){cancelled++;}};},()=>published++,()=>{});
 task.cancel();resolve({widthPx:20});await task.done;expect([calls,cancelled,published]).toEqual([1,1,0]);
});

test('custom title speech highlights use shaped caret coordinates',async()=>{
 const {titleHighlightRects}=await import('../src/reader/speech-highlight-layout.ts');
 const highlight={isTitle:true,sourceStart:1,sourceEnd:3} as import('../src/reader/speech-highlight.ts').SpeechHighlight;
 expect(titleHighlightRects('ABCD',['ABCD'],highlight,200,{fontSlot:1,scale:1,lineHeight:20},()=>1,[{top:5,height:24}],[[40,51,78,93,130]])).toEqual([{left:51,top:5,width:42,height:24}]);
});
