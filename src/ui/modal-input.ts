import {mergeProps} from 'solid-js';
import {useRestorableInput} from '@podjs/framework/restorable-input';
import {routeActivity} from './route-activity.tsx';
import {routeMemory} from '../navigation/activity-navigation.ts';
import type {ModalInput,ModalInputRecovery} from './service.ts';

/** Reissue the user-owned prompt against its new guest lifetime. The host keeps
 * text/selection in retained state; this owner supplies the new continuation.
 * Never replay a submit, repository write or credential action on mount. */
export function modalInputKey(name:string):string|undefined {
 const owner=routeActivity();return owner?`watchrss:${routeMemory(owner.entry).id}:${name}`:undefined;
}
export function useModalInput(options:{key:string;title:string;value:()=>string;input?:ModalInput;recovery?:ModalInputRecovery;active:()=>boolean;onValue:(value:string)=>void|Promise<void>;onError:(error:unknown)=>void}) {
 return useRestorableInput(mergeProps(options,{key:modalInputKey(options.key),missingInputMessage:'当前运行时未接入文字输入'}));
}
