import {application,device,delay} from '@podjs/framework/services';
import {kv,lifecycle,onLifecycleChange} from '@podjs/framework/watch';
import config from '../../pod.config.json';
import {OnboardingStore} from '../onboarding/store';
import {PRIVACY_POLICY_VERSION} from '../onboarding/state';
import {observeHostInternet} from '../onboarding/network-host';
import {utf8Encode,utf8Decode} from '../cloud/types';
import {watchAppVersion} from '../core/app-version';
import {installationId,telemetryTransport} from './host';
import {WatchDeviceProfileTelemetry} from './device-profile';

export function startDeviceProfileTelemetry():()=>void {
 const consented=()=>{try{return new OnboardingStore(kv).load().privacyPolicyAgreedVersion>=PRIVACY_POLICY_VERSION;}catch{return false;}};
 const telemetry=new WatchDeviceProfileTelemetry(kv,{
  consented,buildInfo:()=>application.buildInfo(),info:()=>device.info(),identity:installationId,
  now:Date.now,after:(ms,callback)=>{const task=delay(ms);void task.result.then(callback,()=>{});return ()=>task.cancel();},
  versionName:config.versionName,versionCode:config.versionCode,privacyPolicyVersion:PRIVACY_POLICY_VERSION,
  async send(report){
   const response=await telemetryTransport.request({method:'POST',url:'https://sly-data-plane.watchrss.cn/functions/v1/watch-device-profile',
    headers:{'content-type':'application/json; charset=utf-8','X-WatchRSS-App-Version':watchAppVersion},body:utf8Encode(JSON.stringify(report))});
   if(response.status<200||response.status>=300)throw Error('Device profile upload failed');
   return JSON.parse(utf8Decode(response.body));
  },
 });
 void telemetry.refresh(lifecycle()==='active');
 const offLifecycle=onLifecycleChange(value=>{void telemetry.refresh(value==='active');});
 const offNetwork=observeHostInternet(status=>{if(status==='available'||status==='bluetooth')void telemetry.refresh(lifecycle()==='active',true);});
 return ()=>{telemetry.stop();offLifecycle();offNetwork();};
}
