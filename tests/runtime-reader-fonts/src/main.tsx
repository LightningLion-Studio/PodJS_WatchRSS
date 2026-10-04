import {mount} from '@pocketjs/framework/solid';
import {createSignal} from 'solid-js';
import WatchRSS from '../../../src/ui/screen.tsx';
import {ReaderScreen} from '../../../src/ui/ReaderScreen.tsx';
import {services} from '../../../src/services.ts';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {delay,fileChunks} from '@podjs/framework/services';
import {systemTextResourceCounts} from '@podjs/framework/text';
import {readerPreviewSession as session,requestReaderPreviewOpen} from '../../../src/reader/preview-host.ts';
import {handleReaderPreview} from '../../../src/sync/reader-preview.ts';
import {defaultReaderPreset} from '../../../src/reader/preset.ts';
import {ReaderPresetStore,notifyReaderPresetsChanged} from '../../../src/reader/preset-store.ts';
const sleep=(ms:number)=>delay(ms).result;
const [articleMode,setArticleMode]=createSignal(false),[preset,setPreset]=createSignal(defaultReaderPreset());
const article={id:'font-verification-only',title:'阅读字体的形状变化',content:'阅读时字体的形状与换行应保持一致。\n我们比较系统字体与自定义宋体。\nWWW iii 字体测量 12345'};
const send=(request:Record<string,unknown>)=>handleReaderPreview({version:2,sessionId:'fixture-font',...request},session,requestReaderPreviewOpen);
async function stage(name:string,sequence:number){kv.set('reader-font-result',{state:'running',stage:name,nativePreset:session.state()?.preset??preset(),logicalWidth:getDisplayMetrics().logicalWidth});const end=Date.now()+90000;while(!(await fileChunks.stat('font-advance-'+name)).file){if(Date.now()>end)throw Error('Snapshot stage timed out: '+name);if(session.state())send({phase:'heartbeat',sequence});await sleep(150);}}
async function run(){
 await sleep(2000);const store=new ReaderPresetStore(),state=store.load(),fonts=[];
 for(const [id,fileName] of [['serif','serif.ttc'],['sans','sans.ttc']]){const info=await fileChunks.hash('reader_assets/fonts/'+fileName);fonts.push({id,fileName,sha256:info.sha256,byteCount:info.size,displayName:id,familyName:id,mimeType:'font/collection',metadataJson:'{}',faceCount:2,updatedAt:1,modifiedBy:'fixture',deleted:false});}
 store.mergeManifest({presets:[],fonts,backgrounds:[],deletions:[]});notifyReaderPresetsChanged();const before=JSON.stringify(kv.get('watchrss.reader-presets'));
 const base=defaultReaderPreset('font-only','Font preview',true,14),serif={...base,body:{...base.body,fontAssetId:'serif'}},sans={...base,body:{...base.body,fontAssetId:'sans'}};
 send({phase:'update',sequence:0,preset:base});await stage('preview-system',0);
 send({phase:'update',sequence:1,preset:serif});await stage('preview-serif',1);
 send({phase:'resourceHandoff',sequence:2,preset:sans});notifyReaderPresetsChanged();await stage('preview-transfer',2);
 send({phase:'update',sequence:3,preset:sans});await stage('preview-sans',3);send({phase:'stop'});await stage('preview-stopped',3);
 setPreset(serif);setArticleMode(true);await stage('article-serif',3);setPreset(base);await stage('article-system',3);
 setPreset({...base,body:{...base.body,fontAssetId:'missing'}});await stage('article-missing',3);
 setArticleMode(false);await sleep(2000);if(JSON.stringify(kv.get('watchrss.reader-presets'))!==before)throw Error('Rendering changed preset storage');
 const counts=systemTextResourceCounts();if(counts.active||counts.cached||counts.queued)throw Error('Text resources leaked: '+JSON.stringify(counts));
 kv.set('reader-font-result',{state:'passed',stage:'done',presetStorageUnchanged:true,systemTextResources:counts});
}
function App(){const metrics=getDisplayMetrics();return <>{articleMode()?<ReaderScreen article={article} preset={preset()} services={services} width={metrics.logicalWidth} height={metrics.logicalHeight} fontSize={14} lineHeight={19} llmEnabled={false} llmAutoSummarize={false} llmPromptPreset={0} active={true} autoStart={false} speed={1} favorite={false} speaking={false} busy={false} onFavorite={()=>{}} onShare={()=>{}} onSpeak={()=>{}} onSpeechControls={()=>{}} onMedia={()=>{}} onControls={()=>{}} onError={error=>kv.set('reader-font-result',{state:'failed',error})} ref={()=>{}}/>:<WatchRSS services={services}/>}</>;}
mount(App);void run().catch(error=>kv.set('reader-font-result',{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
