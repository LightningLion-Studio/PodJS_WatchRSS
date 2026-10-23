export function parseLegacyArticleIds(input:unknown):string[]{if(!Array.isArray(input)||input.length>128||input.some(id=>typeof id!=='string'||!id.trim()||id.length>512))throw Error('Invalid legacy article aliases');return [...new Set(input as string[])];}
/** A legacy ID cannot name two canonical articles, including across batches. */
export function assertUniqueArticleAliases(rows:readonly {articleId:string;legacyArticleIds?:readonly string[]}[],owners=new Map<string,string>()){
 for(const row of rows)for(const id of [row.articleId,...row.legacyArticleIds??[]]){const old=owners.get(id);if(old!==undefined&&old!==row.articleId)throw Error('Ambiguous legacy article alias');owners.set(id,row.articleId);}return owners;
}
