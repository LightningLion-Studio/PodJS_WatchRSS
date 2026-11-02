import type {RequestLifetime} from '../cloud/types.ts';
/** Explicit per-request lifetime; foreground requests never inherit this state. */
export function backgroundMediaWork():RequestLifetime&{cancel():void} {
 let active=true;const listeners=new Set<()=>void>();
 return {isCurrent:()=>active,onCancel(fn){if(!active){fn();return()=>{};}listeners.add(fn);return()=>{listeners.delete(fn);};},cancel(){if(!active)return;active=false;for(const fn of listeners)fn();listeners.clear();}};
}
export function backgroundResult<T>(operation:{result:Promise<T>;cancel():void},work?:RequestLifetime):Promise<T> {
 const off=work?.onCancel(()=>operation.cancel());
 return operation.result.finally(()=>off?.());
}
