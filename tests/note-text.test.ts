import {test,expect} from 'bun:test';
import {memoPlainText,memoTitle} from '../src/notes/text.ts';
import native from './fixtures/note-text-native.json';
import titles from './fixtures/notes-title-vectors.json';
// Compose remains the frozen plain-text reference; its old title rule is no longer used.
test('memo plain text matches executed native Kotlin/Jsoup fixtures',()=>{for(const c of native.cases)expect(memoPlainText(c.input),JSON.stringify(c.input)).toBe(c.plainText);});
test('memo titles follow the shared phone three-word vectors',()=>{for(const c of titles)expect(memoTitle(c.plainText),c.name).toBe(c.expected||'未命名笔记');});
