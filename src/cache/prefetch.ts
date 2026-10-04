import type {ContentBlock} from '../reader/content.ts';
import {inlineImageTargets} from './policy.ts';
import type {ManagedCache} from './managed.ts';
/** A reader owns its prefetch leases; two workers bound hashing as well as downloads for ALL. */
export function prefetchInlineImages(cache:Pick<ManagedCache,'acquire'>,blocks:readonly ContentBlock[],baseUrl:string|undefined,mode:string):{done:Promise<void>;cancel():void}{
 const targets=inlineImageTargets(blocks,baseUrl,mode);let stopped=false,index=0;
 const active=new Set<{cancel():void}>();
 async function run(){while(!stopped&&index<targets.length){const request=cache.acquire(targets[index++],{},true);active.add(request);try{const file=await request.result;file.release();}catch{/* A failed image is retried when visible; prefetch must not replace the article with an error. */}finally{active.delete(request);}}}
 return {done:Promise.all([run(),run()]).then(()=>{}),cancel(){stopped=true;for(const request of active)request.cancel();}};
}
