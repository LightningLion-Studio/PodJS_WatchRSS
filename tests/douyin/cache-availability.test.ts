import {expect,test} from 'bun:test';
import {douyinCacheUnavailable,directDouyinMediaUrl} from '../../src/douyin/cache-availability.ts';
test('only local cache availability codes allow the ordinary media path',()=>{
 for(const code of ['cache_error','media_cache_error','resource_exhausted','invalid_argument'])expect(douyinCacheUnavailable({code})).toBe(true);
 for(const code of ['permission_denied','restricted','source_expired','cancelled','media_traffic_stopped','resolution_limit','unknown'])expect(douyinCacheUnavailable({code})).toBe(false);
});
test('direct fallback accepts only the original public HTTP source shape',()=>{
 expect(directDouyinMediaUrl('https://fixture.invalid/video?signature=opaque')).toBe(true);
 for(const url of ['file:///private','podjs-media-cache://play/a.mp4','https://user:password@fixture.invalid/video',' https://fixture.invalid/video','https://'])expect(directDouyinMediaUrl(url)).toBe(false);
});
