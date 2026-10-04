import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {fileChunks} from '@podjs/framework/services';
import {db,getLibrarySyncRepository} from '../../src/services.ts';
import {clearRepositoryFixture} from '../helpers/library-repository-fixture.ts';
import {stableArticleId} from '../../src/sync/local-manifest.ts';
import {hostArticleBodyCodec,hostSyncText} from '../../src/sync/article-body-host.ts';
import {importedTextFileName} from '../../src/reader/imported-text.ts';
const key='storage-guest-result';
function check(ok:unknown,message:string):asserts ok{if(!ok)throw new Error(message);}
async function run(){
 const started=Date.now(),repo=await getLibrarySyncRepository(),files=new Set<string>();let result:Record<string,unknown>|undefined;await clearRepositoryFixture(db);
 const captureFiles=async()=>{for(const row of await db.query('SELECT content_html,content_text FROM article_sync_content'))for(const value of Object.values(row)){const name=importedTextFileName(typeof value==='string'?value:null);if(name)files.add('article_content/'+name);}};
 try{
  kv.set(key,{state:'running',phase:'seed'});await db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'watchrss://phone-imports','Imports',1)");
  const expected=new Map<string,string>();
  for(const [index,mode] of ['inline','chunks','original'].entries()){
   const id=index+1,url='https://example.com/large/'+mode,stable=await stableArticleId(url,hostSyncText.parseUri,hostArticleBodyCodec),body='汉😀\0text'.repeat(90000)+mode;expected.set(stable,body);
   await db.execute('INSERT INTO articles(id,channel_id,title,link,dedup_key,fetched_at,content) VALUES(?,1,?,?,?,1,?)',[id,mode,url,stable,mode==='inline'?'':null]);
   for(let offset=0,part=0;offset<body.length;offset+=16000,part++){
    const chunk=body.slice(offset,offset+16000);
    if(mode==='inline')await db.execute('UPDATE articles SET content=content||? WHERE id=?',[chunk,id]);
    else await db.execute(`INSERT INTO ${mode==='chunks'?'article_body_chunks':'article_original_chunks'}(article_id,chunk_index,body) VALUES(?,?,?)`,[id,part,chunk]);
   }
  }
  let oversizedRejected=false;try{await db.query('SELECT content FROM articles WHERE id=1');}catch{oversizedRejected=true;}check(oversizedRejected,'Fixture did not exceed the old host query limit');
  kv.set(key,{state:'running',phase:'production-snapshot'});const window=await repo.prepareWindow('storage-test-phone',0);check(window.fullArticleManifest.length===3,'Missing long manifests');
  const exported=await repo.exportRequested(window.fullArticleManifest.map(m=>({articleId:m.articleId,bodyHash:'',metadataOnly:false,chunkIndexes:[]})));check(exported.length===3,'Missing exports');
  for(const item of exported)check(item.article.contentText===expected.get(item.article.articleId),'Long text changed: '+item.article.title);
  await captureFiles();check(files.size===3,'Production cache did not publish immutable text files');
  kv.set(key,{state:'running',phase:'metadata-only-receive'});const first=exported.find(item=>item.article.title==='inline')!;
  await repo.receiveArticle({article:{...first.article,favoriteSaved:true,favoriteChangedAt:10,updatedAt:10},body:{articleId:first.article.articleId,bodyHash:first.manifest.bodyHash,bodyByteCount:first.manifest.bodyByteCount,chunkSize:first.manifest.chunkSize,chunkHashes:first.manifest.chunkHashes,metadataOnly:true,chunks:[]}},'storage-test-phone',false);
  const retained=await repo.exportRequested([{articleId:first.article.articleId,bodyHash:'',metadataOnly:false,chunkIndexes:[]}]);check(retained[0]?.article.contentText===expected.get(first.article.articleId),'Metadata receive lost the body');check(retained[0]?.article.favoriteSaved,'Metadata receive did not apply saved state');
  for(const row of await db.query('SELECT content FROM articles WHERE id=1')){const name=importedTextFileName(String(row.content));check(name,'Receive did not externalize long content');files.add('article_content/'+name);}await captureFiles();
  await repo.finalizeSnapshot([],[]);check((await db.query('SELECT count(*) n FROM articles'))[0]?.n===0,'Replacement left articles');
  result={state:'passed',productionFactory:true,oversizedQueryRejected:true,inlineBody:true,chunkBody:true,originalBody:true,nulAndSupplementaryText:true,metadataOnlyReceive:true,immutableBodyFiles:files.size,replacement:true,elapsedMs:Date.now()-started};
 }finally{await captureFiles();await clearRepositoryFixture(db);for(const path of files)await fileChunks.remove(path);}
 kv.set(key,result);
}
mount(()=><Text>Production sync storage verification</Text>);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
