import {createEffect,onCleanup} from 'solid-js';
import {delay,onNetworkChange} from '@podjs/framework/services';
import {appLogger} from '../logs/app-logger.ts';
import type {DouyinStock} from './stock.ts';

/** UI idle ownership complements the native foreground-media admission gate. */
export function bindDouyinStockIdle(stock:DouyinStock,idle:()=>boolean):void {
 createEffect(()=>{
  if(!idle())return;
  const timer=delay(1500);let active=true;
  const refill=()=>{if(active)void stock.resume().catch(()=>appLogger.w('DouyinStock','refill failed'));};
  void timer.result.then(refill,()=>{});
  const off=onNetworkChange(()=>{stock.suspend();refill();});
  onCleanup(()=>{active=false;timer.cancel();off();stock.suspend();});
 });
}
