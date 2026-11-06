import {afterEach, expect, mock, test} from 'bun:test';
import {createRoot, createSignal, type Setter} from 'solid-js';
import type {TextEnvironment, TextLayoutLine, TextLayoutOptions} from '@podjs/framework/services';

interface Deferred<T> {promise:Promise<T>;resolve:(value:T)=>void}
function deferred<T>():Deferred<T> {
 let resolve!:(value:T)=>void;
 const promise=new Promise<T>(done=>{resolve=done;});
 return {promise,resolve};
}
interface LayoutRequest extends Deferred<{lines:TextLayoutLine[]}> {
 options:TextLayoutOptions;
 cancel:ReturnType<typeof mock<()=>void>>;
}
const environments:Deferred<TextEnvironment>[]=[];
const layouts:LayoutRequest[]=[];
const capabilities=new Set(['text.layout','text.raster','text.environment']);

// Only host and rendering boundaries are mocked. The actual hook, its Compose
// conversion, and Solid ownership/effects run under Bun's browser condition.
mock.module('@pocketjs/framework/components',()=>({View:()=>null,Text:()=>null}));
mock.module('@podjs/framework/text',()=>({SystemTextLine:()=>null}));
mock.module('@podjs/framework/watch',()=>({hasCapability:(name:string)=>capabilities.has(name)}));
mock.module('@podjs/framework/services',()=>({textLayout:{
 environment:()=>{const request=deferred<TextEnvironment>();environments.push(request);return request.promise;},
 layout:(options:TextLayoutOptions)=>{
  const request:LayoutRequest={...deferred<{lines:TextLayoutLine[]}>(),options:{...options},cancel:mock(()=>{})};
  layouts.push(request);
  // Cancellation deliberately does not settle the promise. Tests can deliver
  // a host result afterwards and exercise the production stale-result guard.
  return {result:request.promise,cancel:request.cancel};
 },
}}));

const {useBeianText}=await import('../src/ui/BeianText.tsx');
const disposers:Array<()=>void>=[];
afterEach(()=>{
 while(disposers.length)disposers.pop()!();
 layouts.length=0;environments.length=0;
 capabilities.clear();for(const name of ['text.layout','text.raster','text.environment'])capabilities.add(name);
});
const settle=()=>new Promise<void>(resolve=>setTimeout(resolve,0));
function mount(initialWidth=233) {
 let text!:ReturnType<typeof useBeianText>,setWidth!:Setter<number>,dispose!:()=>void;
 createRoot(cleanup=>{
  let disposed=false;dispose=()=>{if(!disposed){disposed=true;cleanup();}};disposers.push(dispose);
  const [width,changeWidth]=createSignal(initialWidth);setWidth=changeWidth;text=useBeianText(width,2);
 });
 return {...text,setWidth,dispose};
}
function environment(index:number,fontScale:number) {
 environments[index]!.resolve({density:2,fontScale,spValuesPx:[]});
}
function reply(request:LayoutRequest,heightPx:number,baselinePx:number,topPx=7) {
 request.resolve({lines:[{start:0,end:request.options.text.length,visibleEnd:request.options.text.length,topPx,bottomPx:topPx+heightPx,baselinePx:topPx+baselinePx}]});
}

// Fixed results from the Compose 1.7.1 ui-unit/ui-text AAR oracle, density=2.
// tests/compose-font-scale.test.ts records the AAR hashes and reflection entry
// points; its scale-1.3 canonical row and actual 21->26->12->14 call order agree.
// These are exact Float values expanded to JS numbers, not outputs calculated
// using composeSpToPx/composeLineHeightPx by the test itself.
const nativeSizes=[
 {fontScale:1,titleSize:42,titleLineHeight:52,subtitleSize:24,subtitleLineHeight:28},
 {fontScale:1.3,titleSize:48.599998474121094,titleLineHeight:60.17143630981445,subtitleSize:31.200000762939453,subtitleLineHeight:36.400001525878906},
] as const;
function expectedOptions(text:string,widthPx:number,fontSizePx:number,lineHeightPx:number,colorArgb:number):TextLayoutOptions {
 return {text,widthPx,fontWeight:400,fontSizePx,lineHeightPx,lineHeightMode:'span',fallbackLineSpacing:true,lineBreak:'simple',align:'center',textMotion:'static',colorArgb};
}

for(const native of nativeSizes)test(`fontScale ${native.fontScale} sends exact native typography and the original 400-weight asset`,async()=>{
 const hook=mount();expect(environments).toHaveLength(1);expect(layouts).toHaveLength(0);
 expect(hook.widthPx()).toBe(394);expect(hook.title()).toEqual({heightPx:52});expect(hook.subtitle()).toEqual({heightPx:28});
 environment(0,native.fontScale);await settle();expect(layouts).toHaveLength(2);
 const [title,subtitle]=layouts as [LayoutRequest,LayoutRequest];
 expect(title.options).toEqual(expectedOptions('工信部备案',394,native.titleSize,native.titleLineHeight,0xfff5f5f5));
 expect(subtitle.options).toEqual(expectedOptions('beian.miit.gov.cn',394,native.subtitleSize,native.subtitleLineHeight,0xffb6b6b6));
 reply(title,43,34);reply(subtitle,25,19,11);await settle();
 expect(hook.title()).toEqual({heightPx:43,options:{...title.options,heightPx:43,baselinePx:34,paragraph:{...title.options,lineIndex:0}}});
 expect(hook.subtitle()).toEqual({heightPx:25,options:{...subtitle.options,heightPx:25,baselinePx:19,paragraph:{...subtitle.options,lineIndex:0}}});
});

test('disposing while text environment is pending never submits either layout',async()=>{
 const hook=mount();expect(environments).toHaveLength(1);expect(layouts).toHaveLength(0);
 hook.dispose();environment(0,1.3);await settle();
 expect(layouts).toHaveLength(0);expect(hook.title()).toEqual({heightPx:52});expect(hook.subtitle()).toEqual({heightPx:28});
});

test('disposing submitted layouts cancels both and late host replies cannot publish a partial or complete pair',async()=>{
 const hook=mount();environment(0,1);await settle();expect(layouts).toHaveLength(2);
 const [title,subtitle]=layouts as [LayoutRequest,LayoutRequest];
 reply(title,91,70);await settle();
 expect(hook.title()).toEqual({heightPx:52});expect(hook.subtitle()).toEqual({heightPx:28});
 hook.dispose();expect(title.cancel).toHaveBeenCalledTimes(1);expect(subtitle.cancel).toHaveBeenCalledTimes(1);
 reply(subtitle,77,61);await settle();
 expect(hook.title()).toEqual({heightPx:52});expect(hook.subtitle()).toEqual({heightPx:28});
});

test('a width change ignores an old pending environment before creating layout requests',async()=>{
 const hook=mount();hook.setWidth(201);expect(environments).toHaveLength(2);
 environment(0,1.3);await settle();expect(layouts).toHaveLength(0);
 environment(1,1);await settle();expect(layouts).toHaveLength(2);expect(hook.widthPx()).toBe(330);
 const [title,subtitle]=layouts as [LayoutRequest,LayoutRequest];
 expect(title.options).toEqual(expectedOptions('工信部备案',330,42,52,0xfff5f5f5));
 expect(subtitle.options).toEqual(expectedOptions('beian.miit.gov.cn',330,24,28,0xffb6b6b6));
 reply(title,41,33);reply(subtitle,24,18);await settle();
 expect(hook.title().options?.widthPx).toBe(330);expect(hook.subtitle().options?.paragraph?.widthPx).toBe(330);
});

test('a width change cancels the old layouts and their late results cannot overwrite newer measured lines',async()=>{
 const hook=mount();environment(0,1);await settle();
 const [oldTitle,oldSubtitle]=layouts as [LayoutRequest,LayoutRequest];
 hook.setWidth(173);expect(oldTitle.cancel).toHaveBeenCalledTimes(1);expect(oldSubtitle.cancel).toHaveBeenCalledTimes(1);
 expect(hook.title()).toEqual({heightPx:52});expect(hook.subtitle()).toEqual({heightPx:28});
 environment(1,1.3);await settle();expect(layouts).toHaveLength(4);
 const title=layouts[2]!,subtitle=layouts[3]!;
 expect(title.options).toEqual(expectedOptions('工信部备案',274,48.599998474121094,60.17143630981445,0xfff5f5f5));
 expect(subtitle.options).toEqual(expectedOptions('beian.miit.gov.cn',274,31.200000762939453,36.400001525878906,0xffb6b6b6));
 reply(title,63,48);reply(subtitle,37,28);await settle();
 const publishedTitle=hook.title(),publishedSubtitle=hook.subtitle();
 expect(publishedTitle.heightPx).toBe(63);expect(publishedSubtitle.heightPx).toBe(37);
 reply(oldTitle,21,16);reply(oldSubtitle,13,9);await settle();
 expect(hook.title()).toBe(publishedTitle);expect(hook.subtitle()).toBe(publishedSubtitle);
 expect(hook.title().options?.paragraph?.widthPx).toBe(274);expect(hook.subtitle().options?.widthPx).toBe(274);
 expect(title.cancel).not.toHaveBeenCalled();expect(subtitle.cancel).not.toHaveBeenCalled();
});

test('a host without text.environment keeps the supported scale-one layout path',async()=>{
 capabilities.delete('text.environment');mount();await settle();
 expect(environments).toHaveLength(0);expect(layouts).toHaveLength(2);
 expect(layouts[0]!.options).toEqual(expectedOptions('工信部备案',394,42,52,0xfff5f5f5));
 expect(layouts[1]!.options).toEqual(expectedOptions('beian.miit.gov.cn',394,24,28,0xffb6b6b6));
});
