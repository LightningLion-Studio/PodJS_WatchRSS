import {mount} from '@pocketjs/framework/solid';
import {Text,View} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {fileChunks,hostOperation,sqlite} from '@podjs/framework/services';
import {readOfflineMedia,retryOfflineMedia} from '../../../src/reader/offline-media.ts';

const image='iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAFUlEQVR4nGP4z8DwHwwZ/oMBA+kCAA97J9lJHDRvAAAAAElFTkSuQmCC';
const ready='offline/rss/42/image_0.png',recovered='offline/rss/42/image_2.png';
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
mount(()=><View class="absolute inset-0 bg-black items-center justify-center"><Text class="text-sm text-white">离线媒体隔离验证</Text></View>);
void (async()=>{
  await sqlite.execute(`CREATE TABLE offline_media(id INTEGER PRIMARY KEY,item_id INTEGER NOT NULL,media_type TEXT NOT NULL,origin_url TEXT NOT NULL,relative_path TEXT,created_at INTEGER NOT NULL)`);
  try{
    await fileChunks.write(ready,image);
    await sqlite.execute('INSERT INTO offline_media VALUES(1,42,?,?,?,1)',['IMAGE','https://example.test/ready.png',ready]);
    await sqlite.execute('INSERT INTO offline_media VALUES(2,42,?,?,NULL,1)',['IMAGE','https://example.test/failed.png']);
    const initial=await readOfflineMedia({query:sqlite.query},{stat:fileChunks.stat},42);
    check(initial.failed===1&&initial.available['https://example.test/ready.png']===ready,'initial offline rows mismatch');
    const decoded=await hostOperation<{path:string;width:number;height:number}>('image.decode',{path:ready,maxDimension:64}).result;
    check(decoded.width>0&&decoded.height>0,'relative app-owned image path did not decode');
    await fileChunks.remove(decoded.path);
    const next=await retryOfflineMedia({query:sqlite.query,execute:sqlite.execute},{stat:fileChunks.stat,
      download:async(_url,path)=>{check(path===recovered,'unexpected retry path');await fileChunks.write(path,image);},
      remove:fileChunks.remove},42);
    check(next.failed===0&&next.available['https://example.test/failed.png']===recovered,'retry did not persist');
    kv.set('offline-media-runtime-result',{state:'passed',hostSql:true,hostFiles:true,relativeDecode:true,retry:true,cleanup:true});
  }finally{
    await sqlite.execute('DROP TABLE offline_media').catch(()=>{});
    await fileChunks.remove(ready).catch(()=>{});
    await fileChunks.remove(recovered).catch(()=>{});
  }
})().catch(error=>kv.set('offline-media-runtime-result',{state:'failed',message:String(error)}));
