import { defaultReaderPreset } from '../reader/preset.ts';
import { readerFontResolver } from '../reader/font-assets.ts';

export const informationDocumentStyle = {
  preset: defaultReaderPreset(),
  fonts: readerFontResolver({}),
};
