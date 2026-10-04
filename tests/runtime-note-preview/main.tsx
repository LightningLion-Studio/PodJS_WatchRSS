import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {createSignal,Show} from 'solid-js';
import {kv,getDisplayMetrics} from '@podjs/framework/watch';
import {sqlite,fileChunks,delay} from '@podjs/framework/services';
import {MemoRepository} from '../../src/notes/index.ts';
import type {SqlDatabase} from '../../src/core/types.ts';
import {NoteAssetReceiver} from '../../src/sync/note-assets.ts';
import {NoteDetailScreen} from '../../src/ui/NotesScreen.tsx';
import {RemoteImage,remoteImageResourceCounts} from '../../src/ui/RemoteImage.tsx';
import {TiledImage} from '../../src/ui/TiledImage.tsx';
import {prepareNotePreview,noteBlockSourceOffsets} from '../../src/notes/preview.ts';
import native from '../fixtures/note-preview-native.json';
import fixture from '../fixtures/note-preview-image.json';
const key='note-preview-result',path='notes/assets/note-preview-owned.png',repo=new MemoRepository(sqlite as SqlDatabase,'preview-fixture',()=> 'note-preview-owned');
const [phase,setPhase]=createSignal('starting');let thumbnail=false,tiled=false,error='';
const metrics=getDisplayMetrics(),width=metrics.logicalWidth,height=metrics.logicalHeight;
function check(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
function same(a:unknown,b:unknown):boolean{if(a===b)return true;if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;const x=a as Record<string,unknown>,y=b as Record<string,unknown>;return Object.keys(x).length===Object.keys(y).length&&Object.keys(x).every(k=>same(x[k],y[k]));}
async function until(value:()=>boolean){const deadline=Date.now()+20000;while(!value()){check(!error,error);check(Date.now()<deadline,'Image completion deadline');await delay(50).result;}}
async function run(){
 for(const c of native.cases){const blocks=prepareNotePreview(c.input);check(same(blocks,c.blocks),'Native blocks mismatch');check(same(noteBlockSourceOffsets(c.input,blocks),c.offsets),'Native offsets mismatch');}
 await repo.initialize();check((await repo.allIncludingDeleted()).length===0,'Fixture memos must be empty');check(!(await fileChunks.stat(path)).exists,'Owned asset exists');
 try{
  const response=await new NoteAssetReceiver(fileChunks).apply({version:1,storageKey:'note-preview-owned.png',sha256:fixture.sha256,chunkIndex:0,chunkCount:1,data:fixture.data});check(response.complete,'Asset receive');
  setPhase('thumbnail');await until(()=>thumbnail);setPhase('starting');await delay(150).result;check((await fileChunks.hash(path)).sha256===fixture.sha256,'Thumbnail cleanup removed asset');
  setPhase('tiled');await until(()=>tiled);setPhase('starting');await delay(200).result;check((await fileChunks.hash(path)).sha256===fixture.sha256,'Preview cleanup removed asset');
  await repo.save({title:'备忘录预览验证',markdown:'# 标题\n正文与 **粗体**\n![资源图片](assets/note-preview-owned.png)\n| A | B |\n| --- | ---: |\n| 数据 | 22 |\n```html\n<p>literal</p>\n```'});
  setPhase('detail');await delay(1200).result;check(!error,error);setPhase('starting');await delay(200).result;check((await fileChunks.hash(path)).sha256===fixture.sha256,'Detail cleanup removed asset');check(remoteImageResourceCounts().cached===0,'Thumbnail cache retained');
 }finally{setPhase('starting');await sqlite.execute('DELETE FROM memo_notes WHERE note_id=?',['note-preview-owned']);await fileChunks.remove(path);await fileChunks.remove('notes/assets/.note-preview-owned.png.part');}
 kv.set(key,{state:'passed',nativeCases:native.cases.length,thumbnailDecodedAndUploaded:thumbnail,tiledOverviewDecodedAndUploaded:tiled,sourceRetainedAcrossUnmounts:true,detailMounted:true,ownedRowsAndFilesRemoved:true,visualAcceptance:false});
}
mount(()=><><Show when={phase()==='thumbnail'}><RemoteImage url="assets/note-preview-owned.png" filePath={path} width={64} height={64} onSize={(w,h)=>{thumbnail=w===4&&h===4;}} onError={e=>{error=String(e);}}/></Show><Show when={phase()==='tiled'}><TiledImage url="assets/note-preview-owned.png" filePath={path} geometry={{width,height,imageWidth:4,imageHeight:4,density:metrics.density}} state={{scale:1,x:0,y:0}} onSize={(w,h)=>{tiled=w===4&&h===4;}} onError={e=>{error=String(e);}}/></Show><Show when={phase()==='detail'}><NoteDetailScreen repository={repo} noteId="note-preview-owned" width={width} height={height} input={async()=>null} onBack={()=>{error='Unexpected back';}} onError={e=>{error=e;}}/></Show><Show when={phase()==='starting'}><Text>Note preview verification</Text></Show></>);void run().catch(e=>kv.set(key,{state:'failed',error:String(e)}));
