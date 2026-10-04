import {expect,test} from 'bun:test';
import {noteCharacterCount,noteMetadata,noteRelativeTime} from '../src/notes/metadata.ts';

const now=Date.parse('2026-09-26T12:00:00-04:00');
test('note time follows Android zh-CN abbreviated relative thresholds',()=>{
  expect(noteRelativeTime(now,now)).toBe('0分钟前');
  expect(noteRelativeTime(now-30_000,now)).toBe('0分钟前');
  expect(noteRelativeTime(now-60_000,now)).toBe('1分钟前');
  expect(noteRelativeTime(now-3_599_999,now)).toBe('59分钟前');
  expect(noteRelativeTime(now-3_600_000,now)).toBe('1小时前');
  expect(noteRelativeTime(now-86_399_999,now)).toBe('23小时前');
  expect(noteRelativeTime(now-86_400_000,now)).toBe('昨天');
  expect(noteRelativeTime(now-172_800_000,now)).toBe('前天');
  expect(noteRelativeTime(now-6*86_400_000,now)).toBe('6天前');
  expect(noteRelativeTime(now-7*86_400_000,now)).toBe('9月19日');
  expect(noteRelativeTime(Date.parse('2025-09-26T12:00:00-04:00'),now)).toBe('2025年9月26日');
  expect(noteRelativeTime(now+60_000,now)).toBe('1分钟后');
  expect(noteRelativeTime(now+86_400_000,now)).toBe('明天');
});

test('metadata counts Kotlin non-whitespace UTF-16 units',()=>{
  expect(noteCharacterCount('A \t\u00a0\u3000😀')).toBe(3);
  expect(noteMetadata({updatedAt:now-86_400_000,plainText:'你 好😀'},now)).toBe('昨天 · 4 字');
});
