/** Child-process crash harness; only the caller-owned temporary DB is opened. */
import {SqlFixture} from './fixture';
import {SqlBusinessSource} from '../../src/sync-v2/source';
const [path,mode,edge]=process.argv.slice(2),db=new SqlFixture(path,mode),at=Number(edge);
const source=await SqlBusinessSource.open(db),store=db.store();
db.transaction=async statements=>{db.raw.exec('BEGIN IMMEDIATE');let i=0;for(const s of statements){if(i++===at)process.exit(78);db.raw.query(s.sql).run(...(s.params??[]) as any[]);}if(i++===at)process.exit(78);db.raw.exec('COMMIT');if(i===at)process.exit(78);};
await store.scanPage(source,1);db.close();
