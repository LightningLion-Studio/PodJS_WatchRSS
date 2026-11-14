import {expect,mock,test} from 'bun:test';
import {plugin} from 'bun';
import {createRequire} from 'node:module';
import {createComponent,createMemo,createRenderEffect,createRoot,createSignal,mergeProps} from 'solid-js';
const require=createRequire(import.meta.url),{transformSync}=require('@babel/core');
plugin({name:'speech-work-review',setup(b){b.onLoad({filter:/\/ui\/SpeechPlaybackScreen\.tsx$/},async args=>({contents:transformSync(await Bun.file(args.path).text(),{filename:args.path,babelrc:false,configFile:false,presets:[[require('babel-preset-solid'),{generate:'universal',moduleName:'@pocketjs/framework/renderer'}],[require('@babel/preset-typescript'),{isTSX:true,allExtensions:true}]]}).code,loader:'js'}));}});
mock.module('@pocketjs/framework/renderer',()=>({createComponent,mergeProps,memo:createMemo,effect:createRenderEffect}));
mock.module('@pocketjs/framework/components',()=>Object.fromEntries(['View','Text','Image'].map(kind=>[kind,(props:any)=>({kind,props})])));
mock.module('@pocketjs/framework/gesture',()=>({createGesture:()=>({dispose(){}})}));
mock.module('@pocketjs/framework/host',()=>({getOps:()=>({measureText:()=>20})}));
mock.module('@pocketjs/framework/input',()=>({hitNode(){},pressNode(){}}));
let phase='active';const listeners=new Set<(s:string)=>void>();
mock.module('@podjs/framework/watch',()=>({lifecycle:()=>phase,onLifecycleChange:(f:any)=>{listeners.add(f);return()=>listeners.delete(f);},onRawScrollInput:()=>()=>{},getDisplayMetrics:()=>({shape:'rect'})}));
mock.module('@podjs/framework/services',()=>({mediaVolume:{},delay:()=>({result:new Promise(()=>{}),cancel(){}}),hostOperation:()=>({result:Promise.resolve(),cancel(){}})}));
mock.module('../src/reader/speech-playback',()=>({speechPlaybackStatus:()=>''}));
const {SpeechPlaybackScreen}=await import('../src/ui/SpeechPlaybackScreen');
const {playbackWork}=await import('../src/core/playback-work');
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
test('speech route releases on hide, background, playback error and disposal, then reacquires',async()=>{
 let dispose=()=>{},setActive!:(v:boolean)=>void,setState!:(v:any)=>void;
 try{
  createRoot(stop=>{dispose=stop;const [active,changeActive]=createSignal(true),[state,changeState]=createSignal<any>({playing:true,rate:1});setActive=changeActive;setState=changeState;
   SpeechPlaybackScreen({width:233,height:233,get active(){return active();},get state(){return state();},volumeEnabled:false,volumeGuard:false,onToggle(){},onPrevious(){},onNext(){},onStop(){},onAutoAdvance(){},onRate(){},currentArticleActionText:'返回文章',onOpenCurrentArticle(){}});
  });await flush();expect(playbackWork.active).toBe(true);
  setActive(false);await flush();expect(playbackWork.active).toBe(false);setActive(true);await flush();expect(playbackWork.active).toBe(true);
  phase='background';for(const f of listeners)f(phase);await flush();expect(playbackWork.active).toBe(false);
  phase='active';for(const f of listeners)f(phase);await flush();expect(playbackWork.active).toBe(true);
  setState({playing:false,rate:1,error:'synthetic playback failure'});await flush();expect(playbackWork.active).toBe(false);
  setState({playing:true,rate:1});await flush();expect(playbackWork.active).toBe(true);
 }finally{dispose();expect(playbackWork.active).toBe(false);expect(listeners.size).toBe(0);}
});
