// Functional scale/recovery check, not a disk or full-import speed benchmark.
// A loaded runner can spend >120s applying the legacy bulk response. Keep the
// production defaults and the 5s no-op/delta assertions unchanged.
export const SCALE_LOOPBACK_BULK_ACK_MS = 240_000;
export const SCALE_LOOPBACK_TEST_MS = 600_000;
export const SCALE_LOOPBACK_CHILD_MS = SCALE_LOOPBACK_TEST_MS + 10_000;
export const SCALE_LOOPBACK_PARENT_MS = SCALE_LOOPBACK_CHILD_MS + 10_000;
