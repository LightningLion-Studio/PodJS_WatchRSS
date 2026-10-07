import {expect,test} from 'bun:test';
import {initialLoginStatus,updateLoginStatus,finishLoginStatus,loginQrWaitStatus,DOUYIN_QR_WAIT} from '../src/ui/douyin/login-state.ts';
test('native QR wait ignores page loading, follows QR and verification, and stops at error/success/cancel',()=>{
 let state=initialLoginStatus();expect(loginQrWaitStatus(state)).toEqual({visible:true,message:DOUYIN_QR_WAIT.message});
 state=updateLoginStatus(state,{type:'pageState',loading:false,loginPanelVisible:false});expect(loginQrWaitStatus(state).visible).toBe(true);
 state=updateLoginStatus(state,{type:'qr',kind:'login',mime:'image/png',imageBase64:'AAAA'});expect(loginQrWaitStatus(state).visible).toBe(false);
 state=updateLoginStatus(state,{type:'qrCleared'});expect(loginQrWaitStatus(state).visible).toBe(true);
 state=updateLoginStatus(state,{type:'verifying',active:true});expect(loginQrWaitStatus(state).visible).toBe(false);
 state=updateLoginStatus(state,{type:'qrCleared'});expect(loginQrWaitStatus(state).visible).toBe(false);
 state=updateLoginStatus(state,{type:'verifying',active:false});expect(loginQrWaitStatus(state).visible).toBe(true);
 for(const ended of [finishLoginStatus(state),updateLoginStatus(state,{type:'cancelled'})]){
  expect(loginQrWaitStatus(ended).visible).toBe(false);expect(updateLoginStatus(ended,{type:'qrCleared'})).toBe(ended);
 }
});
