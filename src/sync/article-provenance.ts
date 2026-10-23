import type {IncomingArticle} from './article-receiver';
/** Body identity is separately pinned by the verified encoding-cache hash.
 * Derived text, local row IDs and clocks reconstructed by old readers do not
 * establish origin. Every transferable state field must still match. */
export function articleState(a:IncomingArticle&Partial<{independentSaved:boolean;independentChangedAt:number;independentSortOrder:number}>){return JSON.stringify([a.url,a.title,a.excerpt,a.imageUrl,a.rssSourceUrl,a.independentSaved??false,a.favoriteSaved,a.favoriteChangedAt,a.favoriteSortOrder,a.watchLaterSaved,a.watchLaterChangedAt,a.watchLaterSortOrder,a.readingProgress,a.readingPositionBytes,a.readingPositionContentHash,a.readingPositionChangedAt,a.isRead]);}
