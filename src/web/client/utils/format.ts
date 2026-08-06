/**
 * Cross-page formatting helpers shared by more than one screen. Page-specific
 * formatters (e.g. the Jobs page's verbose relative time, or the Library
 * pages' version-label wording) stay next to their page — only genuinely
 * general-purpose, identical-everywhere helpers belong here.
 */

/** Strips the protocol from a URL for compact display, e.g. "react.dev/reference". */
export function displayUrl(url: string | null | undefined): string {
  if (!url) return "";
  return url.replace(/^https?:\/\//, "");
}

/**
 * Returns a URL's host (host:port), dropping protocol and path — e.g.
 * `http://127.0.0.1:8080/api` → "127.0.0.1:8080". Falls back to the
 * protocol-stripped string when the input isn't a parseable URL.
 */
export function displayHost(url: string | null | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return displayUrl(url);
  }
}
