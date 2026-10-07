import {expect,test} from 'bun:test';
import {isImportedContentUrl,isDeletableLocalContentChannel,isImportedTextItemUrl} from '../../src/core/imported-content.ts';
import {kotlinTrim} from '@podjs/framework/text-compat';
import {nativeTrim} from '../../src/sync/local-manifest.ts';
import fixture from '../fixtures/imported-content-kotlin.json';
test('common trim matches actual Kotlin/JVM trim over every BMP code unit',()=>{
 const whitespace=new Set(fixture.whitespaceCodePoints);
 expect(nativeTrim).toBe(kotlinTrim);
 for(let cp=0;cp<=65535;cp++){
  const char=String.fromCharCode(cp),input=char+'x'+char;
  if(kotlinTrim(input)!==(whitespace.has(cp)?'x':input))throw Error(`Kotlin trim mismatch U+${cp.toString(16)}`);
 }
});
test('native imported/deletable/text-item classification matches Kotlin fixture across prefixes/control/BOM edges',()=>{
 for(const row of fixture.cases){
  expect(isImportedContentUrl(row.url)).toBe(row.imported);
  expect(isDeletableLocalContentChannel(row.url)).toBe(row.deletable);
  expect(isImportedTextItemUrl(row.url)).toBe(row.textItem);
 }
 expect(isImportedContentUrl(undefined)).toBe(false);
});
