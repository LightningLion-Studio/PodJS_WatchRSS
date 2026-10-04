import {mount} from '@pocketjs/framework/solid';
import {createSignal,Show} from 'solid-js';
import {Text} from '@pocketjs/framework/components';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {rfcomm,byteStreams} from '@podjs/framework/services';
import {getLibrarySyncRepository,db,services} from '../../src/services.ts';
import {RfcommLibraryListener} from '../../src/sync/rfcomm.ts';
import {ReaderScreen} from '../../src/ui/ReaderScreen.tsx';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import type {Article} from '../../src/ui/service.ts';

const key='phone-txt-novel-peer-result';
const [readerArticle,setReaderArticle]=createSignal<Article|null>(null);
function check(value:unknown,message:string):asserts value {if(!value)throw new Error(message);}
async function run(){
 const repository=await getLibrarySyncRepository();
 const deviceId=await repository.deviceId();
 const existing=await db.query('SELECT id FROM articles ORDER BY link');
 if(existing.length>0){
  const first=await services.getArticle(String(existing[0]?.id));check(first,'Stored first TXT chapter cannot reopen');setReaderArticle(first);kv.set(key,{state:'passed',watchArticles:2,renderStage:'article-loaded'});return;
 }
 kv.set(key,{state:'starting',deviceId});
 check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===0,'Fixture article rows must start empty');
 const listener=new RfcommLibraryListener(repository,{radio:rfcomm,streams:byteStreams});
 try{
  const results=await listener.start({onListening:()=>kv.set(key,{state:'running',phase:'listening',deviceId})});
  check(results.some(result=>result.request.phase==='manifest'&&result.libraryApplied&&result.ack?.applied),'Library transfer did not apply');
  const sources=await db.query('SELECT title,url FROM channels');
  check(sources.length===1&&String(sources[0]?.title)==='TXT章节夹具','TXT novel channel was not transferred');
  const rows=await db.query('SELECT id,title,link,content FROM articles ORDER BY link');
  check(rows.length===2,'Expected two TXT chapters');
  check(rows.every(row=>String(row.link).includes('/import-txt-novel/')&&String(row.link).includes('/chapter/')),'TXT chapter URL identity was lost');
  check(rows.map(row=>String(row.title)).join('|')==='第一章|第二章','TXT chapter order or titles changed');
  const bodies:string[]=[];
  for(const row of rows){
   const article=await services.getArticle(String(row.id));
   check(article,'Chapter is absent from reader service');
   bodies.push(String(article.rawContent));
  }
  check(bodies[0]?.includes(`第一章正文${'字'.repeat(130000)}`)&&bodies[1]?.includes('第二章正文'),'TXT chapter bodies changed during transfer');
  kv.set(key,{state:'passed',watchArticles:rows.length,chapterTitles:rows.map(row=>row.title),longChapterLength:bodies[0]?.length,actions:results.length});
  const first=await services.getArticle(String(rows[0]!.id));
  check(first,'First TXT chapter cannot open');
  setReaderArticle(first);
  kv.set(key,{...(kv.get<Record<string,unknown>>(key)??{}),renderStage:'article-loaded'});
 }finally{listener.stop();}
}
function App(){const metrics=getDisplayMetrics();return <Show when={readerArticle()} fallback={<Text>Phone TXT novel verification</Text>}>{article=><ReaderScreen article={article()} preset={defaultReaderPreset()} services={services} width={metrics.logicalWidth} height={metrics.logicalHeight} fontSize={14} lineHeight={19} llmEnabled={false} llmAutoSummarize={false} llmPromptPreset={0} active={true} autoStart={false} speed={1} favorite={false} speaking={false} busy={false} onFavorite={()=>{}} onShare={()=>{}} onSpeak={()=>{}} onSpeechControls={()=>{}} onMedia={()=>{}} onControls={()=>{}} onError={error=>kv.set(key,{state:'render-failed',error})} ref={()=>{}}/>}</Show>;}
mount(App);
void run().catch(error=>kv.set(key,{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
