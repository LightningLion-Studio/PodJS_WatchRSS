import {AI_DISCLOSURE_LIMIT, AI_DISCLOSURE_PLACEHOLDER, watchDisclosureSnapshot} from '../src/llm/ai-disclosure.ts';

export function assertReleaseDisclosure(source: string): void {
  if (source.includes(AI_DISCLOSURE_PLACEHOLDER)) {
    throw Error('ai-disclosure-default.json contains __FILL_BEFORE_RELEASE__');
  }
  if (Buffer.byteLength(source) > AI_DISCLOSURE_LIMIT) {
    throw Error('ai-disclosure-default.json exceeds the watch disclosure size limit');
  }
  const snapshot = watchDisclosureSnapshot(JSON.parse(source));
  const entries = snapshot?.features.article_summary;
  if (!entries?.length) {
    throw Error('ai-disclosure-default.json requires an article_summary entry for release');
  }
  if (entries.some(entry => entry.filingNumber === null && entry.launchNumber === null)) {
    throw Error('ai-disclosure-default.json requires a filing number or launch number for each summary entry');
  }
}
