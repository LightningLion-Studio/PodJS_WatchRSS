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
 * use this adapter. During a tween, gate ownership and slop in picture axes,
 * rather than rounding the recognizer to a neighbouring screen axis. */
export function playerGesture(options:GestureOptions,rotation:()=>number,viewport:()=>PlayerViewport):GestureOptions {
 const contacts=new Map<number,{degrees:number;viewport:PlayerViewport;panning:boolean}>();
 let active:number|undefined,screenTravel=0,pictureTravel=0,crossTravel=0;
 const angle=()=>active===undefined?rotation():contacts.get(active)?.degrees??rotation();
 const convert=(c:GestureContact)=>{const state=contacts.get(c.id);return playerCoordinates(c,state?.degrees??rotation(),state?.viewport??viewport());};
 const observe=(c:GestureContact)=>{
  active=c.id;const local=convert(c),horizontal=options.axis==='x';
  screenTravel=Math.max(Math.abs(c.dx),Math.abs(c.dy));
  pictureTravel=Math.abs(horizontal?local.dx:local.dy);crossTravel=Math.abs(horizontal?local.dy:local.dx);
  return local;
 };
 const release=(c:GestureContact)=>{contacts.delete(c.id);if(active===c.id)active=undefined;};
 const result:GestureOptions={...options,
  get axis(){const axis=options.axis;if(axis!=='x'&&axis!=='y')return axis;const degrees=angle();if(degrees%90!==0)return 'any';return Math.abs(Math.round(degrees/90)%2)===1?(axis==='x'?'y':'x'):axis;},
  get panSlop(){
   if(active===undefined||angle()%90===0||(options.axis!=='x'&&options.axis!=='y'))return options.panSlop;
   // Trigonometry must not break the recognizer's registration-order tie.
   if(pictureTravel===0||pictureTravel+1e-9<crossTravel)return Infinity;
   // The framework consumes slop along max(screen dx,dy) for axis:any.
   // Player recognizers specify panSlop, so scale it to consume the same
   // number of picture pixels and preserve the first frame's fdx/fdy.
   return options.panSlop===undefined?undefined:options.panSlop*screenTravel/pictureTravel;
  },
  onDown(c){contacts.set(c.id,{degrees:rotation(),viewport:{...viewport()},panning:false});const local=observe(c);options.onDown?.(local);},
  onMove(c){const local=observe(c);options.onMove?.(local);},
  onUp(c){try{options.onUp?.(observe(c));}finally{if(!contacts.get(c.id)?.panning)release(c);}},
  onCancel(c){try{options.onCancel?.(observe(c));}finally{release(c);}},
 };
 if(options.onPanStart||options.onPanMove||options.onPanEnd){
  result.onPanStart=c=>{const state=contacts.get(c.id);if(state)state.panning=true;options.onPanStart?.(observe(c));};
  if(options.onPanMove)result.onPanMove=c=>options.onPanMove!(observe(c));
  // The framework delivers onUp before onPanEnd. Keep the angle through both.
  result.onPanEnd=c=>{try{options.onPanEnd?.(observe(c));}finally{release(c);}};
 }
 return result;
}
