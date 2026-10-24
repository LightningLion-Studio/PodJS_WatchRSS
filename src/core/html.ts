import {unwrapEscapedHtml} from "@podjs/framework/html";
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export function decodeHtml(value: string): string {
  return value.replace(/&(#x?[\da-f]+|[a-z][\w]+);/gi, (_, key: string) => {
    const low = key.toLowerCase();
    if (low[0] === "#") { const n = low[1] === "x" ? parseInt(low.slice(2), 16) : parseInt(low.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(Math.min(n, 0x10ffff)) : ""; }
    return entities[low] ?? `&${key};`;
  });
}
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  let s = unwrapEscapedHtml(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<\s*(script|style|noscript)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "");
  s = s.replace(/<\s*(br|p|div|li|tr|h[1-6]|blockquote|pre|section|article)[^>]*>/gi, "\n").replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|blockquote|pre|section|article)\s*>/gi, "\n");
  s = decodeHtml(s.replace(/<[^>]*>/g, ""));
  return s.replace(/[ \t\f\r]+/g, " ").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/\n{2,}/g, "\n").trim();
}
