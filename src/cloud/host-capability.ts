import {CLOUD_HOST_CAPABILITY_UNAVAILABLE} from './execution';
/** Diagnostic names only. This list grants no host permissions. */
const methods=new Set([
 'app.buildInfo','cloud.acquire','cloud.release','discovery.networkSnapshot','runtime.delay',
 'sql.query','sql.execute','sql.transaction','sql.notify','secure.keys','secure.get','secure.set','secure.delete','secure.update','secure.compareAndSet','secure.acquire','secure.release',
 'crypto.random','crypto.hash','crypto.hmacSha256','crypto.verifyP256','crypto.ecdhPublicKey','crypto.ecdhUnwrap','crypto.hkdfSha256',
 'crypto.gunzipSealedParts','crypto.closeSealedGzip','crypto.openSealedParts','crypto.aesGcmEncrypt','crypto.aesGcmDecrypt','crypto.largeAesGcmEncrypt','crypto.largeAesGcmDecrypt','crypto.gzip','crypto.gunzip',
 'log.append','http.download','uri.parse','file.list','file.createTemp','file.read','file.write','file.stat','file.hash','file.commit','file.publishBytes','file.compose','file.delete',
 'file.gzip','file.gunzip','file.htmlText','file.openText','file.readTextChunk','file.closeText',
]);
export const cloudDiagnosticHostMethod=(value:unknown):string|undefined=>typeof value==='string'&&methods.has(value)?value:undefined;
export class CloudHostCapabilityError extends Error {
 readonly code=CLOUD_HOST_CAPABILITY_UNAVAILABLE;
 readonly method?:string;
 constructor(method:string){super(CLOUD_HOST_CAPABILITY_UNAVAILABLE);this.method=cloudDiagnosticHostMethod(method);}
}
export function cloudHostFailure(error:unknown,method:string):unknown {
 return String(error).includes('permission_denied')?new CloudHostCapabilityError(method):error;
}
