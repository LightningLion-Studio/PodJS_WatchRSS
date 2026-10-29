import {expect,test} from 'bun:test';
import {BiliFeedBrowser,type BrowseStore} from '../../src/bili/browse.ts';
import {BiliRecommendationHistory,biliFeedScope,feedCacheKey,feedSeenKey,recommendationId} from '../../src/bili/recommendations.ts';
import {BiliClient} from '../../src/bili/client.ts';
import type {BiliFeedPage,BiliItem,BiliSession} from '../../src/bili/types.ts';
class Store implements BrowseStore { values=new Map<string,unknown>();get<T=unknown>(k:string){return this.values.get(k) as T|undefined;}set<T>(k:string,v:T){this.values.set(k,v);} }
const items=(...ids:number[]):BiliItem[]=>ids.map(aid=>({aid,cid:aid,title:'private-title'}));
const page=(ids:number[],source:'watch'|'web'='web',nextPage?:string):BiliFeedPage=>({items:items(...ids),source,nextPage});
const session=(id:string,token='synthetic'):BiliSession=>({cookies:{DedeUserID:id,SESSDATA:token},updatedAt:1});
const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return{resolve,promise};};

test('512 IDs persist oldest-first; the 513th evicts oldest, redisplaying touches recency',()=>{
 const s=new Store(),h=new BiliRecommendationHistory(s,'a');h.remember(items(...Array.from({length:512},(_,i)=>i+1)));
 expect(h.read()).toHaveLength(512);h.remember(items(1));h.remember(items(513));
 const restarted=new BiliRecommendationHistory(s,'a');expect(restarted.read()).toHaveLength(512);expect(restarted.read()[0]).toBe('aid:3');expect(restarted.read()).not.toContain('aid:2');expect(restarted.read().at(-2)).toBe('aid:1');expect(restarted.read().at(-1)).toBe('aid:513');
});
test('aid takes priority, cid has no effect, absent aid uses case-sensitive bvid and never title',()=>{
 expect(recommendationId({aid:7,bvid:'BVother'})).toBe('aid:7');expect(recommendationId({bvid:' BVabc '})).toBe('bvid:BVabc');expect(recommendationId({aid:NaN,bvid:'BVabc'})).toBe('bvid:BVabc');expect(recommendationId({})).toBeUndefined();
 const s=new Store(),h=new BiliRecommendationHistory(s,'a');h.remember([{aid:7,cid:8},{aid:7,cid:9},{bvid:'BVabc'},{bvid:'BVAbc'}]);expect(h.read()).toEqual(['aid:7','bvid:BVabc','bvid:BVAbc']);expect(JSON.stringify(s.values.values().next().value)).not.toContain('private-title');
});
test('filter same-page and cross-page duplicates, top up with exact watch cursors and share history on refresh',async()=>{
 const s=new Store(),calls:unknown[]=[],counts:number[]=[];let responses=[page([1,1,2],'watch','{"pn":2,"opaque":"x"}'),page([2,3],'watch','{"pn":3}'),page([3,4,5],'watch','{"pn":4}')];
 const b=new BiliFeedBrowser({feed:async p=>{calls.push(p);return responses.shift()!;}},s,undefined,{onFiltered:n=>counts.push(n)});await b.refresh();expect(b.state.items.map(x=>x.aid)).toEqual([1,2,3,4,5]);expect(calls).toEqual([undefined,{page_next:'{"pn":2,"opaque":"x"}'},{page_next:'{"pn":3}'}]);expect(counts).toEqual([3]);
 responses=[page([1,2,3,4,5],'watch','{"pn":2}'),page([6,7,8,9,10],'watch')];await b.refresh();expect(b.state.items.map(x=>x.aid)).toEqual([6,7,8,9,10]);expect(counts).toEqual([3,5]);
});
test('Web duplicate-only pages make at most three calls with advancing fresh indices, without error or autoload loop',async()=>{
 const s=new Store(),h=new BiliRecommendationHistory(s,'anonymous');h.remember(items(1,2,3,4,5));s.set(feedCacheKey(),items(1,2,3,4,5));const calls:unknown[]=[],counts:number[]=[];
 const b=new BiliFeedBrowser({feed:async p=>{calls.push(p);return page([1,2,3,4,5]);}},s,undefined,{onFiltered:n=>counts.push(n)});await b.refresh();await b.loadMore();
 expect(calls).toEqual([undefined,{fresh_idx:1,fresh_idx_1h:1},{fresh_idx:2,fresh_idx_1h:2}]);expect(counts).toEqual([15]);expect(b.state.items).toEqual(items(1,2,3,4,5));expect(b.state.error).toBeUndefined();expect(b.state.canLoadMore).toBe(false);
});
test('restart reads history even without cached cards and skips a known ID with a different cid',async()=>{
 const s=new Store();await new BiliFeedBrowser({feed:async()=>page([7],'watch')},s).refresh();s.values.delete(feedCacheKey());
 const b=new BiliFeedBrowser({feed:async()=>({source:'watch',items:[{aid:7,cid:999},{aid:8,cid:10},{bvid:'BVnew'},{bvid:'BVnew'}]})},s);await b.refresh();expect(b.state.items).toEqual([{aid:8,cid:10},{bvid:'BVnew'}]);expect(new BiliRecommendationHistory(s,'anonymous').read()).toEqual(['aid:7','aid:8','bvid:BVnew']);
});
test('account and anonymous scopes isolate both seen IDs and cached cards, including returning to an earlier account',async()=>{
 const s=new Store();let current:BiliSession|null=session('001');const calls:unknown[]=[];
 const b=new BiliFeedBrowser({feed:async p=>{calls.push(p);return page([1,2,3,4,5]);}},s,undefined,{scope:()=>biliFeedScope(current)});
 await b.refresh();current=session('2');await b.refresh();expect(b.state.items).toHaveLength(5);current=null;await b.refresh();expect(b.state.items).toHaveLength(5);
 current=session('1','rotated-token');await b.refresh();expect(calls).toHaveLength(6);expect(b.state.items).toHaveLength(5);
 expect(s.get(feedSeenKey('account:1'))).toHaveLength(5);expect(s.get(feedSeenKey('account:2'))).toHaveLength(5);expect(s.get(feedSeenKey('anonymous'))).toHaveLength(5);expect([...s.values.keys()].join(' ')).not.toContain('rotated-token');
});
test('missing account ID uses opaque session scope, never anonymous or raw credential',()=>{
 const a=biliFeedScope({cookies:{SESSDATA:'synthetic-A'},updatedAt:0}),b=biliFeedScope({cookies:{SESSDATA:'synthetic-B'},updatedAt:0});expect(a).not.toBe(b);expect(a).not.toBe('anonymous');expect(a).not.toContain('synthetic');expect(biliFeedScope(session('42','a'))).toBe(biliFeedScope(session('42','b')));
});
test('account switch drops late response without adding its IDs to either scope',async()=>{
 const s=new Store(),late=deferred<BiliFeedPage>();let scope='A',n=0;
 const b=new BiliFeedBrowser({feed:async()=>++n===1?late.promise:page([9],'watch')},s,undefined,{scope:()=>scope});const old=b.refresh();scope='B';await b.refresh();late.resolve(page([7],'watch'));await old;
 expect(s.get(feedSeenKey('A'))).toBeUndefined();expect(s.get<string[]>(feedSeenKey('B'))).toEqual(['aid:9']);expect(b.state.items).toEqual(items(9));
});
test('dispose during top-up does not remember undisplayed first page or overwrite cache',async()=>{
 const s=new Store(),late=deferred<BiliFeedPage>();let n=0;const b=new BiliFeedBrowser({feed:async()=>++n===1?page([7],'watch','{"pn":2}'):late.promise},s);
 const request=b.refresh();await Promise.resolve();b.dispose();late.resolve(page([8],'watch'));await request;expect(s.get(feedSeenKey())).toBeUndefined();expect(s.get(feedCacheKey())).toBeUndefined();
});
test('partial fresh data survives top-up network failure and retries its uncommitted cursor',async()=>{
 let n=0;const calls:unknown[]=[],b=new BiliFeedBrowser({feed:async p=>{calls.push(p);if(++n===2)throw Error('network');return n===1?page([7],'watch','{"pn":2}'):page([8],'watch');}},new Store());
 await b.refresh();expect(b.state.items).toEqual(items(7));expect(b.state.error).toBeUndefined();await b.loadMore();expect(calls).toEqual([undefined,{page_next:'{"pn":2}'},{page_next:'{"pn":2}'}]);expect(b.state.items).toEqual(items(7,8));
});
test('legacy global cache is not attributed to a new account; corrupt seen storage is bounded and ignores titles',async()=>{
 const s=new Store();s.set('watchrss.bili.feed-cache.v1',items(99));s.set(feedSeenKey('A'),['title:secret',null,'aid:1']);const b=new BiliFeedBrowser({feed:async()=>page([1,2],'watch')},s,undefined,{scope:()=> 'A'});await b.refresh();expect(b.state.items).toEqual(items(2));expect(new BiliRecommendationHistory(s,'A').read()).toEqual(['aid:1','aid:2']);
});
for(const watch of [true,false])test(`production BiliClient + browser both routes deduplicate and carry pagination: watch=${watch}`,async()=>{
 const s=new Store(),urls:string[]=[];let n=0;
 const c=new BiliClient({watchApi:()=>watch?{appkey:'fixture',mobiApp:'fixture',platform:'fixture',device:'watch',build:'1'}:{},secureStore:{get:async key=>key.endsWith('.wbi')?JSON.stringify({imgKey:'a'.repeat(32),subKey:'b'.repeat(32)}):null,set:async()=>{},delete:async()=>{}},transport:{request:async r=>{urls.push(r.url);const ids=++n<=2?[1,2,3,4,5]:[6,7,8,9,10];return{status:200,headers:{},body:new TextEncoder().encode(JSON.stringify({code:0,data:watch?{items:ids.map(aid=>({aid,cid:aid,item_type:'ugc'})),page_next:'{"pn":2}'}:{item:ids.map(aid=>({aid,goto:'av'}))}}))};}}});
 const b=new BiliFeedBrowser(c,s);await b.refresh();await b.refresh();expect(b.state.items.map(x=>x.aid)).toEqual([6,7,8,9,10]);expect(urls).toHaveLength(3);
 const last=new URL(urls[2]);if(watch){expect(last.hostname).toBe('app.bilibili.com');expect(last.searchParams.get('page_next')).toContain('"pn":2');}else{expect(last.hostname).toBe('api.bilibili.com');expect(last.searchParams.get('fresh_idx')).toBe('1');expect(last.searchParams.has('page_next')).toBe(false);}
});

test('a filtered hit does not become recently displayed or prevent oldest eviction',async()=>{
 const s=new Store(),h=new BiliRecommendationHistory(s,'anonymous');h.remember(items(...Array.from({length:512},(_,i)=>i+1)));
 const b=new BiliFeedBrowser({feed:async()=>page([1],'watch')},s);await b.refresh();expect(b.state.items).toEqual([]);h.remember(items(513));expect(h.read()).not.toContain('aid:1');expect(h.read()[0]).toBe('aid:2');expect(h.read()).toHaveLength(512);
});
test('three undersized pages keep their available fresh items and next cursor without error',async()=>{
 let n=0;const b=new BiliFeedBrowser({feed:async()=>page([++n],'watch',JSON.stringify({pn:n+1}))},new Store());await b.refresh();expect(n).toBe(3);expect(b.state.items).toEqual(items(1,2,3));expect(b.state.error).toBeUndefined();expect(b.state.canLoadMore).toBe(true);
});
test('a real watch HTTP failure falls back to Web and shares the same displayed-ID history',async()=>{
 const s=new Store(),urls:string[]=[];let watchCalls=0,webCalls=0;
 const c=new BiliClient({watchApi:()=>({appkey:'fixture',mobiApp:'fixture',platform:'fixture',device:'watch',build:'1'}),secureStore:{get:async key=>key.endsWith('.wbi')?JSON.stringify({imgKey:'a'.repeat(32),subKey:'b'.repeat(32)}):null,set:async()=>{},delete:async()=>{}},transport:{request:async r=>{
  urls.push(r.url);const watch=new URL(r.url).hostname==='app.bilibili.com';const failed=watch&&++watchCalls===2;
  const ids=watch||++webCalls===1?[1,2,3,4,5]:[6,7,8,9,10];return{status:failed?500:200,headers:{},body:new TextEncoder().encode(JSON.stringify({code:0,data:watch?{items:ids.map(aid=>({aid,cid:aid,item_type:'ugc'})),page_next:'{"pn":2}'}:{item:ids.map(aid=>({aid,goto:'av'}))}}))};
 }}});const b=new BiliFeedBrowser(c,s);await b.refresh();await b.refresh();expect(b.state.items.map(x=>x.aid)).toEqual([6,7,8,9,10]);expect(urls.map(x=>new URL(x).hostname)).toEqual(['app.bilibili.com','app.bilibili.com','api.bilibili.com','api.bilibili.com']);expect(new URL(urls.at(-1)!).searchParams.get('fresh_idx')).toBe('1');
});
