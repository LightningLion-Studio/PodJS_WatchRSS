import {expect,test} from 'bun:test';
import {biliCdnHeaders} from '../../src/bili/cdn.ts';
import {biliPlaybackCandidates,createBiliPlaybackRetry} from '../../src/playback.ts';

const web={'User-Agent':'Mozilla/5.0',Referer:'https://www.bilibili.com/',Cookie:'synthetic-session',Authorization:'synthetic-auth'};
test('watch signed media uses the tested profile and never inherits Web identity headers',()=>{
 const original={...web,referer:'https://other.invalid/',cookie:'synthetic-cookie',Origin:'https://www.bilibili.com'};
 expect(biliCdnHeaders({apiSource:'watch'},original)).toEqual({'User-Agent':'Mozilla/5.0','Accept-Encoding':'identity',Range:'bytes=0-'});
 expect(original).toHaveProperty('Cookie','synthetic-session');
 expect(biliCdnHeaders({apiSource:'web'},web)).toBe(web);
});
test('watch primary and backups preserve scheme, signed platform/query and order verbatim',()=>{
 const primary='http://edge.example.invalid:4480/video?platform=watch&uparams=platform&upsig=synthetic',backup='https://upos.example.invalid/video?platform=watch&uparams=platform&upsig=other';
 const source={apiSource:'watch' as const,quality:16,acceptQuality:[],acceptDescription:[],durl:[{url:primary,backupUrl:[backup,primary]}]};
 const candidates=biliPlaybackCandidates(source,'fixture',web);
 expect(candidates.map(x=>x.url)).toEqual([primary,backup]);
 for(const c of candidates){expect(c.biliApiSource).toBe('watch');expect(c.headers).toEqual({'User-Agent':'Mozilla/5.0','Accept-Encoding':'identity',Range:'bytes=0-'});}
});
test('DASH audio/video use the same watch profile and retain their signed URLs',()=>{
 const candidates=biliPlaybackCandidates({apiSource:'watch',quality:16,acceptQuality:[],acceptDescription:[],durl:[],dash:{video:[{baseUrl:'http://fixture.invalid/v?platform=watch',backupUrl:[],codecId:7}],audio:[{baseUrl:'https://fixture.invalid/a?platform=watch',backupUrl:[]}]}},'fixture',web);
 expect(candidates).toHaveLength(1);expect(candidates[0]).toMatchObject({videoUrl:'http://fixture.invalid/v?platform=watch',audioUrl:'https://fixture.invalid/a?platform=watch',biliApiSource:'watch'});
 expect(candidates[0].headers).not.toHaveProperty('Referer');expect(candidates[0].headers).not.toHaveProperty('Cookie');
});
test('forced Web resolution replaces the watch profile with existing Web headers',async()=>{
 const source={apiSource:'watch' as const,acceptQuality:[],acceptDescription:[],durl:[{url:'https://fixture.invalid/watch',backupUrl:[]}]};
 const calls:unknown[]=[];const retry=createBiliPlaybackRetry(source,async options=>{calls.push(options);return{...source,apiSource:'web',durl:[{url:'https://fixture.invalid/web',backupUrl:[]}]};},'fixture',web);
 const result=await retry({error:{code:'restricted'}});expect(result.biliApiSource).toBe('web');expect(result.headers).toBe(web);expect(result.headers).not.toHaveProperty('Range');expect(calls).toEqual([{forceWeb:true}]);
});
test('one fresh Web source can reuse a rejected watch URL with its different request profile',async()=>{
 const source={apiSource:'watch' as const,acceptQuality:[],acceptDescription:[],durl:[{url:'https://fixture.invalid/shared',backupUrl:[]}]};
 let resolutions=0;const retry=createBiliPlaybackRetry(source,async options=>{expect(options).toEqual({forceWeb:true});resolutions++;return{...source,apiSource:'web'};},'fixture',web);
 const next=await retry({error:{code:'restricted'}});expect(next).toMatchObject({url:'https://fixture.invalid/shared',biliApiSource:'web',headers:web});
 await expect(retry({error:{code:'restricted'}})).rejects.toThrow();expect(resolutions).toBe(1);
});
