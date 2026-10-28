import {kotlinTrim} from '@podjs/framework/text-compat';
/** Existing CLI single-TXT packages use this immutable local display hint. */
export const isCliSingleTextUrl = (url: string): boolean => /^watchrss:\/\/import\/online-v1\/[0-9a-f]{64}$/i.test(url);
/** Matches native ImportedContentIds, including its prefix matching behavior. */
export function isImportedContentUrl(url: string | null | undefined): boolean {
  const normalized = kotlinTrim(url ?? "").toLowerCase();
  return normalized.startsWith("https://watchrss.local/import-content") ||
    normalized.startsWith("https://watchrss.local/import-epub") ||
    normalized.startsWith("https://watchrss.local/import-txt-novel") ||
    normalized === "watchrss://phone-imports" || isCliSingleTextUrl(normalized);
}

/** Native channel deletion uses the same set of local source identifiers. */
export const isDeletableLocalContentChannel = isImportedContentUrl;

export function isImportedTextItemUrl(url: string | null | undefined): boolean {
  const normalized = kotlinTrim(url ?? "").toLowerCase();
  return normalized.startsWith("https://watchrss.local/import-content/txt/") || isCliSingleTextUrl(normalized);
}
