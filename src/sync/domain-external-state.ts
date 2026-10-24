import {directoryWitness,directoryWitnessWindow,type DirectoryWitnessEntry,type WitnessStat} from '@podjs/framework/directory-witness';
import type {WatchAccountState} from '../account/types';
import type {DomainExternalState} from './domain-fast-path';
import {READER_PRESETS_KEY} from '../reader/preset-store';
export function createDomainExternalState(ports:{account():Promise<WatchAccountState|null>;kvFingerprint(key:string):string|undefined;list(path:string):Promise<{entries:DirectoryWitnessEntry[]}>;stat?(path:string):Promise<WitnessStat>;hash(text:string):Promise<string>;now?:()=>number}):()=>Promise<DomainExternalState>{
 const accountState=async()=>{
  const account=await ports.account(),scope=await ports.hash(JSON.stringify(['watchrss.ble.owner.v1',account?.backendBaseUrl.replace(/\/+$/,'')??'',account?.userId??''])),now=(ports.now??Date.now)();
  const root=await ports.hash(JSON.stringify([account,!!account&&(!account.tokenExpiresAtMillis||now>=account.tokenExpiresAtMillis-60000),!!account&&(!account.refreshTokenExpiresAtMillis||now>=account.refreshTokenExpiresAtMillis)]));
  return {scope,root};
 };
 return async()=>{
  const account=await accountState(),paths=[['books'],['notes/assets'],['reader_assets/fonts','reader_assets/backgrounds','reader_assets/variants']] as const;
  const results=await Promise.allSettled(paths.map(paths=>ports.stat?directoryWitnessWindow(paths,ports.list,ports.stat,ports.hash):directoryWitness(paths,ports.list,ports.hash)));
  const inventory=results.map(r=>r.status==='fulfilled'?r.value:undefined),roots:DomainExternalState['roots']={};
  const digest=(v:typeof inventory[number])=>typeof v==='string'?v:v?.digest;
  if(digest(inventory[0]))roots.books=digest(inventory[0]);if(digest(inventory[1]))roots.notes=digest(inventory[1]);
  const reader=ports.kvFingerprint(READER_PRESETS_KEY);if(reader&&digest(inventory[2]))roots.reader=await ports.hash(JSON.stringify([reader,digest(inventory[2])]));
  roots.account=account.root;
  const initial={scope:account.scope,roots};
  if(!ports.stat)return initial;
  return {...initial,revalidate:async()=>{
   const current=await accountState(),validRoots={...roots};
   for(const [i,d]of ['books','notes','reader'].entries()){
    const window=inventory[i];if(typeof window!=='object'||!window||!await window.valid())delete validRoots[d as 'books'|'notes'|'reader'];
   }
   if(ports.kvFingerprint(READER_PRESETS_KEY)!==reader)delete validRoots.reader;
   if(current.root!==account.root)delete validRoots.account;
   return {scope:current.scope,roots:validRoots};
  }};
 };
}
