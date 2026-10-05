import {SyncAccountTelemetry,type UsageEvent} from '../sync/account-telemetry.ts';
import type {DiagnosticStorage} from '../sync/diagnostic-log.ts';
import type {WatchAccountState} from '../account/types.ts';
import {utf8Encode,type HttpTransport} from '../cloud/types.ts';
export interface TelemetryPorts {
  freshAccount():Promise<WatchAccountState>;
  identity():Promise<{installId:string;deviceId:string}>;
  transport:HttpTransport;
  delay(ms:number):Promise<unknown>;
  versionName:string;versionCode:number;appVersion:string;
}
/** No raw content or per-item identities enter this API or its persisted store. */
export class WatchUsageTelemetry extends SyncAccountTelemetry {
  private scheduled=false;
  private generation=0;
  constructor(storage:DiagnosticStorage,private readonly ports:TelemetryPorts,now:()=>number=Date.now){super(storage,now);}
  override record(event:UsageEvent,properties:{screen?:string;durationMs?:number}={}):void {
    super.record(event,properties);this.generation++;this.schedule();
  }
  recordAppLaunch(){this.record('app_opened');}
  recordReleaseOobeOpened(debugBuild:boolean){
    if(debugBuild||this.storage.get('watchrss.telemetry.release-oobe-recorded')==='true')return;
    this.record('release_oobe_opened');this.storage.set('watchrss.telemetry.release-oobe-recorded','true');
  }
  recordScreenOpen(screen:string){this.record('screen_opened',{screen});}
  recordScreenDuration(screen:string,durationMs:number){if(durationMs>0)this.record('screen_duration',{screen,durationMs});}
  recordSyncReceived(){this.record('sync_received');}
  recordFeedRefreshed(){this.record('feed_refreshed');}
  recordArticleReadStarted(){this.record('article_read_started');}
  recordArticleReadFinished(){this.record('article_read_finished');}
  recordVideoPlayed(){this.record('video_played');}
  private schedule(){
    if(this.scheduled)return;
    this.scheduled=true;
    void this.run();
  }
  private async run(){
    let uploadingGeneration=this.generation;
    try{await this.ports.delay(750);uploadingGeneration=this.generation;await this.uploadPending();}catch{/* Native retries on subsequent captures, not on a timer. */}
    finally{this.scheduled=false;if(this.generation!==uploadingGeneration)this.schedule();}
  }
  private async uploadPending(){
    const account=await this.ports.freshAccount();
    const identity=await this.ports.identity();
    for(const snapshot of this.snapshots()){
      const payload={...snapshot,...identity,platform:'watch',appVersionName:this.ports.versionName,
        appVersionCode:this.ports.versionCode,diagnosticsOptedIn:false};
      const response=await this.ports.transport.request({method:'POST',url:account.backendBaseUrl.replace(/\/+$/,'')+'/functions/v1/telemetry-rollup',
        headers:{Authorization:`Bearer ${account.watchDeviceToken}`,'X-WatchRSS-App-Version':this.ports.appVersion,'content-type':'application/json; charset=utf-8'},body:utf8Encode(JSON.stringify(payload))});
      if(response.status<200||response.status>=300)return;
    }
  }
}
/** Activity-like resume/pause semantics, including the native extra account open. */
export class TelemetryScreenSession {
  private current?:{key:unknown;screen:string;started:number};
  constructor(private readonly telemetry:Pick<WatchUsageTelemetry,'recordScreenOpen'|'recordScreenDuration'>,private readonly elapsed:()=>number){}
  update(key:unknown,screen:string|undefined,active:boolean){
    if(this.current&&active&&this.current.key===key&&this.current.screen===screen)return;
    this.pause();
    if(active&&screen){this.current={key,screen,started:this.elapsed()};this.telemetry.recordScreenOpen(screen);if(screen==='AccountStatusActivity')this.telemetry.recordScreenOpen('watch_account');}
  }
  pause(){if(this.current){this.telemetry.recordScreenDuration(this.current.screen,this.elapsed()-this.current.started);this.current=undefined;}}
}
