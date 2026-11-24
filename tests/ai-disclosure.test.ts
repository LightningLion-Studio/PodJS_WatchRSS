import {describe,expect,test} from 'bun:test';
import {AI_DISCLOSURE_UNAVAILABLE,createWatchDisclosureLoader} from '../src/llm/ai-disclosure.ts';
import bundled from '../src/llm/ai-disclosure-default.json';
import {assertReleaseDisclosure} from '../scripts/ai-disclosure-release.ts';

const snapshot = (revision: number, displayText: string) => ({
  revision, updatedAt: 1795000000000,
  features: {article_summary: [{displayText, modelName: '测试模型', providerName: null, filingNumber: null, launchNumber: 'MOCK-01'}]},
});
const placeholder = snapshot(1, '__FILL_BEFORE_RELEASE__');
const offline = async () => { throw Error('offline'); };

describe('watch AI disclosure', () => {
  test('network wins and caches the new revision and original text', async () => {
    const remote = snapshot(3, '所用模型：测试模型\n上线编号：MOCK-01');
    let saved: unknown;
    let fetches = 0;
    const load = createWatchDisclosureLoader({
      fetch: async () => { if (++fetches === 1) return remote; throw Error('offline'); },
      read: () => snapshot(2, 'cache'),
      write: value => { saved = value; },
    }, snapshot(1, 'bundled'));
    const displayText = remote.features.article_summary[0].displayText;
    expect(await Promise.all([load(), load()])).toEqual([displayText, displayText]);
    expect(fetches).toBe(1);
    expect(saved).toEqual(remote);
    expect(await load()).toBe(displayText);
    expect(fetches).toBe(2);
  });

  test('cold start uses cache, bundle and unavailable text in order', async () => {
    const load = (cache: unknown, fallback: unknown) => createWatchDisclosureLoader({
      fetch: offline, read: () => cache, write: () => { throw Error('unexpected write'); },
    }, fallback)();
    expect(await load(snapshot(2, 'cache'), snapshot(1, 'bundled'))).toBe('cache');
    expect(await load({revision: 7}, snapshot(1, 'bundled'))).toBe('bundled');
    expect(await load(undefined, placeholder)).toBe(AI_DISCLOSURE_UNAVAILABLE);
  });

  test('successful empty snapshot replaces stale disclosure', async () => {
    const empty = {revision: 4, updatedAt: 0, features: {}};
    let saved: unknown = snapshot(3, 'retired');
    const load = createWatchDisclosureLoader({fetch: async () => empty, read: () => saved, write: value => { saved = value; }}, placeholder);
    expect(await load()).toBe(AI_DISCLOSURE_UNAVAILABLE);
    expect(saved).toEqual(empty);
    const reopenOffline = createWatchDisclosureLoader({fetch: offline, read: () => saved, write: () => {}}, snapshot(1, 'bundled'));
    expect(await reopenOffline()).toBe(AI_DISCLOSURE_UNAVAILABLE);
  });

  test('invalid remote data and unreadable cache use the bundle', async () => {
    const load = createWatchDisclosureLoader({
      fetch: async () => snapshot(3, '__FILL_BEFORE_RELEASE__'),
      read: () => { throw Error('cache unavailable'); },
      write: () => { throw Error('unexpected write'); },
    }, snapshot(1, 'bundled'));
    expect(await load()).toBe('bundled');
  });

  test('first offline open uses the published bundled model and filing number', async () => {
    const load = createWatchDisclosureLoader({fetch: offline, read: () => undefined, write: () => {}}, bundled);
    expect(await load()).toBe('所用模型：DeepSeek-V4.1-Flash\n备案号：网信算备330105747635301240017号');
    expect(bundled.revision).toBe(1);
    expect(bundled.features.article_summary[0]).toMatchObject({
      modelName: 'DeepSeek-V4.1-Flash',
      providerName: '百度智能云千帆',
      filingNumber: '网信算备330105747635301240017号',
      launchNumber: null,
    });
    expect(() => assertReleaseDisclosure(JSON.stringify(bundled))).not.toThrow();
  });
});

describe('watch AI disclosure release gate', () => {
  test('rejects the placeholder, including in metadata', () => {
    const incomplete = snapshot(1, '所用模型：测试模型');
    incomplete.features.article_summary[0].launchNumber = '__FILL_BEFORE_RELEASE__';
    for (const value of [placeholder, incomplete]) {
      expect(() => assertReleaseDisclosure(JSON.stringify(value))).toThrow('ai-disclosure-default.json contains __FILL_BEFORE_RELEASE__');
    }
  });

  test('accepts a populated snapshot and rejects missing disclosures', () => {
    expect(() => assertReleaseDisclosure(JSON.stringify(snapshot(1, '所用模型：测试模型')))).not.toThrow();
    const missingNumber = snapshot(1, '所用模型：测试模型');
    expect(() => assertReleaseDisclosure(JSON.stringify({
      ...missingNumber, features: {article_summary: [{...missingNumber.features.article_summary[0], launchNumber: null}]},
    }))).toThrow('requires a filing number or launch number');
    expect(() => assertReleaseDisclosure('{"revision":1,"updatedAt":1,"features":{}}')).toThrow('requires an article_summary entry');
  });
});
