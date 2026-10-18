import type {NetworkSnapshot} from '@podjs/framework/services';
/** Native foreground/entry consent gate shared by the bounded proxy window. */
export function douyinPreloadAllowed(n:NetworkSnapshot,allowBluetooth=false):boolean {
 return n.active&&n.internet&&n.validated&&(n.wifi||n.cellular||n.bluetooth&&allowBluetooth);
}
