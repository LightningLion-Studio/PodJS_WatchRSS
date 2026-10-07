import {expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {dirname} from 'node:path';
import * as solid from 'solid-js';
const {createComponent,createMemo,createRenderEffect,mergeProps,createRoot,createSignal}=solid;
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'image-parity',setup(builder){builder.onLoad({filter:/\/(RemoteImage|RemoteImage-u3-before|image)\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
type Element={kind:string;props:any;children:any};
const element=(kind:string)=>(props:any):Element=>({kind,props,children:props.children});
const primitives={Image:element('Image'),View:element('View')};
const renderer={createComponent,mergeProps,memo:createMemo,effect:createRenderEffect};
mock.module('@pocketjs/framework/components',()=>primitives);
mock.module('@pocketjs/framework/renderer',()=>renderer);
const frameworkDir=dirname(realpathSync(Bun.resolveSync('@podjs/framework/image',import.meta.dir)));
mock.module(Bun.resolveSync('solid-js',frameworkDir),()=>solid);
mock.module(Bun.resolveSync('@pocketjs/framework/components',frameworkDir),()=>primitives);
mock.module(Bun.resolveSync('@pocketjs/framework/renderer',frameworkDir),()=>renderer);
const {RemoteImage:before}=await import('./fixtures/RemoteImage-u3-before.tsx');
const {RemoteImage:after}=await import('../src/ui/RemoteImage.tsx');
function snapshot(node:Element):unknown {
 const styles:Record<string,unknown>={};const classes=String(node.props.class??'').split(' ');
 if(classes.includes('relative'))styles.posType=0;if(classes.includes('absolute'))styles.posType=1;if(classes.includes('overflow-hidden'))styles.overflow=1;
 Object.assign(styles,node.props.style);
 return {kind:node.kind,class:classes.filter(x=>!['relative','absolute','overflow-hidden'].includes(x)).join(' '),styles,children:node.children?Array.isArray(node.children)?node.children.map(snapshot):snapshot(node.children):null};
}
test('stretch cover contain preserve node tree, caller styles, crop and reactive dimensions',()=>{
 for(const fit of [undefined,'stretch','cover','contain'] as const){
  const [width,setWidth]=createSignal(90),[height,setHeight]=createSignal(50);let dispose!:()=>void;
  createRoot(end=>{dispose=end;const props={url:'',get width(){return width();},get height(){return height();},fit,class:'rounded'};
   const a=before(props) as unknown as Element,b=after(props) as unknown as Element;
   expect(snapshot(b)).toEqual(snapshot(a));setWidth(160);setHeight(80);expect(snapshot(b)).toEqual(snapshot(a));
  });dispose();
 }
});
