import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {rfcomm,byteStreams,fileChunks,base64ToBytes} from '@podjs/framework/services';
import {getLibrarySyncRepository,db,services} from '../../src/services.ts';
import {RfcommLibraryListener} from '../../src/sync/rfcomm.ts';
import {ImportedTextStore} from '../../src/reader/imported-text.ts';
import {importedReaderHandle} from '../../src/reader/imported-speech.ts';

const key='phone-txt-peer-result';
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
function expectedText(){return Array.from({length:6000},(_,i)=>`行${i} 汉字😀 alpha-${i%97}`).join('\n');}
async function run(){
 const repository=await getLibrarySyncRepository();
 check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===0,'Fixture article rows must start empty');
 const listener=new RfcommLibraryListener(repository,{radio:rfcomm,streams:byteStreams});
 try{
  const results=await listener.start({onListening:()=>kv.set(key,{state:'running',phase:'listening'})});
  check(results.some(result=>result.request.phase==='manifest'&&result.libraryApplied&&result.ack?.applied),'Library transfer did not apply');
  const rows=await db.query('SELECT id,title,link,content FROM articles');
  check(rows.length===1,'Expected exactly one imported TXT article');
  const row=rows[0]!;
  check(String(row.link).startsWith('https://watchrss.local/import-content/txt/'),'Imported TXT identity was lost');
  const store=new ImportedTextStore({stat:path=>fileChunks.stat(path),read:async(path,offset,maxBytes)=>base64ToBytes((await fileChunks.read(path,offset,maxBytes)).dataBase64),readText:(path,offset,maxBytes)=>fileChunks.readText(path,offset,maxBytes)});
  const imported=await importedReaderHandle(db,store,String(row.id));
  check(imported.hasMarker&&imported.handle,'Imported TXT was not materialized as a reader file');
  check(imported.handle.chunkCount>1,'Expected multiple 16 KiB reader chunks');
  const chunks:string[]=[];
  for(let index=0;index<imported.handle.chunkCount;index++){
   const part=await store.chunk(imported.handle,index);
   check(part!==null,`Reader chunk ${index} unavailable`);
   chunks.push(part);
  }
  check(chunks.join('')===expectedText(),'Imported TXT changed during transport or file readback');
  const article=await services.getArticle(String(row.id));
  check(article?.importedText?.chunkCount===chunks.length,'Article service did not expose the chunked reader handle');
  check(article.rawContent===''&&article.content==='','Article service exposed a file marker as visible body text');
  kv.set(key,{state:'passed',title:row.title,watchArticles:rows.length,chunkCount:chunks.length,byteLength:imported.handle.byteLength,actions:results.length});
 }finally{listener.stop();}
}
mount(()=><Text>Phone TXT sync verification</Text>);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error)}));
