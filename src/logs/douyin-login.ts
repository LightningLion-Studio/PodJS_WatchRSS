import {appLogger} from './app-logger.ts';
import type {BrowserAuthStatus} from '@podjs/framework/services';

/** Observes host events only. Never retains a QR, URL, cookie or page text. */
export class DouyinLoginLog {
 private loading=true;
 private stateStarted:number;
 private stateNumber=1;
 private loginStarted:number|undefined;
 private qrKind:string|undefined;
 private closed=false;
 constructor(private readonly now=Date.now){this.stateStarted=now();}
 status(event:BrowserAuthStatus):void {
  if(this.closed)return;
  if(event.type==='pageState'){
   if(event.loginPanelVisible&&this.loginStarted===undefined)this.loginStarted=this.now();
   if(event.loading!==this.loading){this.duration(false);this.loading=event.loading;this.stateStarted=this.now();this.stateNumber++;}
  }else if(event.type==='qr'){
   if(this.qrKind!==event.kind)appLogger.d('DouyinLogin',event.kind==='secondVerify'?'检测到二步验证二维码':'检测到登录二维码');
   this.qrKind=event.kind;
  }else if(event.type==='qrCleared'||event.type==='verifying'||event.type==='cancelled')this.qrKind=undefined;
 }
 qrLoaded(durationMs:number):void {
  if(!this.closed)appLogger.d('DouyinLogin',`二维码加载耗时: ${durationMs}ms (${seconds(durationMs)}秒)`);
 }
 completed():void {
  if(this.closed||this.loginStarted===undefined)return;
  const duration=Math.max(0,this.now()-this.loginStarted);
  appLogger.d('DouyinLogin',`登录耗时: ${duration}ms (${seconds(duration)}秒)`);
  this.loginStarted=undefined;
 }
 dispose():void{if(this.closed)return;this.duration(true);this.closed=true;}
 private duration(disposed:boolean){
  const duration=Math.max(0,this.now()-this.stateStarted);
  appLogger.d('DouyinLogin',`第${this.stateNumber}段${this.loading?'loading':'不loading'}状态持续: ${duration}ms (${seconds(duration)}秒)${disposed?' [组件销毁]':''}`);
 }
}
function seconds(ms:number):string {return ms%1000===0?(ms/1000).toFixed(1):String(ms/1000);}
