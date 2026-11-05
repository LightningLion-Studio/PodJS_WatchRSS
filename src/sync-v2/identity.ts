/** Watch is only a receiver of the repo identity key. The existing approved
 * account root authenticates this bootstrap; no repo-init or key generation. */
import {encodeBase64,decodeBase64} from '@podjs/framework/bytes';
import {hex,unhex,hmacSha256Bytes,sha256Hex,lengthPrefixFields} from '@podjs/framework/crypto';
import {validateP256PublicKey} from '@podjs/framework/p256';
import {checkD64} from '@podjs/framework/sql-projection';
import {canonical,jsonBytes,parseCanonicalJson,bytes,exact,hexId,uint,oid,type Scope} from './protocol';
export interface IdentityCrypto {
 hkdf(key:Uint8Array,salt:Uint8Array,info:Uint8Array):Promise<Uint8Array>;
 decrypt(key:Uint8Array,aad:Uint8Array,nonce:Uint8Array,ciphertext:Uint8Array):Promise<Uint8Array>;
 verify(spki:Uint8Array,message:Uint8Array,signature:Uint8Array):Promise<boolean>;
}
export const b64=(value:Uint8Array)=>encodeBase64(value).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
export function unb64(value:any,size?:number){if(typeof value!=='string'||!/^[A-Za-z0-9_-]*$/.test(value))throw Error('invalid_encoding');const out=decodeBase64(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));if(b64(out)!==value||size!==undefined&&out.length!==size)throw Error('invalid_encoding');return out;}
export const idCommitment=(key:Uint8Array)=>{if(key.length!==32)throw Error('invalid_schema');return sha256Hex(lengthPrefixFields([bytes('wrss.sync.v2/id-key-commitment'),key]));};
const message=(domain:string,body:any)=>lengthPrefixFields([bytes(domain),jsonBytes(body)]);
const mac=(key:Uint8Array,domain:string,body:any)=>b64(hmacSha256Bytes(key,message(domain,body)));
export const descriptorOid=(descriptor:any)=>'repo-descriptor:sha256:'+sha256Hex(jsonBytes(descriptor));
function scope(value:Scope){exact(value,['repoId','libraryEpoch','contentGeneration']);hexId(value.repoId,32);if(checkD64(value.libraryEpoch)==='0'||checkD64(value.contentGeneration)==='0')throw Error('invalid_schema');}
function spki(point:string){hexId(point,130);if(!point.startsWith('04'))throw Error('invalid_schema');const bytes=unhex('3059301306072a8648ce3d020106082a8648ce3d030107034200'+point);validateP256PublicKey(bytes);return bytes;}
function lowSignature(value:any){const signature=unb64(value,64),r=hex(signature.subarray(0,32)),s=hex(signature.subarray(32));if(/^0+$/.test(r)||/^0+$/.test(s)||r>='ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551'||s>'7fffffff800000007fffffffffffffffde737d56d38bcf4279dce5617e3192a8')throw Error('signature_invalid');return signature;}
export async function verifyDescriptor(descriptor:any,root:Uint8Array,accountId:string,expectedScope:Scope,crypto:IdentityCrypto,pin?:string){
 exact(descriptor,['body','proof','signature']);const body=descriptor.body;
 exact(body,['version','accountId','scope','creationId','creatorDeviceId','creatorPlatform','wrappingKeyVersion','creatorPublicKey','idKeyCommitment']);
 hexId(body.accountId,32);hexId(body.creationId,32);hexId(body.creatorDeviceId,32);hexId(body.idKeyCommitment,64);scope(body.scope);
 if(body.version!==2||!['android','mini'].includes(body.creatorPlatform)||uint(body.wrappingKeyVersion,4294967295)<1||root.length!==32)throw Error('invalid_schema');
 if(jsonBytes(descriptor).length>8192||body.accountId!==accountId||canonical(body.scope)!==canonical(expectedScope)||descriptor.proof!==mac(root,'wrss.sync.v2/repo-bootstrap-auth',body)||pin!==undefined&&pin!==descriptorOid(descriptor))throw Error('authentication_required');
 if(!await crypto.verify(spki(body.creatorPublicKey),message('wrss.sync.v2/repo-bootstrap-sign',{body,proof:descriptor.proof}),lowSignature(descriptor.signature)))throw Error('signature_invalid');
 return descriptorOid(descriptor);
}
export function watchRepoInit():never{throw Error('key_migration_phone_required');}
export interface WatchRecipient {authorized:boolean;accountId:string;deviceId:string;platform:'watch'}
function recipient(member:WatchRecipient,accountId:string){if(member.authorized!==true||member.platform!=='watch'||member.accountId!==accountId)throw Error('authentication_required');hexId(member.deviceId,32);}
function requestBody(body:any){exact(body,['version','accountId','scope','descriptorOid','recipientDeviceId','recipientPlatform','requestId','challenge','wrappingKeyVersion','expiresAtMillis']);scope(body.scope);hexId(body.accountId,32);oid(body.descriptorOid,'repo-descriptor');hexId(body.recipientDeviceId,32);hexId(body.requestId,32);hexId(body.challenge,64);if(body.version!==2||body.recipientPlatform!=='watch'||uint(body.wrappingKeyVersion,4294967295)<1)throw Error('invalid_schema');uint(body.expiresAtMillis);}
export function deliveryRequest(body:any,root:Uint8Array){requestBody(body);if(root.length!==32)throw Error('invalid_schema');return {body:JSON.parse(canonical(body)),proof:mac(root,'wrss.sync.v2/id-key-request',body)};}
async function unwrap(value:any,root:Uint8Array,crypto:IdentityCrypto){
 exact(value,['header','ciphertext']);if(jsonBytes(value).length>8192)throw Error('invalid_schema');
 const aad=jsonBytes(value.header),nonce=unb64(value.header.nonce,12),salt=unb64(value.header.salt,32),ciphertext=unb64(value.ciphertext);if(ciphertext.length<16)throw Error('invalid_encoding');
 const key=await crypto.hkdf(root,salt,lengthPrefixFields([bytes(value.header.domain),unhex(sha256Hex(aad))]));
 try{const raw=await crypto.decrypt(key,aad,nonce,ciphertext),plain=parseCanonicalJson(raw);exact(plain,['idKeyHex']);hexId(plain.idKeyHex,64);return unhex(plain.idKeyHex);}finally{key.fill(0);}
}
export async function receiveIdentity(value:any,pending:any,descriptor:any,root:Uint8Array,now:number,member:WatchRecipient,crypto:IdentityCrypto){
 recipient(member,pending?.body?.accountId);uint(now);exact(pending,['body','proof']);requestBody(pending.body);const body=pending.body;
 await verifyDescriptor(descriptor,root,member.accountId,body.scope,crypto,body.descriptorOid);
 if(body.recipientDeviceId!==member.deviceId||body.wrappingKeyVersion!==descriptor.body.wrappingKeyVersion||body.expiresAtMillis<=now||body.expiresAtMillis>now+300000||pending.proof!==mac(root,'wrss.sync.v2/id-key-request',body))throw Error('authentication_required');
 exact(value.header,['domain',...Object.keys(body),'salt','nonce']);const {domain,salt,nonce,...bound}=value.header;
 if(domain!=='wrss.sync.v2/id-key-delivery'||canonical(bound)!==canonical(body))throw Error('authentication_required');
 const key=await unwrap(value,root,crypto);if(idCommitment(key)!==descriptor.body.idKeyCommitment){key.fill(0);throw Error('fingerprint_mismatch');}return key;
}
export async function recoverIdentity(value:any,descriptor:any,root:Uint8Array,member:WatchRecipient,expectedScope:Scope,pin:string,crypto:IdentityCrypto){
 recipient(member,descriptor?.body?.accountId);await verifyDescriptor(descriptor,root,member.accountId,expectedScope,crypto,pin);
 exact(value.header,['version','domain','accountId','scope','descriptorOid','wrappingKeyVersion','salt','nonce']);const {salt,nonce,...bound}=value.header;
 if(canonical(bound)!==canonical({version:2,domain:'wrss.sync.v2/id-key-recovery',accountId:member.accountId,scope:expectedScope,descriptorOid:pin,wrappingKeyVersion:descriptor.body.wrappingKeyVersion}))throw Error('authentication_required');
 const key=await unwrap(value,root,crypto);if(idCommitment(key)!==descriptor.body.idKeyCommitment){key.fill(0);throw Error('fingerprint_mismatch');}return key;
}
