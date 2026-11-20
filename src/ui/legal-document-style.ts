import { defaultReaderPreset } from '../reader/preset.ts';
import { readerFontResolver } from '../reader/font-assets.ts';

export const legalDocumentStyle = {
  preset: defaultReaderPreset(),
  fonts: readerFontResolver({}),
  backgroundSnapshot: { state: {}, revision: 0 },
};
