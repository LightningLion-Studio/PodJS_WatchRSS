import {expect,test} from 'bun:test';
import {WatchAccountClient} from '../src/account/client';
import {watchAppVersion} from '../src/core/app-version';
import {pairingHostArgs} from '../src/ui/pairing-host-args';
import {utf8Encode} from '../src/cloud/types';

test('all native relay routes inherit the standard watch version from their owned start',()=>{
 expect(pairingHostArgs('provision.start',{deviceId:'d',appVersion:'stale'})).toEqual({deviceId:'d',appVersion:watchAppVersion});
 for(const method of ['provision.receive','provision.check','provision.respond','provision.sessionRequest','provision.close']){
  const args={sessionId:'s',reason:'user_back'};expect(pairingHostArgs(method,args)).toBe(args);
 }
});
for(const appVersion of [undefined,'watch-test+123'])test(`account and watch device token calls include version (${appVersion??'default'})`,async()=>{
 const calls:any[]=[];
 const client=new WatchAccountClient({backendBaseUrl:'https://example.test',appVersion,transport:{request:async request=>{calls.push(request);return{status:200,headers:{},body:utf8Encode('{}')};}}});
 await client.requestPhoneOtp('synthetic');await client.verifyPhoneOtp('synthetic','000000','license','public');
 await client.issueWatchDeviceToken('phone','watch','install','test','fixture-token');
 expect(calls).toHaveLength(3);
 for(const call of calls)expect(call.headers['X-WatchRSS-App-Version']).toBe(appVersion??watchAppVersion);
 expect(calls[2].url).toBe('https://example.test/functions/v1/issue-watch-device-token');
 expect(calls[2].headers.authorization).toBe('Bearer fixture-token');
});
