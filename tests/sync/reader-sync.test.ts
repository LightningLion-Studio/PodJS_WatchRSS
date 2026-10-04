import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {ReaderPresetStore,READER_PRESETS_KEY,availableReaderPresets,onReaderPresetsChanged,notifyReaderPresetsChanged} from '../../src/reader/preset-store.ts';
import {defaultReaderPreset} from '../../src/reader/preset.ts';
import {parseReaderManifest,mergeReaderManifest,type ReaderManifest} from '../../src/sync/reader-manifest.ts';
import {ReaderResources,READER_CHUNK_BYTES as CHUNK,type ReaderResourceFiles} from '../../src/sync/reader-resources.ts';
import {ReaderSyncActions} from '../../src/sync/reader-actions.ts';
import {encodeChunkData,type JsonObject} from '../../src/sync/protocol.ts';
const empty=():ReaderManifest=>({presets:[],fonts:[],backgrounds:[],deletions:[]});
const preset=(id='p',updatedAt=1,deleted=false,modifiedBy='a')=>({id,name:'preset',payloadJson:JSON.stringify(defaultReaderPreset(id)),updatedAt,deleted,modifiedBy});
const font=(id='f',sha256='h')=>({id,sha256,displayName:'font',familyName:'family',fileName:'f.ttf',mimeType:'font/ttf',byteCount:3,faceCount:1,metadataJson:'{}',updatedAt:1,modifiedBy:'a',deleted:false});
const background=()=>({id:'b',sha256:'b'.repeat(64),displayName:'b',kind:'IMAGE',mimeType:'image/png',masterFileName:'b.png',byteCount:2,durationMs:0,width:10,height:10,posterAssetId:'',variantsJson:'{}',updatedAt:1,modifiedBy:'a',deleted:false});
const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
function files(){
 const data=new Map<string,Uint8Array>();
 const port:ReaderResourceFiles={stat:async p=>({file:data.has(p),size:data.get(p)?.length??0}),read:async(p,o,n)=>{if(!data.has(p))throw Error('missing');return data.get(p)!.slice(o,o+n);},write:async(p,b)=>{data.set(p,b.slice());},append:async(p,b,o)=>{const old=data.get(p)??new Uint8Array();if(old.length!==o)throw Error('offset');const next=new Uint8Array(o+b.length);next.set(old);next.set(b,o);data.set(p,next);},truncate:async(p,n)=>{data.set(p,data.get(p)!.slice(0,n));},remove:async p=>{data.delete(p);},hash:async p=>{const b=data.get(p);if(!b)throw Error('missing');return {size:b.length,sha256:hash(b)};},digest:async b=>hash(b),commit:async(p,target,size,sha)=>{const b=data.get(p)!;if(b.length!==size||hash(b)!==sha.toLowerCase())throw Error('commit mismatch');data.set(target,b);data.delete(p);}};
 return {data,port,resources:new ReaderResources(port)};
}
const push=(bytes:Uint8Array,index:number,count:number,complete:Uint8Array,extra:JsonObject={})=>({kind:'font',fileName:'font.ttf',sha256:hash(complete),totalBytes:complete.length,chunkIndex:index,chunkCount:count,chunkSha256:hash(bytes),data:encodeChunkData(bytes),...extra});
test('manifest preserves native timestamp/tombstone/device tie rules and REPLACE/hash uniqueness',()=>{
 const local={...empty(),presets:[preset()],fonts:[font('old')],deletions:[{kind:'preset',entityId:'p',deletedAt:5,deletedBy:'old'}]};
 expect(mergeReaderManifest(local,{...empty(),presets:[preset('p',0,true,'z')]}).presets).toEqual(local.presets);
 expect(mergeReaderManifest(local,{...empty(),presets:[preset('p',1,true,'0')]}).presets[0]!.deleted).toBe(true);
 expect(mergeReaderManifest({...local,presets:[preset('p',1,true)]},{...empty(),presets:[preset('p',1,false,'z')]}).presets[0]!.deleted).toBe(true);
 expect(mergeReaderManifest(local,{...empty(),presets:[preset('p',1,false,'z')]}).presets[0]!.modifiedBy).toBe('z');
 const result=mergeReaderManifest(local,{...empty(),fonts:[font('new')],deletions:[{kind:'preset',entityId:'p',deletedAt:1,deletedBy:'remote'}]});expect(result.fonts.map(r=>r.id)).toEqual(['new']);expect(result.deletions[0]!.deletedAt).toBe(1);expect(result.presets[0]!.deleted).toBe(false);
});
test('reader manifest parses whole request before any storage write and preserves old KV for empty exchange',async()=>{
 let writes=0;const values=new Map<string,unknown>();const store=new ReaderPresetStore({get:<T>(k:string)=>values.get(k) as T|undefined,set:(k,v)=>{writes++;values.set(k,v);}});const seeded=store.ensureSeeded(true,16,5),before=JSON.stringify(values.get(READER_PRESETS_KEY));writes=0;
 const {resources}=files();let changed=0;const actions=new ReaderSyncActions(store,resources,()=>changed++);
 const response=await actions.apply({phase:'manifest'});expect(response.version).toBe(11);expect((response.presets as any[]).length).toBe(2);expect(writes).toBe(0);expect(JSON.stringify(values.get(READER_PRESETS_KEY))).toBe(before);
 await expect(actions.apply({phase:'manifest',presets:[preset('new')],fonts:[{}]})).rejects.toThrow();expect(writes).toBe(0);
 await actions.apply({phase:'manifest',presets:[preset('new')],fonts:[font('f')],backgrounds:[background()]});expect(writes).toBe(1);expect(store.load().selection).toEqual(seeded.selection);expect(availableReaderPresets(store.load()).map(p=>p.id)).toContain('new');expect(store.exportManifest().fonts).toHaveLength(1);expect(changed).toBe(2);
 store.setThemeMode('LIGHT');expect(store.exportManifest().fonts).toHaveLength(1);
});
test('resource transfer validates chunks, retains target until complete, resumes and serves each 1 MiB range',async()=>{
 const {data,resources,port}=files(),all=new Uint8Array(CHUNK+7).fill(3);data.set('reader_assets/fonts/font.ttf',new Uint8Array([9]));
 await expect(resources.push(push(all.subarray(0,CHUNK),0,2,all,{chunkSha256:'bad'}))).rejects.toThrow('资源分块校验失败');expect(data.size).toBe(1);
 expect(await resources.push(push(all.subarray(0,CHUNK),0,2,all))).toMatchObject({applied:false});expect(data.get('reader_assets/fonts/font.ttf')).toEqual(new Uint8Array([9]));
 const restarted=new ReaderResources(port);expect(await restarted.push(push(all.subarray(0,CHUNK),0,2,all))).toMatchObject({applied:false});
 expect(await restarted.push(push(all.subarray(CHUNK),1,2,all))).toMatchObject({applied:true});expect(data.get('reader_assets/fonts/font.ttf')).toEqual(all);expect(data.has('reader_assets/fonts/font.ttf.part.meta')).toBe(false);
 for(let i=0;i<2;i++){const response=await restarted.pull({kind:'font',fileName:'font.ttf',chunkIndex:i});expect(response.data).toBe(encodeChunkData(all.subarray(i*CHUNK,(i+1)*CHUNK)));expect(response.chunkCount).toBe(2);}
 expect(await restarted.push(push(all.subarray(CHUNK),1,2,all))).toMatchObject({applied:true});
 await expect(restarted.pull({kind:'font',fileName:'font.ttf',chunkIndex:2})).rejects.toThrow('资源分块越界');

});
test('resource retry handles changed transfer, partial writes, conflicting replay and invalid paths',async()=>{
 const {data,resources}=files(),all=new Uint8Array(CHUNK*2).fill(8),part='reader_assets/fonts/font.ttf.part';
 await expect(resources.push(push(all.subarray(CHUNK),1,2,all))).rejects.toThrow('资源传输已变化');
 await resources.push(push(all.subarray(0,CHUNK),0,2,all));data.set(part,new Uint8Array(CHUNK+13).fill(8));expect(await resources.push(push(all.subarray(CHUNK),1,2,all))).toMatchObject({applied:true});
 data.delete('reader_assets/fonts/font.ttf');await resources.push(push(all.subarray(0,CHUNK),0,3,new Uint8Array(CHUNK*3).fill(8)));const newAll=new Uint8Array(CHUNK*3).fill(8);data.set(part,new Uint8Array(CHUNK*2).fill(9));
 await expect(resources.push(push(newAll.subarray(CHUNK,CHUNK*2),1,3,newAll))).rejects.toThrow('资源分块内容冲突');
 expect(await resources.push(push(newAll.subarray(0,CHUNK),0,3,newAll))).toMatchObject({applied:false});expect(data.get(part)).toEqual(newAll.subarray(0,CHUNK));
 for(const name of ['../x','x/y','x\\y','x..y',' '])await expect(resources.push(push(new Uint8Array(),0,1,new Uint8Array(),{fileName:name}))).rejects.toThrow('文件名无效');
});
test('empty resources and missing master/watch/poster descriptors follow native behavior',async()=>{
 const {data,resources}=files();expect(await resources.push(push(new Uint8Array(),0,1,new Uint8Array()))).toMatchObject({applied:true});expect(await resources.pull({kind:'font',fileName:'font.ttf',chunkIndex:0})).toMatchObject({data:'',chunkCount:1,totalBytes:0});
 const bg={...background(),variantsJson:JSON.stringify({watch:{fileName:'watch.png',sha256:'c'.repeat(64),byteCount:1},watchPoster:{fileName:'poster.png',sha256:'d'.repeat(64),byteCount:0},phone:{fileName:'ignore.png',sha256:'e'.repeat(64),byteCount:1}})};
 const snapshot={...empty(),fonts:[{...font(),fileName:'font.ttf',sha256:hash(new Uint8Array()),byteCount:0},{...font('deleted'),deleted:true}],backgrounds:[bg]};
 expect((await resources.missing(snapshot)).map(r=>[r.kind,r.fileName])).toEqual([['background','b.png'],['variant','watch.png'],['variant','poster.png']]);expect(data.size).toBe(1);
});
test('preset update listeners release ownership and entity tombstones govern payload visibility',()=>{
 let calls=0;const stop=onReaderPresetsChanged(()=>calls++);notifyReaderPresetsChanged();stop();notifyReaderPresetsChanged();expect(calls).toBe(1);
 const store=new ReaderPresetStore({get:<T>()=>({version:1,records:[{...preset(),deleted:true}],selection:{mode:'DARK',lightPresetId:'p',darkPresetId:null,darkFollowsLight:true},schedule:{mode:'FIXED_TIME',lightStartMinutes:420,darkStartMinutes:1140,latitude:null,longitude:null,locationUpdatedAt:0}} as T),set:()=>{}});expect(availableReaderPresets(store.load())).toEqual([]);
 expect(parseReaderManifest({presets:[null,'ignored',preset()]}).presets).toHaveLength(1);
});

test('reader wire parsing, conflict predicates and resource acknowledgements match native Kotlin',async()=>{
 const native=await import('../fixtures/reader-sync-native.json');
 for(const row of native.parsing){const request=JSON.parse(row.raw);if('error' in row)expect(()=>parseReaderManifest(request)).toThrow();else expect(parseReaderManifest(request)).toEqual(row.expected);}
 for(const row of native.conflicts){const local={...preset(),...row.local,name:'local'},incoming={...preset(),...row.incoming,name:'remote'};expect(mergeReaderManifest({...empty(),presets:[local]},{...empty(),presets:[incoming]}).presets[0]!.name).toBe(row.wins?'remote':'local');}
 const {resources,data}=files(),all=new Uint8Array(CHUNK+7).fill(3);
 for(const step of native.transfer){if('error' in step)await expect(resources.push(push(all.subarray(step.index*CHUNK,Math.min(all.length,(step.index+1)*CHUNK)),step.index,2,all))).rejects.toThrow(step.error);else expect(await resources.push(push(all.subarray(step.index*CHUNK,Math.min(all.length,(step.index+1)*CHUNK)),step.index,2,all))).toEqual(step.response);if('targetHash' in step)expect(hash(data.get('reader_assets/fonts/font.ttf')!)).toBe(step.targetHash!);}
 expect(await resources.pull({kind:'font',fileName:'font.ttf',chunkIndex:1})).toEqual(native.pullLast);
});

test('asset-only manifests retain raw preset payloads and real preset updates leave unrelated records untouched',()=>{
 const values=new Map<string,unknown>(),store=new ReaderPresetStore({get:<T>(k:string)=>values.get(k) as T|undefined,set:(k,v)=>{values.set(k,v);}});
 const seeded=store.ensureSeeded(true,16,5),raw=JSON.stringify(seeded.records),selection=JSON.stringify(seeded.selection);
 store.mergeManifest({...empty(),fonts:[font()],backgrounds:[background()]});
 expect(JSON.stringify(store.load().records)).toBe(raw);expect(JSON.stringify(store.load().selection)).toBe(selection);expect(store.exportManifest().fonts).toHaveLength(1);expect(store.exportManifest().backgrounds).toHaveLength(1);
 const changed=preset('reader-podjs-migrated',20);store.mergeManifest({...empty(),presets:[changed]});
 expect(store.exportManifest().presets.find(p=>p.id===changed.id)).toEqual(changed);
 expect(store.load().records[0]).toEqual(seeded.records[1]);expect(store.load().selection).toEqual(seeded.selection);
});
