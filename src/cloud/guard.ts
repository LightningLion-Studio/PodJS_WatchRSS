/** Production supplies the cloud host gate; build type does not restrict cloud sync. */
export interface CloudGuard { require(): void; }
export const cloudDisabled: CloudGuard = { require() { throw Error('Cloud sync unavailable in this build'); } };
