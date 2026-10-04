import {mount} from '@pocketjs/framework/solid';
import {Text} from '@pocketjs/framework/components';
import {kv} from '@podjs/framework/watch';
import {rfcomm,byteStreams,webSockets,delay} from '@podjs/framework/services';
import {getLibrarySyncRepository,db} from '../../src/services.ts';
import {hostArticleBodyCodec} from '../../src/sync/article-body-host.ts';
import {hashJavaText} from '../../src/sync/article-export.ts';
import {RfcommLibraryListener} from '../../src/sync/rfcomm.ts';
import {IpSyncController} from '../../src/sync/ip-controller.ts';
import {hostIpCrypto} from '../../src/sync/ip-crypto-host.ts';
import type {SessionActionResult} from '../../src/sync/session.ts';
const key='ip-peer-result',uuid='7349d245-eac4-4abd-9695-0d54b4e2e0bb',peer='article-peer-phone',articleId='c83023f8b742978ea92293dc638bc9493b6a2acd45c521bdf8dc650996516da6';
function check(v:unknown,m:string):asserts v{if(!v)throw new Error(m);}
async function run(){
 const repository=await getLibrarySyncRepository();check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===0,'Fixture articles must be empty');check(Number((await db.query('SELECT count(*) n FROM channels'))[0]?.n)===0,'Fixture channels must be empty');
 let finish!:()=>void,fail!:(e:unknown)=>void;const done=new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;});void done.catch(()=>{});let sawRoute=false;const actions:SessionActionResult[]=[],leases:boolean[]=[];let routeKind='',address='';let proof:Record<string,unknown>={};
 const ip=new IpSyncController({repository,sockets:webSockets,streams:byteStreams,crypto:hostIpCrypto,delay,mediaLease:async on=>{leases.push(on);},onRoute:route=>{if(route){sawRoute=true;routeKind=route.endpoint.transportKind;address=route.endpoint.address;kv.set(key,{state:'running',phase:'authenticated',routeKind,address});}else if(sawRoute)finish();},onError:fail},{onActionCompleted:result=>actions.push(result)});
 const listener=new RfcommLibraryListener(repository,{radio:{...rfcomm,listen:()=>rfcomm.listen('Paired IP Verification',uuid)},streams:byteStreams});
 try{
  const bootstrap=await listener.start({offerIpEndpoint:descriptor=>ip.offer(descriptor),onListening:()=>kv.set(key,{state:'running',phase:'listening',uuid})});check(bootstrap.length===1&&bootstrap[0]?.response.ipUpgradeAccepted===true&&bootstrap[0].ack?.applied,'Bootstrap acceptance');await done;
  check(actions.length===1&&actions[0]?.libraryApplied,'IP applied exchange');const cursor=await repository.cursor(peer);check(cursor.lastRemoteSeqApplied===11,'Durable IP sequence');
  const exported=await repository.exportRequested([{articleId,bodyHash:'',chunkIndexes:[],metadataOnly:false}]);check(exported.length===1,'Durable export missing');const a=exported[0]!.article;check(a.independentSaved&&a.favoriteSaved&&a.watchLaterSaved,'Saved state missing');check(a.readingProgress===.25&&a.readingPositionBytes===17,'Reader position missing');
  proof={watchId:await repository.deviceId(),contentSha256:await hashJavaText(a.contentText,hostArticleBodyCodec),cursorAfterApplied:cursor.lastRemoteSeqApplied,bootstrapAccepted:true,authenticated:true,routeKind,endpointAddress:address,savedFlags:true};
 }finally{listener.stop();await ip.dispose();const rows=await db.query('SELECT dedup_key FROM articles');check(rows.every(r=>r.dedup_key===articleId),'Unexpected fixture article; refuse cleanup');await repository.finalizeSnapshot([],[]);}
 check(leases.length===2&&leases[0]===true&&leases[1]===false,'IP media ownership release');check(Number((await db.query('SELECT count(*) n FROM articles'))[0]?.n)===0,'Owned article cleanup');kv.set(key,{state:'passed',...proof,ownedDataRemoved:true,leasesReleased:true,visualAcceptance:false});
}
mount(()=><Text>Authenticated IP synchronization verification</Text>);void run().catch(e=>kv.set(key,{state:'failed',error:String(e)}));
