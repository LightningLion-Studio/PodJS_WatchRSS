import {test,expect} from 'bun:test';
import {loopbackFeedTransport} from './src/transport.ts';
test('fixture feed keeps production request shape but forwards only to loopback',async()=>{
 const seen:any[]=[];const delegate={request:async(request:any)=>{seen.push(request);return {status:200,headers:{},body:new Uint8Array()};}};
 const fixture=loopbackFeedTransport('http://127.0.0.1:12345',delegate);
 await fixture.request({method:'POST',url:'https://www.douyin.com/aweme/v2/web/module/feed/?fixture=1',headers:{Cookie:'fixture-only'},body:new Uint8Array()});
 expect(seen).toHaveLength(1);expect(seen[0].url).toBe('http://127.0.0.1:12345/aweme/v2/web/module/feed/?fixture=1');expect(seen[0].method).toBe('POST');
 for(const url of ['https://www.douyin.com/aweme/v1/web/aweme/detail/','https://foreign.invalid/aweme/v2/web/module/feed/','http://127.0.0.1:12345/other'])expect(()=>fixture.request({method:'GET',url,headers:{}})).toThrow('fixture_non_feed_blocked');
 expect(seen).toHaveLength(1);
 expect(()=>loopbackFeedTransport('https://www.douyin.com',delegate)).toThrow('fixture_requires_loopback');
});
