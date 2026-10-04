import { mount } from '@pocketjs/framework/solid';
import { Text } from '@pocketjs/framework/components';
import { kv } from '@podjs/framework/watch';
import { rfcomm, byteStreams } from '@podjs/framework/services';
import { getLibrarySyncRepository, db } from '../../src/services.ts';
import { RfcommLibraryListener } from '../../src/sync/rfcomm.ts';

const resultKey = 'real-novel-reverse-result';
const expectedArticles = 5378;

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

async function count(table: string): Promise<number> {
  return Number((await db.query(`SELECT count(*) n FROM ${table}`))[0]?.n);
}

async function run() {
  const repository = await getLibrarySyncRepository();
  const watchId = await repository.deviceId();
  check((await count('articles')) === 0, 'Reverse fixture must start without articles');
  const listener = new RfcommLibraryListener(repository, { radio: rfcomm, streams: byteStreams });
  const started = Date.now();
  try {
    const results = await listener.start({
      onListening: () => kv.set(resultKey, { state: 'running', phase: 'listening', watchId, started }),
    });
    check(
      results.some(result => result.request.phase === 'manifest' && result.libraryApplied && result.ack?.applied),
      'Phone replacement did not apply',
    );
    const articles = await count('articles');
    const channels = await count('channels');
    const caches = await count('article_sync_content');
    check(articles === expectedArticles, 'Reverse fixture article count mismatch');
    kv.set(resultKey, { state: 'passed', watchId, articles, channels, caches, actions: results.length, elapsedMs: Date.now() - started });
  } finally {
    listener.stop();
  }
}

mount(() => <Text>Real novel reverse sync verification</Text>);
void run().catch(error => kv.set(resultKey, { state: 'failed', error: String(error), stack: error instanceof Error ? error.stack : '' }));
