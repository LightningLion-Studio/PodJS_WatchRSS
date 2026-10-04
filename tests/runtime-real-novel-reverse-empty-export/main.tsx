import { mount } from '@pocketjs/framework/solid';
import { Text } from '@pocketjs/framework/components';
import { kv } from '@podjs/framework/watch';
import { getLibrarySyncRepository, db } from '../../src/services.ts';

const resultKey = 'real-novel-reverse-empty-export-result';
async function run() {
  const articles = Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n);
  if (articles !== 5378) throw new Error(`Expected 5,378 imported articles, got ${articles}`);
  const repository = await getLibrarySyncRepository();
  const started = Date.now();
  const outgoing = await repository.exportRequested([]);
  if (outgoing.length !== 0) throw new Error('Empty body request returned articles');
  kv.set(resultKey, { state: 'passed', articles, outgoing: outgoing.length, elapsedMs: Date.now() - started });
}

mount(() => <Text>Empty export verification</Text>);
void run().catch(error => kv.set(resultKey, { state: 'failed', error: String(error) }));
