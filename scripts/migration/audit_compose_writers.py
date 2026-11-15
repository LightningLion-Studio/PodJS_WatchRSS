#!/usr/bin/env python3
"""Read immutable production blobs at every formal Compose v1 tag; inventory API callsites.

This is a bounded static source inventory, not a claim about arbitrary library internals.
Every unresolved preference basename remains visible and fails the coverage gate.
File constructors include reads as well as writes, so their raw expressions are retained.
"""
import argparse,json,re,subprocess
from pathlib import Path

API=re.compile(r'\b(getSharedPreferences|getDefaultSharedPreferences|EncryptedSharedPreferences\s*\.\s*create|preferencesDataStoreFile|preferencesDataStore|PreferenceDataStoreFactory\s*\.\s*create|FileOutputStream|FileWriter|File|openFileOutput|getDir|getDatabasePath|openOrCreateDatabase|getExternalFilesDir|RandomAccessFile|FileChannel\s*\.\s*open|Files\s*\.\s*(?:write|writeString|newOutputStream)|createTempFile|createTempDirectory|writeText|writeBytes|appendText|appendBytes|outputStream|bufferedWriter|openOutputStream|mkdirs|renameTo|copyTo)\s*\(')
STR=re.compile(r'"(?:\\.|[^"\\])*"')

def mask(source,strings=False):
 pattern=re.compile(r'"""[\s\S]*?"""|"(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|//[^\n]*|/\*[\s\S]*?\*/')
 return pattern.sub(lambda m: ''.join('\n' if c=='\n' else ' ' for c in m[0]) if strings or m[0].startswith(('//','/*')) else m[0],source)

def arguments(source,start):
 # Balanced Kotlin/Java argument expressions, including nested calls and lambdas.
 clean=mask(source,True);depth=1;end=start
 while end<len(clean) and depth:
  if clean[end]=='(':depth+=1
  elif clean[end]==')':depth-=1
  end+=1
 text=source[start:end-1];masked=clean[start:end-1];args=[];begin=0;nest=0
 for i,c in enumerate(masked):
  if c in '([{':nest+=1
  elif c in ')]}':nest-=1
  elif c==',' and nest==0:args.append(text[begin:i].strip());begin=i+1
 args.append(text[begin:].strip());return args,end

def definitions(source):
 d={}
 for m in re.finditer(r'\b(?:val|var)\s+(\w+)\s*(?::[^=\n]+)?=\s*([^\n;]+)',source):d.setdefault(m[1],m[2].rstrip(', '))
 for m in re.finditer(r'\b(\w+)\s*:\s*String\s*=\s*([^,\n)]+)',source):d.setdefault(m[1],m[2])
 for m in re.finditer(r'\b(?:static\s+)?final\s+String\s+(\w+)\s*=\s*([^;\n]+)',source):d.setdefault(m[1],m[2])
 return d

def resolve(expr,defs,depth=0):
 expr=expr.strip();expr=re.sub(r'^(?:name|fileName|preferencesName)\s*=\s*','',expr)
 if depth>12:return None
 if STR.fullmatch(expr):
  try:return json.loads(expr)
  except ValueError:return expr[1:-1]
 if re.fullmatch(r'[\w.]+',expr):
  name=expr.rsplit('.',1)[-1]
  if name in defs and defs[name]!=expr:return resolve(defs[name],defs,depth+1)
 if expr.startswith('File('):
  args,_=arguments(expr,5);bits=[resolve(a,defs,depth+1) or '<'+a+'>' for a in args[:2]];return '/'.join(bits)
 if re.fullmatch(r'(?:\w+\.)*(?:filesDir|cacheDir|noBackupFilesDir)',expr):return {'filesDir':'files','cacheDir':'cache','noBackupFilesDir':'no_backup'}[expr.rsplit('.',1)[-1]]
 # Keep concatenation/interpolation as a path template rather than inventing a concrete ID.
 if '+' in expr:
  pieces=re.split(r'\s*\+\s*',expr);values=[resolve(p,defs,depth+1) for p in pieces]
  if any(v is not None for v in values):return ''.join(v if v is not None else '<'+p+'>' for p,v in zip(pieces,values))
 return None

def scan(path,source):
 source=mask(source);search=mask(source,True);defs=definitions(source);rows=[]
 for m in API.finditer(search):
  # A ContextWrapper override declares the API; it does not itself write a store.
  if re.search(r'fun\s+$',search[max(0,m.start()-20):m.start()]):continue
  kind=re.sub(r'\s+','',m[1]);args,end=arguments(source,m.end());values=[resolve(x,defs) for x in args]
  pref=kind in ('getSharedPreferences','getDefaultSharedPreferences','EncryptedSharedPreferences.create','preferencesDataStore','preferencesDataStoreFile','PreferenceDataStoreFactory.create')
  names=[];status='resolved'
  if kind=='getSharedPreferences':names=[values[0]] if values and values[0] is not None else []
  elif kind=='EncryptedSharedPreferences.create':names=[v for v in values if v is not None][:1]
  elif kind in ('preferencesDataStore','preferencesDataStoreFile'):names=[values[0]] if values and values[0] is not None else []
  elif kind=='PreferenceDataStoreFactory.create':status='delegated-produceFile' # The nested producer call is inventoried independently.
  elif kind=='getDefaultSharedPreferences':status='platform-default';names=['<package>_preferences']
  else:
   receiver=re.search(r'([A-Za-z_][\w.]*)\.$',source[max(0,m.start()-150):m.start()]);parent=resolve(receiver[1],defs) if receiver else None
   names=[resolve('File('+','.join(args)+')',defs) if kind=='File' else parent or (values[0] if values else None)];names=[n for n in names if n is not None]
  if pref and not names and status=='resolved':
   if path.endswith('/AccountDataContext.kt') and args and args[0]=='preferenceName(name)':status='account-scope-wrapper'
   else:status='UNRESOLVED'
  rows.append({'api':kind,'kind':'preference' if pref else 'file-constructor-or-api','line':source.count('\n',0,m.start())+1,'expression':source[m.start():end],'names':names,'resolution':status})
 return rows

def main():
 p=argparse.ArgumentParser();p.add_argument('--repo',required=True,type=Path);p.add_argument('--framework',required=True,type=Path);p.add_argument('--out',required=True,type=Path);p.add_argument('--extra-ref',action='append',default=[]);a=p.parse_args()
 def git(*args,**kw):return subprocess.check_output(['git','-C',str(a.repo),*args],**kw)
 tags=[x for x in git('tag','--list','v1*').decode().splitlines() if re.fullmatch(r'v1\.\d+\.\d+(?:-\d+)?',x)]
 refs=[(tag,tag) for tag in tags]+[tuple(x.split('=',1)) for x in a.extra_ref];objects={};trees={}
 for label,ref in refs:
  rows=[]
  for item in git('ls-tree','-rz','--full-tree',ref).split(b'\0'):
   if not item:continue
   meta,path=item.split(b'\t',1);mode,typ,oid=meta.decode().split();path=path.decode()
   if typ=='blob' and path.endswith(('.kt','.java')) and any(x in path for x in ('/src/main/','/src/release/')):
    rows.append((oid,path));objects[oid]=None
  trees[label]=rows
 raw=git('cat-file','--batch',input=('\n'.join(objects)+'\n').encode());pos=0
 for oid in objects:
  end=raw.index(b'\n',pos);header=raw[pos:end].split();n=int(header[2]);pos=end+1;objects[oid]=raw[pos:pos+n].decode(errors='replace');pos+=n+1
 converter=(a.framework/'platforms/android/runtime/src/main/java/dev/podjs/runtime/PodStoreConverter.java').read_text();stores=set(re.findall(r'"([\w]+)"',re.search(r'STORES=\{([^}]+)',converter)[1]))
 rows=[];summary={}
 for label,entries in trees.items():
  for oid,path in entries:
   for row in scan(path,objects[oid]):
    row.update(ref=label,path=path,oid=oid)
    if row['kind']=='preference':
     coverage=[]
     for name in row['names']:
      if row['api'] in ('preferencesDataStore','preferencesDataStoreFile'):physical='files/datastore/'+name+'.preferences_pb';base=name.removesuffix('.preferences_pb')
      else:physical='shared_prefs/'+name+'.xml';base=name
      classification='STORES' if base in stores else 'MISSING'
      if base=='read_aloud_secure_prefs':classification='retained-known-exact-path' if 'retainedKnownFile' in converter else 'MISSING'
      coverage.append({'name':name,'physicalPath':physical,'store':base,'classification':classification})
      key=(row['api'],name,physical,classification);g=summary.setdefault(key,{'api':row['api'],'name':name,'physicalPath':physical,'classification':classification,'refs':set(),'callsites':set()});g['refs'].add(label);g['callsites'].add(path+':'+str(row['line']))
     row['coverage']=coverage
    rows.append(row)
 groups=[]
 for g in summary.values():g['refs']=sorted(g['refs']);g['callsites']=sorted(g['callsites']);groups.append(g)
 unresolved=[r for r in rows if r['kind']=='preference' and r['resolution']=='UNRESOLVED'];missing=[g for g in groups if g['classification']=='MISSING']
 result={'command':' '.join(__import__('sys').argv),'formalTags':tags,'refs':[{'label':label,'commit':git('rev-parse',ref+'^{commit}').decode().strip()} for label,ref in refs],'productionSourceBlobs':len(objects),'apiRows':len(rows),'stores':sorted(stores),'preferenceNames':sorted(groups,key=lambda r:(r['physicalPath'],r['api'])),'unresolvedPreferences':unresolved,'missingPreferences':missing,'rows':rows,'scope':'All production Java/Kotlin API callsites in selected immutable refs; file constructors include read sites and dynamic expressions. External SDK implementation internals are outside this source scan.'}
 a.out.parent.mkdir(parents=True,exist_ok=True);a.out.write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'formalTags':len(tags),'sourceBlobs':len(objects),'apiRows':len(rows),'preferenceNames':len(groups),'unresolvedPreferences':len(unresolved),'missingPreferences':len(missing)},ensure_ascii=False))
 return 1 if unresolved or missing else 0
if __name__=='__main__':raise SystemExit(main())
