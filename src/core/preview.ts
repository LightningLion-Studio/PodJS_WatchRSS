import { decodeHtml, htmlToText } from "./html.ts";
import { resolveUrl } from "./parser.ts";

export function articlePreview(content:string|null|undefined,description:string|null|undefined,imageUrl:string|null|undefined,link:string|null|undefined):{summary:string|null;imageUrl:string|null} {
  const raw=content?.trim()?content:description??"";
  const plain=htmlToText(raw).replace(/\s+/g," ").trim();
  const summary=plain.length>60?plain.slice(0,60).replace(/[\uD800-\uDBFF]$/u,"").trimEnd()+"...":plain||null;
  const safe=raw.replace(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,"");
  const tag=safe.match(/<img\b[^>]*?\s+src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  const source=imageUrl?.trim()||decodeHtml(tag?.[1]??tag?.[2]??tag?.[3]??"").trim();
  const resolved=source?resolveUrl(source,link??undefined):null;
  return {summary,imageUrl:resolved&&/^https?:\/\//i.test(resolved)?resolved:null};
}
