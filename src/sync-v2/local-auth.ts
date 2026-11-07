/** Object authentication for the raw local cache. Business application and
 * its ACK remain the responsibility of the existing P2 projection verifier. */
import {exact,uint,oid,hexId,parseCanonicalJson,jsonBytes,canonical,KINDS,type Scope} from './protocol';
import {sameScope,features,indexRow} from './wire';
import {openV2,objectOid,type EnvelopeCrypto} from './sealed';
import {verifyCommit,verifySigned,type SigningPort} from './signing';
import {recipe} from './content-schema';
import type {ApprovedKey} from './head-pins';
export function localTreeNode(node:any,scope:Scope){
 if(!node||typeof node.prefix!=='string'||!/^[a-f0-9]{0,64}$/.test(node.prefix))throw Error('invalid_schema');
 if(node?.form==='leaf'){exact(node,['version','scope','form','prefix','rows']);if(!Array.isArray(node.rows)||node.rows.length>256)throw Error('invalid_schema');let prior='';for(const r of node.rows){indexRow(r);if(!r.entityKey.startsWith(node.prefix)||r.entityKey<=prior)throw Error('invalid_schema');prior=r.entityKey;}}
 else if(node?.form==='node'){exact(node,['version','scope','form','prefix','children']);if(!Array.isArray(node.children)||!node.children.length||node.children.length>16||node.prefix.length>=64)throw Error('invalid_schema');let prior='';for(const c of node.children){exact(c,['digit','oid','count']);if(typeof c.digit!=='string'||!/^[a-f0-9]$/.test(c.digit)||c.digit<=prior||uint(c.count,4294967295)===0)throw Error('invalid_schema');prior=c.digit;oid(c.oid,'tree');}}
 else throw Error('invalid_schema');sameScope(node.scope,scope);if(node.version!==2||typeof node.prefix!=='string'||!/^[a-f0-9]{0,64}$/.test(node.prefix))throw Error('invalid_schema');return node;
}
export function localObjectAuthenticator(options:{scope:Scope;crypto:EnvelopeCrypto&SigningPort;keys:{id:Uint8Array;content:Uint8Array};approved:(id:string)=>Promise<ApprovedKey>;refsAuthor:(parent:string)=>Promise<ApprovedKey>}){
 return async(id:string,raw:Uint8Array)=>{
  const type=id.split(':')[0];
  if(['blob','recipe','meta','state'].includes(type)){
   const opened=await openV2(options.crypto,options.keys.id,options.keys.content,options.scope,id,raw),v=opened.value;if(type==='recipe')recipe(v);
   if(type==='meta'){exact(v,['version','entityKey','kind','logicalId','addedAtSource','requiredFeatures','payload']);if(v.version!==2||!KINDS.includes(v.kind)||typeof v.logicalId!=='string'||!['original','unknown'].includes(v.addedAtSource))throw Error('invalid_schema');hexId(v.entityKey,64);features(v.requiredFeatures);}
   if(type==='state'){exact(v,['version','entityKey','requiredFeatures','payload','noteSegments']);if(v.version!==2||!Array.isArray(v.noteSegments))throw Error('invalid_schema');hexId(v.entityKey,64);features(v.requiredFeatures);if(v.noteSegments.length)throw Error('unsupported_feature');}return;
  }
  const v=parseCanonicalJson(raw);
  if(type==='tree'){localTreeNode(v,options.scope);return;}
  if(type==='commit'||type==='commit-header'){exact(v,['body','signature']);const key=await options.approved(v.body?.authorDeviceId);if(key.deviceId!==v.body?.authorDeviceId)throw Error('member_unknown');const commitId=type==='commit'?id:objectOid('commit',jsonBytes(v.body));await verifyCommit(options.crypto,key.publicKey,v,commitId,options.scope);return;}
  if(type==='state-refs'||type==='recipe-refs'){
   exact(v,['body','signature']);const state=type==='state-refs',parent=state?'stateOid':'recipeOid',children=state?'segmentOids':'blobOids';exact(v.body,['scope',parent,children]);sameScope(v.body.scope,options.scope);oid(v.body[parent],state?'state':'recipe');const ids=v.body[children];if(!Array.isArray(ids)||ids.length>2048||state&&new Set(ids).size!==ids.length)throw Error('invalid_schema');for(const child of ids)oid(child,state?'state':'blob');const key=await options.refsAuthor(v.body[parent]),approved=await options.approved(key.deviceId);if(canonical(approved)!==canonical(key))throw Error('member_unknown');await verifySigned(options.crypto,key.publicKey,'wrss.sync.v2/'+type+'-sign',v.body,v.signature);return;
  }
  throw Error('unsupported_feature');
 };
}
