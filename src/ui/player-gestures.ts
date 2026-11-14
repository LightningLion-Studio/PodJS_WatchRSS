import type {GestureContact,GestureOptions} from '@pocketjs/framework/gesture';
export interface PlayerViewport {x:number;y:number;w:number;h:number}
export function rotateVector(x:number,y:number,degrees:number):{x:number;y:number}{
 const angle=((degrees%360)+360)%360;
 if(angle===0)return{x,y};if(angle===90)return{x:-y,y:x};if(angle===180)return{x:-x,y:-y};if(angle===270)return{x:y,y:-x};
 const radians=angle*Math.PI/180,c=Math.cos(radians),s=Math.sin(radians);return{x:x*c-y*s,y:x*s+y*c};
}
/** Inverse of the player's clockwise render transform, about the viewport centre.
 * Positions use the picture's origin (also for edge tests); vectors have no origin.
 * Zero degrees returns the original contact to keep the legacy path exact. */
export function playerCoordinates<T extends GestureContact>(contact:T,degrees:number,viewport:PlayerViewport):T {
 if(degrees%360===0)return contact;
 const quarter=Math.round(degrees/90),swapped=Math.abs(quarter%2)===1;
 const width=swapped?viewport.h:viewport.w,height=swapped?viewport.w:viewport.h;
 const point=(x:number,y:number)=>{const p=rotateVector(x-viewport.x-viewport.w/2,y-viewport.y-viewport.h/2,-degrees);return{x:p.x+width/2,y:p.y+height/2};};
 const p=point(contact.x,contact.y),start=point(contact.startX,contact.startY),d=rotateVector(contact.dx,contact.dy,-degrees),f=rotateVector(contact.fdx,contact.fdy,-degrees),v=rotateVector(contact.vx,contact.vy,-degrees);
 return {...contact,x:p.x,y:p.y,startX:start.x,startY:start.y,dx:d.x,dy:d.y,fdx:f.x,fdy:f.y,vx:v.x,vy:v.y};
}

/** Rotate the recognizer's axis BEFORE the framework arbitrates ownership.
 * Sample the same display angle used by rendering at down, and retain it until
 * release (paging can replace the source and reset its render angle mid-drag).
 * Tap hit tests stay in screen coordinates. The unrotated detail panel does not
 * use this adapter. Axis locks follow the nearest rendered quarter during tweening. */
export function playerGesture(options:GestureOptions,rotation:()=>number,viewport:()=>PlayerViewport):GestureOptions {
 let degrees:number|undefined;
 const angle=()=>degrees??rotation();
 const convert=(c:GestureContact)=>playerCoordinates(c,angle(),viewport());
 const result:GestureOptions={...options,get axis(){const axis=options.axis;if(axis!=='x'&&axis!=='y')return axis;return Math.abs(Math.round(angle()/90)%2)===1?(axis==='x'?'y':'x'):axis;},
  onDown(c){degrees=rotation();options.onDown?.(convert(c));},
 };
 for(const key of ['onMove','onUp','onCancel','onPanStart','onPanMove','onPanEnd'] as const){
  const handler=options[key];if(handler)result[key]=c=>handler(convert(c));
 }
 return result;
}
