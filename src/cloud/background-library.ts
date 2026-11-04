import {createNoteAssetWriter} from '../notes/cloud-assets';
import {checkpointedFile} from '@podjs/framework/work-window';
import {restoreRequestMetadata} from './restore-callsite';
import {CLOUD_SYNC_SUSPENDED} from './execution';
import {createBookFiles} from '../books/files-port';
import {bytesToBase64} from '@podjs/framework/bytes';
import {stableGzipHeader} from '@podjs/framework/crypto';
import type {SqlDatabase} from '../core/types';
import {initializeSchema} from '../core/schema';
import {ensureSyncDevice} from '../sync/local-identity';
import {SqlLibrarySessionRepository} from '../sync/library-repository';
import {SqlReadingProgressStore} from '../reader/sql-progress';
import {ReadingProgressStore} from '../reader/progress';
import {ImportedTextWriter,javaUtf8Chunks} from '../reader/imported-text-writer';
import {importedTextFileName} from '../reader/imported-text';
import {encodeBodyJson,type SyncBodyCodec} from '../sync/article-body';
import type {SyncTextPort} from '../sync/local-manifest';
import {createCloudHostPorts,type CloudHostRequest} from './host-ports';
import {utf8Decode} from './types';
import type {CloudGuard} from './guard';
export async function createBackgroundLibrary(host:CloudHostRequest,readKv:(key:string)=>Promise<unknown>,guard:CloudGuard){
 const metadata=restoreRequestMetadata('projection'),rawHost=host;host=<T>(method:string,args:Record<string,unknown>)=>rawHost<T>(method,typeof args.callsiteId==='number'?args:metadata.args(method,args));
 const publicationHost=(op:number):CloudHostRequest=><T>(method:string,args:Record<string,unknown>)=>rawHost<T>(method,metadata.args(method,args,['file.write','file.commit','file.compose'].includes(method)?op:undefined));
 const bookHost=publicationHost(13),articleHost=publicationHost(15);
 guard.require();const ports=createCloudHostPorts(host,guard);
 const db:SqlDatabase={query:(sql,params=[])=>host('sql.query',{sql,params}),execute:async(sql,params=[])=>{await host('sql.execute',{sql,params});},transaction:async statements=>{await host('sql.transaction',{statements});},transactionChanges:statements=>host('sql.transaction',{statements,reportChanges:true})};
 await initializeSchema(db,{seedBuiltinChannels:false});
 if((await db.query('SELECT id FROM library_clear_journal WHERE id=1')).length)throw Error(CLOUD_SYNC_SUSPENDED);
 await ensureSyncDevice(db,()=>ports.crypto.random(16));
 const reading=new SqlReadingProgressStore(db,new ReadingProgressStore({get:async key=>{const value=await readKv(key);return typeof value==='string'?value:null;},set:async()=>{throw Error('Background legacy progress is read only');}}));
 const append=async(path:string,bytes:Uint8Array,offset:number)=>{
  for(let at=0;at<bytes.length;at+=32768){const part=bytes.subarray(at,at+32768);const r=await articleHost<{size:number}>('file.write',{path,append:true,expectedOffset:offset,dataBase64:bytesToBase64(part)});offset+=part.length;if(r.size!==offset)throw Error('后台正文写入不完整');}return {size:offset};
 };
 const writer=new ImportedTextWriter({resumable:async(id,text,checkpoint)=>{const keyHash=await ports.crypto.sha256(encode(id)),bytes=encode(text);const file=await checkpointedFile(articleHost,bytes,{directory:'article_content',identity:'imported-text-v2:'+keyHash,hash:ports.crypto.sha256,checkpoint,target:(_binding,digest)=>'article_content/v2-'+keyHash+'-'+digest+'.txt'});return 'watchrss-watch-content:'+file.path.slice('article_content/'.length);},createTemp:directory=>host('file.createTemp',{directory}),write:(path,bytes)=>articleHost('file.write',{path,dataBase64:bytesToBase64(bytes),atomicReplace:true}),append,hash:path=>host('file.hash',{path}),commit:(path,target,expectedSize,expectedSha256)=>articleHost('file.commit',{path,target,expectedSize,expectedSha256}),remove:async path=>{await host('file.delete',{path});}});
 const hydrate=async(value:string)=>{const name=importedTextFileName(value);if(!name)return value;const bytes=await ports.files.read('article_content/'+name);if(!bytes)throw Error('正文文件缺失');return utf8Decode(bytes);};
 const encode=(value:string)=>{const chunks=[...javaUtf8Chunks(value)],out=new Uint8Array(chunks.reduce((n,b)=>n+b.length,0));let at=0;for(const b of chunks){out.set(b,at);at+=b.length;}return out;};
 const codec:SyncBodyCodec={sha256:ports.crypto.sha256,encode:async body=>stableGzipHeader(await ports.crypto.gzip(encode(encodeBodyJson(body)))),decode:async bytes=>utf8Decode(bytes[0]===31&&bytes[1]===139?await ports.crypto.gunzip(bytes,32*1024*1024):bytes)};
 const text:SyncTextPort={yieldTurn:()=>ports.crypto.yieldTurn!(),parseUri:value=>host('uri.parse',{value}),htmlText:async html=>{
  const input=await host<{path:string}>('file.createTemp',{directory:'cloud-crypto'});let output:string|undefined;
  try{await append(input.path,encode(html),0);const result=await host<{path:string}>('file.htmlText',{path:input.path,maxOutputBytes:32*1024*1024});output=result.path;const bytes=await ports.files.read(output);if(!bytes)throw Error('HTML 转码失败');return utf8Decode(bytes);}
  finally{await host('file.delete',{path:input.path}).catch(()=>{});if(output)await host('file.delete',{path:output}).catch(()=>{});}
 }};
 return new SqlLibrarySessionRepository(db,{noteAssetWriter:createNoteAssetWriter(host),bookFiles:createBookFiles(bookHost,ports.crypto.sha256),codec,text,uri:{parseUri:text.parseUri,parseAndroid:value=>host('uri.parse',{value,syntax:'android'})},files:{hydrate,storeText:(key,value,checkpoint)=>writer.storeText(key,value,()=>false,checkpoint)},migrateReading:id=>reading.migrate(id),prepareReadingMigration:ids=>reading.migrationStatements(ids),migrateReadingMany:ids=>reading.migrateMany(ids),cleanupRemovedContent:async({itemIds})=>{
  for(const id of itemIds){const directory=`offline/rss/${id}`;const listing=await host<{entries:{file:boolean;path:string}[]}>('file.list',{path:directory}).catch(()=>undefined);for(const e of listing?.entries??[])if(e.file&&e.path.startsWith(directory+'/')&&!e.path.slice(directory.length+1).includes('/'))await host('file.delete',{path:e.path});}
 }});
}
