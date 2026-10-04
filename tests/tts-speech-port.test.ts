import {expect,test} from 'bun:test';
import {ReaderSpeech} from '../src/reader/speech.ts';
import {ConfiguredSpeechPort,type CloudSpeechHost} from '../src/tts/speech-port.ts';
import {TtsConfigStore} from '../src/tts/config-store.ts';
const bytes=(v:string)=>new TextEncoder().encode(v);
test('configured cloud speech plays a private audio file and completes ReaderSpeech lifecycle',async()=>{
 const plain=new Map<string,unknown>(),secrets=new Map<string,string>(),events:string[]=[];
 const store=new TtsConfigStore({get:<T>(key:string)=>plain.get(key) as T|undefined,set:(key,value)=>{plain.set(key,value);}}, {get:async key=>secrets.get(key)??null,set:async(key,value)=>{secrets.set(key,value);}});
 await store.save({engine:'minimax',model:'',voiceId:'',speed:1,baseUrl:'',apiKey:'secret'});
 let audioState='stopped';const host:CloudSpeechHost={
  initializeLocal:async()=>{},speakLocal:async()=>{},localState:async()=>({state:'ready'}),stopLocal:async()=>{},onLocalProgress:()=>()=>{},
  temp:async()=>{events.push('temp');return 'tts/private.part';},write:async(_path,data)=>{events.push('write:'+new TextDecoder().decode(data));},
  remove:async()=>{events.push('remove');},play:async()=>{events.push('play');audioState='playing';},
  setSpeed:async rate=>{events.push('speed:'+rate);},
  audioState:async()=>({state:audioState}),stopAudio:async()=>{audioState='stopped';}
 };
 const transport={request:async()=>({status:200,headers:{},body:bytes(JSON.stringify({data:{audio:'4d5033'}}))})};
 const port=new ConfiguredSpeechPort(store,transport,async()=>{throw Error('third-party speech must not read the watch account');},host);
 const progress:string[]=[];
 const reader=new ReaderSpeech(port,async()=>{audioState='stopped';});
 await reader.speak('你好',1,()=>events.push('started'),event=>progress.push(event.type));
 expect(events).toEqual(['temp','write:MP3','play','speed:1','started','remove']);
 expect(progress).toEqual(['start','done']);
 await reader.stop();
});
test('stopping during cloud synthesis cannot start stale audio',async()=>{
 const plain=new Map<string,unknown>();
 const store=new TtsConfigStore({get:<T>(key:string)=>plain.get(key) as T|undefined,set:(key,value)=>{plain.set(key,value);}}, {get:async()=>null,set:async()=>{}});
 await store.save({engine:'backend_default',model:'',voiceId:'',speed:1,baseUrl:'',apiKey:''});
 let finish!:(body:Uint8Array)=>void;
 const response=new Promise<Uint8Array>(resolve=>{finish=resolve;});
 let played=0,temporary=0;
 const host:CloudSpeechHost={initializeLocal:async()=>{},speakLocal:async()=>{},localState:async()=>({state:'ready'}),stopLocal:async()=>{},onLocalProgress:()=>()=>{},
  temp:async()=>{temporary++;return 'tts/stale.part';},write:async()=>{},remove:async()=>{},play:async()=>{played++;},setSpeed:async()=>{},audioState:async()=>({state:'stopped'}),stopAudio:async()=>{}};
 const port=new ConfiguredSpeechPort(store,{request:async()=>({status:200,headers:{},body:await response})},async()=>({backendBaseUrl:'https://example.test',watchDeviceToken:'test-token'}),host);
 await port.initialize();const pending=port.speak('你好',1,'stale');
 await port.stop();finish(bytes('{"audio":"4d5033"}'));await pending;
 expect(temporary).toBe(0);expect(played).toBe(0);
});
test('stop waits for a pending play command before stopping audio',async()=>{
 const plain=new Map<string,unknown>();
 const store=new TtsConfigStore({get:<T>(key:string)=>plain.get(key) as T|undefined,set:(key,value)=>{plain.set(key,value);}}, {get:async()=>null,set:async()=>{}});
 await store.save({engine:'backend_default',model:'',voiceId:'',speed:1,baseUrl:'',apiKey:''});
 let resolvePlay!:()=>void,signalPlay!:()=>void;
 const playStarted=new Promise<void>(resolve=>{signalPlay=resolve;});
 const playPending=new Promise<void>(resolve=>{resolvePlay=resolve;});
 const events:string[]=[];
 const host:CloudSpeechHost={initializeLocal:async()=>{},speakLocal:async()=>{},localState:async()=>({state:'ready'}),stopLocal:async()=>{},onLocalProgress:()=>()=>{},
  temp:async()=> 'tts/pending.part',write:async()=>{},remove:async()=>{events.push('remove');},
  play:async()=>{events.push('play');signalPlay();await playPending;events.push('playing');},
  setSpeed:async()=>{events.push('speed');},audioState:async()=>({state:'stopped'}),stopAudio:async()=>{events.push('stop');}};
 const port=new ConfiguredSpeechPort(store,{request:async()=>({status:200,headers:{},body:bytes('{"audio":"4d5033"}')})},async()=>({backendBaseUrl:'https://example.test',watchDeviceToken:'test-token'}),host);
 await port.initialize();const speaking=port.speak('你好',1,'pending');
 await playStarted;
 const stopping=port.stop();
 expect(events).toEqual(['play']);
 resolvePlay();await Promise.all([speaking,stopping]);
 expect(events).toEqual(['play','playing','stop','remove']);
});
test('a new utterance waits for the previous stop to finish',async()=>{
 const plain=new Map<string,unknown>();
 const store=new TtsConfigStore({get:<T>(key:string)=>plain.get(key) as T|undefined,set:(key,value)=>{plain.set(key,value);}}, {get:async()=>null,set:async()=>{}});
 await store.save({engine:'backend_default',model:'',voiceId:'',speed:1,baseUrl:'',apiKey:''});
 let resolveFirst!:()=>void,signalFirst!:()=>void;
 const firstStarted=new Promise<void>(resolve=>{signalFirst=resolve;});
 const firstPending=new Promise<void>(resolve=>{resolveFirst=resolve;});
 const events:string[]=[];let playCount=0;
 const host:CloudSpeechHost={initializeLocal:async()=>{},speakLocal:async()=>{},localState:async()=>({state:'ready'}),stopLocal:async()=>{},onLocalProgress:()=>()=>{},
  temp:async()=>`tts/${playCount}.part`,write:async()=>{},remove:async()=>{},
  play:async()=>{playCount++;events.push(`play${playCount}`);if(playCount===1){signalFirst();await firstPending;}},
  setSpeed:async()=>{},audioState:async()=>({state:'playing'}),stopAudio:async()=>{events.push('stop');}};
 const port=new ConfiguredSpeechPort(store,{request:async()=>({status:200,headers:{},body:bytes('{"audio":"4d5033"}')})},async()=>({backendBaseUrl:'https://example.test',watchDeviceToken:'test-token'}),host);
 await port.initialize();const old=port.speak('旧',1,'old');await firstStarted;
 const stopping=port.stop();const newer=port.speak('新',1,'new');
 expect(events).toEqual(['play1']);
 resolveFirst();await Promise.all([old,stopping,newer]);
 expect(events).toEqual(['play1','stop','play2']);
});
