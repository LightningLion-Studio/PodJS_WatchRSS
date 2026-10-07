import {CrownVolumeController as Controller,applyCrownVolumeGuard as applyGuard,scaledCrownVolumeDelta as scaledDelta,type CrownVolumeProfile} from '@podjs/framework/media-volume';
import type {MediaVolumePort} from './start-volume.ts';
import type {CrownGuardState,CrownVolumeDisplay,VolumeClock} from '@podjs/framework/media-volume';
export {emptyCrownGuard} from '@podjs/framework/media-volume';
export type {CrownGuardState,CrownVolumeDisplay,VolumeClock} from '@podjs/framework/media-volume';
const profile:CrownVolumeProfile={sessionGapMs:600,capFraction:.21,rawScale:.01,rangeScale:.06,hideMs:1200};
export function applyCrownVolumeGuard(current:number,delta:number,min:number,max:number,enabled:boolean,previous:CrownGuardState,eventMs:number){
 return applyGuard(current,delta,min,max,enabled,previous,eventMs,profile);
}
export function scaledCrownVolumeDelta(raw:number,min:number,max:number):number{return scaledDelta(raw,min,max,profile);}
export class CrownVolumeController extends Controller {
 constructor(port:MediaVolumePort,clock:VolumeClock,changed:(state:CrownVolumeDisplay)=>void,notify:()=>void,failed:(error:unknown)=>void=()=>{}){super(port,clock,changed,notify,failed,profile);}
}
