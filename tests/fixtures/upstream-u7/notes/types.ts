export interface MemoNote {
  noteId: string;
  folderId: string | null;
  title: string;
  markdown: string;
  plainText: string;
  contentHash: string;
  baseContentHash: string;
  baseMarkdown: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  modifiedBy: string;
  deleted: boolean;
  deletedAt: number;
}

export interface MemoFolder {
  folderId: string;
  name: string;
  sortOrder: number;
  updatedAt: number;
  modifiedBy: string;
  deleted: boolean;
  deletedAt: number;
}

