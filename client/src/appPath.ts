/** Resolves a path relative to the application mount point in the document. */
export function withAppBase(path: string, baseURI: string = document.baseURI): string {
  const base = new URL('.', baseURI);
  const url = new URL(path.replace(/^\/+/, ''), base);
  return url.pathname + url.search + url.hash;
}
