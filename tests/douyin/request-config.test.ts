import {expect,test} from 'bun:test';
import {applyDouyinRequestConfig,readDouyinRequestConfig,douyinRequestProfile,DOUYIN_REQUEST_LOCAL_KEY,DOUYIN_REQUEST_REMOTE_KEY,resolveDouyinRequestConfig} from '../../src/douyin/request-config.ts';

function stores(){const values=new Map<string,unknown>(),secrets=new Map<string,string>([['douyin.cookie','synthetic-cookie-A']]);return {values,secrets,kv:{get:<T>(key:string)=>values.get(key) as T|undefined,set:<T>(key:string,value:T)=>{values.set(key,value);}},secure:{get:async(key:string)=>secrets.get(key)??null,set:async(key:string,value:string)=>{secrets.set(key,value);},remove:async(key:string)=>{secrets.delete(key);}}};}
test('conservative web defaults align version, Chrome and engine while retaining old request fields',()=>{
 const p=douyinRequestProfile();expect(p.params).toMatchObject({version_code:'170400',version_name:'17.4.0',browser_version:'155.0.0.0',engine_version:'155.0.0.0',update_version_code:'170400',msToken:''});expect(p.headers['User-Agent']).toContain('Chrome/155.0.0.0');expect(p.params).not.toHaveProperty('verifyFp');expect(p.params).not.toHaveProperty('fp');expect(p.params).not.toHaveProperty('support_dash');
});
test('remote then local field overrides keep identifiers only in secure storage',async()=>{
 const s=stores();await applyDouyinRequestConfig(s.kv,s.secure,{versionCode:'123456',versionName:'12.3.4',userAgent:'remote-UA',browserVersion:'150.0.0.0',verifyFp:'synthetic-fp',msToken:'synthetic-token',webid:'synthetic-webid',uifid:'synthetic-uifid',webPagination:true},'remote');
 await applyDouyinRequestConfig(s.kv,s.secure,{userAgent:'local-UA',msToken:'',webPagination:false},'local');
 const config=await readDouyinRequestConfig(s.kv,s.secure),profile=douyinRequestProfile(config);
 expect(profile.params).toMatchObject({version_code:'123456',version_name:'12.3.4',verifyFp:'synthetic-fp',fp:'synthetic-fp',msToken:'',webid:'synthetic-webid',uifid:'synthetic-uifid',browser_version:'150.0.0.0',engine_version:'150.0.0.0'});expect(profile.headers['User-Agent']).toBe('local-UA');expect(config.webPagination).toBe(false);
 expect(JSON.stringify([...s.values])).not.toMatch(/synthetic|msToken|verifyFp|uifid|webid/);expect(JSON.stringify([...s.secrets])).toContain('synthetic-token');
});
test('legacy version and UA rollback can be supplied without changing the signer',async()=>{
 const s=stores();await applyDouyinRequestConfig(s.kv,s.secure,{versionCode:'290100',versionName:'29.1.0',browserVersion:'130.0.0.0',userAgent:'Chrome/90.0.4430.212'});
 expect(douyinRequestProfile(await readDouyinRequestConfig(s.kv,s.secure))).toMatchObject({params:{version_code:'290100',version_name:'29.1.0',browser_version:'130.0.0.0'},headers:{'User-Agent':'Chrome/90.0.4430.212'}});
});
test('untrusted snapshot cannot inject headers, paths, signatures or private fields into ordinary KV',async()=>{
 const s=stores();s.values.set(DOUYIN_REQUEST_REMOTE_KEY,{versionCode:'bad',browserVersion:'130\r\nSecret: x',userAgent:'bad\n',verifyFp:'UNTRUSTED',msToken:'UNTRUSTED',host:'https://evil',a_bogus:'bad',webPagination:'true'});
 s.values.set(DOUYIN_REQUEST_LOCAL_KEY,[]);expect(await readDouyinRequestConfig(s.kv,s.secure)).toEqual({});expect(await resolveDouyinRequestConfig(()=>{throw Error('synthetic-secret');})).toEqual({});
 for(const value of [{userAgent:'bad\r\nCookie: x'},{versionCode:'x'},{browserVersion:'latest'},{msToken:'a b'},{verifyFp:'x\n'},{webPagination:'yes'}])await expect(applyDouyinRequestConfig(s.kv,s.secure,value as any)).rejects.toThrow('invalid_douyin_request_config');
});
test('fingerprint aliases are filled only from supplied values; explicit separate aliases survive',()=>{
 expect(douyinRequestProfile({fp:'f'}).params).toMatchObject({fp:'f',verifyFp:'f'});expect(douyinRequestProfile({fp:'a',verifyFp:'b'}).params).toMatchObject({fp:'a',verifyFp:'b'});
});

test('persisted session identifiers do not survive a Cookie replacement or logout',async()=>{
 const s=stores();await applyDouyinRequestConfig(s.kv,s.secure,{versionCode:'170400',msToken:'synthetic-token',verifyFp:'synthetic-fp'},'remote');expect(await readDouyinRequestConfig(s.kv,s.secure)).toMatchObject({msToken:'synthetic-token'});
 s.secrets.set('douyin.cookie','synthetic-cookie-B');expect(await readDouyinRequestConfig(s.kv,s.secure)).toEqual({versionCode:'170400'});s.secrets.delete('douyin.cookie');expect(await readDouyinRequestConfig(s.kv,s.secure)).toEqual({versionCode:'170400'});
});
