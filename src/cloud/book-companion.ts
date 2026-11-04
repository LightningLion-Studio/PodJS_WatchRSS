import type {CloudObject} from './codec';
export const isBookCompanion=(o:CloudObject)=>/^book-catalogs\/[a-f0-9]{64}\.json$/.test(o.name)&&!o.privateBook&&!o.privateArticle&&!o.entryRef&&!o.objectKeyEnvelope&&!o.readerKeyEnvelope;
