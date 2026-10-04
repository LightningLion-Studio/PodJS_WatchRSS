import {delay,displayPower} from '@podjs/framework/services';
import {hasCapability} from '@podjs/framework/watch';
import {ReaderPreviewSession} from './preview-session.ts';
export const readerPreviewSession=new ReaderPreviewSession({now:()=>Date.now(),monotonic:()=>globalThis.performance?.now?.()??Date.now(),after(ms,callback){let cancelled=false;const task=delay(ms);void task.result.then(()=>{if(!cancelled)callback();},()=>{});return()=>{cancelled=true;task.cancel();};}});
let openRevision=0;const openListeners=new Set<()=>void>();
export function readerPreviewOpenRevision(){return openRevision;}
export function requestReaderPreviewOpen(){openRevision++;for(const listener of openListeners)listener();}
export function onReaderPreviewOpen(listener:()=>void){openListeners.add(listener);return()=>{openListeners.delete(listener);};}
let screenQueue:Promise<unknown>=Promise.resolve();
export function setReaderPreviewVisible(visible:boolean){if(!hasCapability('display.power'))return;screenQueue=screenQueue.catch(()=>{}).then(()=>displayPower.keepAwake('reader-preview',visible));void screenQueue.catch(error=>console.warn('Reader preview display',String(error)));}
export async function disposeReaderPreview(){readerPreviewSession.dispose();setReaderPreviewVisible(false);await screenQueue.catch(()=>{});openListeners.clear();}
