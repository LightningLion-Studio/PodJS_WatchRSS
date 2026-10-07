import {expect,test} from 'bun:test';
import {DouyinQrLoadTelemetry} from '../../src/telemetry/qr-load.ts';
test('login panel starts timing; verification and QR before panel do not count; once flag survives re-entry',()=>{
 let now=100;const reported:number[]=[];const session=new DouyinQrLoadTelemetry(v=>reported.push(v),()=>now);
 const qr={type:'qr',kind:'login',imageBase64:'private',mime:'image/png'} as const;
 session.status(qr);session.status({type:'pageState',loading:false,loginPanelVisible:true});now=300;
 session.status({...qr,kind:'secondVerify'});expect(reported).toEqual([]);session.status(qr);session.status({type:'qrCleared'});session.status(qr);expect(reported).toEqual([200]);
});
test('production constructor does not need an injected clock',()=>{let reported=0;const session=new DouyinQrLoadTelemetry(()=>reported++);session.status({type:'pageState',loading:false,loginPanelVisible:true});session.status({type:'qr',kind:'login',imageBase64:'x',mime:'image/png'});expect(reported).toBe(1);});
