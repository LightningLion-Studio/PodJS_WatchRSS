/** Matches native ImportedContentIds, including its prefix matching behavior. */
export function isImportedContentUrl(url: string | null | undefined): boolean {
  const normalized = url?.trim().toLowerCase() ?? "";
  return normalized.startsWith("https://watchrss.local/import-content") ||
    normalized.startsWith("https://watchrss.local/import-epub") ||
    normalized.startsWith("https://watchrss.local/import-txt-novel") ||
    normalized === "watchrss://phone-imports";
}

/** Native channel deletion uses the same set of local source identifiers. */
export const isDeletableLocalContentChannel = isImportedContentUrl;

export function isImportedTextItemUrl(url: string | null | undefined): boolean {
  return (url?.trim().toLowerCase() ?? "").startsWith("https://watchrss.local/import-content/txt/");
}
