import {DouyinFeedStore,FEED_KEY} from '../../src/douyin/feed-store.ts';
import {expect,test} from 'bun:test';
import {parseDouyinFeed,parseDouyinFeedAsync} from '../../src/douyin/parser.ts';
import {DouyinClient} from '../../src/douyin/client.ts';
import {utf8Encode} from '../../src/cloud/types.ts';
const row={aweme_id:'7',desc:'中🙂',author:{uid:8,nickname:'作者'},statistics:{digg_count:'9'},video:{play_addr:{url_list:['https://fixture/main'],width:720},bit_rate:[{gear_name:'h265',is_h265:1,bit_rate:123,video_extra:{definition:'HD',quality:'high'},play_addr:{url_list:['https://fixture/variant'],height:1280}}],duration:1500}};
test('sliced feed matches the existing mapper on large ignored fields and mixed shapes',async()=>{
 for(const input of [{aweme_list:[row,null,{}, {...row,aweme_id:''}],max_cursor:99,has_more:1},{aweme_list:Array.from({length:16},(_,i)=>({...row,aweme_id:String(i),ignored:'x'.repeat(145000)})),cursor:'next',has_more:1},{aweme_list:false},{}]){
 const raw=JSON.stringify(input);expect(await parseDouyinFeedAsync(raw)).toEqual(parseDouyinFeed(raw));}
});
test('production defaults persist exactly the unchanged feed snapshot',async()=>{
 const values=new Map<string,string>([['douyin.cookie','fixture']]);const storage={get:async(k:string)=>values.get(k)??null,set:async(k:string,v:string)=>{values.set(k,v);},remove:async(k:string)=>{values.delete(k);}};
 // Uses default clock and signer, as production does.
 const client=new DouyinClient({secureStorage:storage,transport:{request:async()=>({status:200,headers:{},body:utf8Encode(JSON.stringify({aweme_list:[row],cursor:'next',has_more:1}))})}});
 const result=await client.fetchFeedPage({count:16});expect(result.ok).toBe(true);const stored=await new DouyinFeedStore(storage).read(FEED_KEY);expect(stored.items).toEqual(parseDouyinFeed(JSON.stringify({aweme_list:[row]})).items);expect(stored).toMatchObject({cursor:'next',hasMore:true,anchorAwemeId:null});
});

test('web play_addr_265 survives asynchronous projection alongside both legacy keys',async()=>{
 const video={play_addr_265:{url_list:['https://fixture/web265'],width:360,height:640},play_addr_h265:{url_list:['https://fixture/legacy265']},play_addr_bytevc1:{url_list:['https://fixture/bytevc1']}};
 const raw=JSON.stringify({aweme_list:[{aweme_id:'265',video}],has_more:0});
 const sync=parseDouyinFeed(raw),asyncPage=await parseDouyinFeedAsync(raw);expect(asyncPage).toEqual(sync);
 expect(sync.items[0]!.variants.map(v=>[v.playUrl,v.codec])).toEqual([['https://fixture/web265','h265'],['https://fixture/legacy265','h265'],['https://fixture/bytevc1','h265']]);
});
