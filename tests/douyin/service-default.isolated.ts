// Run separately: bun --conditions=browser test ./tests/douyin/service-default.isolated.ts
import {expect,test} from 'bun:test';
import {DouyinClient} from '../../src/douyin/client.ts';
import {createBiliClient} from '../../src/bili/client.ts';
import {utf8Encode,utf8Decode} from '../../src/cloud/types.ts';
import {decodeMediaText} from '../../src/media/text.ts';
import {ABogusSigner} from '../../src/douyin/signing.ts';

test('production defaults sign, decode and refresh through fresh host turns, retaining exact content',async()=>{
  const original=(globalThis as any).pod;
  const events:unknown[]=[];let turns=0;
  const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});
  (globalThis as any).pod={capabilities:()=>JSON.stringify(['runtime.timer']),takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
    decodeUtf8:(bytes:Uint8Array)=>{try{return decoder.decode(bytes);}catch{return null;}},
    emit:(raw:string)=>{const e=JSON.parse(raw);expect(e.method).toBe('runtime.delay');setTimeout(()=>{turns++;events.push({t:'service.result',id:e.id,ok:true,value:null});(globalThis as any).__pocketPumpServices();},0);}};
  try{
    expect(new ABogusSigner().sign({a:'1'})).toMatch(/^[A-Za-z0-9/+=-]{168}$/);
    const item={aweme_id:'7',desc:'中文🙂'.repeat(6000),author:{nickname:'作者'},video:{play_addr:{url_list:['https://fixture.invalid/video']}}};
    const raw=JSON.stringify({aweme_list:[item],max_cursor:99,has_more:1});
    const bytes=utf8Encode(raw);
    expect(await decodeMediaText(bytes)).toBe(raw);expect(turns).toBeGreaterThan(0);
    const store={async get(k:string){return k==='douyin.cookie'?'fixture-cookie':null;},async set(){},async remove(){}};
    let requests=0;
    const client=new DouyinClient({secureStorage:store,transport:{async request(r){requests++;expect(r.url).toContain('a_bogus=');return {status:200,headers:{},body:bytes};}}});
    const result=await client.fetchFeedPage();expect(result.ok&&result.data.items[0].description).toBe(item.desc);expect(requests).toBe(1);
    const bad=utf8Encode('<html>'+'x'.repeat(70000)+'</html>');
    expect(await new DouyinClient({secureStorage:store,transport:{async request(){return {status:200,headers:{},body:bad};}}}).fetchFeedPage()).toMatchObject({ok:false,code:'PARSE_FAILED'});
    const bili=createBiliClient({transport:{async request(){return {status:200,headers:{},body:utf8Encode(JSON.stringify({code:0,data:{list:[{title:item.desc,history:{oid:7}}]}}))};}}});
    expect((await bili.history()).items[0].title).toBe(item.desc);
    delete (globalThis as any).pod.decodeUtf8;
    const malformed=new Uint8Array(2100).fill(0x80);
    expect(await decodeMediaText(malformed)).toBe(utf8Decode(malformed));
  }finally{(globalThis as any).pod=original;}
});
