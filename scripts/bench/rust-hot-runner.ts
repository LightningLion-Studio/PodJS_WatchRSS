import '@podjs/framework/services';
import {parseContent,contentText} from '../../src/reader/content.ts';
import {extractReadableHtml} from '../../src/reader/content.ts';
import {breakUnits,layoutUiText} from '../../src/reader/line-break.ts';
import {lineStarts} from '../../src/reader/text-anchor.ts';
import {javaUtf8Chunks} from '../../src/reader/imported-text-writer.ts';
import {encodeChunkData,decodeChunkData,encodeFrame,decodeFrame} from '../../src/sync/protocol.ts';
import {prepareNotePreview} from '../../src/notes/preview.ts';
import {parseDouyinFeed} from '../../src/douyin/parser.ts';
import {differential} from './byte-codecs-differential.ts';
import {parseCommentPage} from '../../src/bili/comments.ts';
import {correspondenceCsrf} from '../../src/bili/html.ts';
const host=globalThis as any,now=host.__benchNow,print=host.__benchPrint;
const events:unknown[]=[];
Object.assign(host.pod,{
 capabilities:()=>JSON.stringify(['runtime.timer']),
 emit:(line:string)=>{const request=JSON.parse(line);if(request.method!=='runtime.delay')throw Error('unexpected benchmark IO');events.push({t:'service.result',id:request.id,ok:true,value:null});},
 takeEvents:()=>events.length?JSON.stringify(events.splice(0)):undefined,
});
host.__benchPump=()=>{if(!events.length)return false;host.__pocketPumpServices();return true;};
function measure(name:string,size:number,fn:()=>unknown){fn();const samples:number[]=[];for(let i=0;i<11;i++){const t=now();fn();samples.push(now()-t);}samples.sort((a,b)=>a-b);print(JSON.stringify({name,size,medianMs:samples[5],maxMs:samples.at(-1)}));}
const html:string=host.__rs1Html,blocks=parseContent(html),text=contentText(blocks);
measure('reader.parseContent.407',html.length,()=>parseContent(html));
measure('reader.readable.407',html.length,()=>extractReadableHtml(html,'https://example.org/article'));
measure('reader.normalizeParagraphs.407',text.length,()=>text.replace(/\r\n?/g,'\n').split('\n'));
measure('reader.breakUnits.407',text.length,()=>breakUnits(text));
// Pure measurement model: isolates JS loops; native font/GPU costs excluded.
const measureText=(s:string)=>s.length*7;
const lines=layoutUiText(text,{width:205,measure:measureText});
measure('reader.layoutUiText.407',text.length,()=>layoutUiText(text,{width:205,measure:measureText}));
measure('reader.lineStarts.407',lines.length,()=>lineStarts(text,lines));
const note=('# 标题\n\n长文 memo 🙂\n\n| 名称 | 数值 |\n| --- | ---: |\n| alpha | 42 |\n\n').repeat(1200);
measure('memo.preview.long',note.length,()=>prepareNotePreview(note));
const row={aweme_id:'1',desc:'存档 response 🙂',author:{uid:'42',nickname:'fixture'},video:{play_addr:{url_list:['https://example.org/video']},cover:{url_list:['https://example.org/image']},width:720,height:1280},statistics:{digg_count:123},create_time:1700000000};
const feed=JSON.stringify({aweme_list:Array.from({length:200},(_,i)=>({...row,aweme_id:String(i)})),has_more:1,max_cursor:42});
measure('douyin.json+project.200',feed.length,()=>parseDouyinFeed(feed));
measure('json.parse.feed.200',feed.length,()=>JSON.parse(feed));
const comments=JSON.stringify({replies:Array.from({length:200},(_,i)=>({rpid:i,member:{mid:'42',uname:'fixture'},content:{message:'存档 评论 🙂'.repeat(20)},replies:[]})),cursor:{next:201,is_end:false}});
measure('bili.comments.json+project.200',comments.length,()=>parseCommentPage(JSON.parse(comments)));
const page='<html><script>'+feed+'</script><div id="1-name">fixture-token</div></html>';
measure('bili.html.csrf',page.length,()=>correspondenceCsrf(page));
measure('array.filter-sort.4000',4000,()=>Array.from({length:4000},(_,i)=>({id:i,title:String(i%37)})).filter(x=>x.id%3).sort((a,b)=>a.title.localeCompare(b.title)));
for(const chars of [4096,32768,262144]){
 const str=('同步 sync 中文🙂\r\n').repeat(Math.ceil(chars/14)).slice(0,chars);
 const bytes=TextEncoderFallback(str),base64=encodeChunkData(bytes),frame=encodeFrame({action:'syncLibrary',phase:'articles',body:str});
 measure('sync.javaUtf8.'+chars,str.length,()=>[...javaUtf8Chunks(str)]);
 measure('sync.base64.encode.'+chars,bytes.length,()=>encodeChunkData(bytes));
 measure('sync.base64.decode.'+chars,base64.length,()=>decodeChunkData(base64));
 measure('sync.frame.encode.'+chars,str.length,()=>encodeFrame({action:'syncLibrary',phase:'articles',body:str}));
 measure('sync.frame.decode.'+chars,frame.length,()=>decodeFrame(frame));
}
function TextEncoderFallback(s:string):Uint8Array {const chunks=[...javaUtf8Chunks(s)],out=new Uint8Array(chunks.reduce((n,b)=>n+b.length,0));let at=0;for(const b of chunks){out.set(b,at);at+=b.length;}return out;}
// Measure each actual bridge call, including conversion/copy costs. Differential
// test work is excluded; it deliberately runs large assertion loops.
const stats:Record<string,{calls:number,maxMs:number,maxInput:number}>={};
for(const name of ['encodeUtf8Chunk','encodeBase64Chunk','decodeBase64Chunk','decodeUtf8']){
 const native=host.pod[name];if(!native)continue;stats[name]={calls:0,maxMs:0,maxInput:0};
 host.pod[name]=(...args:any[])=>{const start=now();try{return native(...args);}finally{const entry=stats[name];entry.calls++;entry.maxMs=Math.max(entry.maxMs,now()-start);entry.maxInput=Math.max(entry.maxInput,args[0].length);}};
}
const largeText='同步 🙂'.repeat(60000),largeBytes=TextEncoderFallback(largeText),largeBase64=encodeChunkData(largeBytes);
decodeChunkData(largeBase64);
print(JSON.stringify({phase:'native.pieces',stats}));
differential(html).then(assertions=>{print(JSON.stringify({phase:'differential',assertions}));host.__benchDone=true;}).catch(error=>{print(JSON.stringify({error:String(error)}));});
