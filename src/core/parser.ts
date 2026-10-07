import type {XmlNode} from "@podjs/framework/xml";
import {traceServiceWork} from "@podjs/framework/service-trace";
import { decodeHtml, htmlToText } from "./html";
import { rssDedupKey, nativeRssTrim } from "./rss-dedup-key";
import type { ParsedFeed } from "./types";
type Node = { name: string; attrs: Record<string,string>; text: string; children: Node[] };
export function parseXml(source: string): Node {
  const root: Node = { name: "#root", attrs: {}, text: "", children: [] }, stack = [root];
  const token = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[^>]*\?>|<\s*(\/?)\s*([\w:.-]+)([^>]*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = token.exec(source))) {
    if (m[1] !== undefined) { stack[stack.length-1].text += m[1]; continue; }
    if (!m[3]) { if (m[5] !== undefined) stack[stack.length-1].text += m[5]; continue; }
    if (m[2] === "/") { const n = stack.pop(); if (!n || n.name !== m[3].toLowerCase()) throw new Error(`Malformed XML: unexpected closing tag ${m[3]}`); stack[stack.length - 1].text += n.text; continue; }
    const name = m[3].toLowerCase(), attrs: Record<string,string> = {};
    (m[4] ?? "").replace(/([\w:.-]+)\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)')/g, (_, k, a, b) => (attrs[k.toLowerCase()] = decodeHtml(a ?? b), ""));
    const n: Node = { name, attrs, text: "", children: [] }; stack[stack.length-1].children.push(n);
    if (!/\/\s*$/.test(m[4] ?? "")) stack.push(n);
  }
  if (stack.length !== 1 || root.children.length !== 1) throw new Error("Malformed XML: expected one root element");
  return root;
}
const child = (n: Node, name: string) => n.children.find(x => x.name === name || x.name.endsWith(`:${name}`));
const children = (n: Node, name: string) => n.children.filter(x => x.name === name || x.name.endsWith(`:${name}`));
const textContent = (n: Node): string => n.text;
const val = (n: Node | undefined) => n ? decodeHtml(textContent(n)).trim() : "";
export function resolveUrl(reference: string | null | undefined, base?: string): string | null { const ref=reference?.trim(); if(!ref) return null; if(/^[a-z][a-z0-9+.-]*:/i.test(ref)) return ref; if(ref.startsWith("//")) return (base?.match(/^(https?:)/i)?.[1] ?? "https:") + ref; if(!base || !/^https?:\/\//i.test(base)) return ref; const match=base.match(/^(https?:\/\/[^\/?#]+)(\/[^?#]*)?/i); if(!match) return ref; const origin=match[1], basePath=match[2] || "/"; if(ref.startsWith("#") || ref.startsWith("?")) return origin+basePath+ref; const suffix=ref.match(/^([^?#]*)([?#].*)?$/)!; const raw=suffix[1], path=raw.startsWith("/") ? raw : basePath.slice(0,basePath.lastIndexOf("/")+1)+raw, parts:string[]=[]; for(const part of path.split("/")){if(!part||part===".")continue;if(part==="..")parts.pop();else parts.push(part);} return origin+"/"+parts.join("/")+(suffix[2]||""); }
function rawLink(n: Node): string | null { const links = children(n, "link"); const alt = links.find(x => !x.attrs.rel || x.attrs.rel === "alternate"); const value=alt?.attrs.href ?? (alt ? decodeHtml(textContent(alt)) : ""); return nativeRssTrim(value)||null; }
function* feedSteps(root:XmlNode,fetchedAt:number,baseUrl?:string):Generator<void,ParsedFeed> {
  const articles:ParsedFeed["articles"]=[];
  const document = root.children[0] ?? root, channel = child(document, "channel") ?? document, atom = !child(document, "channel");
  const rootName = document.name.split(":").pop();
  if (rootName !== "feed" && !((rootName === "rss" || rootName === "rdf") && child(document, "channel"))) throw new Error("该地址不是有效的 RSS 或 Atom 订阅");
  const entries = rootName === "rdf" ? children(document, "item") : atom ? children(document, "entry") : children(channel, "item");
  const image = child(channel, "image");
  const feed = { title: val(child(channel, "title")) || "Untitled feed", description: val(child(channel, "description") ?? child(channel, "subtitle")) || null, imageUrl: image ? resolveUrl(val(child(image,"url")),baseUrl) : resolveUrl(child(channel,"logo") ? val(child(channel,"logo")) : null,baseUrl), articles };
  for(const e of entries){articles.push(traceServiceWork("refresh.entry",()=>{
    const content = child(e,"encoded") ?? child(e,"content") ?? child(e,"description" ) ?? child(e,"summary");
    const nativeVal = (n: Node | undefined) => n ? nativeRssTrim(decodeHtml(textContent(n))) : "";
    const guid = nativeVal(child(e,"guid")) || nativeVal(child(e,"id"));
    const identityLink = rawLink(e), itemLink = resolveUrl(identityLink,baseUrl), title = nativeVal(child(e,"title")) || identityLink || "未命名内容", pubDate = val(child(e,"pubdate")) || val(child(e,"published")) || val(child(e,"updated")), enclosure=child(e,"enclosure"), mediaUrl=resolveUrl(enclosure?.attrs.url,baseUrl), resolvedGuid=guid || null;
    return { title, description: val(child(e,"description") ?? child(e,"summary")) || null, content: content ? textContent(content).trim() : null, link: itemLink, guid: resolvedGuid, pubDate: pubDate || null, imageUrl: enclosure?.attrs.type?.startsWith("image/") ? mediaUrl : null, audioUrl: enclosure?.attrs.type?.startsWith("audio/") ? mediaUrl : null, videoUrl: enclosure?.attrs.type?.startsWith("video/") ? mediaUrl : null, readingProgress: 0, dedupKey: rssDedupKey(resolvedGuid,identityLink,title), fetchedAt };
  }));yield;}return feed;
}
export function parseFeed(xml:string,fetchedAt=Date.now(),baseUrl?:string):ParsedFeed {const steps=feedSteps(traceServiceWork("refresh.parseXml",()=>parseXml(xml)),fetchedAt,baseUrl);for(;;){const next=steps.next();if(next.done)return next.value;}}
export async function parseFeedAsync(xml:string,fetchedAt=Date.now(),baseUrl?:string,options:import("@podjs/framework/text-layout").TextLayoutSliceOptions={}):Promise<ParsedFeed>{const [{parseXmlDocumentAsync},{prepareTextLayout,yieldWorkTurn}]=await Promise.all([import("@podjs/framework/xml"),import("@podjs/framework/text-layout")]);const root=await parseXmlDocumentAsync(xml,options);let feed:ParsedFeed|undefined,key=0;const task=prepareTextLayout(feedSteps(root,fetchedAt,baseUrl),{key:()=>key++,entry:()=>undefined,publish:({layout})=>feed=layout},{yieldTurn:yieldWorkTurn,...options});await task.done;return feed!;}
export { htmlToText };
