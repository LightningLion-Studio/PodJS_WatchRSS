import type {JsonObject} from './protocol.ts';
import {parseReaderManifest,readerRequiredString,type ReaderManifest} from './reader-manifest.ts';
import type {ReaderResources} from './reader-resources.ts';
export class ReaderSyncActions {
 private queue:Promise<unknown>=Promise.resolve();
 constructor(private readonly store:{mergeManifest(incoming:ReaderManifest):ReaderManifest},private readonly resources:Pick<ReaderResources,'missing'|'push'|'pull'>,private readonly changed:()=>void,private readonly resourceTransfer?:()=>void){}
 apply(request:JsonObject):Promise<JsonObject>{const task=this.queue.then(()=>this.handle(request));this.queue=task.catch(()=>{});return task;}
 private async handle(request:JsonObject):Promise<JsonObject>{
  switch(readerRequiredString(request,'phase')){
   case 'manifest':{const snapshot=this.store.mergeManifest(parseReaderManifest(request));this.changed();return {...snapshot,success:true,version:11,action:'syncReader',phase:'manifest',missingResources:await this.resources.missing(snapshot)};}
   case 'pushResource':{if(request.kind==='background'||request.kind==='variant')this.resourceTransfer?.();const response=await this.resources.push(request);if(response.applied)this.changed();return response;}
   case 'pullResource':return this.resources.pull(request);
   default:throw Error('未知阅读器同步阶段');
  }
 }
}
