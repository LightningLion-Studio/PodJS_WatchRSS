import type {SqlDatabase} from '../core/types';
import type {SyncBodyCodec} from './article-body';
/** Aggregate fixed labels only: never retain SQL, parameters, identities or text. */
export class FullSyncPerf {
 private samples=new Map<string,{calls:number;ms:number;maxMs:number}>();
 constructor(private readonly emit?:(fields:Record<string,string|number>)=>void,private readonly now=()=>globalThis.performance?.now?.()??Date.now()){}
 add(label:string,ms:number){const s=this.samples.get(label)??{calls:0,ms:0,maxMs:0};s.calls++;s.ms+=ms;s.maxMs=Math.max(s.maxMs,ms);this.samples.set(label,s);}
 async time<T>(label:string,run:()=>Promise<T>):Promise<T>{const at=this.now();try{return await run();}finally{this.add(label,this.now()-at);}}
 flush(stage:string){if(!this.emit)return;const profile=Object.fromEntries([...this.samples].map(([k,v])=>[k,{calls:v.calls,ms:Math.round(v.ms),maxMs:Math.round(v.maxMs)}]));this.samples.clear();try{this.emit({stage,profile:JSON.stringify(profile)});}catch{}}
 database(db:SqlDatabase):SqlDatabase {
  const bucket=(sql:string)=>sql==='SELECT 1'?'yield':sql.startsWith('PRAGMA')?'pragma':sql.includes('local_article_deletions')?'journal':sql.includes('sync_article_keeps')||sql.includes('sync_article_keep_aliases')?'keeps':sql.includes('sync_book')?'books':sql.includes('article_sync_content')?'body':sql.includes('sync_library_revision')?'revision':sql.includes('sync_projection')?'projection':sql.includes('sync_saved_states')?'saved':sql.includes('articles')?'articles':'other';
  return {query:(q,p,l)=>this.time('sql.query.'+bucket(q),()=>db.query(q,p,l)),execute:(q,p,l)=>this.time('sql.execute.'+bucket(q),()=>db.execute(q,p,l)),transaction:ss=>this.time('sql.transaction',()=>db.transaction(ss)),...(db.transactionChanges?{transactionChanges:(ss:Parameters<NonNullable<SqlDatabase['transactionChanges']>>[0])=>this.time('sql.transactionChanges',()=>db.transactionChanges!(ss))}:{})};
 }
 codec(codec:SyncBodyCodec):SyncBodyCodec{return {sha256:b=>this.time('codec.hash',()=>codec.sha256(b)),encode:b=>this.time('codec.encode',()=>codec.encode(b)),decode:b=>this.time('codec.decode',()=>codec.decode(b))};}
}
