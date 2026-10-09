import {defaultCachePorts} from '@podjs/framework/cache';
import {ManagedCache} from './managed.ts';
export interface ImageDownloadLimits {thumbnailBytes?:number;largeImageBytes?:number}
/** Application policy; all sources keep their original URL and stream to disk. */
export function imageCachePorts(limits:ImageDownloadLimits={}){
 const thumbnail=limits.thumbnailBytes??8*1024*1024,large=limits.largeImageBytes??64*1024*1024;
 for(const bound of [thumbnail,large])if(!Number.isSafeInteger(bound)||bound<1||bound>64*1024*1024)throw new RangeError('invalid image download limit');
 return defaultCachePorts({maxDownloadBytes:path=>path.endsWith('.inline.img')?large:thumbnail,validateImageDimension:1});
}
export const managedCache=new ManagedCache(imageCachePorts());
