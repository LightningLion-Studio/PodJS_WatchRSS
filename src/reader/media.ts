import { parseContentAsync, parseContent, type ContentBlock } from "./content.ts";
export type BiliVideoTarget={aid?:number;bvid?:string;cid?:number};
function urlParts(value:string){
  const match=value.trim().match(/^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?/i);if(!match)return null;
  const host=match[1].split('@').at(-1)!.split(':')[0].toLowerCase(),segments=match[2].split('/').filter(Boolean).map(value=>{try{return decodeURIComponent(value);}catch{return value;}});
  const query:Record<string,string>={};
  for(const part of (match[3]??"").split('&')){const index=part.indexOf('=');if(index<0)continue;try{const key=decodeURIComponent(part.slice(0,index).replace(/\+/g,' '));if(!(key in query))query[key]=decodeURIComponent(part.slice(index+1).replace(/\+/g,' '));}catch{}}
  return {host,segments,query};
}
const domain=(host:string,root:string)=>host===root||host.endsWith('.'+root);
const positive=(value:string|undefined)=>value&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):undefined;
export function biliVideoTarget(link?:string):BiliVideoTarget|null {
  const raw=link?.trim()??"";let id=raw,cid:number|undefined;
  if(!/^BV/i.test(raw)&&!/^av\d+$/i.test(raw)){
    const url=urlParts(raw);if(!url||!domain(url.host,'bilibili.com'))return null;
    const index=url.segments.indexOf('video');id=(index>=0?url.segments[index+1]:undefined)??url.query.bvid??(url.query.aid?'av'+url.query.aid:'');cid=positive(url.query.cid);
  }
  if(/^BV/i.test(id)&&id.length>2)return {bvid:'BV'+id.slice(2),...(cid?{cid}:{})};
  const aid=/^av/i.test(id)?positive(id.slice(2)):undefined;return aid?{aid,...(cid?{cid}:{})}:null;
}
export function douyinVideoTarget(link?:string):{awemeId?:string;webUrl:string}|null {
  const raw=link?.trim()??"",url=urlParts(raw);if(!url||(!domain(url.host,'douyin.com')&&!domain(url.host,'iesdouyin.com')))return null;
  const index=url.segments.indexOf('video'),id=(index>=0?url.segments[index+1]:undefined)??url.query.aweme_id;
  return {awemeId:id,webUrl:id?`https://www.douyin.com/video/${id}`:raw};
}
export function buildArticleBlocks(raw:string,article:{enclosureImageUrl?:string;videoUrl?:string;link?:string}):ContentBlock[]{
  return appendArticleMedia(parseContent(raw),article);
}
export async function buildArticleBlocksAsync(raw:string,article:{enclosureImageUrl?:string;videoUrl?:string;link?:string},signal?:AbortSignal):Promise<ContentBlock[]>{return appendArticleMedia(await parseContentAsync(raw,signal),article);}
function appendArticleMedia(blocks:ContentBlock[],article:{enclosureImageUrl?:string;videoUrl?:string;link?:string}):ContentBlock[]{
  const image=article.enclosureImageUrl?.trim(),video=article.videoUrl?.trim();
  if(image&&!blocks.some(b=>b.type==='image'&&b.url===image))blocks.push({type:'image',url:image});
  if(video){if(!blocks.some(b=>b.type==='video'&&b.url===video))blocks.push({type:'video',url:video});}
  else {
    const bili=biliVideoTarget(article.link),douyin=douyinVideoTarget(article.link);
    const url=bili?`https://www.bilibili.com/video/${bili.bvid??'av'+bili.aid}${bili.cid?'?cid='+bili.cid:''}`:douyin?.webUrl;
    if(url&&!blocks.some(b=>b.type==='video'&&b.url===url))blocks.push({type:'video',url,...(bili&&image?{poster:image}:{})});
  }
  return blocks;
}
