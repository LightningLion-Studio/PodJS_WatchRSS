import {expect, test} from 'bun:test';
import {wrapFieldText} from '../src/reader/field-wrap.ts';

const measure = (text: string) => Array.from(text).reduce((width, character) =>
  width + (character.charCodeAt(0) <= 127 ? 1 : 2), 0);

test('moves a field value to its own line and keeps the ASCII model intact', () => {
  expect(wrapFieldText('所用模型：DeepSeek-V4.1-Flash', 26, measure))
    .toEqual(['所用模型：', 'DeepSeek-V4.1-Flash']);
});

test('wraps a filing number at the label or CJK boundary, preserving the number', () => {
  const text = '备案号：网信算备330105747635301240017号';
  expect(wrapFieldText(text, 34, measure)).toEqual(['备案号：', '网信算备330105747635301240017号']);
  expect(wrapFieldText(text, 24, measure)).toEqual(['备案号：', '网信算备', '330105747635301240017号']);
  expect(wrapFieldText(text, 29, measure)).toEqual(['备案号：', '网信算备', '330105747635301240017号']);
});

test('only hard-wraps a run that exceeds a whole line', () => {
  expect(wrapFieldText('甲ABCDEFGHIJK乙', 5, measure)).toEqual(['甲', 'ABCDE', 'FGHIJ', 'K', '乙']);
  expect(wrapFieldText('甲ABCDE乙', 5, measure)).toEqual(['甲', 'ABCDE', '乙']);
});

test('preserves explicit line breaks and wraps unlabelled CJK text', () => {
  expect(wrapFieldText('甲乙丙丁\r\n\nA-B', 4, measure)).toEqual(['甲乙', '丙丁', '', 'A-B']);
});
