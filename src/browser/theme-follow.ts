import type {BrowserOpenOptions} from '@podjs/framework/services';
export type BrowserTheme=NonNullable<BrowserOpenOptions['theme']>;
export interface BrowserThemeFollowerPort {
 read():BrowserTheme;
 update(theme:BrowserTheme):Promise<{updated:boolean}>;
 subscribe(listener:()=>void):()=>void;
 schedule(listener:()=>void):()=>void;
}
/** One serialized updater per owned browser, no rendering or repeated document loads. */
export function followBrowserTheme(port:BrowserThemeFollowerPort):()=>void {
 let stopped=false,running=false,dirty=false,probe=false,previous='',cancelTimer=()=>{};
 const stop=()=>{if(stopped)return;stopped=true;unsubscribe();cancelTimer();};
 const refresh=()=>{dirty=true;if(!running)void drain();};
 const drain=async()=>{running=true;try{while(dirty&&!stopped){dirty=false;const theme=port.read(),key=JSON.stringify(theme);if(key!==previous||probe){probe=false;const result=await port.update(theme);if(!result.updated){stop();break;}previous=key;}}}catch{stop();}finally{running=false;}};
 const unsubscribe=port.subscribe(refresh);
 const tick=()=>{if(stopped)return;probe=true;refresh();if(!stopped)cancelTimer=port.schedule(tick);};
 cancelTimer=port.schedule(tick);refresh();return stop;
}
