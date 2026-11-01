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

test('DYLOGIN closes error vocabulary without leaking vendor messages or invalid code types',async()=>{
 const {loginError,douyinLoginFailureCode}=await import('../src/ui/douyin/login-state.ts');
 for(const error of [null,undefined,{code:123},{code:'sessionid=PRIVATE'},new Error('PRIVATE')]){
  expect(loginError(error).message).toBe('加载失败，请重试');expect(douyinLoginFailureCode(error)).toBe('browser_auth_failed');
 }
 for(const code of ['browser_qr_timeout','browser_auth_timeout','browser_script_error','webview_renderer_gone','webview_http_403']){
  expect(loginError({code}).message).toContain('重试登录');expect(douyinLoginFailureCode({code})).toBe(code);
 }
});
