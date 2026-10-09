import type {DebugGate} from './gate.ts';
import {utf8Encode} from '../cloud/types.ts';
export const CREDENTIAL_KEYS=['watchrss.bili.session.v1','douyin.cookie','state_json'] as const;
export const MAX_CREDENTIAL_BYTES=12000;
export type CredentialValues=Record<typeof CREDENTIAL_KEYS[number],string|null>;
export interface CredentialSnapshot {version:1;values:CredentialValues}
export interface CredentialPorts {
 get(key:string):Promise<string|undefined|null>;
 /** One atomic secure-store publication, followed by client invalidation. */
 commit(values:CredentialValues):Promise<void>;
 fingerprint(value:string):Promise<string>;
 log(line:string):void;
}
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v);
function fields(v:Record<string,unknown>,allowed:readonly string[]){if(Object.keys(v).some(k=>!allowed.includes(k)))throw Error('credentials_structure');}
function storedValue(key:string,raw:string|null){
 if(raw===null)return;
 if(typeof raw!=='string'||!raw.trim())throw Error('credentials_structure');
 if(key==='douyin.cookie'){if(raw!==raw.trim()||/[\r\n\0]/.test(raw))throw Error('credentials_structure');return;}
 let v:unknown;try{v=JSON.parse(raw);}catch{throw Error('credentials_structure');}
 if(!object(v))throw Error('credentials_structure');
 if(key==='watchrss.bili.session.v1'){
  fields(v,['cookies','refreshToken','cookieRefreshCheckedAt','updatedAt']);
  if(!object(v.cookies)||Object.keys(v.cookies).length>128)throw Error('credentials_structure');
  for(const [name,value] of Object.entries(v.cookies))if(!/^[A-Za-z0-9_!#$%&'*+.^`|~-]+$/.test(name)||name==='__proto__'||typeof value!=='string'||/[\r\n\0]/.test(value))throw Error('credentials_structure');
  if(v.refreshToken!==undefined&&typeof v.refreshToken!=='string')throw Error('credentials_structure');
  for(const k of ['updatedAt','cookieRefreshCheckedAt'])if((k==='updatedAt'||v[k]!==undefined)&&(!Number.isSafeInteger(v[k])||Number(v[k])<0))throw Error('credentials_structure');
 }else{
  fields(v,['userId','phoneMasked','installId','watchDeviceToken','watchAccessToken','watchRefreshToken','backendBaseUrl','posthogHost','posthogProjectApiKey','tokenExpiresAtMillis','accessTokenExpiresAtMillis','refreshTokenExpiresAtMillis','updatedAtMillis','entitlement','telemetryConfig']);
  if(typeof v.userId!=='string'||!v.userId.trim()||!(typeof v.watchAccessToken==='string'&&v.watchAccessToken.trim()||typeof v.watchDeviceToken==='string'&&v.watchDeviceToken.trim()))throw Error('credentials_structure');
  for(const k of ['userId','phoneMasked','installId','watchDeviceToken','watchAccessToken','watchRefreshToken','backendBaseUrl','posthogHost','posthogProjectApiKey'])if(v[k]!==undefined&&typeof v[k]!=='string')throw Error('credentials_structure');
  for(const k of ['tokenExpiresAtMillis','accessTokenExpiresAtMillis','refreshTokenExpiresAtMillis','updatedAtMillis'])if(v[k]!==undefined&&(!Number.isSafeInteger(v[k])||Number(v[k])<0))throw Error('credentials_structure');
  if(v.entitlement!==undefined){if(!object(v.entitlement))throw Error('credentials_structure');const e=v.entitlement;fields(e,['plan','active','expiresAtMillis','features']);if(typeof e.plan!=='string'||typeof e.active!=='boolean'||!Number.isSafeInteger(e.expiresAtMillis)||Number(e.expiresAtMillis)<0||!Array.isArray(e.features)||e.features.some(x=>typeof x!=='string'))throw Error('credentials_structure');}
  if(v.telemetryConfig!==undefined){if(!object(v.telemetryConfig))throw Error('credentials_structure');const t=v.telemetryConfig;fields(t,['anonymousEnabled','diagnosticsEnabled','sampleRate']);if(typeof t.anonymousEnabled!=='boolean'||typeof t.diagnosticsEnabled!=='boolean'||typeof t.sampleRate!=='number'||!Number.isFinite(t.sampleRate)||t.sampleRate<0||t.sampleRate>1)throw Error('credentials_structure');}
 }
}
export function parseCredentials(raw:string):CredentialSnapshot {
 if(typeof raw!=='string'||raw.length>MAX_CREDENTIAL_BYTES||utf8Encode(raw).length>MAX_CREDENTIAL_BYTES)throw Error('credentials_too_long');
 let v:unknown;try{v=JSON.parse(raw);}catch{throw Error('credentials_json');}
 if(!object(v))throw Error('credentials_structure');
 if(v.version!==1)throw Error('credentials_version');
 fields(v,['version','values']);if(!object(v.values)||Object.keys(v.values).length!==CREDENTIAL_KEYS.length)throw Error('credentials_structure');
 fields(v.values,CREDENTIAL_KEYS);
 for(const key of CREDENTIAL_KEYS){if(!Object.hasOwn(v.values,key)||(v.values[key]!==null&&typeof v.values[key]!=='string'))throw Error('credentials_structure');storedValue(key,v.values[key] as string|null);}
 return v as unknown as CredentialSnapshot;
}
/** This controller cannot read or mutate secrets until the existing host DebugGate allows it. */
export class CredentialsBackup {
 private tail:Promise<unknown>=Promise.resolve();
 constructor(private gate:DebugGate,private ports:CredentialPorts){}
 private serial<T>(operation:()=>Promise<T>):Promise<T>{this.gate.require();const task=this.tail.then(()=>{this.gate.require();return operation();});this.tail=task.catch(()=>{});return task;}
 private async audit(operation:string,values:CredentialValues){
  for(const key of CREDENTIAL_KEYS){const value=values[key];const fingerprint=value===null?'absent':(await this.ports.fingerprint(value)).slice(0,8);this.ports.log(`${operation} key=${key} count=${value===null?0:1} sha256=${fingerprint}`);}
 }
 export():Promise<string>{return this.serial(async()=>{const values={} as CredentialValues;for(const key of CREDENTIAL_KEYS)values[key]=(await this.ports.get(key))??null;const raw=JSON.stringify({version:1,values});parseCredentials(raw);await this.audit('export',values);return raw;});}
 import(raw:string):Promise<void>{return this.serial(async()=>{const {values}=parseCredentials(raw);await this.ports.commit(values);await this.audit('import',values);});}
}
