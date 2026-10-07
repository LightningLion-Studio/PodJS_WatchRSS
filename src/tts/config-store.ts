import {debugGate} from '../debug/host.ts';
import {kv} from '@podjs/framework/watch';
import {secureStorage} from '@podjs/framework/services';

export type TtsEngine='local'|'backend_default'|'minimax'|'azure'|'doubao';
export interface TtsConfig {engine:TtsEngine;model:string;voiceId:string;speed:number;baseUrl:string}
export interface TtsConfigInput extends TtsConfig {apiKey:string}
export interface TtsConfigPublic extends TtsConfig {apiKey:string}
export interface TtsConfigStorage {
 get<T>(key:string):T|undefined;
 set<T>(key:string,value:T):void;
}
export interface TtsSecretStorage {get(key:string):Promise<string|null|undefined>;set(key:string,value:string):Promise<void>}
const KEY='watchrss.tts.config.v1';
const SECRET_PREFIX='watchrss.tts.api-key.';
const engines=new Set<string>(['local','backend_default','minimax','azure','doubao']);
const keyRequired=(engine:TtsEngine)=>engine==='minimax'||engine==='azure'||engine==='doubao';
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max?value.trim():null;
const masked=(key:string)=>key?key.length<=4?'****':`****${key.slice(-4)}`:'';

export class TtsConfigStore {
 constructor(private readonly storage:TtsConfigStorage=kv,private readonly secrets:TtsSecretStorage=secureStorage){}
 read():TtsConfig {
  const raw=this.storage.get<Partial<TtsConfig>>(KEY);
  if(!raw||!engines.has(String(raw.engine))){const legacy=this.storage.get<{speechRate?:number}>('watchrss.settings');const speed=legacy?.speechRate;return {engine:'local',model:'',voiceId:'',speed:typeof speed==='number'&&Number.isFinite(speed)&&speed>=0.5&&speed<=2?speed:1,baseUrl:''};}
  return {engine:raw.engine as TtsEngine,model:text(raw.model,256)??'',voiceId:text(raw.voiceId,256)??'',speed:typeof raw.speed==='number'&&Number.isFinite(raw.speed)&&raw.speed>=0.5&&raw.speed<=2?raw.speed:1,baseUrl:text(raw.baseUrl,1024)??''};
 }
 async publicConfig():Promise<TtsConfigPublic>{const config=this.read();const key=keyRequired(config.engine)?await this.secrets.get(SECRET_PREFIX+config.engine):'';return {...config,apiKey:masked(key??'')};}
 async apiKey(engine:TtsEngine):Promise<string>{return keyRequired(engine)?(await this.secrets.get(SECRET_PREFIX+engine))??'':'';}
 selectDebugEngine(engine:TtsEngine,defaults:Pick<TtsConfig,'model'|'voiceId'|'baseUrl'>){debugGate.require();if(!engines.has(engine))throw Error('语音引擎无效');const config={...this.read(),...defaults,engine};this.storage.set(KEY,config);return config;}
 /** Debug editor permits incomplete configs, just like native per-field updates. */
 updateDebugField(field:'model'|'voiceId'|'baseUrl',value:string){
  debugGate.require();if(!['model','voiceId','baseUrl'].includes(field)||typeof value!=='string'||value.length>(field==='baseUrl'?1024:256))throw Error('配置字段无效');
  const config={...this.read(),[field]:value};this.storage.set(KEY,config);return config;
 }
 async setDebugApiKey(engine:TtsEngine,value:string){debugGate.require();if(!engines.has(engine)||!keyRequired(engine)||typeof value!=='string'||value.length>4096)throw Error('API Key 无效');await this.secrets.set(SECRET_PREFIX+engine,value);}
 setSpeed(speed:number){if(!Number.isFinite(speed)||speed<0.5||speed>2)throw new Error('语速无效');this.storage.set(KEY,{...this.read(),speed});}
 private async prepare(input:unknown):Promise<{config:TtsConfig;apiKeyToSave?:string}>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('配置格式无效');
  const value=input as Record<string,unknown>;
  if(typeof value.engine!=='string'||!engines.has(value.engine))throw new Error('语音引擎无效');
  const engine=value.engine as TtsEngine,model=text(value.model,256),voiceId=text(value.voiceId,256),baseUrl=text(value.baseUrl,1024),apiKey=text(value.apiKey,4096);
  if(model===null||voiceId===null||baseUrl===null||apiKey===null)throw new Error('配置字段无效');
  if(typeof value.speed!=='number'||!Number.isFinite(value.speed)||value.speed<0.5||value.speed>2)throw new Error('语速无效');
  if(baseUrl&&(!/^https:\/\//i.test(baseUrl)||/\s/.test(baseUrl)))throw new Error('服务地址必须使用 HTTPS');
  let apiKeyToSave:string|undefined;
  if(keyRequired(engine)){
   const existing=await this.apiKey(engine);
   if(apiKey.startsWith('****')){if(apiKey!==masked(existing)||!existing)throw new Error('API Key 无效');}
   else if(apiKey)apiKeyToSave=apiKey;
   else if(!existing)throw new Error('apiKey 不能为空');
  }
  const config:TtsConfig={engine,model:engine==='local'||engine==='backend_default'?'':model,voiceId:engine==='local'||engine==='backend_default'?'':voiceId,speed:value.speed,baseUrl:engine==='backend_default'?'':baseUrl};
  return {config,apiKeyToSave};
 }
 async validate(input:unknown):Promise<void>{await this.prepare(input);}
 async save(input:unknown):Promise<TtsConfig>{
  const {config,apiKeyToSave}=await this.prepare(input);
  if(apiKeyToSave)await this.secrets.set(SECRET_PREFIX+config.engine,apiKeyToSave);
  this.storage.set(KEY,config);
  const settings=this.storage.get<Record<string,unknown>>('watchrss.settings');if(settings&&typeof settings==='object'&&!Array.isArray(settings))this.storage.set('watchrss.settings',{...settings,speechRate:config.speed});
  return config;
 }
}
