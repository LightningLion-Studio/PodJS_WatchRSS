import data from './title-unicode-data.json';
// Unicode 17.0.0: L/N, M, Han, GCB, Extended_Pictographic and InCB.
function decode(value:string):number[]{
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',out:number[]=[];let bits=0,n=0;
 for(const c of value){const v=alphabet.indexOf(c);if(v<0)continue;bits=bits<<6|v;n+=6;if(n>=8){n-=8;out.push(bits>>>n&255);}}
 return out;
}
const bytes=decode(data.encodedRanges),ranges:number[]=[];
let pos=0,cursor=128;
function variable(){let value=0,shift=0,b;do{b=bytes[pos++];value|=(b&127)<<shift;shift+=7;}while(b&128);return value;}
while(pos<bytes.length){const start=cursor+variable(),end=start+variable(),value=variable();ranges.push(start,end,value);cursor=end+1;}
export function titleProperties(cp:number):number{
 if(cp<128)return cp>=48&&cp<=57||cp>=65&&cp<=90||cp>=97&&cp<=122?1:cp===13?8:cp===10?16:cp<32||cp===127?24:0;
 let lo=0,hi=ranges.length/3-1,value=0;
 while(lo<=hi){const mid=(lo+hi)>>>1,i=mid*3;if(cp<ranges[i])hi=mid-1;else if(cp>ranges[i+1])lo=mid+1;else{value=ranges[i+2];break;}}
 if(cp>=0xac00&&cp<=0xd7a3)value=(value&~120)|((cp-0xac00)%28===0?12:13)<<3;
 return value;
}
const gcb=(p:number)=>(p>>>3)&15;
class ClusterState{
 seen=false;previous=0;regional=0;indic=false;linker=false;pict=false;zwjPict=false;
 boundary(next:number):boolean{
  const a=gcb(this.previous),b=gcb(next);
  if(a===1&&b===2)return false;
  if(a>=1&&a<=3||b>=1&&b<=3)return true;
  if(a===9&&[9,10,12,13].includes(b)||[10,12].includes(a)&&[10,11].includes(b)||[11,13].includes(a)&&b===11)return false;
  if(b===4||b===5||b===8||a===7)return false;
  if((next&256)&&this.indic&&this.linker)return false;
  if((next&128)&&a===5&&this.zwjPict)return false;
  if(a===6&&b===6&&this.regional%2)return false;
  return true;
 }
 accept(next:number){
  const b=gcb(next);this.zwjPict=b===5&&this.pict;if(b!==4)this.pict=!!(next&128);
  if(next&256){this.indic=true;this.linker=false;}else if(!(next&1536)){this.indic=false;this.linker=false;}else if(next&512)this.linker=this.linker||this.indic;
  this.regional=b===6?this.regional+1:0;this.previous=next;this.seen=true;
 }
}
/** Include a leading Prepend/Extend sequence if it belongs to the first word. */
export function noteTitleStart(text:string,wanted:number):number{
 const state=new ClusterState();let index=0,start=0;
 for(const c of text){const p=titleProperties(c.codePointAt(0)!);if(state.seen&&state.boundary(p))start=index;if(index>=wanted)return start;state.accept(p);index+=c.length;}
 return start;
}
/** Longest complete extended-grapheme prefix using at most limit code points.
 * wordEnd optionally extends the last selected word to its full source cluster. */
export function truncateNoteTitle(text:string,limit=80,wordEnd=text.length):string{
 if(limit<0)throw RangeError('Negative title limit');
 const state=new ClusterState();let index=0,last=0,count=0;
 for(const c of text){const p=titleProperties(c.codePointAt(0)!);if(state.seen&&state.boundary(p)){if(index>=wordEnd&&count<=limit)return text.slice(0,index);last=index;}if(count===limit)return text.slice(0,last);state.accept(p);index+=c.length;count++;}
 return text;
}
