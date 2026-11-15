import type {HttpTransport} from '../cloud/types.ts';
/** Production transport. Isolated fixture builds replace this package import at build time. */
export const wrapDouyinTransport=(transport:HttpTransport):HttpTransport=>transport;
