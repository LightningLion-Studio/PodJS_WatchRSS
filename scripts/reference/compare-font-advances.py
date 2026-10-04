#!/usr/bin/env python3
"""Compare native probe widths with the actual packaged atlas advances."""
from pathlib import Path
import hashlib,json,struct
root=Path(__file__).resolve().parents[2]
pak=Path('/home/wilf/data/PodJS/podjs-watch/dist/projects/com.lightningstudio.watchrss.podjs/android-watch/main.pak')
buf=pak.read_bytes()
count,directory,names=struct.unpack_from('<III',buf,8)
fonts={}
for index in range(count):
    at=directory+index*24
    offset,length,name_offset=struct.unpack_from('<III',buf,at+4)
    name_length=struct.unpack_from('<H',buf,at+16)[0]
    name=buf[names+name_offset:names+name_offset+name_length].decode()
    if not name.startswith('ui:font.'):continue
    data=buf[offset:offset+length]
    version,glyphs=struct.unpack_from('<HH',data,4)
    assert version in (2,3,4)
    stride=12 if version==4 else 8
    advances={}
    for glyph in range(glyphs):
        at=16+glyph*stride
        cp=struct.unpack_from('<I',data,at)[0]
        advances[chr(cp)]=struct.unpack_from('<f',data,at+8)[0] if version==4 else data[at+6]
    fonts[int(name.split('.')[-1])]=(version,advances)
probe=json.loads((root/'artifacts/reference-reader-fonts.json').read_text())
rows=[];seen=set()
for case in probe['probes']:
    role=case['role']
    if role in seen:continue
    seen.add(role)
    old,new=(1,34) if role=='BODY' else (10,37)
    old_scale=1 if role=='BODY' else 21.7/18
    for sample in case['samples']:
        text=sample['text']
        native=sample['compose']['width']
        old_width=sum(fonts[old][1][char] for char in text)*old_scale*2
        width=sum(fonts[new][1][char] for char in text)*2
        rows.append(dict(role=role,text=text,nativePhysicalWidth=native,previousAtlasPhysicalWidth=old_width,
            readerAtlasPhysicalWidth=width,absoluteError=abs(width-native),slot=new,atlasVersion=fonts[new][0]))
report={'pakSha256':hashlib.sha256(buf).hexdigest(),'rows':rows,
    'scope':'Sum of packaged per-codepoint advances; does not prove pair kerning, shaping, raster coverage, or arbitrary fonts.'}
(root/'artifacts/font-profile-advance-comparison.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(report,ensure_ascii=False,indent=2))
