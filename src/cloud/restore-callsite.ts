import {HostCallsiteTrace,hostSizeBand} from '@podjs/framework/work-window';
/** Stable, release-visible catalogue. IDs contain no user-data identifiers.
 * callsiteId = route index * 16 + operation index. Never renumber entries. */
export const RESTORE_ROUTES=['runtime','snapshot','previous','entry-ref','projection','archive','pending'] as const;
export type RestoreCallsite=typeof RESTORE_ROUTES[number];
export const RESTORE_OPERATIONS=['other-crypto','hkdf','encrypt','decrypt','large-encrypt','large-decrypt','gzip','gunzip','hash','sealed-gzip','sealed-open','cache-write','journal-append','book-write','sealed-close','article-write'] as const;
const operations:Record<string,number>={'crypto.random':0,'crypto.ecdhPublicKey':0,'crypto.ecdhUnwrap':0,'crypto.verifyP256':0,'crypto.hkdfSha256':1,'crypto.aesGcmEncrypt':2,'crypto.aesGcmDecrypt':3,'crypto.largeAesGcmEncrypt':4,'crypto.largeAesGcmDecrypt':5,'file.gzip':6,'file.gunzip':7,'crypto.hash':8,'crypto.gzip':6,'crypto.gunzip':7,'file.hash':8,'crypto.gunzipSealedParts':9,'crypto.openSealedParts':10,'file.write':11,'file.compose':11,'file.commit':11,'crypto.closeSealedGzip':14};
export const RESTORE_RECEIPTS=['none','source-part','inflate-part','object','entry','applied','download','other','published-part','published-file'] as const;
export const restoreCallsiteTrace=()=>new HostCallsiteTrace(RESTORE_ROUTES.flatMap((_,i)=>RESTORE_OPERATIONS.map((_,j)=>i*16+j)),RESTORE_RECEIPTS.map((_,i)=>i));
/** Metadata is added to requests, never inferred from an arbitrary path or ID. */
export function restoreRequestMetadata(site:RestoreCallsite){
 const sizes=new Map<string,number>();
 return {
  args(method:string,args:Record<string,unknown>,operation?:number){
   const op=operation??operations[method]??(method.startsWith('crypto.')?0:undefined);if(op===undefined)return args;
   const base64=(v:unknown)=>typeof v==='string'?Math.max(0,Math.floor(v.length*3/4)-(v.endsWith('==')?2:v.endsWith('=')?1:0)):undefined;
   const size=base64(args.dataBase64)??base64(args.ciphertextBase64)??(typeof args.length==='number'?args.length:typeof args.bytes==='number'?args.bytes:sizes.get(String(args.inputPath??args.path))??base64(args.inputBase64)??-1);
   return {...args,callsiteId:RESTORE_ROUTES.indexOf(site)*16+op,sizeBand:hostSizeBand(size)};
  },
  completed(method:string,args:Record<string,unknown>,value:unknown){
   if(method==='file.delete'){sizes.delete(String(args.path));return;}
   if(!value||typeof value!=='object')return;const v=value as {size?:unknown;path?:unknown};
   const path=typeof v.path==='string'?v.path:typeof args.path==='string'?args.path:undefined;
   if(path&&typeof v.size==='number'&&Number.isSafeInteger(v.size)){if(sizes.size>=512&&!sizes.has(path))sizes.delete(sizes.keys().next().value!);sizes.set(path,v.size);}
  },
 };
}
export function restoreReceiptClass(kind:'units'|'projections',id:string){
 if(kind==='projections')return id.includes('-object-p')||!id.includes('-chunk-')?2:1;
 if(id.startsWith('applied:'))return 5;
 if(/(?:^|:)file:[a-f0-9]{64}:[0-9]+$/.test(id))return 8;
 if(/(?:^|:)file:[a-f0-9]{64}$/.test(id))return 9;
 if(id.startsWith('download:')||id.startsWith('manifest:'))return 6;
 if(id.startsWith('decoded:'))return id.includes('-chunk-')?1:id.includes('-object')?3:4;
 return 7;
}
