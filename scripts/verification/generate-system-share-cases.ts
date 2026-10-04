import {qrPixels} from "../../src/ui/qr-pixels.ts";
import {nativeShareText} from '../../src/sharing/policy.ts';
const cases=[];
for(const origin of ['channel','bili-detail','detail'] as const){
 for(const [title,link] of [[' 标题 ',' URL '],['','URL'],[' title ',null],['\u2002','\n'],['\u2002标题\t','\n https://例子.test/a \u2002'],['标题','\u2002']] as const){
  const input={origin,title,link};cases.push({...input,expected:nativeShareText(input)});
 }
}
await Bun.write(new URL('../../tests/system-share-assets/cases.json',import.meta.url),JSON.stringify(cases));

const links=['https://example.com/article/123','https://例子.test/文章?标题=中文&emoji=⌚','https://example.com/'+ 'a'.repeat(450)];
const qrCases=links.flatMap(link=>[256,260].map(size=>({link,size})));
await Bun.write(new URL('../../tests/system-share-assets/qr-cases.json',import.meta.url),JSON.stringify(qrCases));
for(let i=0;i<qrCases.length;i++){const {link,size}=qrCases[i];await Bun.write(new URL('../../tests/system-share-assets/qr-'+i+'.rgba',import.meta.url),qrPixels(link,size,true,size));}
