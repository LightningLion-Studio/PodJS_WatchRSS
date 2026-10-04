/** Exercises the actual compiled component with controlled host completions; no device or GPU. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {transformSync} from '@babel/core';
import solidPreset from 'babel-preset-solid';
import tsPreset from '@babel/preset-typescript';
import * as solid from 'solid-js/dist/solid.js';
const input=readFileSync(new URL('../../src/ui/BeianQrSurface.tsx',import.meta.url),'utf8');
const compiled=transformSync(input,{filename:'BeianQrSurface.tsx',presets:[[solidPreset,{generate:'universal',moduleName:'test-renderer'}],[tsPreset,{allExtensions:true,isTSX:true}]],babelrc:false,configFile:false})!.code!;
const body=compiled.replace(/^import .*?;\n/gm,'').replace('export function BeianQrSurface','function BeianQrSurface');
const factory=new Function('MediaSurface','delay','mediaSurfaces','createEffect','createSignal','onCleanup','Show','createBeianQrSource','_$createComponent',body+'\nreturn BeianQrSurface;');
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function drain(){for(let i=0;i<14;i++)await Promise.resolve();}
function harness(){
 const source=deferred<string>(),state=deferred<any>(),timers:any[]=[],captured:any[]=[];
 let dispose!:()=>void,sourceCloses=0,errors=0,ready=0,reads=0;
 const delay=(milliseconds:number)=>{const pending=deferred<void>();const timer={milliseconds,pending,cancels:0,result:pending.promise,cancel(){this.cancels++;pending.reject(Error('cancelled'));}};timers.push(timer);return timer;};
 const Component=factory((props:any)=>{captured.push(props);return null;},delay,{state(){reads++;return state.promise;}},solid.createEffect,solid.createSignal,solid.onCleanup,solid.Show,()=>({result:source.promise,close(){sourceCloses++;}}),solid.createComponent);
 solid.createRoot(end=>{dispose=end;Component({bitmapSize:240,density:2,blurPx:36,brightness:.412862745,active:true,onReady(){ready++;},onError(){errors++;}});});
 return {source,state,timers,captured,dispose,get sourceCloses(){return sourceCloses;},get errors(){return errors;},get ready(){return ready;},get reads(){return reads;},async mount(){source.resolve('beian-qr/.pod-write-probe.part');await drain();assert.equal(captured.length,1);return captured[0];}};
}
let checks=0;const eq=(actual:unknown,expected:unknown)=>{assert.deepEqual(actual,expected);checks++;};
const warnings:unknown[][]=[],warn=console.warn;console.warn=(...args)=>warnings.push(args);
try{
 {const h=harness();h.dispose();h.source.resolve('beian-qr/.pod-write-late.part');await drain();eq(h.sourceCloses,1);eq(h.captured.length,0);eq(h.errors,0);}
 {const h=harness();h.dispose();h.source.reject(Error('late source'));await drain();eq(h.errors,0);eq(h.captured.length,0);}
 {const h=harness();h.source.reject(Error('source failed'));await drain();eq(h.errors,1);eq(h.captured.length,0);h.dispose();eq(h.sourceCloses,1);}
 {const h=harness(),p=await h.mount();p.onState({id:'surface',state:'loading'});eq(h.timers.map(t=>t.milliseconds),[5000,16]);h.timers[1].pending.resolve();await drain();eq(h.reads,1);h.timers[0].pending.resolve();await drain();eq(h.errors,1);eq(h.ready,0);eq(h.timers[1].cancels,1);h.state.resolve({id:'surface',state:'ready'});await drain();p.onError(Error('late failure'));p.onState({id:'surface',state:'loading'});eq(h.errors,1);eq(h.ready,0);eq(h.timers.length,2);h.dispose();}
 {const h=harness(),p=await h.mount();p.onState({id:'surface',state:'loading'});p.onState({id:'surface',state:'ready'});p.onState({id:'surface',state:'ready'});await drain();eq(h.ready,1);eq(h.errors,0);eq(h.reads,0);eq(h.timers.map(t=>t.cancels),[1,1]);h.dispose();}
 {const h=harness(),p=await h.mount();p.onState({id:'surface',state:'loading'});h.timers[1].pending.resolve();await drain();h.state.resolve({id:'surface',state:'ready'});await drain();eq(h.ready,1);eq(h.errors,0);eq(h.timers[0].cancels,1);p.onError(Error('update failed'));p.onError(Error('duplicate'));eq(h.errors,1);h.dispose();}
 {const h=harness(),p=await h.mount();p.onState({id:'surface',state:'loading'});p.onError(Error('native failed'));await drain();eq(h.errors,1);eq(h.timers.map(t=>t.cancels),[1,1]);p.onState({id:'surface',state:'ready'});eq(h.ready,0);h.dispose();}
 {const h=harness(),p=await h.mount();p.onState({id:'surface',state:'loading'});h.timers[1].pending.resolve();await drain();h.state.reject(Error('state failed'));await drain();eq(h.errors,1);eq(h.timers[0].cancels,1);h.dispose();}
 {const h=harness(),p=await h.mount();p.onState({id:'surface',state:'loading'});h.timers[1].pending.resolve();await drain();h.dispose();h.state.reject(Error('state after disposal'));await drain();p.onError(Error('callback after disposal'));p.onState({id:'surface',state:'ready'});eq(h.errors,0);eq(h.ready,0);eq(h.sourceCloses,1);eq(h.timers.map(t=>t.cancels),[1,1]);}
 {const h=harness(),p=await h.mount();p.onState({id:'surface',state:'loading'});h.dispose();await drain();eq(h.errors,0);eq(h.reads,0);eq(h.timers.map(t=>t.cancels),[1,1]);}
 eq(warnings.length,5);
 console.warn=warn;console.log(JSON.stringify({scenarios:10,assertions:checks,success:true,source:'actual BeianQrSurface.tsx compiled in-memory using Solid universal preset',device:false}));
}catch(error){console.warn=warn;throw error;}
