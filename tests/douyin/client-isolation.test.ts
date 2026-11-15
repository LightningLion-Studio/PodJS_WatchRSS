import {test,expect} from 'bun:test';
import {DouyinClient,DOUYIN_PUBLIC_MEDIA_HEADERS} from '../../src/douyin/client.ts';
function fixture(){
 const values=new Map<string,string>([['douyin.cookie','session-a']]);const requests:any[]=[];
 const client=new DouyinClient({secureStorage:{get:async k=>values.get(k)??null,set:async(k,v)=>{values.set(k,v);},remove:async k=>{values.delete(k);}},signer:{sign:()=> 'offline'},transport:{request:async request=>{requests.push(request);return {status:200,headers:{},body:new TextEncoder().encode(JSON.stringify(request.url.includes('/detail/')?{status_code:0,aweme_detail:{aweme_id:'42',desc:'offline',video:{play_addr:{url_list:['https://fixture.invalid/main']},duration:1000}}}:{status_code:0,aweme_list:[],has_more:0}))};}}});
 return {client,requests};
}
test('R01 a background detail refusal does not poison explicit detail, refresh or feed',async()=>{
 const {client,requests}=fixture();client.usePrestoreTrafficPolicy();
 expect((await client.resolvePlayback('42',{prefetch:true})).ok).toBe(false);expect(requests).toHaveLength(0);
 expect((await client.fetchDetail('42',{forceRefresh:true})).ok).toBe(true);
 expect((await client.resolvePlayback('42',{freshRequest:true,forceRefresh:true})).ok).toBe(true);
 expect((await client.fetchFeedPage()).ok).toBe(true);expect(requests).toHaveLength(3);
});
test('R01 foreground requests survive a stopped background capability and credentials reset it',async()=>{
 const {client,requests}=fixture();client.usePrestoreTrafficPolicy();client.stopMediaTraffic();
 expect((await client.fetchFeedPage({background:{isCurrent:()=>true} as any})).ok).toBe(false);
 expect((await client.fetchFeedPage()).ok).toBe(true);
 await client.applyCookie('session-b');expect((await client.fetchFeedPage({background:{isCurrent:()=>true} as any})).ok).toBe(true);
 client.stopMediaTraffic();await client.clearCookie();await client.applyCookie('session-c');expect((await client.fetchFeedPage({background:{isCurrent:()=>true} as any})).ok).toBe(true);expect(requests).toHaveLength(3);
});
test('R04 public media headers never inherit a login cookie',async()=>{
 const {client}=fixture();expect(await client.buildPlaybackHeaders()).toEqual({...DOUYIN_PUBLIC_MEDIA_HEADERS});
 await client.applyCookie('session-b');expect(Object.keys(await client.buildPlaybackHeaders()).map(k=>k.toLowerCase())).not.toContain('cookie');
});
test('R12 authorization scope survives restart storage and changes on each replacement',async()=>{
 const {client}=fixture();const first=await client.stockAuthorizationScope();expect(first).toBeDefined();expect(await client.stockAuthorizationScope()).toBe(first);
 await client.applyCookie('session-b');const second=await client.stockAuthorizationScope();expect(second).not.toBe(first);
 await client.applyCookie('session-b');expect(await client.stockAuthorizationScope()).not.toBe(second);
 await client.clearCookie();expect(await client.stockAuthorizationScope()).toBeUndefined();
});
