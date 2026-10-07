import {expect,test} from 'bun:test';
import {correspondenceCsrf} from '../../src/bili/html.ts';
const legacy=(html:string)=>/id=["']1-name["'][^>]*>\s*([^<\s]+)\s*</.exec(html)?.[1];
test('correspondence token matches legacy HTML extraction, including malformed candidates',()=>{
 const cases=['',`<div id="1-name"> csrf-token </div>`,`<div id='1-name'>\n中文🙂\u00a0</div>`,`id="1-name' >value<`,`id="1-name" id='1-name'> x <`,`id="1-name">\n< id="1-name">last<`,`id="1-name">token! no-close`];
 const pieces=['id="1-name"',"id='1-name'",'id="1-name\'','>', '<', ' ', '\n', '\u00a0','token','中文🙂'];let seed=2;
 for(let run=0;run<2000;run++){let html='';for(let i=0;i<40;i++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;html+=pieces[seed%pieces.length];}cases.push(html);}
 for(const html of cases)expect(correspondenceCsrf(html)).toBe(legacy(html));
 expect(correspondenceCsrf('id="1-name" '.repeat(20000))).toBeUndefined();
});
