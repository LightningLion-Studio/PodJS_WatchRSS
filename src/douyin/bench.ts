import {benchmark,type BenchmarkCode} from '@podjs/framework/benchmark';

export interface DouyinAuthAttempt {seq:number;attempt:number;entered:boolean;}
interface Owner {login?:DouyinAuthAttempt;logout?:number;postLogout:boolean;}
const owners=new WeakMap<object,Owner>();let attempts=0;
const owner=(key:object)=>{let value=owners.get(key);if(!value){value={postLogout:false};owners.set(key,value);}return value;};
const nextAttempt=()=>attempts<2_147_483_647?++attempts:0;
const authFields=(action:DouyinAuthAttempt)=>({attempt:action.attempt});
type CancelPort=typeof benchmark&{cancelPresented?:(code:BenchmarkCode,seq:number)=>void};
/** Presentation is fail-closed until the shared renderer/cancellation bridge is linked. */
function present(code:BenchmarkCode,seq:number){
 if(typeof (benchmark as CancelPort).cancelPresented!=='function')return;
 benchmark.presented(code,seq);
}
export const douyinBench={
 entry:(key:object)=>{const value=owner(key);if(value.logout)(benchmark as CancelPort).cancelPresented?.('logout_feedback',value.logout);value.logout=undefined;return benchmark.begin('entry_start');},
 presentEntry:(key:object,seq:number,code:'needs_login'|'refreshing')=>{if(code==='needs_login'||owner(key).postLogout)present(code,seq);},
 cancelPresented:(code:BenchmarkCode,seq:number)=>(benchmark as CancelPort).cancelPresented?.(code,seq),
 loginTap(key:object,state:()=>boolean|undefined,navigate:()=>void){
  const before=state();if(before===undefined)return;
  const attempt=nextAttempt(),seq=benchmark.begin('auth_state',{attempt,state:before?'present':'absent'});
  const action={seq,attempt,entered:false};const value=owner(key);if(value.logout)(benchmark as CancelPort).cancelPresented?.('logout_feedback',value.logout);value.logout=undefined;value.login=action;
  benchmark.mark('login_tap',seq,{attempt});
  try{navigate();}finally{const after=state();if(after!==undefined)benchmark.mark('auth_state',seq,{attempt,state:after?'present':'absent'});}
 },
 loginEntry(key:object,retry=false):DouyinAuthAttempt{
  const state=owner(key);if(state.logout)(benchmark as CancelPort).cancelPresented?.('logout_feedback',state.logout);state.logout=undefined;let action=state.login;
  if(retry||!action||action.entered){const attempt=nextAttempt();action={seq:benchmark.begin('login_entry',{attempt}),attempt,entered:true};}
  else{action.entered=true;benchmark.mark('login_entry',action.seq,authFields(action));}
  state.login=action;return action;
 },
 attempt:(key:object)=>owner(key).login,
 leaveLogin(key:object,action:DouyinAuthAttempt){if(owner(key).login===action)owner(key).login=undefined;},
 persisted(key:object,action:DouyinAuthAttempt){owner(key).postLogout=false;owner(key).logout=undefined;benchmark.mark('auth_persisted',action.seq,authFields(action));},
 error:(action:DouyinAuthAttempt)=>benchmark.mark('error',action.seq,authFields(action)),
 logoutStart(key:object){const value=owner(key);value.postLogout=true;value.logout=benchmark.begin('logout_start');return value.logout;},
 logoutFeedback(key:object){const seq=owner(key).logout;if(seq)present('logout_feedback',seq);},
 cancelLogoutFeedback(key:object){const seq=owner(key).logout;if(seq)(benchmark as CancelPort).cancelPresented?.('logout_feedback',seq);},
 authClear(key:object):{seq:number;attempt?:number}|undefined{
  const value=owner(key);if(value.logout)return {seq:value.logout};
  const action=value.login;return action&&action.seq>0?{seq:action.seq,attempt:action.attempt}:undefined;
 },
};
