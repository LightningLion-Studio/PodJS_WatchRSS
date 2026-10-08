import {normalizeReadingProgress, type ReadingProgressStore} from './progress.ts';
import type {ReadingProgress} from './types.ts';

export interface ProgressCheckpointStorage {
 get<T>(key:string):T|undefined;
 set(key:string,value:unknown):void;
 delete(key:string):unknown;
}
const keyFor=(id:number)=>`watchrss.reader.checkpoint.${id}`;


/** A synchronous lifecycle snapshot survives loss of the asynchronous SQL tail.
 * Ordinary scroll writes still go directly to the existing store. Only a pending
 * checkpoint is reconciled/removed, and an older queued write cannot erase it. */
export class LifecycleReadingProgressStore {
 private readonly pending=new Map<number,ReadingProgress>();
 constructor(private readonly store:Pick<ReadingProgressStore,'load'|'save'> & Partial<Pick<ReadingProgressStore,'saveSnapshot'>>,private readonly storage:ProgressCheckpointStorage){}
 checkpoint(articleId:number,value:ReadingProgress):void {
  const snapshot=normalizeReadingProgress(value);
  this.storage.set(keyFor(articleId),{version:1,value:snapshot});
  this.pending.set(articleId,snapshot);
 }
 private read(articleId:number):ReadingProgress|undefined {
  const raw=this.storage.get<{version?:number;value?:ReadingProgress}>(keyFor(articleId));
  if(raw?.version!==1||!raw.value||typeof raw.value!=='object'||!Number.isFinite(raw.value.updatedAt)||!Number.isFinite(raw.value.offset)||!Number.isFinite(raw.value.progress))return;
  return normalizeReadingProgress(raw.value);
 }
 private clear(articleId:number,expected:ReadingProgress):void {
  const current=this.read(articleId);
  if(current&&JSON.stringify(current)===JSON.stringify(expected)){
   this.storage.delete(keyFor(articleId));this.pending.delete(articleId);
  }
 }
 async load(articleId:number):Promise<ReadingProgress> {
  const stored=await this.store.load(articleId),pending=this.read(articleId);
  if(!pending)return stored;
  this.pending.set(articleId,pending);
  // A newer sync/repository edit wins. Equal clocks keep the exact local anchor.
  if(stored.updatedAt>pending.updatedAt){this.clear(articleId,pending);return stored;}
  await this.persist(articleId,pending);
  this.clear(articleId,pending);
  return pending;
 }
 private persist(articleId:number,value:ReadingProgress):Promise<void> {
  return this.store.saveSnapshot?this.store.saveSnapshot(articleId,value):this.store.save(articleId,value.offset,value.progress,value.textAnchor,value.importedAnchor);
 }
 /** Capture checkpoint ownership when a sample is enqueued, before async tails run. */
 prepareSave(articleId:number,value:ReadingProgress):()=>Promise<void> {
  const pending=this.pending.get(articleId);
  return async()=>{
   await this.persist(articleId,value);
   if(pending)this.clear(articleId,pending);
  };
 }
}
