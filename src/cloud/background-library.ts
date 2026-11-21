import type {CloudGuard} from './guard';
import type {CloudHostRequest} from './host-ports';
import {SqlLibraryCloudRepository} from '../sync/library-repository';
import {createBackgroundLibraryPorts} from './background-library-ports';

export async function createBackgroundLibrary(host:CloudHostRequest,readKv:(key:string)=>Promise<unknown>,guard:CloudGuard){
 const {db,libraryPorts}=await createBackgroundLibraryPorts(host,readKv,guard);
 return new SqlLibraryCloudRepository(db,libraryPorts);
}
