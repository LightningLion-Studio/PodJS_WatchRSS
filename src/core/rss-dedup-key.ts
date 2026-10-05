// Kotlin Char.isWhitespace()/String.trim() parity for the values accepted by
// RssParseService before it calls RssDedupKey.compute.
const NATIVE_WHITESPACE = /^[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;

export function nativeRssTrim(value: string): string {
  return value.replace(NATIVE_WHITESPACE, "");
}

/** Exact port of native RssDedupKey.compute. The parser supplies already
 * trimmed fields, while direct callers retain Kotlin's original value. */
export function rssDedupKey(guid: string | null | undefined, link: string | null | undefined, title: string): string {
  if (guid != null && nativeRssTrim(guid)) return `guid:${guid}`;
  if (link != null && nativeRssTrim(link)) return `link:${link}`;
  return `title:${title}`;
}
