import {createContentTransport} from '@podjs/framework/content-http';
/** Explicit isolated entry. No import/startup hook and no implicit continuation. */
import {contentHostPorts} from '@podjs/framework/content-host';
import {AuthenticatedContentSessions} from '@podjs/framework/content-worker';
import {createSyncV2Crypto,unhex} from '@podjs/framework/crypto';
import {WatchContentStore} from './content-store';
import {WatchContentHttp} from './content-http';
import {WatchContentEngine,type ContentSource,type ContentMetric} from './content-engine';
import {SyncV2Http,type Session,type OriginPolicy} from './http';
import type {WatchServiceKeyPin} from './service-key';
import type {ApprovedKey} from './head-pins';
import {localProjectionCipher,projectionSql} from './host';
import type {CloudHostRequest} from '../cloud/host-ports';
import type {HttpTransport} from '../cloud/types';
import {digest,canonical} from './protocol';
/** Host has a separate HTTP client. Requests are bounded; redirects stay off. */
export function contentHttpTransport(host:CloudHostRequest):HttpTransport {return createContentTransport(host,url=>/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::[0-9]+)?\//.test(url));}
export function watchContentV2(options:{enabled?:boolean;origin:string;originPolicy?:OriginPolicy;host:CloudHostRequest;session:()=>Promise<Session>;servicePin:WatchServiceKeyPin;
 keys:import('./sealed').ObjectKeys;authBinding:string;alias:string;source:(binding:string)=>Promise<ContentSource>;approved:(id:string)=>Promise<ApprovedKey>;
 assertCurrent:()=>Promise<void>;refreshApproved:(windowId:string)=>Promise<void>;sessions?:AuthenticatedContentSessions;transport?:HttpTransport;allowChargingCellular?:()=>Promise<boolean>;now?:()=>number;metric?:(m:ContentMetric)=>void;}){
 let open:Promise<WatchContentEngine>|undefined;
 return {async open(){if(options.enabled!==true)return null;return open??=(async()=>{
  await options.assertCurrent();const session=await options.session(),ports=contentHostPorts(options.host,options.sessions??new AuthenticatedContentSessions()),http=new SyncV2Http(options.transport??contentHttpTransport(options.host),options.origin,session.scope,options.session,false,options.servicePin,true,false,false,false,options.originPolicy);
  await http.capabilities();const binding={scope:session.scope,accountId:options.servicePin.accountId,auth:options.authBinding,keyVersion:options.keys.version,keyHash:digest(Array.from(options.keys.content)),idHash:digest(Array.from(options.keys.id))};
  const store=new WatchContentStore(projectionSql(options.host),localProjectionCipher(options.host,'content:'+digest(binding)),ports.files,binding);await store.init();
  return new WatchContentEngine(store,new WatchContentHttp(http,createSyncV2Crypto(options.host),options.now??Date.now),ports.crypto,options.keys,{
   refreshApproved:options.refreshApproved,alias:options.alias,source:options.source,approved:options.approved,assertCurrent:options.assertCurrent,now:options.now,metric:options.metric,
   signals:async()=>ports.signals(await options.allowChargingCellular?.()??true),yieldControl:()=>options.host('runtime.delay',{milliseconds:1}),
  });
 })().catch(e=>{open=undefined;throw e;});}};
}
