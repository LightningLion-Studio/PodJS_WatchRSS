import {htmlToText} from '../../src/core/html.ts';
import {articlePreview} from '../../src/core/preview.ts';
import {buildArticleBlocks} from '../../src/reader/media.ts';
import {contentText} from '../../src/reader/content.ts';
/** Read-only real SQLite boundary fixture for the production reader getter.
 * No device or network. The mounted QuickJS probe reports synthetic native IO.
 */
import {Database} from 'bun:sqlite';
import {resolve} from 'node:path';
const arg=(k:string,d='')=>process.argv.find(v=>v.startsWith(`--${k}=`))?.slice(k.length+3)??d;
const path=arg('db');if(!path)throw Error('--db=<read-only snapshot> required');
const out=arg('out','/tmp/sql-turn-fixture.json');
const db=new Database(path,{readonly:true});
const source=await Bun.file(resolve(import.meta.dir,'../../src/services.ts')).text();
const getter=source.split('\n').find(v=>v.includes('async getArticle(id)'))!;
const metadata=getter.match(/db.query\("([^"]+)"/)![1];
const imported=`SELECT link,substr(content,1,512) content,
    (SELECT substr(body,1,512) FROM article_original_chunks WHERE article_id=a.id AND chunk_index=0) original
    FROM articles a WHERE id=?`;
const queries:[string,(number|string|null)[]][]=[
 [metadata,[12569]],[imported,[12569]],['SELECT content FROM articles WHERE id=?',[12569]],
 ['SELECT * FROM source_preferences WHERE channel_id=?',[40]],
 ['SELECT origin_url,media_type,relative_path FROM offline_media WHERE item_id=? ORDER BY id',[12569]],
];
const sqlReplies:Record<string,unknown>={};
for(const [sql,params] of queries)sqlReplies[JSON.stringify([sql.replace(/\s+/g,' ').trim(),params])]=db.query(sql).all(...params);
const row=db.query('SELECT state_json,progress,changed_at FROM article_reading_state WHERE article_id=12569').get() as any;
const fixture={sqlReplies,progress:row.state_json?{...JSON.parse(row.state_json),progress:row.progress,updatedAt:row.changed_at}:{offset:0,progress:row.progress,updatedAt:row.changed_at},
 channels:db.query('SELECT id,url,title,description FROM channels WHERE id=40').all().map((r:any)=>({...r,id:String(r.id),unreadCount:1})),
 listArticles:db.query(metadata.replace('WHERE a.id=?','WHERE a.channel_id=? ORDER BY a.fetched_at DESC,a.id DESC LIMIT 12')).all(40)};
const meta=db.query(metadata).get(12569) as any,body=(db.query('SELECT content FROM articles WHERE id=?').get(12569) as any).content;
const preview=articlePreview(meta.preview_content==null?undefined:String(meta.preview_content),meta.description==null?undefined:String(meta.description),String(meta.image_url??''),String(meta.link??''));
const expectedArticle:any={id:String(meta.id),channelId:String(meta.channel_id),channelTitle:String(meta.channel_title??'RSS'),title:String(meta.title),enclosureImageUrl:meta.image_url?String(meta.image_url):undefined,videoUrl:meta.video_url?String(meta.video_url):undefined,audioUrl:meta.audio_url?String(meta.audio_url):undefined,content:htmlToText(body),savedAt:undefined,saveSortOrder:undefined,excerpt:String(meta.summary??preview.summary??''),link:String(meta.link??''),imageUrl:String(meta.preview_image_url??preview.imageUrl??''),watchLater:!!Number(meta.is_watch_later),publishedAt:String(meta.pub_date??''),read:!!meta.is_read,saved:!!meta.is_saved,rawContent:body};
expectedArticle.contentBlocks=buildArticleBlocks(body,expectedArticle);expectedArticle.content=contentText(expectedArticle.contentBlocks);expectedArticle.useOriginalContent=!!Number((db.query('SELECT * FROM source_preferences WHERE channel_id=?').get(40) as any)?.use_original_content);expectedArticle.offlineMedia={};expectedArticle.offlineMediaFailures=0;
await Bun.write(out,JSON.stringify({...fixture,expectedArticle}));
const helper=`import {WatchRssRepository} from '../../src/core/repository.ts';
import {importedReaderHandle} from '../../src/reader/imported-speech.ts';
import {readOfflineMedia} from '../../src/reader/offline-media.ts';
import {buildArticleBlocks,buildArticleBlocksAsync} from '../../src/reader/media.ts';
import {contentText} from '../../src/reader/content.ts';
import {htmlToText} from '../../src/core/html.ts';
import {articlePreview} from '../../src/core/preview.ts';
import {traceServiceWork} from '@podjs/framework/service-trace';
import {fileChunks} from '@podjs/framework/services';
const appLogger={d(){}},init=async()=>{},db=sqlite;
const repo=new WatchRssRepository(db,async()=>{throw Error('Network forbidden');});
const importedTextStore={handle:async()=>{throw Error('Unexpected imported marker');}} as any;
${source.match(/function mapArticle\([\s\S]*?\n\}/)![0]}
${getter.trim().replace('async getArticle(id)','async function getReaderArticle(id:string)').replace(/},$/,'}')}`;
const runner=resolve(import.meta.dir,'sql-turn-runner.tsx');
// Inject at build time; keep the fixture runner in source free of copied product logic.
const bundle=arg('bundle','/tmp/sql-turn.js'),framework=arg('framework','/home/wilf/data/PodJS/podjs-watch.wt-c-k20');
await Bun.write(out+'.loader.ts',helper);
const result=Bun.spawnSync(['bun',resolve(import.meta.dir,'reader-entry.ts'),`--framework=${framework}`,`--runner=${runner}`,`--sql-loader=${out}.loader.ts`,`--sql-fixture=${out}`,`--mode=app`,`--out=${bundle}`],{stdout:'inherit',stderr:'inherit'});
if(result.exitCode)throw Error('SQL probe build failed');
console.log(JSON.stringify({fixture:out,bundle,queries:queries.map(([sql,p])=>({fingerprint:new Bun.CryptoHasher('sha256').update(sql).digest('hex'),rows:(sqlReplies[JSON.stringify([sql.replace(/\s+/g,' ').trim(),p])] as any[]).length,utf8Bytes:Buffer.byteLength(JSON.stringify(sqlReplies[JSON.stringify([sql.replace(/\s+/g,' ').trim(),p])]))}))}));
