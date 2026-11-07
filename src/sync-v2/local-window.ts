/** C28 session-owned snapshots. Issuing/reading a window never contacts cloud. */
import {exact,hexId,oid,checkD64,uint,canonical,jsonBytes,type Scope} from './protocol';
import {features} from './wire';
export type LocalWindowSnapshot={serverRevision:string;refs:{deviceId:string;commitOid:string;refRevision:string}[];account:{commitOid:string|null;revision:string;rollbackGeneration:string};historyFloorRevision:string;checkpointOid:string|null};
export class LocalReadWindows {
 private windows=new Map<string,{issued:number;expires:number;snapshot:LocalWindowSnapshot}>();private closed=false;
 constructor(private readonly scope:Scope,private readonly authenticated:()=>boolean,private readonly snapshot:()=>Promise<LocalWindowSnapshot>,private readonly nonce:()=>Promise<string>,private readonly now:()=>number=Date.now){}
 async issue(knownRefs:any,requestedFeatures:any){
  if(this.closed||!this.authenticated())throw Error('proof_invalid');features(requestedFeatures);if(!Array.isArray(knownRefs)||knownRefs.length>65)throw Error('invalid_schema');let previous='';for(const r of knownRefs){exact(r,['ref','oid','revision']);if(typeof r.ref!=='string'||r.ref<=previous||!/^refs\/(account\/current|devices\/[a-f0-9]{32}\/index)$/.test(r.ref))throw Error('invalid_schema');previous=r.ref;if(r.oid!==null)oid(r.oid,'commit');checkD64(r.revision);}
  const value=JSON.parse(canonical(await this.snapshot())) as LocalWindowSnapshot;exact(value,['serverRevision','refs','account','historyFloorRevision','checkpointOid']);checkD64(value.serverRevision);checkD64(value.historyFloorRevision);exact(value.account,['commitOid','revision','rollbackGeneration']);if(value.account.commitOid!==null)oid(value.account.commitOid,'commit');checkD64(value.account.revision);checkD64(value.account.rollbackGeneration);if(value.checkpointOid!==null)oid(value.checkpointOid,'commit');
  if(!Array.isArray(value.refs)||value.refs.length>64)throw Error('invalid_schema');previous='';for(const r of value.refs){exact(r,['deviceId','commitOid','refRevision']);hexId(r.deviceId,32);oid(r.commitOid,'commit');if(checkD64(r.refRevision)==='0'||r.deviceId<=previous)throw Error('invalid_schema');previous=r.deviceId;}
  const issued=this.now();uint(issued);const windowId=await this.nonce();hexId(windowId,32);if(this.closed||!this.authenticated())throw Error('proof_invalid');if(this.windows.has(windowId))throw Error('proof_invalid');
  for(const [id,v]of this.windows)if(v.expires<=issued)this.windows.delete(id);if(this.windows.size>=8)this.windows.delete(this.windows.keys().next().value!);const expiresAtMillis=issued+300000;uint(expiresAtMillis);this.windows.set(windowId,{issued,expires:expiresAtMillis,snapshot:value});const result={version:2,scope:this.scope,windowId,expiresAtMillis,...value,pageToken:null};if(jsonBytes(result).length>262144){this.windows.delete(windowId);throw Error('object_too_large');}return result;
 }
 check(windowId:string){const v=this.windows.get(windowId),now=this.now();if(this.closed||!this.authenticated()||!v||!Number.isSafeInteger(now)||now<v.issued||now>=v.expires)throw Error('window_expired');return JSON.parse(canonical(v.snapshot)) as LocalWindowSnapshot;}
 close(){this.closed=true;this.windows.clear();}
}
