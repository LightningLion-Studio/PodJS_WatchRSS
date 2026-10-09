import {defaultCachePorts} from '@podjs/framework/cache';
import {ManagedCache} from './managed.ts';
// Download limit and image-validation profile are application policy.
export const managedCache=new ManagedCache(defaultCachePorts({maxDownloadBytes:8*1024*1024,validateImageDimension:1}));
