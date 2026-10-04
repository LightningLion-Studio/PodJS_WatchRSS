export interface ReaderPreset { id: string; name: string; fontSizeSp: number; lineHeightEm: number; paragraphSpacing: number; theme: "light" | "dark" | "system"; }
export const DEFAULT_READER_PRESET: ReaderPreset = { id: "default", name: "默认", fontSizeSp: 14, lineHeightEm: 1.35, paragraphSpacing: 1, theme: "system" };
export interface LayoutOptions { width: number; measure: (text: string) => number; maxLines?: number; }
export interface KeyValueStore { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; }
export interface ReadingProgress { offset: number; progress: number; updatedAt: number; importedAnchor?:import("./imported-document.ts").ImportedReadingAnchor; textAnchor?: {character:number;fraction:number;mediaIndex?:number;section?:"header"|"footer";sectionOffset?:number}; }
