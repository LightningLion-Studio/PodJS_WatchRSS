import {mount} from '@pocketjs/framework/solid';
import {createSignal} from 'solid-js';
import WatchRSS from '../../../src/ui/screen.tsx';
import {ReaderBackground,useReaderBackgrounds} from '../../../src/ui/ReaderBackground.tsx';
import {ReaderScreen} from '../../../src/ui/ReaderScreen.tsx';
import {services} from '../../../src/services.ts';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {delay,fileChunks,mediaSurfaces} from '@podjs/framework/services';
import {mediaSurfaceOwners} from '@podjs/framework/media-surface';
import {systemTextResourceCounts} from '@podjs/framework/text';
import {readerPreviewSession as session,requestReaderPreviewOpen} from '../../../src/reader/preview-host.ts';
import {handleReaderPreview} from '../../../src/sync/reader-preview.ts';
import {defaultReaderPreset} from '../../../src/reader/preset.ts';
import {ReaderPresetStore,notifyReaderPresetsChanged} from '../../../src/reader/preset-store.ts';
const sleep=(ms:number)=>delay(ms).result;
const [mode,setMode]=createSignal<'app'|'surface'|'article'>('app'),[preset,setPreset]=createSignal(defaultReaderPreset()),[active,setActive]=createSignal(true);
const article={id:'background-verification-only',title:'阅读背景验证',content:'背景应留在文字后面。\n图片与视频跟随页面裁切。\n退出阅读时释放资源。'};
const send=(request:Record<string,unknown>)=>handleReaderPreview({version:2,sessionId:'fixture-background',...request},session,requestReaderPreviewOpen);
async function stage(name:string,sequence=0){const value={state:'running',stage:name,nativePreset:preset(),logicalWidth:getDisplayMetrics().logicalWidth};let previous='';const end=Date.now()+90000;while(!(await fileChunks.stat('background-advance-'+name)).file){const resources={text:systemTextResourceCounts(),mediaOwners:mediaSurfaceOwners()},serialized=JSON.stringify(resources);if(previous!==serialized){kv.set('reader-background-result',{...value,...resources});previous=serialized;}if(Date.now()>end)throw Error('Snapshot stage timed out: '+name);if(session.state())send({phase:'heartbeat',sequence});await sleep(150);}}
async function run(){
 await sleep(2000);const store=new ReaderPresetStore(),backgrounds=[];
 for(const [id,kind,master,variants] of [
  ['image','IMAGE','pattern.png',{watch:{fileName:'pattern.png'}}],['image2','IMAGE','alternate.png',{watch:{fileName:'alternate.png'}}],['video','VIDEO','clip.mp4',{watch:{fileName:'clip.mp4'},watchPoster:{fileName:'pattern.png'}}],['broken','VIDEO','broken.mp4',{watch:{fileName:'broken.mp4'},watchPoster:{fileName:'pattern.png'}}]
 ] as const){const source=kind==='IMAGE'?'reader_assets/backgrounds/'+master:'reader_assets/variants/'+master,info=await fileChunks.hash(source);backgrounds.push({id,kind,masterFileName:master,variantsJson:JSON.stringify(variants),sha256:info.sha256,byteCount:info.size,displayName:id,mimeType:kind==='IMAGE'?'image/png':'video/mp4',metadataJson:'{}',updatedAt:1,modifiedBy:'fixture',deleted:false});}
 store.mergeManifest({presets:[],fonts:[],backgrounds,deletions:[]});notifyReaderPresetsChanged();const before=JSON.stringify(kv.get('watchrss.reader-presets'));
 const base=defaultReaderPreset('background-only','Background',true,14),image={...base,background:{...base.background,type:'IMAGE' as const,assetId:'image',colorArgb:0xff14304a}};
 setMode('surface');setPreset(image);await stage('image-crop');
 setPreset({...image,background:{...image.background,fit:'FIT',focusX:.2,focusY:.8,overlayColorArgb:0xff203010,overlayOpacity:.25}});await stage('image-fit');
 setPreset({...image,background:{...image.background,fit:'FILL',zoom:.75,focusX:.2,focusY:.8,rotationDegrees:27,brightness:.7,saturation:1.3,overlayOpacity:.35}});await stage('image-transform');
 setPreset({...image,background:{...image.background,blurDp:12,rotationDegrees:-17}});await stage('image-blur');
 setPreset({...image,background:{...image.background,assetId:'missing',overlayColorArgb:0x40203010,overlayOpacity:.4}});await stage('image-missing');
 const video={...image,background:{...image.background,type:'VIDEO' as const,assetId:'video'}};
 setPreset(video);await stage('video-start');
 setPreset({...video,background:{...video.background,fit:'FIT',zoom:.8,focusX:.2,focusY:.8,rotationDegrees:17,brightness:.8,saturation:.5,videoSpeed:1.5}});await stage('video-update');
 setActive(false);await stage('video-pause');setActive(true);await stage('video-resume');
 setPreset({...video,background:{...video.background,loop:false}});await stage('video-nonloop');
 setPreset({...video,background:{...video.background,assetId:'broken'}});await stage('video-broken');
 setMode('app');await sleep(2000);setPreset(image);send({phase:'update',sequence:0,preset:image});await stage('preview-image',0);
 const alternate={...image,background:{...image.background,assetId:'image2'}};send({phase:'resourceHandoff',sequence:1,preset:alternate});notifyReaderPresetsChanged();await stage('preview-transfer',1);
 send({phase:'update',sequence:2,preset:alternate});await stage('preview-alternate',2);send({phase:'stop'});
 setPreset({...image,background:{...image.background,overlayOpacity:.6}});setMode('article');await stage('article-image');
 setMode('app');await sleep(2000);if(JSON.stringify(kv.get('watchrss.reader-presets'))!==before)throw Error('Background rendering changed saved presets');
 if(mediaSurfaceOwners().length)throw Error('Media surfaces leaked: '+mediaSurfaceOwners());const text=systemTextResourceCounts();if(text.active||text.cached||text.queued)throw Error('Text resources leaked: '+JSON.stringify(text));
 kv.set('reader-background-result',{state:'passed',stage:'done',presetStorageUnchanged:true,mediaOwners:mediaSurfaceOwners(),systemTextResources:text});
}
function App(){const metrics=getDisplayMetrics(),backgrounds=useReaderBackgrounds();return <>{mode()==='surface'?<ReaderBackground background={preset().background} snapshot={backgrounds()} width={metrics.logicalWidth} height={metrics.logicalHeight} active={active()}/>:mode()==='article'?<ReaderScreen article={article} preset={preset()} services={services} width={metrics.logicalWidth} height={metrics.logicalHeight} fontSize={14} lineHeight={19} llmEnabled={false} llmAutoSummarize={false} llmPromptPreset={0} active={true} autoStart={false} speed={1} favorite={false} speaking={false} busy={false} onFavorite={()=>{}} onShare={()=>{}} onSpeak={()=>{}} onSpeechControls={()=>{}} onMedia={()=>{}} onControls={()=>{}} onError={error=>kv.set('reader-background-result',{state:'failed',error})} ref={()=>{}}/>:<WatchRSS services={services}/>}</>;}
mount(App);void run().catch(error=>kv.set('reader-background-result',{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
