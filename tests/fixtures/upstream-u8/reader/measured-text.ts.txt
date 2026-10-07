import { layoutUiText as layoutText } from "./line-break.ts";
import {lazyRegExpTest} from "../core/lazy-regexp.ts";

export type TextMeasurer = (text:string)=>number;
/** Truncate only after wrapping with the same font provider used to paint. */
export function measuredLines(text:string,width:number,measure:TextMeasurer,maxLines=Infinity,firstIndent=0):string[] {
  let all:string[];
  if(firstIndent>0){
    const first=layoutText(text,{width:Math.max(1,width-firstIndent),measure})[0]??"";
    const rest=text.replace(/\r\n?/g,"\n").slice(first.length);
    all=[first,...(rest.length?layoutText(rest.startsWith("\n")?rest.slice(1):rest,{width:Math.max(1,width),measure}):[])];
  } else all=layoutText(text,{width:Math.max(1,width),measure});
  if(all.length<=maxLines)return all;
  const result=all.slice(0,Math.max(1,maxLines));
  const last=Array.from(result[result.length-1]);
  while(last.length && measure(last.join("")+"…")>width-(result.length===1?firstIndent:0))last.pop();
  result[result.length-1]=last.join("")+"…";
  return result;
}
const cjk=lazyRegExpTest('[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}]','u');
const mostlyCjk=(text:string)=>{const chars=Array.from(text.replace(/\s/g,""));const count=chars.filter(cjk).length;return count>=4&&count*2>=chars.length;};
export function normalizeWatchTitle(title:string):string {
  const normalized=title.replace(/\s+/g," ").trim();
  if(!mostlyCjk(normalized))return normalized;
  return normalized.replace(/ /g,(_space,offset:number)=>/[\w\-/]/.test(normalized[offset-1]??"")&&/[\w\-/]/.test(normalized[offset+1]??"")?" ":"");
}
/** Android WatchTitleFormatting first-line/other-line limits and orphan balancing. */
export function* watchTitleMeasurements(title:string,width:number,firstWidth=150,otherWidth=190,protectedSuffix?:string,minPrefixCharsBeforeSuffix=0):Generator<string,string[],number> {
  const chars=Array.from(normalizeWatchTitle(title)), result:string[]=[];
  const limits=[Math.max(1,Math.min(width,firstWidth)),Math.max(1,Math.min(width,otherWidth))];
  for(let start=0;start<chars.length;){
    const limit=limits[result.length?1:0];
    let low=start,high=chars.length;
    while(low<high){const mid=Math.floor((low+high+1)/2);if((yield chars.slice(start,mid).join(""))<=limit)low=mid;else high=mid-1;}
    const end=Math.max(start+1,low);result.push(chars.slice(start,end).join(""));start=end;
  }
  for(let index=1;index<result.length;index++){
    if(Array.from(result[index]).length!==1)continue;
    const prev=result[index-1],limit=limits[index===1?0:1];
    if((yield prev+result[index])<=limit){result[index-1]+=result[index];result.splice(index,1);index--;continue;}
    const prefix=Array.from(prev);
    if(prefix.length>1){const last=prefix.pop()!;if((yield last+result[index])<=limits[1]){result[index-1]=prefix.join("");result[index]=last+result[index];if(index>1)index-=2;}}
  }
  // Native balanceProtectedSuffixLines: keep at least N visible title chars before the hint.
  const normalized=normalizeWatchTitle(title),last=result.length-1;
  if(protectedSuffix&&minPrefixCharsBeforeSuffix>1&&result.length>=2&&mostlyCjk(normalized.slice(0,normalized.length-protectedSuffix.length))&&result[last].endsWith(protectedSuffix)){
    const visible=(line:string)=>Array.from(line.slice(0,line.length-protectedSuffix.length).trimEnd()).filter(ch=>!/\s/.test(ch)).length;
    while(visible(result[last])<minPrefixCharsBeforeSuffix){
      const prev=Array.from(result[last-1]);if(prev.length<=1)break;
      const shifted=prev[prev.length-1]+result[last];
      if((yield shifted)>limits[last===0?0:1])break;
      prev.pop();result[last-1]=prev.join("");result[last]=shifted;
    }
  }
  return result.length?result:[""];
}

export function watchTitleLines(title:string,width:number,measure:TextMeasurer,firstWidth=150,otherWidth=190,protectedSuffix?:string,minPrefixCharsBeforeSuffix=0):string[] {
 const plan=watchTitleMeasurements(title,width,firstWidth,otherWidth,protectedSuffix,minPrefixCharsBeforeSuffix);let step=plan.next();
 while(!step.done)step=plan.next(measure(step.value));return step.value;
}
