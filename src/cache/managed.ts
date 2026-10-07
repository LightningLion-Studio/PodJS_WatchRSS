import {FileCache,type CachePorts} from '@podjs/framework/cache';
import {CACHE_BUCKETS,CACHE_ROOT,cacheEvictionOrder,cacheNamespace,type CacheBucket} from './policy.ts';
export type {CacheEntry,CachePorts,CacheProducer,CachedImage} from '@podjs/framework/cache';
/** WatchRSS compatibility surface. Namespaces, limits and eviction priority remain business policy. */
export class ManagedCache {
 private core:FileCache<CacheBucket>;
 constructor(ports:CachePorts){this.core=new FileCache({root:CACHE_ROOT,buckets:CACHE_BUCKETS,namespace:cacheNamespace,ports,limitBytes:512*1024*1024,
  errors:{limit:'缓存上限无效',directories:'缓存目录过多',path:'缓存目录路径无效',metadata:'缓存文件信息无效',files:'缓存文件过多',remove:'缓存文件无法删除',cancel:'图片缓存请求已取消',url:'缓存地址无效',key:'缓存键无效',file:'图片缓存文件无效'},
  evictionPolicy(files,limit,pinned){
   const images=files.filter(f=>f.bucket==='images'&&f.path.endsWith('.inline.img'));
   const candidates=[...cacheEvictionOrder(images,Math.min(limit,128*1024*1024),pinned)],chosen=new Set(candidates.map(f=>f.path));
   candidates.push(...cacheEvictionOrder(files.filter(f=>!chosen.has(f.path)),limit,pinned));return candidates;
  },
 });}
 get limitBytes(){return this.core.limitBytes;}
 registerProducer(...args:Parameters<FileCache<CacheBucket>['registerProducer']>){return this.core.registerProducer(...args);}
 subscribe(...args:Parameters<FileCache<CacheBucket>['subscribe']>){return this.core.subscribe(...args);}
 configure(limit:number){return this.core.configure(limit);}
 inspect(){return this.core.inspect();}
 stats(){return this.core.stats();}
 maintain(){return this.core.maintain();}
 clearBucket(bucket:'bili-preview'|'douyin-preload'){return this.core.clearBucket(bucket);}
 acquire(url:string,headers:Record<string,string>={},inline=false,bucket:'images'|'bili-preview'='images'){return this.core.acquire(url,headers,{bucket,variant:inline?'inline':'image'});}
}
