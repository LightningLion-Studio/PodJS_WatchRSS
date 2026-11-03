// The normal suite crosses multiple body/checkpoint batches with 128 articles.
// Keep the original 5500-article disk/TCP scenario available explicitly.
export const SCALE_LOOPBACK_FULL = process.env.PODJS_SCALE === '1';
export const SCALE_LOOPBACK_ARTICLES = SCALE_LOOPBACK_FULL ? 5500 : 128;
export const SCALE_LOOPBACK_INTERRUPT_AT = SCALE_LOOPBACK_FULL ? 1000 : 32;
export const SCALE_LOOPBACK_BULK_ACK_MS = SCALE_LOOPBACK_FULL ? 240_000 : 30_000;
export const SCALE_LOOPBACK_TEST_MS = SCALE_LOOPBACK_FULL ? 600_000 : 60_000;
export const SCALE_LOOPBACK_CHILD_MS = SCALE_LOOPBACK_TEST_MS + 10_000;
export const SCALE_LOOPBACK_PARENT_MS = SCALE_LOOPBACK_CHILD_MS + 10_000;
