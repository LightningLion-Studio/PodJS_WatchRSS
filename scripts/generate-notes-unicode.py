from pathlib import Path
from array import array
import base64,hashlib,json,sys,zlib
# Download the Unicode 17 UCD files listed in docs/notes-rendering.md first.
root=Path(sys.argv[1])
expected=json.loads((Path(__file__).resolve().parents[1]/'docs/notes-unicode-sources.json').read_text())
for name,sha in expected.items():
 if name.endswith('.txt') and hashlib.sha256((root/name).read_bytes()).hexdigest()!=sha:raise SystemExit('Unicode 17 source hash mismatch: '+name)
flags=array('H',[0])*0x110000
pending=None
for l in (root/'UnicodeData.txt').read_text().splitlines():
 row=l.split(';');p=int(row[0],16);cat=row[2];v=(1 if cat[0] in 'LN' else 0)|(2 if cat[0]=='M' else 0)
 if row[1].endswith(', First>'):pending=p
 elif row[1].endswith(', Last>'):
  if v:
   for i in range(pending,p+1):flags[i]|=v
  pending=None
 elif v:flags[p]|=v

def ranges(name):
 for line in (root/name).read_text().splitlines():
  s=line.split('#',1)[0].strip()
  if not s:continue
  cols=[x.strip() for x in s.split(';')];points=cols[0].split('..');yield int(points[0],16),int(points[-1],16),cols[1:]
for a,b,prop in ranges('Scripts.txt'):
 if prop[0]=='Han':
  for i in range(a,b+1):flags[i]|=4
names=['Other','CR','LF','Control','Extend','ZWJ','Regional_Indicator','Prepend','SpacingMark','L','V','T','LV','LVT']
for a,b,prop in ranges('GraphemeBreakProperty.txt'):
 if prop[0] in ['LV','LVT']:continue # Hangul syllables are classified algorithmically.
 for i in range(a,b+1):flags[i]|=names.index(prop[0])<<3
for a,b,prop in ranges('emoji-data.txt'):
 if prop[0]=='Extended_Pictographic':
  for i in range(a,b+1):flags[i]|=128
for a,b,prop in ranges('DerivedCoreProperties.txt'):
 if prop[0]=='InCB':
  bit={'Consonant':256,'Linker':512,'Extend':1024}[prop[1]]
  for i in range(a,b+1):flags[i]|=bit
result=[];start=128;value=flags[start]
for i in range(start+1,len(flags)+1):
 if i==len(flags) or flags[i]!=value:
  if value:result.append((start,i-1,value))
  if i<len(flags):start=i;value=flags[i]
out=bytearray();cursor=128
for a,b,v in result:
 for num in [a-cursor,b-a,v]:
  while num>=128:out.append((num&127)|128);num>>=7
  out.append(num)
 cursor=b+1
assert hashlib.sha256(out).hexdigest()==expected['rangesSha256']
encoded=base64.b64encode(out).decode();data=dict(unicodeVersion='17.0.0',encodedRanges=encoded,rangesSha256=hashlib.sha256(out).hexdigest())
(root/'title-unicode-data.json').write_text(json.dumps(data,separators=(',',':'))+'\n')
mini=dict(data,compression='zlib',encodedRanges=base64.b64encode(zlib.compress(out,9)).decode())
(root/'title-unicode-data-zlib.json').write_text(json.dumps(mini,separators=(',',':'))+'\n')
(root/'sources.json').write_text(json.dumps({f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in root.glob('*.txt')},indent=2))
print('ranges',len(result),'raw bytes',len(out),'JSON bytes',len(json.dumps(data,separators=(',',':'))))
