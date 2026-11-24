import {expect,test} from 'bun:test';
import {createWatchAboutSectionLoader,type WatchAboutSectionSnapshot} from '../src/about/section.ts';

const items = [{title: '产品详情', body: '第一行\n第二行'}, {title: null, body: '纯文本'}];
const populated = {revision: 1, items};
const empty = {revision: 2, items: []};
const offline = async () => { throw Error('offline'); };

test('watch about section caches content and treats a successful empty payload as authoritative', async () => {
  let saved: WatchAboutSectionSnapshot | undefined;
  let remote = populated as WatchAboutSectionSnapshot;
  const load = createWatchAboutSectionLoader({
    fetch: async () => remote,
    read: () => saved,
    write: value => { saved = value; },
  });
  expect(await load()).toEqual(items);
  expect(saved).toEqual(populated);
  remote = empty;
  expect(await load()).toEqual([]);
  expect(saved).toEqual(empty);
});

test('watch about section reads cached items on failure and falls back to empty without cache', async () => {
  const load = (cached: unknown) => createWatchAboutSectionLoader({
    fetch: offline, read: () => cached, write: () => { throw Error('unexpected write'); },
  })();
  expect(await load(populated)).toEqual(items);
  expect(await load(empty)).toEqual([]);
  expect(await load(undefined)).toEqual([]);
});

test('watch about section keeps its cache when the remote payload exceeds the item limits', async () => {
  const load = createWatchAboutSectionLoader({
    fetch: async () => ({revision: 3, items: [{title: null, body: '长'.repeat(1001)}]}),
    read: () => populated,
    write: () => { throw Error('unexpected write'); },
  });
  expect(await load()).toEqual(items);
});
