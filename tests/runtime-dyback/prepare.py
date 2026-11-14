#!/usr/bin/env python3
"""Copy production sources; inject only local initial routes and an unused SDK shim."""
import argparse,shutil,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('out',type=Path);p.add_argument('--baseline',action='store_true');p.add_argument('--baseline-ref',default='origin/master');a=p.parse_args()
r=Path(__file__).resolve().parents[2];out=a.out.resolve();out.mkdir(parents=True,exist_ok=True)
shutil.copytree(r/'src',out/'src',dirs_exist_ok=True,ignore=shutil.ignore_patterns('dyback-*.generated.tsx'))
shutil.copytree(r/'tests/runtime-dyback',out/'tests/runtime-dyback',dirs_exist_ok=True,ignore=shutil.ignore_patterns('assets','__pycache__'))
for name in ['node_modules','assets','android']:
 if not (out/name).exists():(out/name).symlink_to(r/name,target_is_directory=True)
(out/'tests/runtime-dyback/assets').symlink_to(r/'assets',target_is_directory=True) if not (out/'tests/runtime-dyback/assets').exists() else None
if a.baseline:
 for name in ['src/ui/screen.tsx','src/ui/VideoPlayerScreen.tsx']:
  (out/name).write_bytes(subprocess.check_output(['git','show',a.baseline_ref+':'+name],cwd=r))
for name in ['package.json','tsconfig.json','pod.config.json']:
 shutil.copyfile(r/name,out/name)
s=(out/'src/ui/screen.tsx').read_text()
s="import {fixtureEntries} from '../../tests/runtime-dyback/src/data.ts';\n"+s
old='createSignal<Entry[]>([{ page: "home" }])'
assert s.count(old)==1
s=s.replace(old,'createSignal<Entry[]>(fixtureEntries())')
s=s.replace('const page = () => current().page;', """const page = () => current().page;
  createEffect(()=>kv.set('dyback.state',{page:page(),pages:stack().map(e=>e.page),item:playingSource()?.awemeId??current().playback?.awemeId??'none'}));""")
(out/'src/ui/screen.tsx').write_text(s)
# The supplied SDK lacks this unrelated export. No information route is opened.
p=out/'src/ui/InformationScreens.tsx'
s=p.read_text().replace('hostOperation,systemSettings,textLayout','hostOperation,textLayout')
p.write_text("const systemSettings={openWifi:async()=>{throw Error('fixture_settings_unavailable');}};\n"+s)
p=out/'src/ui/VideoPlayerScreen.tsx'
s=p.read_text()
needle='  props.ref?.({ invalidatePrefetch'
assert s.count(needle)==1
s=s.replace(needle,"""  createEffect(()=>kv.set('dyback.player',{state:state()?.state,position:state()?.positionMs,volume:state()?.volume,mode:mode(),controls:controlsVisible()}));
"""+needle)
p.write_text(s)
print(out/'tests/runtime-dyback')
