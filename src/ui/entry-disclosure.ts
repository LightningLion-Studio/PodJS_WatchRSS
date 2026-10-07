import {createSignal} from 'solid-js';
import {kv} from '@podjs/framework/watch';
import {createPlatformNoticeRoute,type PlatformNoticeTarget} from '../announcement/platform.ts';
import type {DisclosureStorage} from '@podjs/framework/disclosure';

export type DisclosureCopy={title:string;paragraphs:readonly string[];confirm:string};
export interface EntryDisclosure {pending(homeNoticeVisible?:boolean):DisclosureCopy|undefined;confirm():void}

/** One disclosure session per owner (route entry), like native per-Activity `remember`. */
const sessions=new WeakMap<object,EntryDisclosure>();
export function entryDisclosure(owner:object,target:PlatformNoticeTarget,storage:DisclosureStorage=kv):EntryDisclosure {
 const existing=sessions.get(owner);
 if(existing)return existing;
 const route=createPlatformNoticeRoute(storage,target),[version,setVersion]=createSignal(0);
 const session:EntryDisclosure={
  pending:(homeNoticeVisible=false)=>(version(),route.pending(homeNoticeVisible)),
  confirm:()=>{route.acknowledge();setVersion(value=>value+1);},
 };
 sessions.set(owner,session);
 return session;
}
