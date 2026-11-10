import {test,expect} from 'bun:test';
import {syncV2Origin,SyncV2Http} from '../../src/sync-v2/http';
import {TrustedClock,requireTrustedNow} from '../../src/sync-v2/trusted-time';
import {SYNC_V2_PRODUCT} from '../../src/sync-v2/gate';
import {scope} from './fixture';

const base='https://api.example.com';
test('P6-2 production origin equals the v1 account backendBaseUrl host',()=>{
 expect(syncV2Origin('https://api.example.com',{accountBaseUrl:base,allowLoopback:false})).toBe('https://api.example.com');
 expect(syncV2Origin('https://api.example.com',{accountBaseUrl:base+'/',allowLoopback:false})).toBe('https://api.example.com');
 expect(syncV2Origin('https://api.example.com:8443',{accountBaseUrl:'https://api.example.com:8443',allowLoopback:false})).toBe('https://api.example.com:8443');
});
test('P6-2 origin counterexamples are all isolated_backend_required',()=>{
 const p={accountBaseUrl:base,allowLoopback:false};
 for(const origin of ['http://api.example.com','https://evil.example.com','https://api.example.com.evil.com','https://API.example.com','https://user@api.example.com','https://user:pw@api.example.com','https://api.example.com?x=1','https://api.example.com#f','https://api.example.com:443','https://api.example.com:8443','https://api.example.com/functions','https://api.example.com/','ftp://api.example.com','https://api.example.com\\@x','','http://localhost:3000','http://127.0.0.1:1','http://[::1]:2'])
  expect(()=>syncV2Origin(origin,p),origin).toThrow('isolated_backend_required');
 expect(()=>syncV2Origin(base,{accountBaseUrl:'https://api.example.com/sub',allowLoopback:false})).toThrow('isolated_backend_required');
 expect(()=>syncV2Origin(base,{accountBaseUrl:'http://api.example.com',allowLoopback:false})).toThrow('isolated_backend_required');
});
test('P6-2 loopback only in debug/test builds',()=>{
 expect(syncV2Origin('http://127.0.0.1:18990',{accountBaseUrl:base,allowLoopback:true})).toBe('http://127.0.0.1:18990');
 expect(()=>new SyncV2Http({request:async()=>{throw Error('no io');}} as any,'http://127.0.0.1:1',scope,async()=>{throw Error('no io');},false,undefined,false,false,false,false,{accountBaseUrl:base,allowLoopback:false})).toThrow('isolated_backend_required');
 const http=new SyncV2Http({request:async()=>{throw Error('no io');}} as any,base,scope,async()=>{throw Error('no io');},false,undefined,false,false,false,false,{accountBaseUrl:base,allowLoopback:false});
 expect(http.prefix).toBe(base+'/functions/v1/sync/v2');expect(http.readOnly().prefix).toBe(http.prefix);
});
test('P6-10 product switch defaults off',()=>{expect(SYNC_V2_PRODUCT.syncV2).toBe(false);expect(Object.isFrozen(SYNC_V2_PRODUCT)).toBe(true);});
test('P6-6 trusted time advances monotonically and rejects rollback beyond 5 minutes',()=>{
 let mono=1000;const clock=new TrustedClock(()=>mono);expect(clock.now()).toBeNull();expect(()=>requireTrustedNow(clock)).toThrow('trusted_time_unavailable');
 expect(clock.observe(10_000_000)).toBe(true);mono+=2000;expect(clock.now()).toBe(10_002_000);
 expect(clock.observe(10_002_000-300_001)).toBe(false);expect(clock.now()).toBe(10_002_000);
 expect(clock.observe(10_002_000-1000)).toBe(true);expect(clock.now()).toBe(10_002_000);
 expect(clock.observe(20_000_000)).toBe(true);expect(clock.now()).toBe(20_000_000);
 mono+=86_400_001;expect(clock.now()).toBeNull();expect(clock.observe(1)).toBe(true);expect(clock.now()).toBe(1);
 expect(new TrustedClock(()=>mono).now()).toBeNull();
});
