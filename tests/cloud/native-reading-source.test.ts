import {expect,test} from 'bun:test';
import {fixture} from '../sync/ble-v2-fixture';
import {WatchRssRepository} from '../../src/core/repository';
test('Room19 reading provenance survives export until a newer local reading write',async()=>{
 const f=await fixture();try{
  await f.db.execute("INSERT INTO channels(id,url,title,created_at) VALUES(1,'https://native.example/rss','Native',1)");await f.db.execute("INSERT INTO articles(id,channel_id,title,content,link,guid,dedup_key,fetched_at,is_read,reading_progress) VALUES(1,1,'Post','body','https://native.example/post','g','guid:g',1,1,.5)");
  await f.db.execute("INSERT INTO article_reading_state VALUES(1,.5,100,12,'bodyhash',NULL)");await f.db.execute("INSERT INTO native_reading_sources VALUES(1,'native-device',100)");
  expect((await f.repo.cloudReadingCandidates())[0]).toMatchObject({sourceDeviceId:'native-device',readingPositionChangedAt:100,readingPositionBytes:12});
  await new WatchRssRepository(f.db,async()=>'').setRead(1,false,.25);expect((await f.repo.cloudReadingCandidates())[0].sourceDeviceId).toBe('watch');
 }finally{f.sql.close();}
});
