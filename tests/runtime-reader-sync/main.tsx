import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {ReaderPresetStore,activeReaderPreset} from '../../src/reader/preset-store.ts';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import {ReaderSyncActions} from '../../src/sync/reader-actions.ts';
import {ReaderResources,READER_CHUNK_BYTES as CHUNK} from '../../src/sync/reader-resources.ts';
import {hostReaderResourceFiles as files} from '../../src/sync/reader-resources-host.ts';
import {encodeChunkData,type JsonObject} from '../../src/sync/protocol.ts';
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
async function run(){
 const started=Date.now();kv.set('reader-sync-result',{state:'running',stage:'initialize'});
 const store=new ReaderPresetStore();store.ensureSeeded(true,16,5);const bytes=new Uint8Array(CHUNK+7).fill(3),hash=await files.digest(bytes),preset=defaultReaderPreset('phone-preset','Phone preset',true,23);
 const font={id:'phone-font',sha256:hash,displayName:'Fixture bytes',familyName:'fixture',fileName:'fixture.bin',mimeType:'application/octet-stream',byteCount:bytes.length,faceCount:1,metadataJson:'{}',updatedAt:10,modifiedBy:'phone',deleted:false};
 let changes=0;const resources=new ReaderResources(files),actions=new ReaderSyncActions(store,resources,()=>changes++);
 const manifest=await actions.apply({phase:'manifest',presets:[{id:preset.id,name:preset.name,payloadJson:JSON.stringify(preset),updatedAt:10,modifiedBy:'phone',deleted:false}],fonts:[font]});check((manifest.missingResources as any[]).length===1,'missing font');store.selectPreset('dark',preset.id);check(activeReaderPreset(new ReaderPresetStore().load()).body.fontSizeSp===23,'persistent selected preset');
 const target='reader_assets/fonts/fixture.bin';await files.write(target,new Uint8Array([9]));
 const push=async(index:number)=>{const data=bytes.subarray(index*CHUNK,Math.min(bytes.length,(index+1)*CHUNK));return actions.apply({phase:'pushResource',kind:'font',fileName:'fixture.bin',sha256:hash,totalBytes:bytes.length,chunkIndex:index,chunkCount:2,chunkSha256:await files.digest(data),data:encodeChunkData(data)});};
 kv.set('reader-sync-result',{state:'running',stage:'first-chunk'});check((await push(0)).applied===false,'first applied');check((await files.read(target,0,1))[0]===9,'target replaced early');check((await push(0)).applied===false,'duplicate');
 // Model an interrupted second native write, then exercise the actual host's bounded-prefix truncation adapter.
 await files.append(target+'.part',new Uint8Array([3,3]),CHUNK);
 kv.set('reader-sync-result',{state:'running',stage:'resume'});check((await push(1)).applied===true,'complete');check((await files.hash(target)).sha256===hash,'target hash');check((await actions.apply({phase:'manifest'})).missingResources instanceof Array,'manifest response');check((await resources.missing(new ReaderPresetStore().exportManifest())).length===0,'resource still missing');
 kv.set('reader-sync-result',{state:'running',stage:'pull'});
 for(let i=0;i<2;i++){const response=await actions.apply({phase:'pullResource',kind:'font',fileName:'fixture.bin',chunkIndex:i});check(response.data===encodeChunkData(bytes.subarray(i*CHUNK,Math.min(bytes.length,(i+1)*CHUNK))),'pull data');}
 check(!(await files.stat(target+'.part.meta')).file,'metadata remains');
 kv.set('reader-sync-result',{state:'passed',bytes:bytes.length,sha256:hash,selectedFontSize:activeReaderPreset(new ReaderPresetStore().load()).body.fontSizeSp,manifestPresets:store.exportManifest().presets.length,manifestFonts:store.exportManifest().fonts.length,partialRetry:true,duplicateChunk:true,targetPreservedUntilComplete:true,exactPull:true,changes,elapsedMs:Date.now()-started});
}
mount(()=><Text>Reader sync verification</Text>);
void run().catch(error=>kv.set('reader-sync-result',{state:'failed',error:String(error),stack:error instanceof Error?error.stack:''}));
