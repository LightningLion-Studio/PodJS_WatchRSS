import {expect,test} from 'bun:test';
import {DouyinFeedStore,FEED_KEY,QUEUE_KEY,normalizeItems} from '../../src/douyin/feed-store.ts';
// Exact original read mapper; only the JSON preparation/scheduling changed.
function prior(raw:string|null,key:string){const empty=()=>({items:[],cursor:null,hasMore:false,anchorAwemeId:null,savedAtMillis:0,resolved:{}});try{const value=JSON.parse(raw??'null');if(!value||!Array.isArray(value.items))return empty();const items=normalizeItems(value.items).slice(0,key===QUEUE_KEY?200:40);return {items,cursor:typeof value.cursor==='string'?value.cursor:null,hasMore:value.hasMore===true,anchorAwemeId:items.some(x=>x.awemeId===value.anchorAwemeId)?value.anchorAwemeId:null,savedAtMillis:Number(value.savedAtMillis)||0,resolved:value.resolved&&typeof value.resolved==='object'?value.resolved:{}};}catch{return empty();}}
test('default restore scheduler preserves complete items and old malformed/shape/limit semantics',async()=>{
 const raws:(string|null)[]=[null,'','{','null','0','[]','{"items":false}',
 JSON.stringify({items:[null,{}, {awemeId:' a ',playUrl:' https://fixture.invalid ',opaque:{fields:['汉😀',false]}},{awemeId:'a',playUrl:'duplicate'},{awemeId:'b',playUrl:'good',variants:[{arbitrary:1}]}],anchorAwemeId:'a',cursor:'x',hasMore:true,savedAtMillis:'17',resolved:[1,2],unknown:'ignored'}),
 '{"items":[{"awemeId":"x","playUrl":"y","__proto__":{"safe":true},"n":-0,"n":1e400}],"resolved":{"__proto__":1,"n":-0}}',
 JSON.stringify({items:Array.from({length:205},(_,i)=>({awemeId:String(i),playUrl:'v'+i,unknown:'z'.repeat(2000)})),anchorAwemeId:'204',cursor:null,hasMore:1,savedAtMillis:0,resolved:{}})];
 for(const raw of raws)for(const key of [FEED_KEY,QUEUE_KEY]){
  let reads=0;const store=new DouyinFeedStore({get:async()=>{reads++;return raw;},set:async()=>{},remove:async()=>{}});
  const work=store.read(key);expect(reads).toBe(0);expect(await work).toEqual(prior(raw,key));expect(reads).toBe(1);
 }
});
test('storage rejection still rejects and does not turn a missing host into an empty cache',async()=>{
 const store=new DouyinFeedStore({get:async()=>{throw Error('storage failure');},set:async()=>{},remove:async()=>{}});
 await expect(store.read(FEED_KEY)).rejects.toThrow('storage failure');
});
