import type {BrowserAuthStatus} from '@podjs/framework/services';
/** Native starts at the first detected login panel, reports the first login QR,
 * ignores verification QR, and retains its once flag for this screen lifetime. */
export class DouyinQrLoadTelemetry {
  private started?:number;
  private reported=false;
  constructor(private readonly report:(durationMs:number)=>void,private readonly now:()=>number=Date.now){}
  status(event:BrowserAuthStatus){
    if(event.type==='pageState'&&event.loginPanelVisible&&this.started===undefined)this.started=this.now();
    if(event.type==='qr'&&event.kind==='login'&&this.started!==undefined&&!this.reported){
      this.reported=true;this.report(this.now()-this.started);
    }
  }
}
