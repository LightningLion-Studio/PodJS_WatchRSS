import {CACHE_BUCKETS,CACHE_ROOT,cacheEvictionOrder,type CacheFile,type CacheBucket} from './policy.ts';
export interface CacheEntry {path:string;file:boolean;directory:boolean;size:number;modified:number}
export interface CachePorts {
 list(path:string):Promise<{entries:CacheEntry[]}>;
 stat(path:string):Promise<{exists:boolean;file:boolean;size:number}>;
 remove(path:string):Promise<void>;touch(path:string):Promise<unknown>;validate?(path:string):Promise<void>;
 digest(value:string):Promise<string>;
 download(url:string,path:string,headers:Record<string,string>):{result:Promise<unknown>;cancel():void};
}
export interface CachedImage {path:string;release():void}
type Work={path:string;url:string;headers:Record<string,string>;refs:number;started:boolean;cancelled:boolean;current?:{cancel():void};promise:Promise<void>;resolve():void;reject(error:unknown):void};
export class ManagedCache {
 private limit=512*1024*1024;
 private serial:Promise<unknown>=Promise.resolve();
 private jobs=new Map<string,Work>();private queue:Work[]=[];private active=0;
 private observers=new Set<(bytes:number)=>void>();private lastUsage:number|undefined;
 constructor(private ports:CachePorts){}
 subscribe(listener:(bytes:number)=>void):()=>void {this.observers.add(listener);if(this.lastUsage!==undefined)listener(this.lastUsage);return ()=>this.observers.delete(listener);}
 private locked<T>(action:()=>Promise<T>):Promise<T>{const value=this.serial.then(action);this.serial=value.catch(()=>{});return value;}
 async configure(limit:number):Promise<number>{if(!Number.isSafeInteger(limit)||limit<0)throw Error('缓存上限无效');this.limit=limit;return this.maintain();}
 private async scan(cleanup=false):Promise<CacheFile[]> {
  const files:CacheFile[]=[];
  for(const bucket of CACHE_BUCKETS){
   const root=`${CACHE_ROOT}/${bucket}`,directories=[root];let visited=0;
   while(directories.length){const directory=directories.shift()!;if(++visited>1000)throw Error('缓存目录过多');
    for(const entry of (await this.ports.list(directory)).entries){
     if(!entry.path.startsWith(directory+'/')||entry.path.slice(directory.length+1).includes('/')||entry.path.split('/').includes('..'))throw Error('缓存目录路径无效');
     if(entry.directory){if(bucket==='rss-offline'&&entry.path.split('/').length<16)directories.push(entry.path);continue;}
     if(!entry.file)continue;
     const staged=/^([a-f0-9]{64}\.(?:inline\.img|img|mp4))\.download-[0-9]+$/.exec(entry.path.slice(directory.length+1));
     if(cleanup&&bucket!=='rss-offline'&&staged&&!this.jobs.has(directory+'/'+staged[1])){await this.ports.remove(entry.path);continue;}
     if(!Number.isSafeInteger(entry.size)||entry.size<0||!Number.isFinite(entry.modified))throw Error('缓存文件信息无效');
     // Only committed files are automatic eviction candidates. Temporary writes are owned by their download.
     if(bucket!=='rss-offline'&&!/^[a-f0-9]{64}\.(inline\.img|img|mp4)$/.test(entry.path.slice(directory.length+1)))continue;
     files.push({...entry,bucket});if(files.length>50000)throw Error('缓存文件过多');
    }
   }
  }
  return files;
 }
 private publish(files:CacheFile[]):number {this.lastUsage=files.reduce((n,f)=>n+f.size,0);for(const listener of this.observers)if(this.lastUsage!==undefined)listener(this.lastUsage);return this.lastUsage;}
 inspect():Promise<number>{return this.locked(async()=>this.publish(await this.scan()));}
 maintain():Promise<number>{return this.locked(async()=>{
  const files=await this.scan(true),pinned=new Set([...this.jobs.values()].filter(j=>j.refs>0||j.started).map(j=>j.path));
  // Inline images also have the native Coil 128 MiB ceiling, independently of the managed total.
  const images=files.filter(f=>f.bucket==='images'&&f.path.endsWith('.inline.img'));const candidates=[...cacheEvictionOrder(images,Math.min(this.limit,128*1024*1024),pinned)];
  const chosen=new Set(candidates.map(f=>f.path));candidates.push(...cacheEvictionOrder(files.filter(f=>!chosen.has(f.path)),this.limit,pinned));
  for(const entry of candidates){await this.ports.remove(entry.path);if((await this.ports.stat(entry.path)).exists)throw Error('缓存文件无法删除');}
  return this.publish(await this.scan());
 });}
 /** Native channel removal clears the provider's own flat cache bucket. */
 clearBucket(bucket:'bili-preview'|'douyin-preload'):Promise<number>{return this.locked(async()=>{
  const root=`${CACHE_ROOT}/${bucket}`,prefix=root+'/';
  const jobs=[...this.jobs.values()].filter(job=>job.path.startsWith(prefix));
  for(const job of jobs){job.cancelled=true;job.current?.cancel();if(!job.started){this.queue=this.queue.filter(item=>item!==job);this.jobs.delete(job.path);job.reject(Error('图片缓存请求已取消'));}}
  await Promise.allSettled(jobs.map(job=>job.promise));
  const entries=(await this.ports.list(root)).entries;
  for(const entry of entries){
   if(!entry.path.startsWith(prefix)||entry.path.slice(prefix.length).includes('/')||entry.directory||!entry.file)throw Error('缓存目录路径无效');
   await this.ports.remove(entry.path);
   if((await this.ports.stat(entry.path)).exists)throw Error('缓存文件无法删除');
  }
  return this.publish(await this.scan());
 });}
 /** Reserve a shared download synchronously after hashing; release never deletes a completed cache file. */
 acquire(url:string,headers:Record<string,string>={},inline=false,bucket:'images'|'bili-preview'='images'):{result:Promise<CachedImage>;cancel():void}{
  let stopped=false,work:Work|undefined,released=false;
  const release=()=>{if(released)return;released=true;stopped=true;if(!work)return;if(--work.refs>0)return;if(!work.started){this.queue=this.queue.filter(j=>j!==work);this.jobs.delete(work.path);work.reject(Error('图片缓存请求已取消'));}else{work.cancelled=true;work.current?.cancel();}void this.maintain().catch(()=>{});};
  const result=(async()=>{
   if(!/^https?:\/\//i.test(url))throw Error('缓存地址无效');
   const headerKey=Object.keys(headers).sort().map(k=>[k,headers[k]]);const key=await this.ports.digest(JSON.stringify([url,headerKey]));
   if(!/^[a-f0-9]{64}$/.test(key))throw Error('缓存键无效');if(stopped)throw Error('图片缓存请求已取消');
   const path=`${CACHE_ROOT}/${bucket}/${key}.${inline?'inline.img':'img'}`;
   // The mutation runs in the same queue as eviction, so a leased path cannot be deleted between stat and decode.
   await this.locked(async()=>{
    if(stopped)throw Error('图片缓存请求已取消');work=this.jobs.get(path);
    if(work?.cancelled){await work.promise.catch(()=>{});work=undefined;}
    if(!work){let resolve!:()=>void,reject!:(error:unknown)=>void;const promise=new Promise<void>((yes,no)=>{resolve=yes;reject=no;});void promise.catch(()=>{});work={path,url,headers,refs:0,started:false,cancelled:false,promise,resolve,reject};this.jobs.set(path,work);this.queue.push(work);}
    work.refs++;this.pump();
   });
   await work!.promise;if(stopped)throw Error('图片缓存请求已取消');return {path,release};
  })();void result.catch(()=>release());return {result,cancel:release};
 }
 private pump(){while(this.active<2&&this.queue.length){const work=this.queue.shift()!;work.started=true;this.active++;void this.load(work).then(work.resolve,work.reject).finally(()=>{work.current=undefined;work.started=false;this.active--;if(!work.refs&&this.jobs.get(work.path)===work)this.jobs.delete(work.path);this.pump();void this.maintain().catch(()=>{});});}}
 private async load(work:Work){
  if(work.cancelled)throw Error('图片缓存请求已取消');const current=await this.ports.stat(work.path);
  let valid=current.file&&current.size>0;
  if(valid&&this.ports.validate){try{await this.ports.validate(work.path);}catch{valid=false;}}
  if(!valid){if(work.cancelled)throw Error('图片缓存请求已取消');const request=this.ports.download(work.url,work.path,work.headers);work.current=request;await request.result;if(this.ports.validate)await this.ports.validate(work.path);}
  if(work.cancelled)throw Error('图片缓存请求已取消');const value=await this.ports.stat(work.path);if(!value.file||value.size<=0)throw Error('图片缓存文件无效');await this.ports.touch(work.path);
 }
}
