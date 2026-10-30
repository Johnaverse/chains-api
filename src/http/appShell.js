import { readFile } from 'node:fs/promises';

/**
 * The dashboard page with a <base> at the app's root, for a copy served at a deeper path:
 * a profile at <base>chains/<id> still loads app.js, style.css and the rest from the root.
 * Used for /ui/chains/:id here and for the GitHub Pages 404.html (.github/workflows/static.yml).
 */
export function withBase(html, base) {
  const href = base.endsWith('/') ? base : `${base}/`;
  if (!/^\/[\w\-/.]*$/.test(href)) throw new Error(`Invalid base path: ${base}`);
  return html.replace(/<head>/i, `<head>\n    <base href="${href}">`);
}

/** index.html read once, then served with the given base. */
export function appShell(indexPath, base) {
  let page = null;
  return async () => (page ??= withBase(await readFile(indexPath, 'utf8'), base));
}
