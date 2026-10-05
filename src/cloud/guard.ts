/** Production supplies the gate initialized exclusively from application.buildInfo(). */
export interface CloudGuard { require(): void; }
export const cloudDisabled: CloudGuard = { require() { throw Error('Cloud sync unavailable in this build'); } };
