import { expect, test } from 'bun:test';
import { BiliClient } from '../src/bili/client.ts';
import { DouyinClient } from '../src/douyin/client.ts';
import { clearBiliLogoutData, clearDouyinLogoutData } from '../src/media/logout.ts';
import { FEED_KEY, RECENT_KEY } from '../src/douyin/feed-store.ts';
import type { DouyinItem } from '../src/douyin/types.ts';
import { loginGate, loginError } from '../src/ui/douyin/login-state.ts';
import { observeInternet } from '../src/onboarding/network.ts';
import type { InternetStatus } from '../src/onboarding/state.ts';

class Store {
  values = new Map<string,string>();
  async get(key:string) { return this.values.get(key) ?? null; }
  async set(key:string,value:string) { this.values.set(key,value); }
  async delete(key:string) { this.values.delete(key); }
  async remove(key:string) { this.values.delete(key); }
}
const unusedTransport = { async request(): Promise<never> { throw Error('logout must not call the network'); } };
const video:DouyinItem = {awemeId:'42',description:'saved',createdAtSeconds:0,authorId:'1',authorName:'author',likeCount:0,commentCount:0,shareCount:0,collectCount:0,playUrl:'https://example.com/42.mp4',durationMs:100,variants:[]};

test('Bili settings logout clears account/WBI, interaction, progress and only its preview bucket; retained data survive restart', async () => {
  const secure = new Store(), local = new Store(), buckets:string[] = [];
  await secure.set('watchrss.bili.session.v1',JSON.stringify({cookies:{SESSDATA:'test'},refreshToken:'refresh',updatedAt:1}));
  await secure.set('watchrss.bili.session.v1.wbi',JSON.stringify({imgKey:'i',subKey:'s'}));
  for (const key of ['watchrss.bili.interactions.v1','watchrss.bili.playback-progress.v1','watchrss.bili.feed-cache.v1','watchrss.bili.search-history.v1','saved','channel.settings','douyin.history.v1']) await local.set(key,'retained');
  const client = new BiliClient({transport:unusedTransport,secureStore:secure,onLogout:()=>clearBiliLogoutData(local,{async clearBucket(bucket){buckets.push(bucket);}})});
  expect((await client.getLoginState()).status).toBe('authenticated');
  await client.logout();
  expect(await client.getSession()).toBeNull();
  expect(await new BiliClient({transport:unusedTransport,secureStore:secure}).getSession()).toBeNull();
  expect(secure.values.size).toBe(0);
  expect([...local.values.keys()]).toEqual(['watchrss.bili.feed-cache.v1','watchrss.bili.search-history.v1','saved','channel.settings','douyin.history.v1']);
  expect(buckets).toEqual(['bili-preview']);
});

test('Bili logout invalidates loaded WBI keys and honors custom account keys',async()=>{
  const secure=new Store();await secure.set('custom.wbi',JSON.stringify({imgKey:'i'.repeat(32),subKey:'s'.repeat(32)}));
  const urls:string[]=[];
  const client=new BiliClient({storageKey:'custom',secureStore:secure,transport:{async request(request){urls.push(request.url);return {status:200,headers:{},body:new TextEncoder().encode(JSON.stringify({code:0,data:{item:[],wbi_img:{img_url:'https://x/new.png',sub_url:'https://x/sub.png'}}}))};}}});
  await client.feed();expect(urls.some(url=>url.includes('/nav'))).toBe(false);
  await client.logout();await client.feed();expect(urls.some(url=>url.includes('/nav'))).toBe(true);
});

test('cache deletion failure rejects logout, leaves credentials removed and permits retry', async () => {
  const store=new Store();let calls=0;
  const client=new BiliClient({transport:unusedTransport,secureStore:store,onLogout:()=>clearBiliLogoutData(store,{async clearBucket(){if(++calls===1)throw Error('disk');}})});
  await expect(client.logout()).rejects.toThrow('disk');
  expect(await client.getSession()).toBeNull();await client.logout();expect(calls).toBe(2);
});

test('Douyin logout clears cookie and window/media but retains history, watched IDs, saved state and settings',async()=>{
  const secure=new Store(),local=new Store(),buckets:string[]=[];
  const options={transport:unusedTransport,secureStorage:secure,historyStorage:local,onLogout:()=>clearDouyinLogoutData({async clearBucket(bucket){buckets.push(bucket);}})};
  const client=new DouyinClient(options);await client.applyCookie('sessionid=test');await client.recordHistory(video);await client.setSaved(video,'favorite',true);await client.setSaved(video,'watchLater',true);
  await client.saveRecentWindow([video],video.awemeId,'tail',true);await local.set('douyin.original-content','true');
  expect(await local.get(RECENT_KEY)).not.toBeNull();expect(await local.get(FEED_KEY)).not.toBeNull();
  await client.logout();
  expect(await secure.get('douyin.cookie')).toBeNull();expect(await local.get(RECENT_KEY)).toBeNull();expect(await local.get(FEED_KEY)).toBeNull();
  expect(client.feedSnapshot().items).toEqual([]);
  const restarted=new DouyinClient(options);expect(await restarted.isLoggedIn()).toBe(false);expect((await restarted.restoreFeed()).items).toEqual([]);
  expect(await restarted.listHistory()).toHaveLength(1);expect(await restarted.listWatchedIds()).toEqual(['42']);expect(await restarted.getSavedState('42')).toEqual({favorite:true,watchLater:true});
  expect(await local.get('douyin.original-content')).toBe('true');expect(buckets).toEqual(['douyin-preload']);
});

test('Douyin media cleanup failure is not reported as successful logout',async()=>{
  const store=new Store(),client=new DouyinClient({transport:unusedTransport,secureStorage:store,onLogout:async()=>{throw Error('cache locked');}});
  await client.applyCookie('sessionid=test');await expect(client.logout()).rejects.toThrow('cache locked');expect(await client.isLoggedIn()).toBe(false);
});

for(const state of ['checking','unavailable','bluetooth'] as const) test(`Douyin login forbids browser and cookie flow while ${state}`,()=>{
  expect(loginGate(state,true)).not.toBeNull();expect(loginGate(state,false)).not.toBeNull();
});
test('available internet opens login only when browser authorization is supported',()=>{
  expect(loginGate('available',true)).toBeNull();expect(loginGate('available',false)?.detail).toContain('WebView');
  for(const code of ['webview_unavailable','unsupported','unavailable'])expect(loginError({code}).unavailable).toBe(true);
  expect(loginError({code:'cancelled'})).toEqual({unavailable:false,message:'已取消登录'});
  expect(loginError(Error('connection lost'))).toMatchObject({unavailable:false});
});

test('network changes update the login gate and disposal unsubscribes',async()=>{
  let changed=()=>{},unsubscribed=false;
  let snapshot={active:true,internet:true,validated:true,wifi:false,cellular:false,bluetooth:true};
  const states:InternetStatus[]=[];
  const stop=observeInternet({snapshot:async()=>snapshot,subscribe(change){changed=change;return()=>{unsubscribed=true;};}},state=>states.push(state));
  await Promise.resolve();expect(states).toEqual(['checking','bluetooth']);
  snapshot={...snapshot,wifi:true};changed();await Promise.resolve();expect(loginGate(states.at(-1)!,true)).toBeNull();
  snapshot={...snapshot,active:false};changed();await Promise.resolve();expect(loginGate(states.at(-1)!,true)).not.toBeNull();
  stop();const count=states.length;changed();await Promise.resolve();expect(unsubscribed).toBe(true);expect(states.length).toBe(count);
});
