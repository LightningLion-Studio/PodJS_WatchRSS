import assert from 'node:assert/strict';
import {expect,test} from 'bun:test';
import {binaryCapability,negotiate} from '../../src/sync/library-binary/routing';
import {BOOK_KINDS,HARD_LIMITS,selection,type Kind} from '../../src/sync/library-binary/wire';

test('S4 negotiates four inherited kinds and four book kinds together',()=>{
 const names:Kind[]=['articleBody','articleMetadata','noteAsset','rssSource',...BOOK_KINDS];
 names.sort();
 const kinds=names.map(kind=>({kind,schemaVersion:1 as const,send:true,receive:true}));
 const phone=binaryCapability(kinds,HARD_LIMITS);
 const watch=binaryCapability(kinds.map(row=>({...row,send:!row.kind.startsWith('article')})),HARD_LIMITS);
 const incoming=negotiate(phone,watch);
 assert.ok(incoming);
 expect(incoming.kinds.map(k=>k.kind)).toEqual(names);
 expect(selection(incoming)).toEqual(incoming);
 expect(negotiate(watch,phone)?.kinds.map(k=>k.kind)).toEqual(names.filter(kind=>!kind.startsWith('article')));
});
