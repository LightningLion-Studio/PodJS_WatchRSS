import {expect,test} from 'bun:test';
import {douyinMediaExpiry,douyinMediaNetworkDeadline} from '../../src/douyin/media-expiry.ts';
test('metadata becomes stale after five minutes without inventing a network deadline',()=>{
 const now=1700000000000,url='https://fixture/?signature=opaque';
 expect(douyinMediaExpiry(url,now)).toBe(now+300000);
 expect(douyinMediaNetworkDeadline([url])).toBeUndefined();
});
test('network authorization preserves explicit deadlines beyond the metadata refresh TTL',()=>{
 const now=1700000000000,expiry=1700086400,url='https://fixture/?x-expires='+expiry;
 expect(douyinMediaExpiry(url,now)).toBe(now+1800000);
 expect(douyinMediaNetworkDeadline([url])).toBe(expiry*1000-30000);
 expect(douyinMediaNetworkDeadline([url,'https://fixture/?deadline=1700005000'])).toBe(1700005000000-30000);
 expect(douyinMediaNetworkDeadline(['https://fixture/?expires=1000000000'])).toBe(1000000000000-30000);
});
