import type { MemoNote } from './types.ts';

const MINUTE=60_000, HOUR=60*MINUTE, DAY=24*HOUR, WEEK=7*DAY;
// Kotlin Char.isWhitespace, counted over UTF-16 code units as in NotesActivity.
const KOTLIN_WHITESPACE=/[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/g;

export function noteCharacterCount(plainText:string):number {
  return plainText.replace(KOTLIN_WHITESPACE,'').length;
}

const localDay=(date:Date)=>Date.UTC(date.getFullYear(),date.getMonth(),date.getDate())/DAY;

/** Android 11 DateUtils FORMAT_ABBREV_RELATIVE wording for the zh-CN watch locale. */
export function noteRelativeTime(timestamp:number,now=Date.now()):string {
  const delta=Math.abs(now-timestamp),future=timestamp>now;
  if(delta<MINUTE)return future?'0分钟后':'0分钟前';
  if(delta<HOUR){const n=Math.floor(delta/MINUTE);return future?`${n}分钟后`:`${n}分钟前`;}
  if(delta<DAY){const n=Math.floor(delta/HOUR);return future?`${n}小时后`:`${n}小时前`;}
  if(delta<WEEK){
    const days=Math.max(1,Math.abs(localDay(new Date(timestamp))-localDay(new Date(now))));
    if(days===1)return future?'明天':'昨天';
    if(days===2)return future?'后天':'前天';
    return future?`${days}天后`:`${days}天前`;
  }
  const date=new Date(timestamp),today=new Date(now),month=date.getMonth()+1,day=date.getDate();
  return date.getFullYear()===today.getFullYear()?`${month}月${day}日`:`${date.getFullYear()}年${month}月${day}日`;
}

export function noteMetadata(note:Pick<MemoNote,'updatedAt'|'plainText'>,now=Date.now()):string {
  return `${noteRelativeTime(note.updatedAt,now)} · ${noteCharacterCount(note.plainText)} 字`;
}
