import {test,expect} from 'bun:test';
import v from '../fixtures/book-fingerprint.json';
import {bookPackageLines,splitBookLines,validateBookPackage} from '../../src/books/package';
const sha=async(b:Uint8Array)=>new Bun.CryptoHasher('sha256').update(b).digest('hex');
const vector=v.cases[0]!;const header={format:'watchrss-book' as const,version:1 as const,title:'filename excluded',chapterCount:2,sourceUrl:'https://watchrss.local/import-epub/test',kind:'epub' as const};
const chapters=vector.chapters.map((c,i)=>({...c,chapterIndex:i+1,url:header.sourceUrl+'/chapter/'+(i+1)}));
async function collect(){let s='';for await(const line of bookPackageLines(header,chapters))s+=line;return s;}
async function* chunks(s:string){for(let i=0;i<s.length;i+=7)yield s.slice(i,i+7);}
test('JSONL streaming across tiny chunks matches shared fingerprint including CRLF/Unicode and excludes display metadata',async()=>{const text=await collect(),r=await validateBookPackage(splitBookLines(chunks(text)),sha,vector);expect(r.fingerprint).toBe(vector.fingerprint);expect(r.chapterHashes).toEqual(vector.chapterHashes);expect(text.endsWith('\n')).toBe(true);expect(text).not.toContain('readingProgress');});
test('partial, extra/reordered chapters, nonbook URLs, wrong fingerprint and non-LF framing never validate',async()=>{const text=await collect();for(const corrupt of [text.slice(0,-1),text.split('\n').slice(0,2).join('\n')+'\n',text+text.split('\n')[1]+'\n',text.replace('"chapterIndex":1','"chapterIndex":3'),text.replaceAll('https://watchrss.local','https://public.example'),text.replace('"contentText":"甲','"contentText":"改'),'\ufeff'+text])await expect(validateBookPackage(splitBookLines(chunks(corrupt)),sha,vector)).rejects.toThrow();});

test('HTML-only package changes keep the immutable content identity',async()=>{const text=(await collect()).replace('甲','changed HTML');expect((await validateBookPackage(splitBookLines(chunks(text)),sha,vector)).bookId).toBe(vector.bookId);});
