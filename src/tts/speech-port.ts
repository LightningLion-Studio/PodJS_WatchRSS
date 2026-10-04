import {audio,speech,fileChunks,bytesToBase64} from '@podjs/framework/services';
import type {SpeechPort} from '../reader/speech.ts';
import type {HttpTransport} from '../cloud/types.ts';
import {synthesizeCloudSpeech,type TtsAccount} from './cloud-synth.ts';
import {TtsConfigStore,type TtsConfig} from './config-store.ts';

export interface CloudSpeechHost {
 initializeLocal():Promise<unknown>;
 speakLocal(text:string,rate:number,id:string):Promise<unknown>;
 localState():Promise<{state:string}>;
 stopLocal():Promise<unknown>;
 onLocalProgress(listener:(event:{type:string;utteranceId:string;start?:number;end?:number;elapsedMs?:number})=>void):()=>void;
 temp():Promise<string>;
 write(path:string,data:Uint8Array):Promise<void>;
 remove(path:string):Promise<void>;
 play(path:string):Promise<unknown>;
 setSpeed(rate:number):Promise<unknown>;
 audioState():Promise<{state:string}>;
 stopAudio():Promise<unknown>;
}

export const hostCloudSpeech:CloudSpeechHost={
 initializeLocal:()=>speech.initializeLocal(),speakLocal:(text,rate,id)=>speech.speak(text,'',rate,id).result,
 localState:()=>speech.state(),stopLocal:()=>speech.stop(),onLocalProgress:listener=>speech.onProgress(listener),
 temp:async()=>(await fileChunks.createTemp('tts')).path,
 write:async(path,data)=>{await fileChunks.write(path,bytesToBase64(data));},
 remove:async path=>{await fileChunks.remove(path);},play:path=>audio.play(path).result,
 setSpeed:rate=>audio.setSpeed(rate),audioState:()=>audio.state(),stopAudio:()=>audio.stop()
};

/** Keeps the existing ReaderSpeech segment lifecycle while selecting the configured provider. */
export class ConfiguredSpeechPort implements SpeechPort {
 private generation=0;
 private config:TtsConfig={engine:'local',model:'',voiceId:'',speed:1,baseUrl:''};
 private file?:string;
 private utteranceId?:string;
 private startedAt=0;
 private completed=false;
 private readonly pendingPlays=new Set<Promise<unknown>>();
 private stopBarrier:Promise<unknown>=Promise.resolve();
 private listeners=new Set<(event:{type:string;utteranceId:string;start?:number;end?:number;elapsedMs?:number})=>void>();
 constructor(private readonly store:TtsConfigStore,private readonly transport:HttpTransport,private readonly account:()=>Promise<TtsAccount|null>,private readonly host:CloudSpeechHost=hostCloudSpeech){}
 private emit(type:string,id:string,elapsedMs=0){for(const listener of this.listeners)listener({type,utteranceId:id,elapsedMs});}
 async initialize(){this.config=this.store.read();if(this.config.engine==='local')return this.host.initializeLocal();}
 onProgress(listener:(event:{type:string;utteranceId:string;start?:number;end?:number;elapsedMs?:number})=>void){
  this.listeners.add(listener);const removeLocal=this.host.onLocalProgress(listener);return()=>{this.listeners.delete(listener);removeLocal();};
 }
 async speak(text:string,rate:number,id='speech'){
  const generation=++this.generation;await this.clearFile();this.completed=false;this.utteranceId=id;
  if(this.config.engine==='local')return this.host.speakLocal(text,rate,id);
  const bytes=await synthesizeCloudSpeech(this.transport,{config:this.config,apiKey:await this.store.apiKey(this.config.engine),account:this.config.engine==='backend_default'?await this.account():null,text,rate,requestId:String(Date.now())});
  if(generation!==this.generation)return;
  const path=await this.host.temp();
  if(generation!==this.generation){await this.host.remove(path);return;}
  this.file=path;
  try{
   await this.host.write(path,bytes);if(generation!==this.generation)return;
   await this.stopBarrier;if(generation!==this.generation)return;
   const playing=this.host.play(path);this.pendingPlays.add(playing);
   try{await playing;}finally{this.pendingPlays.delete(playing);}
   if(generation!==this.generation)return;
   await this.host.setSpeed(rate);if(generation!==this.generation)return;
   this.startedAt=Date.now();this.emit('start',id);
  }
  catch(error){await this.clearFile(path);throw error;}
 }
 async state():Promise<{state:string}>{
  if(this.config.engine==='local')return this.host.localState();
  if(!this.file)return {state:'ready'};
  const state=await this.host.audioState();
  if(state.state==='playing')return {state:'speaking'};
  if(state.state==='stopped'){
   if(!this.completed&&this.utteranceId){this.completed=true;this.emit('done',this.utteranceId,Math.max(0,Date.now()-this.startedAt));}
   await this.clearFile();return {state:'ready'};
  }
  return {state:state.state};
 }
 async stop(){
  const generation=++this.generation;
  if(this.config.engine==='local')await this.host.stopLocal();
  else {
   const previous=this.stopBarrier;
   this.stopBarrier=previous.then(async()=>{
    await Promise.allSettled([...this.pendingPlays]);
    await this.host.stopAudio().catch(()=>{});
   });
   await this.stopBarrier;
  }
  if(generation===this.generation){await this.clearFile();this.utteranceId=undefined;}
 }
 private async clearFile(path=this.file){if(!path)return;if(this.file===path)this.file=undefined;await this.host.remove(path).catch(()=>{});}
}
