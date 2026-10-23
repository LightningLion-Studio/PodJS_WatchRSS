import {Database} from 'bun:sqlite';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {initializeSchema} from '../../src/core/schema';
import {SyncSavedStateStore} from '../../src/sync/saved-state';
import {SqlLibrarySessionRepository} from '../../src/sync/library-repository';
import {encodeBodyJson,type SyncBodyCodec} from '../../src/sync/article-body';
import {prepareArticle,type ExportedArticle} from '../../src/sync/article-export';
import type {SqlDatabase} from '../../src/core/types';
export const sha=(b:Uint8Array|string)=>createHash('sha256').update(b).digest('hex');
export const parseUri=async(value:string)=>{try{const u=new URL(value);return {valid:true,scheme:u.protocol.slice(0,-1),host:u.hostname,rawPath:u.pathname,rawQuery:u.search.slice(1)||null};}catch{return {valid:false,scheme:null,host:null,rawPath:null,rawQuery:null};}};
export const article=(p:Partial<ExportedArticle>={}):ExportedArticle=>({articleId:sha('https://example.com/private'),sourceDeviceId:'phone',url:'https://example.com/private',title:'Private',siteName:'独立文章',excerpt:'preview',contentHtml:'<p>body</p>',contentText:'body',imageUrl:null,contentHash:'h',importedAt:100,updatedAt:100,rssSourceUrl:null,rssSourceTitle:null,independentSaved:true,independentChangedAt:100,independentSortOrder:100,favoriteSaved:false,favoriteChangedAt:0,favoriteSortOrder:0,watchLaterSaved:false,watchLaterChangedAt:0,watchLaterSortOrder:0,deleted:false,deletedAt:0,readingProgress:0,readingPositionBytes:0,readingPositionContentHash:'',readingPositionChangedAt:0,isRead:false,...p});
export async function fixture(){
 const sql=new Database(':memory:');sql.exec('PRAGMA foreign_keys=ON');let encodes=0,htmlCalls=0;
 const run=(q:string,p:readonly unknown[]=[])=>sql.query(q).run(...p as any[]);
 const db:SqlDatabase={query:async(q,p=[])=>sql.query(q).all(...p as any[]) as any,execute:async(q,p=[])=>{run(q,p);},transaction:async ss=>{sql.transaction(()=>ss.forEach(s=>run(s.sql,s.params)))();},transactionChanges:async ss=>sql.transaction(()=>ss.map(s=>{run(s.sql,s.params);return Number((sql.query('SELECT changes() n').get() as any).n);} ))()};
 const codec:SyncBodyCodec={sha256:async b=>sha(b),encode:async b=>{encodes++;return gzipSync(encodeBodyJson(b));},decode:async b=>gunzipSync(b).toString('utf8')};
 await initializeSchema(db);await new SyncSavedStateStore(db).initializeDevice('watch');
 const ports={codec,text:{parseUri,htmlText:async(s:string)=>{htmlCalls++;return s.replace(/<[^>]*>/g,'');}},uri:{parseUri,parseAndroid:parseUri},files:{storeText:async(_k:string,v:string)=>v,hydrate:async(v:string)=>v},migrateReading:async()=>{},cleanupRemovedContent:async()=>{},now:()=>1000};
 const repo=new SqlLibrarySessionRepository(db,ports);
 return {sql,db,codec,repo,ports,counts:()=>({encodes,htmlCalls}),packet:async(a=article())=>{const p=await prepareArticle(a,codec);return {article:a,body:{articleId:a.articleId,bodyHash:p.manifest.bodyHash,bodyByteCount:p.manifest.bodyByteCount,chunkSize:p.manifest.chunkSize,chunkHashes:[...p.manifest.chunkHashes],metadataOnly:false,chunks:[{index:0,hash:p.manifest.chunkHashes[0]!,bytes:p.encodedBody!}]}};},changes:()=>Number((sql.query('SELECT total_changes() n').get() as any).n)};
}
