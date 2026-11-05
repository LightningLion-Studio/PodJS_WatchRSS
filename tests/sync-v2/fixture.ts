import {Database} from 'bun:sqlite';
import {createCipheriv,createDecipheriv,randomBytes,hkdfSync,createPublicKey,verify} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {canonical} from '../../src/sync-v2/protocol';
import {WatchProjectionStore,type LocalCipher} from '../../src/sync-v2/store';
import {ProjectionGate} from '../../src/sync-v2/gate';
import type {IdentityCrypto} from '../../src/sync-v2/identity';
export const sharedRoot='/home/wilf/data/OPPO_Develop/.codex-tmp/cloud-v2/syncv2';
export const vector=(name:string)=>JSON.parse(readFileSync(sharedRoot+'/vectors/'+name+'.json','utf8'));
export const scope={repoId:'01'.repeat(16),libraryEpoch:'1',contentGeneration:'2'};
export const idKey=Uint8Array.from({length:32},()=>17),libraryId='aa'.repeat(16);
export const binding={schema:'frozen-v2-rc6',descriptorPin:vector('identity-bootstrap').descriptorOid??'repo-descriptor:sha256:'+'a'.repeat(64),accountScope:'synthetic',capability:'local-projection-v1'};
export const account=vector('rc6-contracts').window;
export const err=(fn:()=>unknown)=>{try{fn();return null;}catch(e){return (e as Error).message;}};
export const identityCrypto:IdentityCrypto={
 hkdf:async(k,s,i)=>new Uint8Array(hkdfSync('sha256',k,s,i,32)),
 decrypt:async(k,a,n,b)=>{const d=createDecipheriv('aes-256-gcm',k,n);d.setAAD(a);d.setAuthTag(b.subarray(-16));return new Uint8Array(Buffer.concat([d.update(b.subarray(0,-16)),d.final()]));},
 verify:async(k,m,s)=>verify('sha256',m,{key:createPublicKey({key:Buffer.from(k),type:'spki',format:'der'}),dsaEncoding:'ieee-p1363'},s),
};
const localKey=Buffer.alloc(32,0x55);
export const cipher:LocalCipher={
 async seal(aad,value){const nonce=randomBytes(12),c=createCipheriv('aes-256-gcm',localKey,nonce);c.setAAD(Buffer.from(aad));return JSON.stringify({nonce:nonce.toString('hex'),ciphertext:Buffer.concat([c.update(canonical(value),'utf8'),c.final(),c.getAuthTag()]).toString('hex')});},
 async open(aad,value){const v=JSON.parse(value),b=Buffer.from(v.ciphertext,'hex'),d=createDecipheriv('aes-256-gcm',localKey,Buffer.from(v.nonce,'hex'));d.setAAD(Buffer.from(aad));d.setAuthTag(b.subarray(-16));return JSON.parse(Buffer.concat([d.update(b.subarray(0,-16)),d.final()]).toString('utf8'));},
};
export class SqlFixture {
 readonly raw:Database;calls=0;maxRows=0;maxTxBytes=0;sql:string[]=[];
 crashAt:number|null=null;afterCommit=false;
 constructor(path=':memory:',mode='DELETE'){this.raw=new Database(path);this.raw.exec('PRAGMA journal_mode='+mode);this.raw.exec('PRAGMA synchronous=FULL');}
 async query(q:string,p:readonly unknown[]=[]):Promise<Record<string,unknown>[]>{this.calls++;this.sql.push(q);const rows=this.raw.query(q).all(...p as any[]) as Record<string,unknown>[];this.maxRows=Math.max(this.maxRows,rows.length);return rows;}
 async execute(q:string,p:readonly unknown[]=[]){await this.transaction([{sql:q,params:p}]);}
 async transaction(statements:{sql:string;params?:readonly unknown[]}[]){this.calls++;this.maxTxBytes=Math.max(this.maxTxBytes,JSON.stringify(statements).length);this.raw.exec('BEGIN IMMEDIATE');try{let i=0;for(const s of statements){if(this.crashAt===i++)throw Error('injected_crash');this.sql.push(s.sql);this.raw.query(s.sql).run(...(s.params??[]) as any[]);}if(this.crashAt===i)throw Error('injected_crash');this.raw.exec('COMMIT');}catch(e){this.raw.exec('ROLLBACK');throw e;}if(this.afterCommit)throw Error('injected_after_commit');}
 store(enabled=true){return new WatchProjectionStore(this,cipher,new ProjectionGate(enabled),scope,libraryId,idKey);}
 close(){this.raw.close();}
}
export const noteValue=(id='n')=>({noteId:id,folderId:null,title:'title '+id,markdown:'local\ntext',plainText:'local text',contentHash:'h',baseContentHash:'base-h',baseMarkdown:'ancestor',pinned:false,createdAt:1,updatedAt:2,modifiedBy:'watch',deleted:false,deletedAt:0});
