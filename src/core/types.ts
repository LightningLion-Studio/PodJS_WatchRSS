export type SqlParams = readonly unknown[];
export interface SqlDatabase {
  query(sql: string, params?: SqlParams, traceLabel?: string): Promise<Record<string, unknown>[]>;
  execute(sql: string, params?: SqlParams, traceLabel?: string): Promise<void>;
  transaction(statements: { sql: string; params?: SqlParams }[]): Promise<void>;
  transactionChanges?(statements: { sql: string; params?: SqlParams }[]): Promise<number[]>;
}
export interface Channel { id: number; url: string; title: string; description: string | null; imageUrl: string | null; lastFetchedAt: number | null; createdAt: number; sortOrder: number; isPinned: boolean; unreadCount?: number; }
export interface SourcePreferences { channelId: number; useOriginalContent: boolean; readPreset: string; }
export interface Article { id: number; channelId: number; title: string; description: string | null; content: string | null; link: string | null; guid: string | null; pubDate: string | null; imageUrl: string | null; audioUrl: string | null; videoUrl: string | null; isRead: boolean; isSaved: boolean; readingProgress: number; dedupKey: string; fetchedAt: number; }
export interface Note { id: number; articleId: number; body: string; createdAt: number; updatedAt: number; }
export type ParsedArticle = Omit<Article, "id" | "channelId" | "isSaved" | "isRead"> & {poolEntryId?:string};
export interface ParsedFeed { title: string; description: string | null; imageUrl: string | null; articles: ParsedArticle[]; }
