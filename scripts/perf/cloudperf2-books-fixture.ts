import {mkdirSync,writeFileSync} from 'node:fs';
import {chapterHash,bookFingerprint,bookId} from '../../src/books/protocol';
import {crypto} from '../../tests/cloud/k2-crypto';
const out=process.argv[2];if(!out)throw Error('output required');mkdirSync(out+'/files/incoming',{recursive:true});
const fixtures=[];
for(const sizeMiB of [1,5,20]){
 const sourceUrl='https://watchrss.local/import-txt-novel/cloudperf2-'+sizeMiB,chapters=[],hashes=[],chapterBytes=65536;
 for(let index=1;index<=sizeMiB*1048576/chapterBytes;index++){const title='Chapter '+index,prefix='Synthetic novel '+sizeMiB+' chapter '+index+'\n',contentText=prefix+'A stream of readable text.\n'.repeat(3000).slice(0,chapterBytes-prefix.length),chapter={chapterIndex:index,title,contentText,contentHtml:null,url:sourceUrl+'/chapter/'+index};chapters.push(chapter);hashes.push(await chapterHash(index,title,contentText,crypto.sha256));}
 const fingerprint=await bookFingerprint(hashes,crypto.sha256),id=await bookId(fingerprint,crypto.sha256),header={format:'watchrss-book',version:1,title:'Synthetic '+sizeMiB+' MiB',chapterCount:chapters.length,sourceUrl,kind:'txt'},text=[header,...chapters].map(v=>JSON.stringify(v)).join('\n')+'\n',path='incoming/book-'+sizeMiB+'.jsonl';
 writeFileSync(out+'/files/'+path,text);fixtures.push({sizeMiB,path,size:Buffer.byteLength(text),descriptor:{bookId:id,fingerprint,title:header.title,chapterCount:header.chapterCount,packagePath:'books/'+id+'.jsonl',sourceUrl,kind:'txt'}});
}
writeFileSync(out+'/fixtures.json',JSON.stringify({fixtures}));
