import {hex,unhex,hmacSha256Bytes,lengthPrefixFields,sha256Hex} from '@podjs/framework/crypto';
import {bytes,jsonBytes,canonical,exact,hexId,uint,checkD64,type Scope} from './protocol';
import {b64,unb64,commitBody,sameScope} from './wire';
import {objectOid} from './sealed';
export interface SigningPort {sign(keyIdSha256:string,input:Uint8Array):Promise<Uint8Array>;signingKey(keyIdSha256:string,create?:boolean):Promise<Uint8Array>;verify(publicKey:Uint8Array,input:Uint8Array,signature:Uint8Array):Promise<boolean>}
const N='ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551',half='7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8';
export function lowSignature(value:any){const raw=unb64(value,64),r=hex(raw.subarray(0,32)),s=hex(raw.subarray(32));if(/^0+$/.test(r)||/^0+$/.test(s)||r>=N||s>half)throw Error('signature_invalid');return raw;}
export const signedMessage=(domain:string,body:any)=>lengthPrefixFields([bytes(domain),jsonBytes(body)]);
export async function verifySigned(port:SigningPort,pub:string,domain:string,body:any,signature:string){const key=unb64(pub,65);if(key[0]!==4||!await port.verify(key,signedMessage(domain,body),lowSignature(signature)))throw Error('signature_invalid');}
export async function signControl(port:SigningPort,key:string,domain:string,body:any){const signature=b64(await port.sign(key,signedMessage(domain,body)));lowSignature(signature);return {body,signature};}
/** C1 account identity comes only from the authenticated user_id. */
export function accountIdFromUserId(userId:string){if(!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(userId))throw Error('invalid_schema');return userId.replace(/-/g,'').toLowerCase();}
export function signingAlias(accountId:string,scope:Scope,deviceId:string,keyId:string){hexId(accountId,32);hexId(deviceId,32);hexId(keyId,32);return sha256Hex(jsonBytes({domain:'wrss.sync.v2/signing-identity',accountId,scope,deviceId,keyId}));}
export async function signingRegistration(port:SigningPort,idKey:Uint8Array,accountId:string,scope:Scope,deviceId:string,keyId:string,authorizedAtMillis:number,revocationRevision:string,create=false){
 uint(authorizedAtMillis);checkD64(revocationRevision);const alias=signingAlias(accountId,scope,deviceId,keyId),publicKey=b64(await port.signingKey(alias,create));unb64(publicKey,65);
 const body={version:2,scope,deviceId,keyId,publicKey,authorizedAtMillis,revocationRevision},bindingProof=b64(hmacSha256Bytes(idKey,signedMessage('wrss.sync.v2/signing-key-bind',body))),possessionSignature=b64(await port.sign(alias,lengthPrefixFields([bytes('wrss.sync.v2/signing-key-possession'),jsonBytes(body),bytes(bindingProof)])));lowSignature(possessionSignature);return {body,bindingProof,possessionSignature};
}
export async function verifyBinding(port:SigningPort,idKey:Uint8Array,scope:Scope,binding:any,approved:(deviceId:string,revocationRevision:string)=>Promise<void>){
 exact(binding,['body','bindingProof','possessionSignature']);const b=binding.body;exact(b,['version','scope','deviceId','keyId','publicKey','authorizedAtMillis','revocationRevision']);sameScope(b.scope,scope);if(b.version!==2)throw Error('invalid_schema');hexId(b.deviceId,32);hexId(b.keyId,32);uint(b.authorizedAtMillis);checkD64(b.revocationRevision);const key=unb64(b.publicKey,65);if(key[0]!==4||idKey.length!==32)throw Error('signature_invalid');
 await approved(b.deviceId,b.revocationRevision);if(b64(hmacSha256Bytes(idKey,signedMessage('wrss.sync.v2/signing-key-bind',b)))!==binding.bindingProof)throw Error('signature_invalid');
 if(!await port.verify(key,lengthPrefixFields([bytes('wrss.sync.v2/signing-key-possession'),jsonBytes(b),bytes(binding.bindingProof)]),lowSignature(binding.possessionSignature)))throw Error('signature_invalid');return b;
}
export async function signCommit(port:SigningPort,alias:string,body:any){commitBody(body);const id=objectOid('commit',jsonBytes(body)),signature=b64(await port.sign(alias,lengthPrefixFields([bytes('wrss.sync.v2/commit-sign'),bytes(id)])));lowSignature(signature);return {oid:id,body,signature};}
export async function verifyCommit(port:SigningPort,publicKey:string,value:any,expectedOid:string,scope:Scope){
 exact(value,['body','signature']);commitBody(value.body);sameScope(value.body.scope,scope);if(jsonBytes(value).length>262144)throw Error('object_too_large');if(objectOid('commit',jsonBytes(value.body))!==expectedOid)throw Error('hash_mismatch');if(!await port.verify(unb64(publicKey,65),lengthPrefixFields([bytes('wrss.sync.v2/commit-sign'),bytes(expectedOid)]),lowSignature(value.signature)))throw Error('signature_invalid');return value.body;
}
