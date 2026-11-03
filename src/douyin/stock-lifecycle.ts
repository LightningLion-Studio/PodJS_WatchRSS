import {createEffect,createMemo,onCleanup} from 'solid-js';
import {delay,onNetworkChange} from '@podjs/framework/services';
import {appLogger} from '../logs/app-logger.ts';
import type {DouyinStockService} from './stock.ts';

/** UI idle ownership complements the native foreground-media admission gate. */
export function bindDouyinStockIdle(stock:DouyinStockService,idle:()=>boolean):void {
 // Depend on the semantic idle state, not every channels/status publication.
 const isIdle=createMemo(idle);
 createEffect(()=>{
  if(!isIdle())return;
  const timer=delay(1500);let active=true;
  const refill=()=>{if(active)void stock.resume().catch(()=>appLogger.w('DouyinStock','refill failed'));};
  void timer.result.then(refill,()=>{});
  // Capability/link-property publications do not imply loss of admission.
  const off=onNetworkChange(()=>{if(active)void stock.networkChanged().catch(()=>appLogger.w('DouyinStock','network reconciliation failed'));});
  onCleanup(()=>{active=false;timer.cancel();off();stock.suspend();});
 });
}
