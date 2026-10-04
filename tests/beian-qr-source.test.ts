import {expect,test} from 'bun:test';
import {inflateSync} from 'node:zlib';
import {beianQrPng} from '../src/ui/beian-qr-png.ts';
import {beianQrPixels} from '../src/ui/beian-qr.ts';
import {createBeianQrSource,type BeianQrFilePorts} from '../src/ui/beian-qr-source.ts';

function deferred<T>(){let resolve!:(value:T)=>void;return {promise:new Promise<T>(yes=>{resolve=yes;}),resolve};}
function ports(){
 const removed:string[]=[],writes:{path:string;bytes:Buffer}[]=[];let sequence=0;
 const value:BeianQrFilePorts={
  async createTemp(directory){return {path:`${directory}/.pod-write-fixture-${++sequence}.part`};},
  async write(path,encoded){const bytes=Buffer.from(encoded,'base64');writes.push({path,bytes});return {size:bytes.length};},
  async remove(path){removed.push(path);},
 };
 return {value,removed,writes};
}

test('PNG DEFLATE decodes to every native QR pixel, including row padding and multiple blocks',()=>{
 for(const size of [1,24,25,26,120,240,512,1024]){
  const png=beianQrPng(size),view=new DataView(png.buffer),pixels=beianQrPixels(size);
  expect(Array.from(png.subarray(0,8))).toEqual([137,80,78,71,13,10,26,10]);
  expect(view.getUint32(16)).toBe(size);expect(view.getUint32(20)).toBe(size);expect(png[24]).toBe(1);expect(png[25]).toBe(0);
  const dataLength=view.getUint32(33),scanlines=inflateSync(png.subarray(41,41+dataLength));
  const stride=Math.ceil(size/8)+1;expect(scanlines.length).toBe(stride*size);
  const decoded:Uint8Array=new Uint8Array(size*size*4);
  for(let y=0;y<size;y++){
   expect(scanlines[y*stride]).toBe(0);
   for(let x=0;x<size;x++){
    const gray=scanlines[y*stride+1+(x>>>3)]&(1<<(7-(x&7)))?255:0,offset=(y*size+x)*4;
    decoded[offset]=decoded[offset+1]=decoded[offset+2]=gray;decoded[offset+3]=255;
   }
  }
  expect(decoded).toEqual(pixels);
 }
 for(const invalid of [0,-1,1.5,NaN,Infinity,1025])expect(()=>beianQrPng(invalid)).toThrow();
});

test('two visible QR sources own separate files and close only their own allocation',async()=>{
 const f=ports(),first=createBeianQrSource(240,f.value),second=createBeianQrSource(240,f.value);
 const paths=await Promise.all([first.result,second.result]);expect(new Set(paths).size).toBe(2);expect(f.removed).toEqual([]);
 expect(f.writes.map(row=>row.path)).toEqual(paths);expect(f.writes[0].bytes.length).toBeLessThan(8192);
 first.close();first.close();await Promise.resolve();expect(f.removed).toEqual([paths[0]]);
 second.close();await Promise.resolve();expect(f.removed).toEqual(paths);
});

test('closing before allocation or during a write drains late work then cleans its own file',async()=>{
 for(const stage of ['allocation','write']){
  const f=ports(),allocation=deferred<{path:string}>(),write=deferred<{size:number}>();
  if(stage==='allocation')f.value.createTemp=()=>allocation.promise;
  else f.value.write=()=>write.promise;
  const request=createBeianQrSource(240,f.value);await Promise.resolve();request.close();
  expect(f.removed).toEqual([]);
  if(stage==='allocation')allocation.resolve({path:'beian-qr/.pod-write-late.part'});
  else write.resolve({size:beianQrPng(240).length});
  await expect(request.result).rejects.toThrow('已关闭');expect(f.removed).toHaveLength(1);expect(f.writes).toEqual([]);
 }
});

test('bad writes clean owned placeholders while unexpected paths are never removed',async()=>{
 for(const failure of ['short','throw']){
  const f=ports();f.value.write=async()=>{if(failure==='throw')throw Error('disk full');return {size:0};};
  await expect(createBeianQrSource(240,f.value).result).rejects.toThrow();expect(f.removed).toEqual(['beian-qr/.pod-write-fixture-1.part']);
 }
 const f=ports();f.value.createTemp=async()=>({path:'reader-assets/preserved.png'});
 await expect(createBeianQrSource(240,f.value).result).rejects.toThrow('路径无效');expect(f.removed).toEqual([]);expect(f.writes).toEqual([]);
});
