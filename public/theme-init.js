// Applies a saved theme before first paint, so a light preference never flashes dark.
//
// This is a separate FILE rather than an inline <script> because the API serves the
// dashboard at /ui under `script-src 'self'` with no 'unsafe-inline' — an inline block is
// refused there, and the flash this code exists to prevent comes back on that deployment
// only (GitHub Pages sends no CSP, so it would keep working and hide the bug).
//
// It must stay synchronous — no defer/async — since running after first paint defeats the
// entire point. It is deliberately tiny for that reason.
try {
    var t = localStorage.getItem('chains:theme');
    if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) { /* private mode — fall back to prefers-color-scheme */ }
