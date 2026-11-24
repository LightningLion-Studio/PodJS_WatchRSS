import type {TextMeasurer} from './measured-text.ts';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CLOSING = /[：、。，；！？）】》」』]/u;

function wrapPart(text: string, width: number, measure: TextMeasurer): string[] {
  const tokens: string[] = [];
  let run = '';
  for (const character of text) {
    if (CJK.test(character) || CLOSING.test(character)) {
      if (run) tokens.push(run);
      run = '';
      if (CLOSING.test(character) && tokens.length) tokens[tokens.length - 1] += character;
      else tokens.push(character);
    } else {
      run += character;
    }
  }
  if (run) tokens.push(run);

  // Keep a final CJK unit with its number when they fit together on a line.
  const unit = tokens.at(-1);
  const number = tokens.at(-2);
  if (unit && number && CJK.test(unit) && /^\d+$/.test(number) && measure(number + unit) <= width) {
    tokens.splice(-2, 2, number + unit);
  }

  const lines: string[] = [];
  let line = '';
  const flush = () => {
    if (line) lines.push(line);
    line = '';
  };
  for (const token of tokens) {
    if (line && measure(line + token) > width) flush();
    if (measure(token) <= width) {
      line += token;
      continue;
    }
    // A run wider than a whole line must make progress even if one glyph is wider too.
    for (const character of token) {
      if (line && measure(line + character) > width) flush();
      line += character;
    }
    flush();
  }
  flush();
  return lines;
}

/** Preserve explicit newlines. Wrap CJK text without splitting a run that fits
 * on its own, and reserve a line for the label when a field needs wrapping. */
export function wrapFieldText(text: string, width: number, measure: TextMeasurer): string[] {
  return text.split(/\r\n?|\n/).flatMap(line => {
    if (measure(line) <= width) return [line];
    const colon = line.indexOf('：');
    if (colon < 0) return wrapPart(line, width, measure);
    return [
      ...wrapPart(line.slice(0, colon + 1), width, measure),
      ...wrapPart(line.slice(colon + 1).trimStart(), width, measure),
    ];
  });
}
