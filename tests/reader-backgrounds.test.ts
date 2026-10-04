import {describe,it,expect} from 'bun:test';
import {readerBackgroundResources,selectReaderBackgroundFiles,readerBackgroundStyle,type ReaderBackgroundSnapshot} from '../src/reader/background-assets.ts';
import {defaultReaderPreset} from '../src/reader/preset.ts';
const bg=()=>({...defaultReaderPreset().background,type:'IMAGE' as const,assetId:'image'});
const snapshot=(rows:unknown[],revision=1)=>({state:{assets:{fonts:[],backgrounds:rows,deletions:[]}},revision}) as ReaderBackgroundSnapshot;
const image={id:'image',kind:'IMAGE',masterFileName:'master.jpg',variantsJson:JSON.stringify({watch:{fileName:'watch.webp'}}),sha256:'image-sha',updatedAt:1,deleted:false};
describe('native reader background resource selection',()=>{
 it('prefers the watch image but falls back to an existing master',async()=>{
  const spec=readerBackgroundResources(bg(),snapshot([image]));expect(spec.imagePaths).toEqual(['reader_assets/variants/watch.webp','reader_assets/backgrounds/master.jpg']);
  expect(await selectReaderBackgroundFiles(spec,async path=>path.endsWith('master.jpg'))).toEqual({kind:'image',path:'reader_assets/backgrounds/master.jpg'});
  expect(await selectReaderBackgroundFiles(spec,async()=>false)).toBeUndefined();
 });
 it('video uses its watch clip and watchPoster, not posterAssetId or the master as a clip',async()=>{
  const video={...image,kind:'VIDEO',masterFileName:'original.mp4',variantsJson:JSON.stringify({watch:{fileName:'clip.mp4'},watchPoster:{fileName:'poster.webp'}})};
  const spec=readerBackgroundResources({...bg(),type:'VIDEO'},snapshot([video]));
  expect(await selectReaderBackgroundFiles(spec,async()=>true)).toEqual({kind:'video',path:'reader_assets/variants/clip.mp4',posterPath:'reader_assets/variants/poster.webp'});
  expect(await selectReaderBackgroundFiles(spec,async p=>p.endsWith('poster.webp'))).toEqual({kind:'image',path:'reader_assets/variants/poster.webp'});
  const masterOnly=readerBackgroundResources({...bg(),type:'VIDEO'},snapshot([{...video,variantsJson:'{}'}]));expect(masterOnly.videoPath).toBeUndefined();
 });
 it('filters tombstones and rejects unsafe names while preserving safe fallback',()=>{
  expect(readerBackgroundResources(bg(),snapshot([{...image,deleted:true}])).imagePaths).toEqual([]);
  expect(readerBackgroundResources({...bg(),type:'SOLID'},snapshot([image])).imagePaths).toEqual([]);
  const invalid={...image,variantsJson:JSON.stringify({watch:{fileName:'../escape.png'}})};expect(readerBackgroundResources(bg(),snapshot([invalid])).imagePaths).toEqual(['reader_assets/backgrounds/master.jpg']);
  expect(readerBackgroundResources(bg(),snapshot([{...invalid,masterFileName:'/system/private'}])).imagePaths).toEqual([]);
 });
 it('resource replacement changes identity even without a new preset',()=>{
  const a=readerBackgroundResources(bg(),snapshot([image])),b=readerBackgroundResources(bg(),snapshot([image],2)),c=readerBackgroundResources(bg(),snapshot([{...image,sha256:'replacement'}]));
  expect(a.revision).not.toBe(b.revision);expect(a.revision).not.toBe(c.revision);
 });
 it('preserves native appearance and playback controls without double trimming',()=>{
  const background={...bg(),fit:'FILL' as const,zoom:1.25,focusX:.2,focusY:.8,rotationDegrees:27,blurDp:12.4,brightness:.7,saturation:1.2,overlayOpacity:.3,videoSpeed:1.5,loop:false,videoTrimStartMs:900,videoTrimEndMs:2500,posterAssetId:'ignored-native-metadata'};
  const result=readerBackgroundStyle(background,2,false);expect(result).toMatchObject({fit:'fill',zoom:1.25,focusX:.2,focusY:.8,rotationDegrees:27,brightness:.7,saturation:1.2,overlayOpacity:.3,speed:1.5,loop:false,active:false});expect(result.blurPx).toBe(Math.fround(Math.fround(12.4)*2));expect(result).not.toHaveProperty('videoTrimStartMs');
 });
});
