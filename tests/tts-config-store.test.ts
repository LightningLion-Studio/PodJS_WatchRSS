import {expect,test} from 'bun:test';
import {TtsConfigStore} from '../src/tts/config-store.ts';

test('TTS config keeps provider keys in secure storage and only reveals a mask',async()=>{
 const plain=new Map<string,unknown>(),secret=new Map<string,string>();
 const store=new TtsConfigStore({get:<T>(key:string)=>plain.get(key) as T|undefined,set:(key,value)=>{plain.set(key,value);}}, {get:async key=>secret.get(key)??null,set:async(key,value)=>{secret.set(key,value);}});
 const request={engine:'minimax',model:'speech-2.8-hd',voiceId:'male-qn-qingse',speed:1.2,baseUrl:'https://api.minimaxi.com',apiKey:'my-secret-1234'};
 await store.save(request);
 expect(JSON.stringify([...plain])).not.toContain('my-secret');
 expect((await store.publicConfig()).apiKey).toBe('****1234');
 await store.save({...request,apiKey:'****1234',speed:1.3});
 expect(await store.apiKey('minimax')).toBe('my-secret-1234');
 expect(store.read().speed).toBe(1.3);
 await expect(store.save({...request,apiKey:'****wrong'})).rejects.toThrow();
 await expect(store.save({...request,baseUrl:'http://example.com'})).rejects.toThrow();
 await expect(store.save({...request,engine:'unexpected'})).rejects.toThrow();
 expect(await store.apiKey('minimax')).toBe('my-secret-1234');
});
test('TTS speed migrates from the existing settings and stays in sync after phone configuration',async()=>{
 const plain=new Map<string,unknown>([['watchrss.settings',{speechRate:1.4,fontSizeSp:14}]]);
 const store=new TtsConfigStore({get:<T>(key:string)=>plain.get(key) as T|undefined,set:(key,value)=>{plain.set(key,value);}}, {get:async()=>null,set:async()=>{}});
 expect(store.read().speed).toBe(1.4);
 store.setSpeed(1.5);expect(store.read().speed).toBe(1.5);
 await store.save({engine:'local',model:'',voiceId:'',speed:1.3,baseUrl:'',apiKey:''});
 expect((plain.get('watchrss.settings') as {speechRate:number;fontSizeSp:number}).speechRate).toBe(1.3);
 expect((plain.get('watchrss.settings') as {speechRate:number;fontSizeSp:number}).fontSizeSp).toBe(14);
});
