import {orderLegacyChapters} from '../books/legacy-order.ts';
import type {Article} from '../ui/service.ts';

export interface NovelChapter extends Article {readingPositionChangedAt:number}
const sourcePattern=/^(https:\/\/watchrss\.local\/import-(?:epub|txt-novel)\/[^/]+)(?:\/chapter\/(\d+)(?:-[^/]+)?)?$/i;
/** A source URL and its chapter URLs share one directory identity. */
export function novelBookSource(url:string|null|undefined):string|undefined {
 return sourcePattern.exec(url?.trim()??'')?.[1];
}
export function isNovelChapter(url:string|null|undefined):boolean {
 return !!sourcePattern.exec(url?.trim()??'')?.[2];
}
export async function orderedNovelChapters(chapters:readonly NovelChapter[],source:string,yieldTurn:()=>Promise<void>){
 return (await orderLegacyChapters(chapters.filter(chapter=>isNovelChapter(chapter.link)&&novelBookSource(chapter.link)===source),undefined,{yieldTurn})).rows;
}
export function novelResumeChapter(chapters:readonly NovelChapter[]):NovelChapter|undefined {
 let selected=chapters[0],clock=0;
 for(const chapter of chapters)if(chapter.readingPositionChangedAt>clock){selected=chapter;clock=chapter.readingPositionChangedAt;}
 return selected;
}
export function novelNavigation(chapters:readonly NovelChapter[],id:string){
 const index=chapters.findIndex(chapter=>chapter.id===id);
 return index<0?undefined:{previous:chapters[index-1],next:chapters[index+1]};
}
/** Side thirds turn one viewport; the middle keeps normal article interaction. */
export function novelPageDirection(x:number,width:number):number {
 return width>0&&x>=0&&x<=width?(x<width/3?-1:x>width*2/3?1:0):0;
}
export function novelMenuAppearance(idleFor:number,moving:boolean){
 return {visible:!moving&&idleFor>=350,opacity:idleFor>=1850?.22:1};
}

interface DirectoryDatabase {query(sql:string,params:unknown[],label?:string):Promise<Record<string,unknown>[]>}
export async function readNovelDirectory(db:DirectoryDatabase,source:string,yieldTurn:()=>Promise<void>){
 if(novelBookSource(source)!==source)return [];
 const prefix=source+'/chapter/';
 const rows=await db.query(`SELECT a.id,a.channel_id,a.title,a.link,a.is_read,COALESCE(r.changed_at,0) reading_clock
   FROM articles a LEFT JOIN article_reading_state r ON r.article_id=a.id
   WHERE substr(a.link,1,?)=?`,[prefix.length,prefix],"reader.novelDirectory");
 return orderedNovelChapters(rows.map(row=>({id:String(row.id),channelId:String(row.channel_id),title:String(row.title),link:String(row.link),content:'',read:!!Number(row.is_read),readingPositionChangedAt:Number(row.reading_clock)})),source,yieldTurn);
}
/** A failed progress write must never navigate to a different chapter. */
export async function openNovelChapterAfterSave(reader:{pause():void;scroller:{stop():void};flushProgress():Promise<void>},chapter:NovelChapter,open:(chapter:NovelChapter)=>Promise<void>,active:()=>boolean){
 reader.pause();reader.scroller.stop();await reader.flushProgress();if(active())await open(chapter);
}
