export interface ScrollRow {top:number;height:number}
export interface ScrollSnapshot {version:1;offset:number;anchor:{index:number;offset:number}|null}
export function validScrollSnapshot(value:unknown):value is ScrollSnapshot {
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const v=value as ScrollSnapshot,a=v.anchor;
 return v.version===1&&Number.isFinite(v.offset)&&v.offset>=0&&(a===null||!!a&&Number.isSafeInteger(a.index)&&a.index>=0&&Number.isFinite(a.offset)&&a.offset>=0);
}
function anchorAt(offset:number,rows:readonly ScrollRow[]):ScrollSnapshot['anchor'] {
 if(!rows.length)return null;
 const padding=rows[0]!.top;
 let index=rows.findIndex(row=>row.top-padding+row.height>offset);
 if(index<0)index=rows.length-1;
 return {index,offset:Math.max(0,offset-(rows[index]!.top-padding))};
}
/** Keep a saved item anchor as late rows/layouts change, until user input or an
 * explicit scroll command takes ownership. Legacy absolute offsets still work. */
export class ScrollRestoration {
 private previousMax=-1;
 private previousRows:readonly ScrollRow[]|undefined;
 constructor(private pending:number|ScrollSnapshot|undefined){}
 target(max:number,rows?:readonly ScrollRow[]):number|undefined {
  if(this.pending===undefined||!Number.isFinite(max)||max<0||(max===this.previousMax&&rows===this.previousRows))return;
  this.previousMax=max;this.previousRows=rows;
  if(typeof this.pending==='number'){
   const value=Math.min(max,this.pending);
   if(max>=this.pending)this.pending=undefined;
   return value;
  }
  const anchor=this.pending.anchor;
  if(anchor&&rows?.length){
   const row=rows[anchor.index];
   // A placeholder or short first page must not consume an unavailable item.
   return row?Math.min(max,Math.max(0,row.top-rows[0]!.top+anchor.offset)):max;
  }
  return Math.min(max,this.pending.offset);
 }
 cancel(){this.pending=undefined;}
 snapshot(offset:number):number|ScrollSnapshot;
 snapshot(offset:number,rows:readonly ScrollRow[]):ScrollSnapshot;
 snapshot(offset:number,rows?:readonly ScrollRow[]):number|ScrollSnapshot {
  if(rows)return typeof this.pending==='object'?this.pending:{version:1,offset:typeof this.pending==='number'?this.pending:Math.max(0,offset),anchor:typeof this.pending==='number'?null:anchorAt(offset,rows)};
  return this.pending??Math.max(0,offset);
 }
}
