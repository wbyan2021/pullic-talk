# Public Static Files

## Structure

```
public/
  css/
    index.css        — index.html styles
    chat.css         — chat.html styles
  js/
    index.js         — index.html JavaScript
    chat.js          — chat.html JavaScript
  index.html         — Main control deck page
  chat.html          — AI group chat page
```

## Notes

- HTML files reference CSS via `<link rel="stylesheet">` and JS via `<script src>`
- Third-party libraries are vendored locally in `vendor/` (marked, highlight.js, DOMPurify, xterm + addons) — no runtime CDN dependency except the fontshare font CSS (graceful degradation if offline)
- `ops.js` exposes `window.OPS` (auth token + fetch helper); the token is injected server-side at render time via the `<!--OPS:TOKEN-->` placeholder — never committed to git
- `installer.js` exposes `window.Installer` (shared one-click install modal used by index and chat pages)
- Server should serve this directory as static root (e.g., `express.static('public')`)
