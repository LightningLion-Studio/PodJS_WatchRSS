import {utf8Decode,utf8Encode} from '../../src/cloud/types.ts';
import {ABogusSigner} from '../../src/douyin/signing.ts';
import {parseDouyinFeed,parseDouyinDetail} from '../../src/douyin/parser.ts';
import {DouyinClient} from '../../src/douyin/client.ts';
import {DouyinFeedStore,normalizeItems} from '../../src/douyin/feed-store.ts';
import {appendDouyinItems} from '../../src/douyin/rss-feed.ts';
import {text as biliText,md5} from '../../src/bili/portable.ts';
import {createBiliClient} from '../../src/bili/client.ts';
import {redactSensitiveLogContent} from '../../src/logs/app-logger.ts';
import {decodeUtf8Piece} from '../../src/core/utf8-decode.ts';
import {decodeMediaText} from '../../src/media/text.ts';
import {correspondenceCsrf} from '../../src/bili/html.ts';
import {initialLoginStatus,updateLoginStatus} from '../../src/ui/douyin/login-state.ts';
import {DouyinPlaybackQueue} from '../../src/douyin/playback-queue.ts';

const host=globalThis as typeof globalThis & {__benchNow:()=>number;__benchPrint:(s:string)=>void;__benchDone:boolean};
const now=host.__benchNow??(()=>performance.now());
const print=host.__benchPrint??console.log;
// Service-result delivery is driven by the outer Rust loop after its pending
// jobs drain, so runtime.delay exercises the real production default yield.
const events:unknown[]=[];
Object.assign((globalThis as any).pod??((globalThis as any).pod={}),{
  capabilities:()=>JSON.stringify(['runtime.timer']),
  emit:(line:string)=>{const request=JSON.parse(line);if(request.t==='service.request'&&request.method==='runtime.delay')events.push({t:'service.result',id:request.id,ok:true,value:null});else throw Error('unexpected benchmark IO');},
  takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
});
(globalThis as any).__benchPump=()=>{if(!events.length)return false;(globalThis as any).__pocketPumpServices();return true;};
const measure=<T>(phase:string,bytes:number,run:()=>T):T=>{const start=now();const value=run();print(JSON.stringify({phase,bytes,ms:now()-start}));return value;};
const asyncMeasure=async<T>(phase:string,bytes:number,run:()=>Promise<T>)=>{const start=now();const value=await run();print(JSON.stringify({phase,bytes,ms:now()-start}));return value;};
const store={async get(key:string){return key==='douyin.cookie'?'fixture-cookie':null;},async set(){},async remove(){}};
async function main(){
  // No clock/random/signer injection: exercise production default constructors.
  const signer=new ABogusSigner();
  for(let lap=0;lap<3;lap++)measure('abogus.sample',0,()=>signer.sign({'关键词':'猫 咪','页':'一/1'}));
  measure('bili.wbi.md5',0,()=>md5('aid=1&cid=2&wts=1700000000'+'a'.repeat(32)));
  for(const target of [4096,65536,262144,1048576,4194304]){
    const rows=Array.from({length:12},(_,i)=>({aweme_id:String(i+1),desc:'中文测试🙂'.repeat(8),create_time:12,author:{uid:'fixture',nickname:'作者'},statistics:{digg_count:9},video:{duration:1500,play_addr:{url_list:['https://video.invalid/main'],width:720,height:1280},bit_rate:[{codec_type:'h264',play_addr:{url_list:['https://video.invalid/avc']}}]}}));
    const seed=JSON.stringify({aweme_list:rows,max_cursor:99,has_more:1});
    // Douyin includes large unconsumed metadata fields; ASCII + CJK/astral mix.
    const raw=JSON.stringify({aweme_list:rows,max_cursor:99,has_more:1,extra:{log_pb:'abc中文🙂'.repeat(Math.max(0,Math.floor((target-seed.length)/8)))}});
    const bytes=utf8Encode(raw);
    if(bytes.length>8*1024*1024)throw Error('fixture exceeds production response limit');
    if(!(globalThis as any).__benchBaseline){
      let pieceMax=0,pieces=0;
      for(let i=0;i<bytes.length;){const start=now();const part=decodeUtf8Piece(bytes,i,'douyin');pieceMax=Math.max(pieceMax,now()-start);i=part.next;pieces++;}
      print(JSON.stringify({phase:'utf8.pieces',bytes:bytes.length,pieces,maxMs:pieceMax}));
    }
    measure('utf8.decode',bytes.length,()=>{if(utf8Decode(bytes)!==raw)throw Error('decode mismatch');});
    measure('bili.utf8.decode',bytes.length,()=>{if(biliText(bytes)!==raw)throw Error('bili decode mismatch');});
    measure('json.parse',bytes.length,()=>JSON.parse(raw));
    const page=measure('feed.parse',bytes.length,()=>parseDouyinFeed(raw));
    const detail=JSON.stringify({aweme_detail:rows[0]});
    measure('detail.parse',detail.length,()=>parseDouyinDetail(detail));
    measure('feed.window.200',0,()=>appendDouyinItems(normalizeItems(Array.from({length:200},(_,i)=>({...page.items[i%12],awemeId:String(i)}))),page.items));
    const feedStore=new DouyinFeedStore(store);
    await asyncMeasure('feed.save',0,()=>feedStore.save('fixture',{items:page.items,cursor:null,hasMore:true,anchorAwemeId:null,savedAtMillis:Date.now(),resolved:{}}));
    let signedParams:Record<string,string>|undefined;
    const client=new DouyinClient({secureStorage:store,transport:{async request(request){signedParams=Object.fromEntries(request.url.split('?')[1].split('&').filter(p=>!p.startsWith('a_bogus=')).map(p=>p.split('=').map(decodeURIComponent)));return {status:200,headers:{},body:bytes};}}});
    await asyncMeasure('client.default.refresh',bytes.length,async()=>{const result=await client.fetchFeedPage();if(!result.ok||result.data.items.length!==12)throw Error('refresh failed');});
    if(target===4096){
      measure('abogus.feed-default',JSON.stringify(signedParams).length,()=>new ABogusSigner().sign(signedParams!));
      measure('queue.default.window',12,()=>new DouyinPlaybackQueue(client,{items:page.items,selectedAwemeId:page.items[0].awemeId,hasMore:true}));
      let calls=0;
      const duplicateClient=new DouyinClient({secureStorage:store,transport:{async request(){calls++;return {status:200,headers:{},body:utf8Encode(JSON.stringify({aweme_list:rows,max_cursor:calls,has_more:1}))};}}});
      const queue=new DouyinPlaybackQueue(duplicateClient,{items:page.items,selectedAwemeId:page.items.at(-1)!.awemeId,hasMore:true});
      await asyncMeasure('queue.duplicate-page-retries',bytes.length,async()=>{const result=await queue.next();if(result.ok||calls!==40)throw Error('retry bound changed');});
      print(JSON.stringify({phase:'queue.retry-count',calls}));
    }
    const html=utf8Encode('<html><script>'+raw+'</script></html>');
    await asyncMeasure('client.default.html-error',html.length,async()=>{const result=await new DouyinClient({secureStorage:store,transport:{async request(){return {status:200,headers:{},body:html};}}}).fetchFeedPage();if(result.ok||result.code!=='PARSE_FAILED')throw Error('html failure changed');});
    const biliBytes=utf8Encode(JSON.stringify({code:0,data:{list:[],cursor:{max:1},extra:JSON.parse(raw).extra}}));
    await asyncMeasure('bili.default.history',biliBytes.length,()=>createBiliClient({transport:{async request(){return {status:200,headers:{},body:biliBytes};}}}).history());
    const auth={type:'pageState' as const,loading:false,loginPanelVisible:true};
    measure('auth.status.update',JSON.stringify(auth).length,()=>updateLoginStatus(initialLoginStatus(),JSON.parse(JSON.stringify(auth))));
    await asyncMeasure('cookie.apply',4096,()=>client.applyCookie('ttwid=fixture;'+'x'.repeat(4080)));
  }
  measure('log.redact.64k',65536,()=>redactSensitiveLogContent('[D] DouyinClient POST /aweme/v2/web/module/feed/\n'.repeat(1400)));
  for(const count of [100,1000,4000]){
    const malformed='id="1-name" '.repeat(count);
    measure('bili.csrf.missing-close',malformed.length,()=>correspondenceCsrf(malformed));
  }
  const ascii=utf8Encode('<html>'+'a'.repeat(8*1024*1024-32)+'</html>');
  measure('html.ascii.8m.decode',ascii.length,()=>utf8Decode(ascii));
  if(!(globalThis as any).__benchBaseline)await asyncMeasure('media.async.8m',ascii.length,()=>decodeMediaText(ascii));
  host.__benchDone=true;
}
main().catch(e=>{print(JSON.stringify({error:String(e)}));});
