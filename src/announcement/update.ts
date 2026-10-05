export interface DownloadProgress { bytesRead: number; totalBytes: number | null }
export interface DownloadedApk { path: string; size: number; status: number; url: string }
export interface ApkInspection { packageName: string }
export type InstallerResult = {status: 'launched' | 'permission-required'};
/** All filesystem paths belong to this port's private updates directory. Inspection
 * must parse the APK, not trust the extension. Installation must revalidate it. */
export interface UpdatePort {
  capabilities: {download: boolean; progress: boolean; inspectApk: boolean; installApk: boolean};
  download(url: string, onProgress: (progress: DownloadProgress) => void): Promise<DownloadedApk>;
  inspectApk(path: string): Promise<ApkInspection>;
  remove(path: string): Promise<void>;
  launchInstaller(path: string): Promise<InstallerResult>;
}
export type UpdateState =
  | {kind: 'idle'}
  | ({kind: 'downloading'} & DownloadProgress)
  | {kind: 'validating'}
  | {kind: 'ready'; apk: DownloadedApk}
  | {kind: 'installing'; apk: DownloadedApk}
  | {kind: 'installer-launched'; apk: DownloadedApk}
  | {kind: 'permission-required'; apk: DownloadedApk}
  | {kind: 'failed'; code: string; message: string; cleanupError?: string};
export class UpdateServiceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'UpdateServiceError'; }
}
const fail = (code: string, message: string): never => { throw new UpdateServiceError(code, message); };
export function requireHttps(url: string): void {
  // QuickJS has no browser URL global. Reject credentials, whitespace and backslashes.
  if (!/^https:\/\/[^\s/\\?#@:]+(?::\d{1,5})?(?:[/?#][^\s\\]*)?$/i.test(url)) fail('invalid-url', '安装包地址必须使用 HTTPS');
}
export class AppUpdateService {
  private value: UpdateState = {kind: 'idle'};
  private readonly listeners = new Set<(state: UpdateState) => void>();
  private busy = false;
  private lastUrl?: string;
  private apk?: DownloadedApk;
  constructor(private readonly port: UpdatePort, private readonly packageName: string) {}
  get state(): UpdateState { return this.value; }
  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(state: UpdateState) {
    this.value = state;
    for (const listener of this.listeners) { try { listener(state); } catch { /* UI cannot abort file validation. */ } }
  }
  private failed(error: unknown, cleanupError?: string) {
    this.publish({kind: 'failed', code: error instanceof UpdateServiceError ? error.code : 'host-error',
      message: error instanceof Error ? error.message : '安装包下载失败', ...(cleanupError ? {cleanupError} : {})});
  }
  resetFailure(): void { if (!this.busy && this.value.kind === 'failed') this.publish({kind: 'idle'}); }
  async download(url: string): Promise<UpdateState> {
    if (this.busy) return this.value;
    this.busy = true;
    this.lastUrl = url;
    let candidate: DownloadedApk | undefined;
    let acceptingProgress = false;
    try {
      requireHttps(url);
      if (!this.port.capabilities.download || !this.port.capabilities.inspectApk)
        fail('unsupported', '当前宿主缺少 APK 下载或校验能力');
      if (this.apk) { await this.port.remove(this.apk.path); this.apk = undefined; }
      this.publish({kind: 'downloading', bytesRead: 0, totalBytes: null});
      let lastBytes = 0;
      acceptingProgress = true;
      candidate = await this.port.download(url, progress => {
        if (!acceptingProgress || !Number.isSafeInteger(progress.bytesRead) || progress.bytesRead < lastBytes) return;
        lastBytes = progress.bytesRead;
        const total = progress.totalBytes;
        this.publish({kind: 'downloading', bytesRead: lastBytes,
          totalBytes: total !== null && Number.isSafeInteger(total) && total > 0 && total >= lastBytes ? total : null});
      });
      acceptingProgress = false;
      if (candidate.status < 200 || candidate.status >= 300) fail('http', `下载失败（HTTP ${candidate.status}）`);
      requireHttps(candidate.url);
      if (!Number.isSafeInteger(candidate.size) || candidate.size <= 0) fail('empty', '下载到的安装包为空');
      this.publish({kind: 'validating'});
      const info = await this.port.inspectApk(candidate.path);
      if (info.packageName !== this.packageName) fail('invalid-apk', '下载内容不是本应用的有效 APK 安装包');
      this.apk = candidate;
      this.publish({kind: 'ready', apk: candidate});
    } catch (error) {
      let cleanupError: string | undefined;
      if (candidate) { try { await this.port.remove(candidate.path); } catch (cleanup) { cleanupError = String(cleanup); } }
      this.failed(error, cleanupError);
    } finally { acceptingProgress = false; this.busy = false; }
    return this.value;
  }
  /** Explicit user retry, no production retry loop; starts a fresh download. */
  async retry(): Promise<UpdateState> {
    return this.lastUrl ? this.download(this.lastUrl) : this.value;
  }
  async launchInstaller(): Promise<UpdateState> {
    if (this.busy) return this.value;
    this.busy = true;
    try {
      if (!this.port.capabilities.installApk) fail('unsupported', '当前宿主缺少系统安装器能力');
      if (!this.apk) fail('not-ready', '尚无已校验的安装包');
      const apk = this.apk!;
      if ((await this.port.inspectApk(apk.path)).packageName !== this.packageName)
        fail('invalid-apk', '下载内容不是本应用的有效 APK 安装包');
      this.publish({kind: 'installing', apk});
      const result = await this.port.launchInstaller(apk.path);
      this.publish({kind: result.status === 'launched' ? 'installer-launched' : 'permission-required', apk});
    } catch (error) { this.failed(error); }
    finally { this.busy = false; }
    return this.value;
  }
}
