import {fail,integer,hash,successResult,receiptResult,type Envelope,type ObjectDescriptor,type AppliedReceipt,type Completion,type Selection,type Row} from './wire';
import {appliedReceipt,requestDigest} from './digests';
import {Grant,type JobBinding} from './state';

/** Disk-backed locator/index. Every successful chunk verification is bounded to
 * one 64KiB block; native may provide a verified durable index instead of JS I/O.
 * Corrupt local cached bytes return missing, whereas corrupt wire DATA is STOP.
 */
export interface MissingIndex {
 locate(objectId:string):Promise<number|null>;
 at(slot:number):Promise<ObjectDescriptor|null>;
 objectCount:number;
 receipt(objectId:string):Promise<AppliedReceipt|null>;
 readChunk(objectId:string,index:number):Promise<Uint8Array|null>;
 objectStaged(objectId:string):Promise<boolean>;
}
export interface MissingSnapshot {state:string;nextManifestPage:number;expiresAtMillis:number;completion:Completion|null;admitted:boolean}
export async function missingPage(r:Envelope,binding:JobBinding,grant:Grant,selection:Selection,index:MissingIndex,s:MissingSnapshot):Promise<Row> {
 const token=grant.token();grant.check(token);
 if(r.type!=='request'||r.phase!=='missing'||r.jobId!==binding.jobId||r.planDigest!==binding.planDigest||r.epoch!==token.epoch||requestDigest(r.jobId,r.planDigest,'missing',r.payload!)!==r.requestDigest)fail('REQUEST_CONFLICT');
 const p=r.payload!,limit=integer(p.limit,selection.limits.maxResultsPerPage),base={state:s.state,nextManifestPage:s.nextManifestPage,expiresAtMillis:s.expiresAtMillis,items:[] as Row[],next:null as Row|null,done:true,completion:s.completion};
 if(limit===0||s.state==='CANCELLED'||s.state==='COMPLETE')return successResult('missing',base);
 if(!s.admitted||s.state==='PLANNING')fail('MANIFEST_INCOMPLETE');
 let start=0,chunk=0,rangesLeft=selection.limits.maxRangesPerPage;
 if(p.afterObjectId!==null){const slot=await index.locate(String(p.afterObjectId));grant.check(token);if(slot===null)fail();start=p.afterChunkIndex===null?slot+1:slot;chunk=p.afterChunkIndex===null?0:Number(p.afterChunkIndex);}
 for(let slot=start;slot<index.objectCount&&base.items.length<limit;slot++){
  const o=await index.at(slot);grant.check(token);if(!o||chunk>o.chunkHashes.length)fail('JOURNAL_CORRUPT');
  const receipt=await index.receipt(o.objectId);grant.check(token);let state='PENDING';const ranges:number[][]=[];
  if(receipt){receiptResult(receipt);if(receipt.jobId!==binding.jobId||receipt.planDigest!==binding.planDigest||receipt.objectId!==o.objectId)fail('RECEIPT_CONFLICT');
   const expected=appliedReceipt({jobId:receipt.jobId,planDigest:receipt.planDigest,requestId:receipt.applyRequestId,requestDigest:receipt.applyRequestDigest} as Envelope,o.objectId,receipt.receiverDeviceId,receipt.outcome);if(expected.resultDigest!==receipt.resultDigest)fail('RECEIPT_CONFLICT');state='APPLIED';
  }else{
   let present=0;
   for(let n=chunk;n<o.chunkHashes.length;n++){
    const bytes=await index.readChunk(o.objectId,n);grant.check(token);
    const valid=bytes!==null&&bytes.length===Math.min(65536,o.size-n*65536)&&hash(bytes)===o.chunkHashes[n];
    if(valid)present++;else if(ranges.length&&ranges[ranges.length-1]![1]===n)ranges[ranges.length-1]![1]=n+1;else ranges.push([n,n+1]);
   }
   // A complete set of chunks is not a finalized/published object receipt.
   const staged=await index.objectStaged(o.objectId);grant.check(token);
   state=!ranges.length&&staged?'STAGED':present>0||chunk>0?'PARTIAL':'PENDING';
  }
  const take=ranges.slice(0,rangesLeft);rangesLeft-=take.length;
  base.items.push({objectId:o.objectId,state,missingRanges:take,receipt});chunk=0;
  if(take.length<ranges.length){if(!take.length){base.items.pop();base.next={afterObjectId:o.objectId,afterChunkIndex:ranges[0]![0]};}else base.next={afterObjectId:o.objectId,afterChunkIndex:take[take.length-1]![1]};break;}
  base.next=slot+1<index.objectCount?{afterObjectId:o.objectId,afterChunkIndex:null}:null;
 }
 base.done=base.next===null;return successResult('missing',base);
}
