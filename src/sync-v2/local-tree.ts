/** Frozen trees/diff wire, with opaque session-local authenticated cursors. */
import {hmacSha256Bytes,equalAuthenticationTag,unhex} from '@podjs/framework/crypto';
import {exact,oid,hexId,jsonBytes,parseCanonicalJson,digest,bytes,text,type Scope} from './protocol';
import {sameScope,sorted,b64,unb64} from './wire';
import {localTreeNode} from './local-auth';
import type {LocalObjectStore} from './local-objects';
export class LocalTreeDiff {
 private secret?:Promise<Uint8Array>;
 constructor(private readonly objects:LocalObjectStore,private readonly scope:Scope,private readonly window:(id:string)=>Promise<void>,private readonly nonce:()=>Promise<string>){}
 private key(){return this.secret??=Promise.all([this.nonce(),this.nonce()]).then(ids=>{for(const id of ids)hexId(id,32);return unhex(ids.join(''));});}
 async diff(body:any){
  exact(body,['scope','windowId','treeRoot','knownNodes','pageToken']);sameScope(body.scope,this.scope);hexId(body.windowId,32);oid(body.treeRoot,'tree');sorted(body.knownNodes,512,(id:any)=>oid(id,'tree'));await this.window(body.windowId);
  await this.objects.object(body.treeRoot);
  const hash=digest({scope:this.scope,windowId:body.windowId,treeRoot:body.treeRoot,knownNodes:body.knownNodes});let after='';if(body.pageToken!==null){text(body.pageToken,2048);const parts=body.pageToken.split('.');if(parts.length!==2)throw Error('invalid_schema');const expected=hmacSha256Bytes(await this.key(),bytes(parts[0]));if(!equalAuthenticationTag(expected,unb64(parts[1],32)))throw Error('invalid_schema');const token=parseCanonicalJson(unb64(parts[0]));exact(token,['hash','after']);if(token.hash!==hash)throw Error('invalid_schema');after=oid(token.after,'tree');}
  const known=new Set(body.knownNodes),seen=new Set<string>(),pending=[body.treeRoot],missing:string[]=[];
  while(pending.length){await this.window(body.windowId);const id=pending.pop()!;if(known.has(id))continue;if(seen.has(id)||seen.size>=1000000)throw Error('invalid_schema');seen.add(id);const object=await this.objects.object(id);if(object.size>262144)throw Error('object_too_large');const raw=new Uint8Array(object.size);for(let at=0;at<object.size;at+=65536)raw.set(await object.read(at,Math.min(65536,object.size-at)),at);const node=localTreeNode(parseCanonicalJson(raw),this.scope);missing.push(id);if(node.form==='node')for(const child of node.children)pending.push(child.oid);}
  const remaining=missing.sort().filter(id=>id>after),nodes=remaining.slice(0,512);let pageToken:string|null=null;if(remaining.length>nodes.length){const raw=b64(jsonBytes({hash,after:nodes.at(-1)!}));pageToken=raw+'.'+b64(hmacSha256Bytes(await this.key(),bytes(raw)));}await this.window(body.windowId);return {windowId:body.windowId,nodes,pageToken};
 }
}
