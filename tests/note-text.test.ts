import {test,expect} from 'bun:test';
import {memoPlainText,memoTitle} from '../src/notes/text.ts';
import native from './fixtures/note-text-native.json';
test('memo plain text and title match executed native Kotlin/Jsoup fixtures',()=>{for(const c of native.cases){expect(memoPlainText(c.input),JSON.stringify(c.input)).toBe(c.plainText);expect(memoTitle(c.input),JSON.stringify(c.input)).toBe(c.title);}});
