import {test,expect} from 'bun:test';
import {createHash} from 'node:crypto';
import {ManagedCache,type CachePorts,type CacheEntry} from '../src/cache/managed.ts';
import {cacheEvictionOrder,cacheSizeLabel,inlineImageTargets,type CacheFile} from '../src/cache/policy.ts';
import {prefetchInlineImages} from '../src/cache/prefetch.ts';
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
const tick=()=>new Promise<void>(r=>setTimeout(r,0));
function fixture(){
 const files=new Map<string,CacheEntry>(),removed:string[]=[],downloads:{url:string;path:string;cancelled:boolean;finish():void}[]=[];let now=100;
 const put=(path:string,size=10,modified=++now)=>files.set(path,{path,file:true,directory:false,size,modified});
 const ports:CachePorts={list:async path=>({entries:[...files.values()].filter(f=>f.path.startsWith(path+'/')&&!f.path.slice(path.length+1).includes('/'))}),stat:async path=>({exists:files.has(path),file:files.has(path),size:files.get(path)?.size??0}),remove:async path=>{removed.push(path);files.delete(path);},touch:async path=>{const f=files.get(path);if(!f)throw Error('missing');f.modified=++now;},digest:async s=>digest(s),download:(url,path)=>{let yes!:()=>void,no!:(e:unknown)=>void;const result=new Promise<void>((a,b)=>{yes=a;no=b;});const job={url,path,cancelled:false,finish(){put(path);yes();}};downloads.push(job);return {result,cancel(){job.cancelled=true;no(Error('cancelled'));}};}};
 return {files,removed,downloads,put,ports,cache:new ManagedCache(ports)};
}
test('native bucket priority retains four Douyin entries and all offline content',()=>{
 const files:CacheFile[]=[...Array.from({length:8},(_,i)=>({path:'d'+i,bucket:'douyin-preload' as const,size:10,modified:i})),{path:'image',bucket:'images',size:10,modified:1},{path:'bili',bucket:'bili-preview',size:10,modified:1},{path:'offline',bucket:'rss-offline',size:1000,modified:0}];
 expect(cacheEvictionOrder(files,100).map(f=>f.path)).toEqual(['d0','d1','image','bili','d2','d3']);
 expect(cacheEvictionOrder(files,1080).map(f=>f.path)).toEqual(['d0','d1']);
 expect(cacheEvictionOrder(files,0,new Set(['d0','image'])).map(f=>f.path)).toEqual(['d1','bili','d2','d3']);
});
test('native inline prefetch deduplicates images and skips video, data, and local paths',()=>{
 const blocks:any[]=[{type:'image',url:'https://x/0'},{type:'image',url:'https://x/0'},{type:'video',url:'https://x/video'},...Array.from({length:6},(_,i)=>({type:'image',url:'https://x/'+i})),{type:'image',url:'data:image/png;base64,eA=='},{type:'image',url:'file:///x.png'}];
 expect(inlineImageTargets(blocks,'https://x/a','关闭')).toEqual([]);expect(inlineImageTargets(blocks,'https://x/a','前 4 项')).toEqual([0,1,2,3].map(i=>'https://x/'+i));expect(inlineImageTargets(blocks,'https://x/a','全部')).toHaveLength(6);
 expect([512,768,1024,1536,2048,2560,3072,4096].map(cacheSizeLabel)).toEqual(['512M','768M','1G','1.5G','2G','2.5G','3G','4G']);
});
test('shared download survives one cancellation, leases prevent eviction, and new manager reuses disk',async()=>{
 const f=fixture(),a=f.cache.acquire('https://x/image'),b=f.cache.acquire('https://x/image');void a.result.catch(()=>{});await tick();expect(f.downloads).toHaveLength(1);a.cancel();expect(f.downloads[0].cancelled).toBe(false);f.downloads[0].finish();const image=await b.result;await expect(a.result).rejects.toThrow();
 await f.cache.configure(0);expect(f.files.has(image.path)).toBe(true);image.release();await f.cache.maintain();expect(f.files.has(image.path)).toBe(false);
 await f.cache.configure(100);const c=f.cache.acquire('https://x/retained');await tick();f.downloads[1].finish();const saved=await c.result;saved.release();await f.cache.maintain();const restarted=new ManagedCache(f.ports);const reused=await restarted.acquire('https://x/retained').result;expect(reused.path).toBe(saved.path);expect(f.downloads).toHaveLength(2);reused.release();
});
test('cancel all consumers aborts work and bounded queue does not start removed requests',async()=>{
 const f=fixture(),requests=Array.from({length:6},(_,i)=>f.cache.acquire('https://x/'+i));for(const r of requests)void r.result.catch(()=>{});await tick();expect(f.downloads).toHaveLength(2);for(const r of requests)r.cancel();await Promise.allSettled(requests.map(r=>r.result));expect(f.downloads.every(d=>d.cancelled)).toBe(true);expect(f.downloads).toHaveLength(2);
 const retry=f.cache.acquire('https://x/0');await tick();expect(f.downloads).toHaveLength(3);f.downloads[2].finish();(await retry.result).release();
});
test('prefetch limits work and stops all queued requests when reader leaves',async()=>{
 const f=fixture(),blocks=Array.from({length:15},(_,i)=>({type:'image' as const,url:'https://x/'+i}));const p=prefetchInlineImages(f.cache,blocks,undefined,'全部');await tick();expect(f.downloads).toHaveLength(2);p.cancel();await p.done;expect(f.downloads).toHaveLength(2);expect(f.downloads.every(d=>d.cancelled)).toBe(true);
});
test('cache scan cannot delete unrelated files or escaped paths and verifies failed deletions',async()=>{
 const f=fixture(),own='managed-cache/images/'+digest('owned')+'.img';f.put(own);f.put('managed-cache/images/unrecognized.img');f.put('reader-assets/important.png');await f.cache.configure(0);expect(f.removed).toEqual([own]);expect(f.files.has('reader-assets/important.png')).toBe(true);expect(f.files.has('managed-cache/images/unrecognized.img')).toBe(true);
 const malicious=new ManagedCache({...f.ports,list:async()=>({entries:[{path:'reader-assets/important.png',file:true,directory:false,size:10,modified:1}]})});await expect(malicious.configure(0)).rejects.toThrow('路径无效');expect(f.removed).toEqual([own]);
 f.put(own);const failing=new ManagedCache({...f.ports,remove:async()=>{}});await expect(failing.configure(0)).rejects.toThrow('无法删除');
});
test('invalid persisted image is downloaded again and stale owned staging files are reclaimed',async()=>{
 const f=fixture(),url='https://x/repair',key=digest(JSON.stringify([url,[]])),path='managed-cache/images/'+key+'.img';f.put(path,1);
 const cache=new ManagedCache({...f.ports,validate:async p=>{if(f.files.get(p)?.size!==10)throw Error('unsupported image');}});
 const request=cache.acquire(url);await tick();expect(f.downloads).toHaveLength(1);f.downloads[0].finish();(await request.result).release();await cache.maintain();
 const stale=path+'.download-123',unknown='managed-cache/images/user.tmp';f.put(stale);f.put(unknown);await cache.maintain();expect(f.files.has(stale)).toBe(false);expect(f.files.has(unknown)).toBe(true);
});
test('maintenance preserves staging files belonging to a current download',async()=>{
 const f=fixture(),request=f.cache.acquire('https://x/active');await tick();const path=f.downloads[0].path+'.download-123';f.put(path);await f.cache.configure(0);expect(f.files.has(path)).toBe(true);request.cancel();await expect(request.result).rejects.toThrow();await f.cache.maintain();expect(f.files.has(path)).toBe(false);
});
test('provider cache clear cancels active covers and leaves other cache buckets intact',async()=>{
 const f=fixture();
 const cover=f.cache.acquire('https://x/cover',{},false,'bili-preview');
 const regular=f.cache.acquire('https://x/cover');
 void cover.result.catch(()=>{});
 await tick();
 expect(f.downloads).toHaveLength(2);
 const regularJob=f.downloads.find(d=>d.path.includes('/images/'))!;
 const coverJob=f.downloads.find(d=>d.path.includes('/bili-preview/'))!;
 regularJob.finish();
 const retained=await regular.result;
 const stale=`managed-cache/bili-preview/${digest('old')}.img`;
 const unrelated=`managed-cache/douyin-preload/${digest('other')}.mp4`;
 f.put(stale);f.put(unrelated);
 await f.cache.clearBucket('bili-preview');
 await expect(cover.result).rejects.toThrow();
 expect(coverJob.cancelled).toBe(true);
 expect(f.files.has(stale)).toBe(false);
 expect(f.files.has(retained.path)).toBe(true);
 expect(f.files.has(unrelated)).toBe(true);
 retained.release();
});
test('the 128 MiB inline ceiling does not lower the managed limit for general images',async()=>{
 const f=fixture(),prefix='managed-cache/images/';f.put(prefix+digest('general')+'.img',130*1024*1024,1);f.put(prefix+digest('inline-old')+'.inline.img',65*1024*1024,2);f.put(prefix+digest('inline-new')+'.inline.img',65*1024*1024,3);
 await f.cache.configure(512*1024*1024);expect(f.removed).toEqual([prefix+digest('inline-old')+'.inline.img']);expect(f.files.has(prefix+digest('general')+'.img')).toBe(true);
});
