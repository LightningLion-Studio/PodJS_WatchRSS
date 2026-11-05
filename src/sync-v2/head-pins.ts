import {canonical,jsonBytes,parseCanonicalJson,compareD64,nextD64,oid,type Scope} from './protocol';
import {verifyCommit,type SigningPort} from './signing';
import {objectOid} from './sealed';
export type Pins={accountOid:string|null;authors:Record<string,{sequence:string;oid:string;keyId:string;publicKey:string}>;seenOids:string[]};
export type ApprovedKey={deviceId:string;keyId:string;publicKey:string};
/** Resolve keys through approved membership plus the K_id binding verifier.
 * All path work is private until the caller commits the returned pins by CAS. */
export async function authenticatePath(port:SigningPort,scope:Scope,head:string,pins:Pins,read:(oid:string)=>Promise<any>,key:(deviceId:string)=>Promise<ApprovedKey>){
 oid(head,'commit');const path:{oid:string;body:any;signature:string;key:ApprovedKey}[]=[],seen=new Set<string>();let cursor:string|null=head;
 while(cursor!==pins.accountOid){if(cursor===null||seen.has(cursor)||path.length>=1000000||pins.seenOids.includes(cursor))throw Error('replay_detected');seen.add(cursor);const value=await read(cursor),approved=await key(value?.body?.authorDeviceId);if(approved.deviceId!==value?.body?.authorDeviceId)throw Error('signature_invalid');const body=await verifyCommit(port,approved.publicKey,{body:value.body,signature:value.signature},cursor,scope);
  if(value.headerOid!==undefined&&objectOid('commit-header',jsonBytes({body,signature:value.signature}))!==value.headerOid)throw Error('hash_mismatch');
  path.push({oid:cursor,body,signature:value.signature,key:approved});cursor=body.accountParent;
 }
 const next: Pins=JSON.parse(canonical(pins));
 for(const entry of [...path].reverse()){
  const b=entry.body,prior=next.authors[b.authorDeviceId];
  if(prior&&(prior.keyId!==entry.key.keyId||prior.publicKey!==entry.key.publicKey))throw Error('signature_invalid');
  if(prior&&(compareD64(b.deviceSequence,prior.sequence)<0||b.deviceSequence===prior.sequence&&entry.oid!==prior.oid))throw Error('replay_detected');
  // Validate the complete author chain to the already accepted author pin.
  let ownId=b.previousOwnCommit,ownSequence=b.deviceSequence;const ownSeen=new Set<string>();
  while(ownId!==(prior?.oid??null)){
   if(ownId===null||ownSeen.has(ownId)||ownSeen.size>=1000000)throw Error('replay_detected');ownSeen.add(ownId);
   const own=await read(ownId),previous=await verifyCommit(port,entry.key.publicKey,{body:own.body,signature:own.signature},ownId,scope);
   if(previous.authorDeviceId!==b.authorDeviceId||compareD64(previous.deviceSequence,ownSequence)>=0||prior&&compareD64(previous.deviceSequence,prior.sequence)<=0)throw Error('replay_detected');ownSequence=previous.deviceSequence;ownId=previous.previousOwnCommit;
  }
  if(prior&&compareD64(ownSequence,prior.sequence)<=0)throw Error('replay_detected');
  let parent:any=null;
  if(b.accountParent!==null){const envelope=await read(b.accountParent),binding=await key(envelope.body.authorDeviceId);parent=await verifyCommit(port,binding.publicKey,{body:envelope.body,signature:envelope.signature},b.accountParent,scope);}
  const previousGeneration=parent?.rollbackGeneration??'0';
  if(b.operation.kind==='rollback'){
   if(!parent||b.rollbackGeneration!==nextD64(previousGeneration))throw Error('replay_detected');
   const targetEnvelope=await read(b.operation.rollbackTarget),binding=await key(targetEnvelope.body.authorDeviceId),target=await verifyCommit(port,binding.publicKey,{body:targetEnvelope.body,signature:targetEnvelope.signature},b.operation.rollbackTarget,scope);
   if(target.treeRoot!==b.treeRoot||b.operation.rollbackTarget!==b.previousOwnCommit&&!b.mergedParents.includes(b.operation.rollbackTarget))throw Error('invalid_schema');
  }else if(b.rollbackGeneration!==previousGeneration||!parent&&b.operation.kind!=='normal')throw Error('replay_detected');
  next.authors[b.authorDeviceId]={sequence:b.deviceSequence,oid:entry.oid,keyId:entry.key.keyId,publicKey:entry.key.publicKey};next.seenOids.push(entry.oid);
 }
 next.accountOid=head;return {pins:next,path,head:path[0]?.body??null};
}
