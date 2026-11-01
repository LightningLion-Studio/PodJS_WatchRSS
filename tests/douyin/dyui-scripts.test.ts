import {expect,test} from 'bun:test';
import {createRequire} from 'node:module';
import {DOUYIN_AUTH_STATUS_SCRIPT} from '@podjs/framework/services';
import {DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT} from '../../src/media/douyin-login.ts';
const require=createRequire(import.meta.url);
const evaluate=(script:string,document:unknown)=>new Function('document','return '+script.trim())(document);
const image=(mime='png')=>({tagName:'IMG',getAttribute:(k:string)=>k==='src'?`data:image/${mime};base64,AAAA`:k==='aria-label'?'二维码':null});
function documentFixture(phase:'loading'|'panel'|'verify'|'gone'|'throw',mime='png'){
 return {readyState:phase==='loading'?'loading':'complete',getElementById:()=>{if(phase==='throw')throw Error('detached DOM fixture');return phase==='verify'?{tagName:'DIV'}:null;},querySelector:()=>phase==='panel'?{}:null,querySelectorAll:(selector:string)=>selector==='div'?[]:phase==='gone'?[]:[image(mime)]};
}
test('DYUI extraction scripts parse as ES2018, before Chromium 83; no new syntax is required',()=>{
 const acorn=require('acorn');
 for(const script of [DOUYIN_AUTH_STATUS_SCRIPT,DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT])expect(()=>acorn.parse(script,{ecmaVersion:2018})).not.toThrow();
});
test('DYUI page transitions and transient DOM exceptions remain retryable snapshots',()=>{
 expect(evaluate(DOUYIN_AUTH_STATUS_SCRIPT,documentFixture('throw'))).toEqual({scriptError:true});
 expect(evaluate(DOUYIN_LOGIN_QR_EXTRACTION_SCRIPT,documentFixture('throw'))).toBeNull();
 expect(evaluate(DOUYIN_AUTH_STATUS_SCRIPT,documentFixture('loading')).loading).toBe(true);
 expect(evaluate(DOUYIN_AUTH_STATUS_SCRIPT,documentFixture('panel')).qr).toMatchObject({kind:'login'});
 expect(evaluate(DOUYIN_AUTH_STATUS_SCRIPT,documentFixture('verify'))).toMatchObject({verifying:true,qr:null});
 expect(evaluate(DOUYIN_AUTH_STATUS_SCRIPT,documentFixture('gone'))).toMatchObject({loading:false,loginPanelVisible:false,qr:null});
 expect(evaluate(DOUYIN_AUTH_STATUS_SCRIPT,documentFixture('panel','jpeg')).qr).toMatchObject({kind:'secondVerify'});
});
