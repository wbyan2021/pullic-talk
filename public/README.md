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
- External CDN dependencies (fontshare, xterm, marked, hljs, DOMPurify) remain inline in HTML
- Server should serve this directory as static root (e.g., `express.static('public')`)
