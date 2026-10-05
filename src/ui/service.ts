/** Data boundary between the watch UI and the native/core RSS implementation. */
export interface Channel {
  id: string;
  title: string;
  url: string;
  description?: string | null;
  imageUrl?: string | null;
  isPinned?: boolean;
  sortOrder?: number;
  createdAt?: number;
  useOriginalContent?: boolean;
  lastFetchedAt?: number | null;
  unreadCount?: number;
}

export interface Article {
  importedText?: import("../reader/imported-text.ts").ImportedTextHandle;
  id: string;
  channelId?: string;
  channelTitle?: string;
  title: string;
  excerpt?: string;
  searchSnippet?: string;
  content: string;
  rawContent?: string;
  useOriginalContent?: boolean;
  contentBlocks?: import("../reader/content.ts").ContentBlock[];
  offlineMedia?: Record<string,string>;
  offlineMediaFailures?: number;
  publishedAt?: string;
  read?: boolean;
  saved?: boolean;
  watchLater?: boolean;
  savedAt?: number;
  saveSortOrder?: number;
  link?: string;
  imageUrl?: string;
  enclosureImageUrl?:string;
  videoUrl?:string;
  audioUrl?:string;
}

export interface Note {
  id: string;
  articleId?: string;
  title: string;
  body: string;
  updatedAt?: string;
}

export interface ArticleQuery {
  channelId?: string;
  query?: string;
  saved?: boolean;
  saveType?: "favorite" | "watchLater";
  page?: number;
  pageSize?: number;
  offset?: number;
}

export type AddChannelPreview =
  | {kind:"existing";channel:Channel}
  | {kind:"ready";token:string;url:string;title:string;description:string|null};

export interface AppServices {
  readAccountStatus():Promise<import('../account/status.ts').AccountStatusSnapshot|null>;
  subscribeAccountStatus(listener:()=>void):()=>void;
  readingProgress?: Pick<import("../reader/progress.ts").ReadingProgressStore,"load"|"save">;
  retryOfflineMedia?(id:string):Promise<{available:Record<string,string>;failed:number}>;
  readSummaryUsage?():Promise<import("../llm/usage.ts").UsageSnapshot>;
  clearSummaryUsage?():Promise<void>;
  subscribeSummaryUsage?(listener:()=>void):()=>void;
  hasSummaryAccount():Promise<boolean>;
  createSummary(id:string,preset:()=>number,changed:(state:import("../llm/summary.ts").SummaryState)=>void):import("../llm/summary.ts").SummarySession;
  listChannels(): Promise<Channel[]>;
  setOriginalUpdatesPaused(channelId:string,paused:boolean):void;
  requestOriginalContents(channelId:string,articleIds:string[]):Promise<void>;
  subscribeChannel(listener:(event:{id:string;kind:"refresh"|"original"|"error"|"library"|"notes";message?:string})=>void):()=>void;
  getChannelPlaybackSettings(id:string):Promise<{hasPlayableMedia:boolean;continuePlaybackInBackground:boolean}>;
  setChannelBackgroundPlayback(id:string,enabled:boolean):Promise<void>;
  getChannelOriginalMode(id: string): Promise<boolean>;
  setChannelOriginalMode(id: string, enabled: boolean): Promise<void>;
  moveChannelToTop(id: string): Promise<void>;
  setChannelPinned(id: string, pinned: boolean): Promise<void>;
  markChannelRead(id: string): Promise<void>;
  deleteChannel(id: string): Promise<void>;
  clearLocalContent(id: string): Promise<void>;
  deleteArticle(id: string): Promise<void>;
  listArticles(query?: ArticleQuery): Promise<Article[]>;
  searchArticles?(channelId:string,keyword:string):Promise<Article[]>;
  getArticle(id: string): Promise<Article | null>;
  getOriginalArticle(id: string): Promise<Article>;
  getSpeechSource?(article: Article, anchor?: import("../reader/speech-segments.ts").SpeechAnchor): Promise<import("../reader/speech-source.ts").SpeechSegmentSource | null>;
  loadImportedTextChunk?(handle:import("../reader/imported-text.ts").ImportedTextHandle,index:number):Promise<string|null>;
  addChannel(url: string): Promise<Channel>;
  previewChannel?(url:string):Promise<AddChannelPreview>;
  confirmAddChannel?(token:string):Promise<Channel>;
  refresh(channelId?: string): Promise<void>;
  markRead(articleId: string): Promise<void>;
  toggleSaved(articleId: string, saved?: boolean): Promise<void>;
  setSaveState(articleId: string, type: "favorite" | "watchLater", saved: boolean): Promise<void>;
  reorderSavedArticles(type:"favorite"|"watchLater",orderedIds:string[]):Promise<void>;
  listNotes(articleId?: string): Promise<Note[]>;
  saveNote(note: { articleId?: string; title: string; body: string }): Promise<Note>;
  /** Native text input (keyboard/IME). Resolves null when cancelled. */
  input(prompt: string, value?: string): Promise<string | null>;
  /** A live Android IME field aligned with an app-drawn search field. */
  openInlineInput?(value:string,bounds:{x:number;y:number;width:number;height:number},onChange:(value:string)=>void,onSubmit:()=>void,options?:{hint?:string;fontSizeSp?:number;inputType?:"text"|"uri"}):Promise<{close():Promise<void>}>;
  speak(text: string, rate?: number, started?: () => void, progress?: (event:import("../reader/speech-highlight.ts").SpeechProgress)=>void): Promise<void>;
  stopSpeech(): Promise<void>;
}
