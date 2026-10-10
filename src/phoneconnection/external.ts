import {abilities,type Ability,type AcousticMode} from './protocol.ts';
import type {AcousticConnectionSession} from './session.ts';
import type {DebugExternalReply} from '@podjs/framework/services';

export interface AcousticReply extends DebugExternalReply {code:number;data:string}
export interface AcousticLaunch {
 mode:AcousticMode;preferredAbility?:Ability;autoListen:boolean;payloadBase64?:string;returnRemoteUrl:boolean;
}
/** Android boolean extras are typed; payload takes precedence and forces guided WiFi. */
export function parseAcousticLaunch(extras:Record<string,string|number|boolean>):AcousticLaunch {
 const bool=(key:string)=>{const value=extras[key];if(value!==undefined&&typeof value!=='boolean')throw Error('invalid_acoustic_input');return value===true;};
 const autoListen=bool('debug_auto_listen'),returnRemoteUrl=bool('return_remote_url');
 const raw=extras.debug_guided_payload_base64;
 if(raw!==undefined&&typeof raw!=='string')throw Error('invalid_acoustic_input');
 const payloadBase64=typeof raw==='string'?raw.trim()||undefined:undefined;
 if(payloadBase64&&(payloadBase64.length>16384||payloadBase64.length%4!==0||! /^[A-Za-z0-9+/]*={0,2}$/.test(payloadBase64)))throw Error('invalid_acoustic_input');
 const preferred=extras.preferred_ability;
 if(preferred!==undefined&&typeof preferred!=='string')throw Error('invalid_acoustic_input');
 const preferredAbility=typeof preferred==='string'&&Object.hasOwn(abilities,preferred)?preferred as Ability:undefined;
 const mode=extras.mode??'SOUND_GUIDED_WIFI';
 if(mode!=='PURE_SOUND'&&mode!=='SOUND_GUIDED_WIFI')throw Error('invalid_acoustic_input');
 return {mode:autoListen||payloadBase64?'SOUND_GUIDED_WIFI':mode,preferredAbility,autoListen,payloadBase64,returnRemoteUrl};
}
export async function executeAcousticLaunch(session:AcousticConnectionSession,launch:AcousticLaunch,decode:(value:string)=>Uint8Array,current:()=>boolean=()=>true,selected:(ability:Ability)=>void=()=>{}):Promise<Ability>{
 const payload=launch.payloadBase64?decode(launch.payloadBase64):undefined;
 const ability=launch.preferredAbility??(payload?session.protocol.parseGuidedWifi(payload).ability:'REMOTE_INPUT');
 selected(ability);
 await session.select(launch.mode,ability);
 if(current()){
  if(payload)await session.debugGuidedPayload(payload);
  else if(launch.autoListen)await session.start();
 }
 return ability;
}
/** One route owns each request. Closing or expiring it resolves cancellation exactly once. */
export class AcousticExternalRequest {
 readonly result:Promise<AcousticReply>;
 closed=false;
 private resolve!:(value:AcousticReply)=>void;
 constructor(readonly launch:AcousticLaunch,readonly deadline:number){this.result=new Promise(resolve=>{this.resolve=resolve;});}
 private finish(value:AcousticReply){if(this.closed)return;this.closed=true;this.resolve(value);}
 remoteUrl(url:string,handoff:(url:string)=>void){
  if(this.closed)return;
  if(Date.now()>=this.deadline){this.cancel();return;}
  if(this.launch.returnRemoteUrl)this.finish({code:0,data:'ok',result:{code:-1,extras:{remote_url:url}}});
  else {this.finish({code:0,data:'ok',result:{code:0}});handoff(url);}
 }
 cancel(){this.finish({code:1,data:'acoustic_cancelled',result:{code:0}});}
}
