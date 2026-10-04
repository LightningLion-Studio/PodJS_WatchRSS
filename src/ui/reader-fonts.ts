import {createMemo,createSignal,onCleanup} from 'solid-js';
import {ReaderPresetStore,onReaderPresetsChanged} from '../reader/preset-store.ts';
import {readerFontResolver} from '../reader/font-assets.ts';
/** Resource completion can change a file without changing its preset. */
export function useReaderFonts(){
 const store=new ReaderPresetStore(),[revision,setRevision]=createSignal(0);
 onCleanup(onReaderPresetsChanged(()=>setRevision(value=>value+1)));
 return createMemo(()=>readerFontResolver(store.load(),revision()));
}
