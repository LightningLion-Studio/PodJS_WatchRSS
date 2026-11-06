import {SyntheticContentBackend} from './p3-backend-fixture';
import {createCipheriv,createDecipheriv,generateKeyPairSync,createPublicKey,hkdfSync,randomBytes,sign,verify,createHash} from 'node:crypto';
import {readFileSync,writeFileSync,existsSync,mkdirSync,statSync,openSync,writeSync,closeSync,fsyncSync,renameSync,truncateSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {gunzipSync} from 'node:zlib';
import {ContentFiles} from '@podjs/framework/content-files';
import {WatchContentEngine} from '../../src/sync-v2/content-engine';
import {WatchContentStore} from '../../src/sync-v2/content-store';
import {WatchContentHttp} from '../../src/sync-v2/content-http';
import {SyncV2Http,parseNetwork} from '../../src/sync-v2/http';
import {WatchServiceKeyPin} from '../../src/sync-v2/service-key';
import {objectOid} from '../../src/sync-v2/sealed';
import {jsonBytes,canonical,digest} from '../../src/sync-v2/protocol';
import {b64,unb64} from '../../src/sync-v2/wire';
import {signedMessage,type SigningPort} from '../../src/sync-v2/signing';
import type {EnvelopeCrypto} from '../../src/sync-v2/sealed';
import {SqlFixture,cipher,scope,idKey} from './fixture';
export {scope,idKey};
const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'});
export const pub=Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,'base64url'),Buffer.from(jwk.y!,'base64url')]);
const order=BigInt('0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551');
export const crypt:EnvelopeCrypto&SigningPort={
 async random(n){return randomBytes(n);},async hkdf(k,s,i){return new Uint8Array(hkdfSync('sha256',k,s,i,32));},
 async encrypt(k,n,b,a){const c=createCipheriv('aes-256-gcm',k,n);c.setAAD(a);return Buffer.concat([c.update(b),c.final(),c.getAuthTag()]);},
 async decrypt(k,n,b,a){const c=createDecipheriv('aes-256-gcm',k,n);c.setAAD(a);c.setAuthTag(b.subarray(-16));return Buffer.concat([c.update(b.subarray(0,-16)),c.final()]);},
 async gunzip(b,n){const out=gunzipSync(b);if(out.length!==n)throw Error('invalid_encoding');return out;},async signingKey(){return pub;},
 async sign(_,b){const sig=sign('sha256',b,{key:pair.privateKey,dsaEncoding:'ieee-p1363'}),s=BigInt('0x'+sig.subarray(32).toString('hex'));return Buffer.concat([sig.subarray(0,32),Buffer.from((s>order/2n?order-s:s).toString(16).padStart(64,'0'),'hex')]);},
 async verify(k,b,s){return verify('sha256',b,{key:createPublicKey({key:{kty:'EC',crv:'P-256',x:b64(k.subarray(1,33)),y:b64(k.subarray(33))},format:'jwk'}),dsaEncoding:'ieee-p1363'},s);},
};
export function pin(){const v=new Map<string,string>();return new WatchServiceKeyPin({get:async k=>v.get(k),compareAndSet:async(k,old,n)=>{if((v.get(k)??null)!==old)return false;v.set(k,n);return true;}},'a'.repeat(32),async()=>({accountId:'a'.repeat(32),syncV2:{receiptKeyId:'e'.repeat(32),receiptSigningPublicKey:b64(new Uint8Array(pair.publicKey.export({format:'der',type:'spki'}))),algorithm:'ES256'}}));}
export class FileHost {
 calls=0;readBytes=0;writeBytes=0;timings:Record<string,number>={};maxBatch=0;maxBatchBytes=0;loseFrame=false;publishHook?:(a:any)=>void;discardHook?:()=>void;afterFrame?:()=>void;
 constructor(readonly root:string){mkdirSync(root,{recursive:true});const fd=openSync(dirname(root),'r');try{fsyncSync(fd);}finally{closeSync(fd);}}
 path(p:string){if(!/^[a-f0-9]{64}\/[a-z0-9.]+$/.test(p))throw Error('invalid_content_path');return join(this.root,p);}
 atomic(path:string,b:Uint8Array){mkdirSync(dirname(path),{recursive:true});const temp=path+'.tmp',fd=openSync(temp,'w');try{writeSync(fd,b);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temp,path);for(const dir of [dirname(path),dirname(dirname(path))]){const fd=openSync(dir,'r');try{fsyncSync(fd);}finally{closeSync(fd);}}}
 request=async<T>(method:string,a:any):Promise<T>=>{this.calls++;const started=performance.now();const path=a.path&&this.path(a.path);let value:any;
  if(method==='content.files.stat'){this.maxBatch=Math.max(this.maxBatch,a.paths.length);value={entries:a.paths.map((p:string)=>{const f=this.path(p),cp=existsSync(f+'.checkpoint')?JSON.parse(readFileSync(f+'.checkpoint','utf8')):null;return {path:p,exists:existsSync(f),size:existsSync(f)?statSync(f).size:0,durableOffset:cp?.durableOffset??0,checkpoint:cp?.checkpoint??null};})};}
  else if(method==='content.files.read'){const total=a.ranges.reduce((n:number,r:any)=>n+r.length,0);this.maxBatch=Math.max(this.maxBatch,a.ranges.length);this.maxBatchBytes=Math.max(this.maxBatchBytes,total);this.readBytes+=total;value={entries:a.ranges.map((r:any)=>({dataBase64:readFileSync(this.path(r.path)).subarray(r.offset,r.offset+r.length).toString('base64')}))};}
  else if(method==='content.files.publish'){const b=Buffer.from(a.dataBase64,'base64');this.writeBytes+=b.length;if(existsSync(path)&&!readFileSync(path).equals(b))throw Error('part_conflict');this.atomic(path,b);if(a.checkpoint)this.atomic(path+'.checkpoint',jsonBytes({durableOffset:b.length,checkpoint:a.checkpoint}));value={size:b.length};this.publishHook?.(a);}
  else if(method==='content.files.discard'){this.atomic(path+'.checkpoint',jsonBytes({durableOffset:0,checkpoint:''}));this.atomic(path,new Uint8Array());value={durableOffset:0};this.discardHook?.();}
  else if(method==='content.files.frame'){const b=Buffer.from(a.dataBase64,'base64');this.writeBytes+=b.length;const cp=existsSync(path+'.checkpoint')?JSON.parse(readFileSync(path+'.checkpoint','utf8')):{durableOffset:0};if(a.offset!==cp.durableOffset)throw Error('offset_conflict');mkdirSync(dirname(path),{recursive:true});const fd=openSync(path,existsSync(path)?'r+':'w+');try{truncateSync(path,a.offset);writeSync(fd,b,0,b.length,a.offset);fsyncSync(fd);}finally{closeSync(fd);}this.atomic(path+'.checkpoint',jsonBytes({durableOffset:a.offset+b.length,checkpoint:a.checkpoint}));value={durableOffset:a.offset+b.length};this.afterFrame?.();if(this.loseFrame){this.loseFrame=false;throw Error('lost_frame_response');}}
  else throw Error(method);this.timings[method]=(this.timings[method]??0)+performance.now()-started;return value;
 };
}
export class ContentBackend extends SyntheticContentBackend {constructor(){super(crypt,b64(new Uint8Array(pair.publicKey.export({format:'der',type:'spki'}))));}}
export const keys={id:idKey,content:new Uint8Array(32).fill(0x22),version:1};
export function engine(root:string,backend:ContentBackend,sourceBytes:Uint8Array,options:{binding?:string;metric?:(m:any)=>void;signals?:()=>Promise<any>;yieldControl?:()=>Promise<void>;sourceCounter?:{reads:number;bytes:number};sourceLength?:(binding:string)=>number;assertCurrent?:()=>Promise<void>;crypto?:EnvelopeCrypto&SigningPort}={}){
 const db=new SqlFixture(join(root,'projection.sqlite')),host=new FileHost(join(root,'files')),store=new WatchContentStore(db,cipher,new ContentFiles(host.request),{scope,auth:options.binding??'auth-v1'}),http=new SyncV2Http(backend,'http://127.0.0.1:18942',scope,async()=>({accessToken:'synthetic-only',legacyDeviceId:'synthetic-device',userId:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',scope}),false,pin(),true),remote=new WatchContentHttp(http,crypt,()=>backend.clock);
 const e=new WatchContentEngine(store,remote,options.crypto??crypt,keys,{alias:'synthetic',source:async binding=>({binding,size:options.sourceLength?.(binding)??sourceBytes.length,ranges:[],assertCurrent:async()=>{},read:async(offset,length)=>{if(options.sourceCounter){options.sourceCounter.reads++;options.sourceCounter.bytes+=length;}return sourceBytes.subarray(offset,offset+length);}}),approved:async()=>({deviceId:'a'.repeat(32),keyId:'b'.repeat(32),publicKey:b64(pub)}) as any,assertCurrent:options.assertCurrent??(async()=>{}),signals:options.signals??(async()=>({charging:true,wifi:false,bluetooth:false,cellular:true,internet:true,localRoute:false})),yieldControl:options.yieldControl??(async()=>{}),now:()=>backend.clock,monotonic:()=>backend.clock,metric:options.metric});return {e,db,host,store,remote};
}
