import {titleProperties,truncateNoteTitle,noteTitleStart} from './title-unicode';
// First three Unicode L/N runs, with marks/joiners retained. Long Han-only runs
// use two-code-point words. The rule is independent of Intl/ICU dictionaries.
export function deriveNoteTitle(plainText:string):string{
 const line=plainText.split(/\r\n|\r|\n/).map(s=>s.trim()).find(Boolean);
 if(!line)return '';
 let first=-1,last=0,count=0;
 for(const [from,to] of wordRanges(line)){if(first<0)first=from;last=to;if(++count===3)break;}
 if(first<0)return truncateNoteTitle(line);
 const start=noteTitleStart(line,first);return truncateNoteTitle(line.slice(start),80,last-start);
}
function* wordRanges(line:string):Generator<[number,number]>{
 let start=-1,index=0,count=0,han=true;
 while(index<=line.length){
  const cp=index<line.length?line.codePointAt(index)!:0,p=titleProperties(cp);
  if(start<0){if(p&1){start=index;count=1;han=!!(p&4);}}
  else if((p&3)||cp===0x200c||cp===0x200d){count++;han=han&&!!(p&4);}
  else{
   if(han&&count>4){let from=start;for(let n=0;n<count;n+=2){let to=from;for(let j=0;j<Math.min(2,count-n);j++)to+=line.codePointAt(to)!>0xffff?2:1;yield [from,to];from=to;}}
   else yield [start,index];
   start=-1;
  }
  if(index===line.length)break;index+=cp>0xffff?2:1;
 }
}

export {truncateNoteTitle} from './title-unicode';
