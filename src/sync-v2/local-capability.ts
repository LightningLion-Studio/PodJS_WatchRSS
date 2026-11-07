import {exact,canonical,validateScope,type Scope} from './protocol';
import {features} from './wire';
export const P4_CLOSED_GATES=Object.freeze({local_objects:false,relay:false,witness:false,custody_release:false,newLocalRepo:false});
export type ObjectCapability={supportsSyncObjectsV2:boolean;syncObjectsVersions:number[];requiredFeatures:string[];supportedFeatures:string[];scope:Scope|null;maxPartBytes:number};
export function checkedCapability(value:any):ObjectCapability {
 exact(value,['supportsSyncObjectsV2','syncObjectsVersions','requiredFeatures','supportedFeatures','scope','maxPartBytes']);
 if(typeof value.supportsSyncObjectsV2!=='boolean'||value.maxPartBytes!==65536||!Array.isArray(value.syncObjectsVersions)||value.syncObjectsVersions.length>32||value.syncObjectsVersions.some((v:any,i:number)=>!Number.isInteger(v)||v<0||v>4294967295||i>0&&v<=value.syncObjectsVersions[i-1]))throw Error('invalid_schema');
 features(value.requiredFeatures);features(value.supportedFeatures);if(value.scope!==null)validateScope(value.scope);return value;
}
export function objectCapability(scope:Scope,enabled=false,requiredFeatures:string[]=[],supportedFeatures:string[]=[]):ObjectCapability {return checkedCapability({supportsSyncObjectsV2:enabled,syncObjectsVersions:[2],requiredFeatures,supportedFeatures,scope,maxPartBytes:65536});}
/** Pure matrix decision. Key possession is an authenticated session result,
 * not a field accepted from the remote capability response. */
export function chooseLocalProtocol(a:{legacyMax:number;capability?:ObjectCapability},b:{legacyMax:number;capability?:ObjectCapability},keyProven:boolean,safeLegacy:boolean){
 const legacy=Math.min(a.legacyMax,b.legacyMax);if(!Number.isInteger(legacy)||legacy<13)return 'upgrade_required';
 const x=a.capability,y=b.capability;
 if(x?.supportsSyncObjectsV2===true&&y?.supportsSyncObjectsV2===true){
  checkedCapability(x);checkedCapability(y);
  const compatible=x.requiredFeatures.every(f=>y.supportedFeatures.includes(f))&&y.requiredFeatures.every(f=>x.supportedFeatures.includes(f));
  if(!compatible&&!safeLegacy)return 'upgrade_required';
  if(keyProven&&compatible&&x.scope!==null&&y.scope!==null&&canonical(x.scope)===canonical(y.scope)&&x.syncObjectsVersions.includes(2)&&y.syncObjectsVersions.includes(2))return 'objects-v2';
 }
 return safeLegacy?'legacy-v'+Math.min(14,legacy):'upgrade_required';
}
