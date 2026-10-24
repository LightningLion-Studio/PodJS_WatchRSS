import {parseHtmlFragment,normalizeHtmlWhitespace,unwrapEscapedHtml,textWorkChunks,type HtmlElement} from '@podjs/framework/html';
import { resolveUrl } from "../core/parser.ts";
import { decodeHtml } from "../core/html.ts";
export type ContentStyle = "body" | "title" | "subtitle" | "quote" | "code" | "link";
export type ContentBlock = {type:"text";text:string;style:ContentStyle} | {type:"image";url:string;alt?:string;width?:number;height?:number} | {type:"video";url:string;poster?:string};
type Element = HtmlElement;
const voidTags=new Set("area base br col embed hr img input link meta param source track wbr".split(" "));
const excludedTags=new Set("script style noscript template header footer nav aside".split(" "));
const excludedClasses=new Set("el-popover article-header article-author article-side comments__feed common__comment__dialog article-actionBar article-tag download-guide-container comp__Directory prime__story__directory__wrapper benefits__statement__wrapper corner corner_img ss__user__card__wrapper ss__user__card ss__user__card__intro bio".split(" "));
const roots="article__main__content article-body entry-content post-content article-content article__content markdown-body rich-text richtext".split(" ");
const detection=/<\s*\/?\s*(html|head|body|article|section|main|div|p|br|h[1-6]|ul|ol|li|span|table|blockquote|pre|code|img|video|iframe)\b/i;
const classes=(node:Element)=>(node.attrs.class??"").split(/\s+/);
const hidden=(node:Element)=>excludedTags.has(node.tag)||classes(node).some(c=>excludedClasses.has(c))||node.attrs.role==="tooltip"||node.attrs["aria-hidden"]==="true"||(node.attrs.style??"").includes("display:none");
/** Bounded-stack fragment tokenizer. Preserves mixed text/media order and accepts HTML void tags. */
function fragment(raw:string,exclude:(node:Element)=>boolean=hidden):Element {
  const root:Element={tag:"body",attrs:{},children:[]}, stack=[root];
  const token=/<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-zA-Z][\w:-]*(?:\s+(?:[^'">]|"[^"]*"|'[^']*')*)?\s*\/?>|[^<]+|</g;
  for(const match of raw.matchAll(token)) {
    const value=match[0];if(value.startsWith("<!"))continue;
    const tag=value.match(/^<(\/?)\s*([\w:-]+)/);
    if(!tag){stack[stack.length-1].children.push(decodeHtml(value));continue;}
    const name=tag[2].toLowerCase();
    if(tag[1]){for(let i=stack.length-1;i>0;i--)if(stack[i].tag===name){stack.length=i;break;}continue;}
    // Common optional end tags; unlike XML, RSS HTML often omits these closes.
    if((name==="li"&&stack.at(-1)?.tag==="li")||(name==="p"&&stack.at(-1)?.tag==="p"))stack.pop();
    const attrs:Record<string,string>={};
    const tail=value.slice(tag[0].length).replace(/\/?\s*>$/,"");
    for(const a of tail.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) attrs[a[1].toLowerCase()]=decodeHtml(a[2]??a[3]??a[4]??"");
    const node:Element={tag:name,attrs,children:[]};stack[stack.length-1].children.push(node);
    if(!voidTags.has(name)&&!value.endsWith("/>"))stack.push(node);
  }
  // Iterative removal avoids recursion during filtering of hostile/deep fragments.
  const pending=[root];while(pending.length){const node=pending.pop()!;node.children=node.children.filter(c=>typeof c==="string"||!exclude(c));for(const c of node.children)if(typeof c!=="string")pending.push(c);}
  return root;
}
function descendants(root:Element):Element[]{const result:Element[]=[],stack=[root];while(stack.length){const n=stack.pop()!;result.push(n);for(let i=n.children.length-1;i>=0;i--){const c=n.children[i];if(typeof c!=="string")stack.push(c);}}return result;}
function text(node:Element|string):string {
  if(typeof node==="string")return normalizeHtmlWhitespace(node);
  const preserve=node.tag==="pre";
  const parts:string[]=[],stack:(Element|string)[]=[node];
  while(stack.length){const n=stack.pop()!;if(typeof n==="string"){parts.push(n);continue;}if(n.tag==="br")parts.push(preserve?"\n":" ");
    const block=/^(p|div|section|article|blockquote|li|ul|ol|h[1-6]|tr|table)$/.test(n.tag);
    if(block&&!preserve){parts.push(" ");stack.push(" ");}
    for(let i=n.children.length-1;i>=0;i--)stack.push(n.children[i]);}
  return (preserve?parts.join(""):normalizeHtmlWhitespace(parts.join(""))).trim();
}
function dimension(node:Element,name:string):number|undefined {const attr=node.attrs[name]??"";const value=/^\d+$/.test(attr)?Number(attr):Number(node.attrs.style?.match(new RegExp(`${name}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`,"i"))?.[1]);return Number.isFinite(value)&&value>0?Math.round(value):undefined;}
function compact(blocks:ContentBlock[]):ContentBlock[]{
  const result:ContentBlock[]=[];
  for(const block of blocks){if(block.type!=="text"){result.push(block);continue;}
    for(const chunk of textWorkChunks(block.text)) {const value=chunk.trim();if(!value)continue;
      const last=result.at(-1);if(last?.type==="text"&&last.style===block.style&&last.text.length+value.length+1<=1024)last.text+="\n"+value;else result.push({...block,text:value});
    }
  }return result;
}
/** Mirrors RssContentParser's block selection and grouping; URLs remain source values. */
export function parseContent(raw:string):ContentBlock[]{raw=unwrapEscapedHtml(raw);return parseContentTree(raw,detection.test(raw.slice(0,4096))?parseHtmlFragment(raw):null);}
function parseContentTree(raw:string,tree:Element|null):ContentBlock[]{
  if(!raw.trim())return [];
  if(!detection.test(raw.slice(0,4096)))return compact(raw.split(/\r\n?|\n/).filter(s=>s.trim()).map(text=>({type:"text",text:text.trim(),style:"body"})));
  const body=tree?filterFragment(tree,hidden):fragment(raw),all=descendants(body);
  const candidates=[...roots.map(c=>all.find(n=>classes(n).includes(c))),all.find(n=>n.tag==="main")&&all.find(n=>n.tag==="main")!.children.filter((n):n is Element=>typeof n!=="string").flatMap(descendants).find(n=>n.tag==="article"),all.find(n=>n.tag==="article")];
  const root=candidates.find(n=>n&&(text(n)||descendants(n).some(c=>["img","video","iframe"].includes(c.tag))))??body;
  const blocks:ContentBlock[]=[];
  const add=(value:string,style:ContentStyle="body")=>{if(value.trim())blocks.push({type:"text",text:value.trim(),style});};
  const media=(n:Element)=>{const url=(n.attrs.src||(n.tag==="video"?descendants(n).find(c=>c.tag==="source"&&c.attrs.src)?.attrs.src:"")||"").trim();if(!url)return;if(n.tag==="img")blocks.push({type:"image",url,alt:n.attrs.alt?.trim()||undefined,width:dimension(n,"width"),height:dimension(n,"height")});else blocks.push({type:"video",url,poster:n.attrs.poster?.trim()||undefined});};
  const pending=[...root.children].reverse();
  while(pending.length){const n=pending.pop()!;if(typeof n==="string"){add(text(n));continue;}
    if(["img","video","iframe"].includes(n.tag)){media(n);continue;}
    if(n.tag==="p"){let buffer="";for(const child of n.children){if(typeof child!=="string"&&["img","video","iframe"].includes(child.tag)){add(buffer);buffer="";media(child);}else buffer+=text(child);}add(buffer);continue;}
    if(/^h[1-6]$/.test(n.tag)){add(text(n),Number(n.tag[1])<=2?"title":"subtitle");continue;}
    if(n.tag==="pre"||n.tag==="code"){add(text(n),"code");continue;}
    if(n.tag==="ul"||n.tag==="ol"){let index=0;for(const c of n.children)if(typeof c!=="string"&&c.tag==="li")add((n.tag==="ol"?`${++index}. `:"- ")+text(c));continue;}
    if(n.tag==="blockquote"){const items=n.children.filter((c):c is Element=>typeof c!=="string"&&(c.tag==="ul"||c.tag==="ol")).flatMap(c=>c.children).filter((c):c is Element=>typeof c!=="string"&&c.tag==="li");if(items.length)items.forEach(c=>add("- "+text(c),"quote"));else add(text(n),"quote");continue;}
    if(n.tag==="br")continue;
    for(let i=n.children.length-1;i>=0;i--)pending.push(n.children[i]);
  }
  return compact(blocks);
}
export function contentText(blocks:readonly ContentBlock[]):string {return blocks.filter((b):b is Extract<ContentBlock,{type:"text"}>=>b.type==="text").map(b=>b.text).join("\n");}

/** Native RssReadableService candidate selection, sanitization and lazy media URL normalization. */
export function extractReadableHtml(raw:string,baseUrl:string):string|null {return readableTree(raw,baseUrl,parseHtmlFragment(raw));}
function readableTree(raw:string,baseUrl:string,native:Element|null):string|null {
  const tree=native?filterFragment(native,n=>["script","style","noscript"].includes(n.tag)):fragment(raw,n=>["script","style","noscript"].includes(n.tag));
  const all=descendants(tree),candidates=all.filter(n=>n.tag==="article"||n.tag==="main"||n.attrs.role==="main"||(n.tag==="div"&&(["content","article","article_content"].includes(n.attrs.id)||classes(n).some(c=>c==="content"||c==="left_zw"))));
  let root=candidates[0]??all.find(n=>n!==tree&&n.tag==="body")??tree,best=-1;
  for(const candidate of candidates){const length=text(candidate).length;if(length>best){best=length;root=candidate;}}
  const removed=new Set("script style noscript header footer nav form aside button svg".split(" "));
  const pending=[root];while(pending.length){const n=pending.pop()!;n.children=n.children.filter(c=>typeof c==="string"||!removed.has(c.tag));for(const c of n.children)if(typeof c!=="string")pending.push(c);}
  const nodes=descendants(root);
  if(!text(root)&&!nodes.some(n=>["img","video","iframe"].includes(n.tag)))return null;
  for(const n of nodes){
    if(n.tag==="img"){
      const src=["src","data-src","data-original","data-lazy-src","data-actualsrc","data-url"].map(k=>n.attrs[k]?.trim()).find(Boolean);
      if(src)n.attrs.src=resolveUrl(src,baseUrl)??src;delete n.attrs.srcset;
    }else if(["video","source","iframe"].includes(n.tag)&&n.attrs.src?.trim())n.attrs.src=resolveUrl(n.attrs.src.trim(),baseUrl)??n.attrs.src.trim();
  }
  const escape=(s:string)=>s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const output:string[]=[],stack:(Element|string)[]=[root];
  while(stack.length){const n=stack.pop()!;if(typeof n==="string"){output.push(n);continue;}
    output.push(`<${n.tag}${Object.entries(n.attrs).map(([key,value])=>` ${key}="${escape(value)}"`).join("")}>`);
    if(voidTags.has(n.tag))continue;stack.push(`</${n.tag}>`);for(let i=n.children.length-1;i>=0;i--){const c=n.children[i];stack.push(typeof c==="string"?escape(c):c);}
  }
  return output.join("").trim()||null;
}

function filterFragment(root:Element,exclude:(node:Element)=>boolean):Element {
 const pending=[root];while(pending.length){const node=pending.pop()!;node.children=node.children.filter(c=>typeof c==='string'||!exclude(c));for(const c of node.children)if(typeof c!=='string')pending.push(c);}return root;
}
async function nativeFragment(raw:string,signal?:AbortSignal):Promise<Element|null>{
 if(signal?.aborted)throw Error('HTML parse cancelled');
 // Old host keeps its original synchronous parser without requesting timers.
 if(!(globalThis as any).pod?.htmlBegin)return null;
 const {requestHtmlFragment}=await import('@podjs/framework/html-slices');
 if(signal?.aborted)throw Error('HTML parse cancelled');
 let tree:Element|null=null;
 const task=requestHtmlFragment(raw,value=>tree=value);
 const cancel=()=>task.cancel();signal?.addEventListener('abort',cancel,{once:true});
 try{await task.done;if(signal?.aborted)throw Error('HTML parse cancelled');return tree;}
 finally{signal?.removeEventListener('abort',cancel);}
}
/** Production body callbacks leave the SQL completion turn during native scan. */
export async function parseContentAsync(raw:string,signal?:AbortSignal):Promise<ContentBlock[]>{
 if(signal?.aborted)throw Error('HTML parse cancelled');
 raw=unwrapEscapedHtml(raw);
 if(!detection.test(raw.slice(0,4096)))return parsePlainContentAsync(raw,signal);
 return parseContentTree(raw,detection.test(raw.slice(0,4096))?await nativeFragment(raw,signal):null);
}
export async function extractReadableHtmlAsync(raw:string,baseUrl:string,signal?:AbortSignal):Promise<string|null>{return readableTree(raw,baseUrl,await nativeFragment(raw,signal));}

/** A newline-free multi-megabyte fallback must not monopolize a service turn.
 * The framework bounds each work unit; only the visible row window is mounted. */
async function parsePlainContentAsync(raw:string,signal?:AbortSignal):Promise<ContentBlock[]> {
 const {prepareTextLayout,yieldWorkTurn}=await import("@podjs/framework/text-layout");
 const blocks:ContentBlock[]=[];
 function* steps():Generator<void,ContentBlock[]> {
  for(const chunk of textWorkChunks(raw)) {
   for(const line of chunk.split(/\r\n?|\n/)){const value=line.trim();if(!value)continue;
    const last=blocks.at(-1);if(last?.type==='text'&&last.text.length+value.length+1<=1024)last.text+='\n'+value;else blocks.push({type:'text',text:value,style:'body'});
   }yield;
  }return blocks;
 }
 let result:ContentBlock[]|undefined,key=0;
 const task=prepareTextLayout(steps(),{key:()=>key++,entry:()=>undefined,publish:snapshot=>result=snapshot.layout},{yieldTurn:yieldWorkTurn});
 const cancel=()=>task.cancel();signal?.addEventListener('abort',cancel,{once:true});
 try{await task.done;if(signal?.aborted)throw Error('HTML parse cancelled');return result??[];}
 finally{signal?.removeEventListener('abort',cancel);}
}
