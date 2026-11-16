import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {truncateNoteTitle} from '../../src/notes/title-unicode';
test('Unicode 17 extended grapheme conformance at every code-point cut',()=>{
 let cases=0,cuts=0;
 for(const line of readFileSync(new URL('../fixtures/GraphemeBreakTest-17.0.0.txt',import.meta.url),'utf8').split('\n')){
  const raw=line.split('#')[0].trim();if(!raw)continue;
  const points:number[]=[],ends:number[]=[];
  for(const token of raw.split(/\s+/)){if(token==='÷')ends.push(points.length);else if(token!=='×')points.push(parseInt(token,16));}
  const text=String.fromCodePoint(...points);
  for(let limit=0;limit<=points.length;limit++){const end=ends.filter(n=>n<=limit).at(-1)!;expect(truncateNoteTitle(text,limit),raw+' limit '+limit).toBe(String.fromCodePoint(...points.slice(0,end)));cuts++;}cases++;
 }
 console.log('GRAPHEME-CONFORMANCE '+JSON.stringify({cases,cuts}));
});
