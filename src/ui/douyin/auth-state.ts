import {createSignal,onCleanup} from 'solid-js';
import type {DouyinClient} from '../../douyin/client.ts';

/** The client owns authentication across routes; no screen keeps a second boolean. */
export function observeDouyinAuth(client:DouyinClient,onError:(error:unknown)=>void=()=>{}) {
 const [state,setState]=createSignal(client.authState());
 onCleanup(client.subscribeAuth(setState));
 if(state()==='unknown')void client.isLoggedIn().catch(onError);
 return state;
}
