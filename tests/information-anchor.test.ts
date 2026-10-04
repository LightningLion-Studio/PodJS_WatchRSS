import {expect, test} from 'bun:test';
import {checkedInformationListAnchor, informationAnchorAtOffset, informationOffsetForAnchor} from '../src/ui/information-anchor.ts';

// Native InfoScreen item boundaries in physical px at density 2. Body item 1
// and beian both include their 12px leading spacer inside their own item.
const heights = [36, 8, 90, 20, 180, 192, 42, 116];

test('canonical indices include both top spacers and preserve body/footer leading gaps', () => {
  const positions = [0, 36, 44, 134, 154, 334, 526, 568];
  for (let index = 0; index < positions.length; index++) {
    expect(informationAnchorAtOffset(heights, positions[index]!)).toEqual({index, offsetPx: 0});
    expect(informationOffsetForAnchor(heights, {index, offsetPx: 0}, 0)).toBe(positions[index]!);
  }
  expect(informationAnchorAtOffset(heights, 339)).toEqual({index: 5, offsetPx: 5});
  expect(informationAnchorAtOffset(heights, 531)).toEqual({index: 6, offsetPx: 5});
});

test('the same anchor moves with earlier layout heights while retaining its physical intra-item offset', () => {
  const anchor = {index: 5, offsetPx: 37};
  const before = informationOffsetForAnchor(heights, anchor, 200);
  const changed = [36, 8, 130, 20, 300, 192, 42, 116];
  const after = informationOffsetForAnchor(changed, anchor, 200);
  expect(before).toBe(371);
  expect(after).toBe(531);
  expect(informationAnchorAtOffset(changed, after)).toEqual(anchor);
});

test('oversized intra-item offsets normalize forward and end restoration fills the viewport', () => {
  const offset = informationOffsetForAnchor(heights, {index: 4, offsetPx: 187}, 100);
  expect(informationAnchorAtOffset(heights, offset)).toEqual({index: 5, offsetPx: 7});
  const bottom = informationOffsetForAnchor(heights, {index: 7, offsetPx: 80}, 466);
  expect(bottom).toBe(218);
  expect(informationAnchorAtOffset(heights, bottom)).toEqual({index: 4, offsetPx: 64});
});

test('out-of-range indices discard their offset and zero-height items do not become the first item', () => {
  expect(informationOffsetForAnchor([20, 30, 500], {index: 99, offsetPx: 100}, 10)).toBe(50);
  expect(informationAnchorAtOffset([20, 0, 0, 30], 20)).toEqual({index: 3, offsetPx: 0});
  expect(informationOffsetForAnchor([20], {index: 0, offsetPx: 4}, 100)).toBe(0);
  expect(informationOffsetForAnchor([], {index: 0, offsetPx: 0}, 100)).toBe(0);
  expect(informationAnchorAtOffset([], 100)).toEqual({index: 0, offsetPx: 0});
});

test('anchors use nonnegative safe integer indices and physical offsets and copy caller state', () => {
  for (const anchor of [{index: -1, offsetPx: 0}, {index: .5, offsetPx: 0}, {index: 0, offsetPx: -1},
    {index: 0, offsetPx: NaN}, {index: 0, offsetPx: Infinity}, {index: 0, offsetPx: .5},
    {index: Number.MAX_SAFE_INTEGER + 1, offsetPx: 0}])
    expect(() => checkedInformationListAnchor(anchor)).toThrow(RangeError);
  const source = {index: 4, offsetPx: 37}, anchor = checkedInformationListAnchor(source);
  source.offsetPx = 99;
  expect(anchor).toEqual({index: 4, offsetPx: 37});
});
