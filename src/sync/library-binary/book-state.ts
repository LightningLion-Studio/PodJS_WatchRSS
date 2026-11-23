import {compareLifecycleTokens,validateLifecycleToken,type LifecycleToken} from '@podjs/framework/lifecycle-token';
import type {BookState} from '../../books/protocol';
import {HARD_LIMITS} from './wire';

export const BOOK_STATE_VERSION='b2BookStateVersion';
export const BOOK_STATE_ACTION='syncLibraryBinaryBookState';
export const MAX_BOOK_PROOFS=512;

export interface BookPackageProof {
 bookId:string;
 fingerprint:string;
 chapterCount:number;
 lifecycle?:LifecycleToken;
 packageSha256:string;
 packageBytes:number;
 d1Complete:true;
}

export function bookPackageProof(state:Pick<BookState,'bookId'|'fingerprint'|'chapterCount'|'lifecycle'>,file:{sha256:string;size:number}):BookPackageProof{
 const {bookId,fingerprint,chapterCount,lifecycle}=state;
 return {bookId,fingerprint,chapterCount,...(lifecycle?{lifecycle}:{}),packageSha256:file.sha256,packageBytes:file.size,d1Complete:true};
}

export function readBookPackageProofs(value:unknown):ReadonlyMap<string,BookPackageProof>{
 const proofs=new Map<string,BookPackageProof>(),duplicates=new Set<string>();
 if(!Array.isArray(value)||value.length>MAX_BOOK_PROOFS)return proofs;
 const hex=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{64}$/.test(s);
 for(const entry of value){
  if(!entry||typeof entry!=='object'||Array.isArray(entry))continue;
  const p=entry as BookPackageProof;
  if(p.d1Complete!==true||!hex(p.bookId)||!hex(p.fingerprint)||!hex(p.packageSha256)||
   !Number.isSafeInteger(p.chapterCount)||p.chapterCount<1||p.chapterCount>100000||
   !Number.isSafeInteger(p.packageBytes)||p.packageBytes<1||p.packageBytes>HARD_LIMITS.maxPackageBytes)continue;
  try{if(p.lifecycle!==undefined)validateLifecycleToken(p.lifecycle);}catch{continue;}
  if(proofs.has(p.bookId))duplicates.add(p.bookId);
  proofs.set(p.bookId,p);
 }
 for(const id of duplicates)proofs.delete(id);
 return proofs;
}

export function sameBookPackage(a:BookPackageProof,b?:BookPackageProof):boolean{
 return !!b&&a.bookId===b.bookId&&a.fingerprint===b.fingerprint&&a.chapterCount===b.chapterCount&&
  a.packageBytes===b.packageBytes&&a.packageSha256===b.packageSha256&&compareLifecycleTokens(a.lifecycle,b.lifecycle)===0;
}
