import type {GestureContact,GestureOptions,GestureRegion} from '@pocketjs/framework/gesture';

/** Observe only rightward Back. Do not claim the opposite direction: a player
 * detail recognizer can own it regardless of registration order. A competing
 * progress drag, vertical page or long press cancels this observer normally. */
export function rightSwipeBack(region:GestureRegion,handlers:{
 start(dx:number):void;move(dx:number):void;end(velocity:number):void;cancel():void;
}):GestureOptions {
 let contact:number|undefined,dragging=false;
 const cancel=()=>{if(dragging)handlers.cancel();dragging=false;contact=undefined;};
 return {
  region,
  onDown(c){if(contact===undefined)contact=c.id;else cancel();},
  onMove(c:GestureContact){
   if(c.id!==contact)return;
   if(!dragging){if(c.dx<=8||c.dx<Math.abs(c.dy))return;dragging=true;handlers.start(c.dx);}
   handlers.move(c.dx);
  },
  onUp(c){if(c.id!==contact)return;if(dragging)handlers.end(c.vx);dragging=false;contact=undefined;},
  onCancel(c){if(c.id===contact)cancel();},
 };
}
