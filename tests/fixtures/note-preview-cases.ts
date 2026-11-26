import type {NotePreviewBlock} from '../../src/notes/preview.ts';
import native from './note-preview-native.json';

const twoParagraphs='a'.repeat(1000)+'\n\n'+'b'.repeat(700)+'\n'+'c'.repeat(500);

// Keep the Kotlin capture intact and describe the product's intentional deviations.
export const notePreviewCases=native.cases.map(({input,blocks,offsets})=>{
 if(input==='    ![indented](a)\n    ```\n|a|b|\n|---|---|'){
  const corrected:NotePreviewBlock[]=[
   {kind:'rich',markup:'    ![indented](a)\n    ```',html:false},
   {kind:'table',rows:[['a','b']],headerRows:1,alignments:['Start','Start']}
  ];
  return {input,blocks:corrected,offsets:[0,null]};
 }
 const expected=blocks as NotePreviewBlock[];
 if(input===twoParagraphs){
  const [first,...rest]=expected;
  return {input,blocks:[{...first,markup:'a'.repeat(1000)+'\n'},...rest],offsets};
 }
 return {input,blocks:expected,offsets};
});
