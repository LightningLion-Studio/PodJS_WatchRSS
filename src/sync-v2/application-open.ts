import {openApplicationSyncV2Core} from './application-core';
import {WatchSyncV2UiState} from './ui-state';
export {receiveApplicationIdentity,productError} from './application-core';
export type {ApplicationSyncV2Account} from './application-core';
/** Foreground UI is assembled separately from the headless business runtime. */
export function openApplicationSyncV2(options:Omit<Parameters<typeof openApplicationSyncV2Core>[0],'createUi'>){
 return openApplicationSyncV2Core({...options,createUi:ports=>new WatchSyncV2UiState(ports)});
}
