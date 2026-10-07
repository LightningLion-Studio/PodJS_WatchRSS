import {expect,test} from 'bun:test';
import {DouyinQrLoadTelemetry} from '../../src/telemetry/qr-load.ts';
test('login panel starts timing; verification and QR before panel do not count; once flag survives re-entry',()=>{
 let now=100;const reported:number[]=[];const session=new DouyinQrLoadTelemetry(v=>reported.push(v),()=>now);
 const qr={type:'qr',kind:'login',imageBase64:'private',mime:'image/png'} as const;
 session.status(qr);session.status({type:'pageState',loading:false,loginPanelVisible:true});now=300;
 session.status({...qr,kind:'secondVerify'});expect(reported).toEqual([]);session.status(qr);session.status({type:'qrCleared'});session.status(qr);expect(reported).toEqual([200]);
});
test('production constructor does not need an injected clock',()=>{let reported=0;const session=new DouyinQrLoadTelemetry(()=>reported++);session.status({type:'pageState',loading:false,loginPanelVisible:true});session.status({type:'qr',kind:'login',imageBase64:'x',mime:'image/png'});expect(reported).toBe(1);});

import {AppLogger,installAppLogger} from '../../src/logs/app-logger.ts';
import {DouyinLoginLog} from '../../src/logs/douyin-login.ts';
test('first login QR uses the same real duration for native diagnostic and telemetry; verification and re-entry never duplicate',async()=>{
 const lines:string[]=[],reports:number[]=[];let now=10;
 const logger=new AppLogger({read:async()=>null,size:async()=>0,replace:async()=>{},append:async()=>{}},undefined,(_level,line)=>lines.push(line));installAppLogger(logger);
 try{
  const log=new DouyinLoginLog(()=>now),qr=new DouyinQrLoadTelemetry(ms=>{log.qrLoaded(ms);reports.push(ms);},()=>now);
  qr.status({type:'pageState',loading:false,loginPanelVisible:true});now=1244;
  qr.status({type:'qr',kind:'secondVerify',mime:'image/jpeg',imageBase64:'AAAA'});expect(lines).toEqual([]);
  const event={type:'qr',kind:'login',mime:'image/png',imageBase64:'AAAA'} as const;
  qr.status({type:'verifying',active:true});qr.status(event);expect(lines).toEqual([]);
  qr.status({type:'verifying',active:false});qr.status(event);qr.status({type:'qrCleared'});now=2000;qr.status(event);
  expect(reports).toEqual([1234]);expect(lines).toHaveLength(1);expect(lines[0]).toContain('[DouyinLogin] 二维码加载耗时: 1234ms (1.234秒)');
  // Both clock defaults use the production construction shape.
  const defaultLog=new DouyinLoginLog(),defaultQr=new DouyinQrLoadTelemetry(ms=>defaultLog.qrLoaded(ms));
  defaultQr.status({type:'pageState',loading:false,loginPanelVisible:true});defaultQr.status(event);
  expect(lines).toHaveLength(2);expect(lines[1]).toMatch(/二维码加载耗时: \d+ms/);
  await logger.flush();
 }finally{installAppLogger(undefined);}
});
