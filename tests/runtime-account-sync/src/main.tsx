import {mount} from '@pocketjs/framework/solid';
import {Text, View} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {secureStorage,sqlite} from '@podjs/framework/services';
import {WatchAccountStore} from '../../../src/account/store.ts';
import {createApplicationActionHandler} from '../../../src/sync/application-actions.ts';
import {readSavedLinks} from '../../../src/sync/saved-links.ts';

const key='account-sync-runtime-result';
const storage={get:async(name:string)=>(await secureStorage.get(name))??null,
  set:secureStorage.set,remove:secureStorage.delete};
const store=new WatchAccountStore(storage);
const payload={action:'syncAccount',version:1,deviceId:'phone-fixture',
  account:{userId:'fixture-user',phoneMasked:'138****1234',installId:'fixture-install',
    watchAccessToken:'fixture-access-token',accessTokenExpiresAt:4102444800000,
    watchRefreshToken:'fixture-refresh-token',refreshTokenExpiresAt:4133980800000,
    backendBaseUrl:'https://api.example.com/',posthogHost:'',posthogProjectApiKey:''},
  entitlement:{plan:'member',active:true,expiresAt:4102444800000,features:['cloud']},
  telemetry:{anonymousEnabled:true,diagnosticsEnabled:false,sampleRate:1}};
const check=(value:unknown,message:string)=>{if(!value)throw Error(message);};
mount(()=><View class="absolute inset-0 bg-black items-center justify-center"><Text class="text-sm text-white">账号同步隔离验证</Text></View>);
void (async()=>{
  await store.clear();
  let changed=0;const unsubscribe=store.subscribe(()=>changed++);
  const handler=createApplicationActionHandler({notes:{} as never,notesChanged:()=>{},
    deviceId:async()=> 'watch-fixture',accountStore:store});
  const success=await handler(payload);
  check(success.success===true&&success.action==='syncAccount'&&success.deviceId==='watch-fixture'
    &&success.boundUserId==='fixture-user'&&success.telemetryBacklog===0,
    `account acknowledgement mismatch: ${JSON.stringify({success:success.success,action:success.action,
      deviceId:success.deviceId,boundUserId:success.boundUserId,telemetryBacklog:success.telemetryBacklog,
      message:String(success.message??'').replaceAll('fixture-access-token','[redacted]').replaceAll('fixture-refresh-token','[redacted]')})}`);
  check(!JSON.stringify(success).includes('fixture-access-token'),'token leaked into response');
  const reopened=new WatchAccountStore(storage),saved=await reopened.read();
  check(saved?.watchDeviceToken==='fixture-access-token'&&saved.backendBaseUrl==='https://api.example.com'
    &&saved.entitlement.plan==='member'&&saved.telemetryConfig.diagnosticsEnabled===false,'secure account readback mismatch');
  const refused=await handler({...payload,account:{...payload.account,backendBaseUrl:'http://192.168.1.8:8787'}});
  check(refused.success===false&&refused.message==='账号后端必须使用 HTTPS','cleartext endpoint accepted');
  check((await reopened.read())?.watchDeviceToken==='fixture-access-token'&&changed===1,
    'invalid payload changed stored account');
  unsubscribe();await store.clear();
  check(await reopened.read()===null,'fixture account cleanup failed');
  await sqlite.execute('CREATE TABLE articles(id INTEGER PRIMARY KEY,link TEXT)');
  await sqlite.execute('CREATE TABLE article_saved_states(article_id INTEGER,save_type TEXT,saved INTEGER,sort_order INTEGER,changed_at INTEGER)');
  await sqlite.execute('CREATE TABLE article_saved_entry_times(article_id INTEGER,save_type TEXT,created_at INTEGER)');
  try {
    await sqlite.transaction([
      {sql:"INSERT INTO articles VALUES(1,'https://fixture-a'),(2,'https://fixture-b'),(3,'https://fixture-later'),(4,'https://cancelled')"},
      {sql:"INSERT INTO article_saved_states VALUES(1,'favorite',1,1,100),(2,'favorite',1,0,200),(3,'watchLater',1,0,300),(4,'favorite',0,0,400)"},
      {sql:"INSERT INTO article_saved_entry_times VALUES(1,'favorite',50),(2,'favorite',60),(3,'watchLater',70)"},
    ]);
    const savedHandler=createApplicationActionHandler({notes:{} as never,notesChanged:()=>{},deviceId:async()=> 'watch-fixture',
      readSavedLinks:type=>readSavedLinks({query:sqlite.query},type)});
    check(JSON.stringify(await savedHandler({action:'ping',nonce:'fixture-nonce'}))===JSON.stringify({success:true,action:'pong',nonce:'fixture-nonce'}),
      'ping response mismatch');
    const favorites=await savedHandler({action:'pullSavedItems',type:'SYNC_FAVORITES'});
    check(favorites.success===true&&favorites.type==='FAVORITE'&&favorites.count===2
      &&JSON.stringify(favorites.items)==='[{"link":"https://fixture-b"},{"link":"https://fixture-a"}]',
      'favorite links or order mismatch');
    const later=await savedHandler({action:'pullSavedItems',type:'WATCHLATER'});
    check(later.success===true&&later.count===1&&JSON.stringify(later.items)==='[{"link":"https://fixture-later"}]',
      'watch-later links mismatch');
  } finally {
    await sqlite.execute('DROP TABLE article_saved_entry_times');
    await sqlite.execute('DROP TABLE article_saved_states');
    await sqlite.execute('DROP TABLE articles');
  }
  kv.set(key,{state:'passed',hostSecureWriteRead:true,invalidPreserved:true,cleanup:true,
    responseTokenFree:true,observerCount:changed,hostSavedLinks:true});
})().catch(error=>kv.set(key,{state:'failed',message:String(error)}));
