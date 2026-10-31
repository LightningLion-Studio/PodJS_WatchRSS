/** Deterministic desktop fixtures. No network or device operations.
 * bun scripts/bench/readerperf-fixtures.ts <output-directory>
 * Use reader-scroll.ts, then its bundle with --start=0 and these files. */
import {resolve} from 'node:path';
const output=resolve(process.argv[2]??'/tmp/readerperf');
const shapes=[[900,1600],[1000,1000],[4000,400],[800,600]];
await Bun.write(resolve(output,'images.html'),Array.from({length:20},(_,i)=>{
 const dimensions=i%4===3?'':` width="${shapes[i%4]![0]}" height="${shapes[i%4]![1]}"`;
 return '<p>'+('阅读性能测试，这是一段包含标点的正文。'.repeat(5))+'</p><img src="https://fixture.test/'+i+'.jpg"'+dimensions+'>';
}).join(''));
await Bun.write(resolve(output,'text.html'),'<p>'+('阅读性能测试，这是一段包含标点的长正文。'.repeat(15000))+'</p>');
await Bun.write(resolve(output,'timing.json'),JSON.stringify({elapsedSeconds:60,gestures:Array.from({length:60},(_,i)=>({startSeconds:i,direction:'up'}))}));

await Bun.write(resolve(output,'dimensions.json'),JSON.stringify(Object.fromEntries(Array.from({length:20},(_,i)=>['https://fixture.test/'+i+'.jpg',{width:shapes[i%4]![0],height:shapes[i%4]![1]}]))));
