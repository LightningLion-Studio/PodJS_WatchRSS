import type { ContentBlock } from "../reader/content.ts";

// Android Regex uses Unicode White_Space, unlike JavaScript's \s (which includes BOM).
const paragraphSeparator = /\n[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*\n/;
// Kotlin trim uses Character.isWhitespace || isSpaceChar. Android also retains
// U+180E as whitespace for compatibility; neither predicate treats BOM as space.
const trimWhitespace = /^[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u00a0\u1680\u180e\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
const trimNative = (text: string): string => text.replace(trimWhitespace, "");

/** Mirrors InfoScreen.buildInfoBlocks; each nonempty source line is its own block. */
export function buildInformationBlocks(content: string): Array<Extract<ContentBlock, { type: "text" }>> {
  const blocks: Array<Extract<ContentBlock, { type: "text" }>> = [];
  for (const sourceParagraph of content.split(paragraphSeparator)) {
    const paragraph = trimNative(sourceParagraph);
    if (!paragraph) continue;
    // Kotlin lines recognizes CRLF, LF and CR, but not Unicode line separators.
    for (const sourceLine of paragraph.split(/\r\n|\n|\r/)) {
      const text = trimNative(sourceLine);
      if (!text) continue;
      const style = text.startsWith("https://") || text.startsWith("http://")
        ? "code" : text.startsWith("•") ? "quote" : "body";
      blocks.push({ type: "text", text, style });
    }
  }
  return blocks;
}

/** Fits the framework's 4096-byte accessibility label limit without splitting a code point. */
export function informationSemanticLabel(text: string): string {
  let bytes = 0;
  let offset = 0;
  let prefixEnd = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    offset += character.length;
    if (bytes <= 4093) prefixEnd = offset;
    if (bytes > 4096) return `${text.slice(0, prefixEnd)}…`;
  }
  return text;
}
