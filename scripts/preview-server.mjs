// Serves the extension folder with a stubbed `chrome.*` API so the popup can
// be looked at in a normal browser tab: http://localhost:5199/popup.html
// Usage: node scripts/preview-server.mjs [port]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', 'extension');
const PORT = Number(process.argv[2] || 5199);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const STUB = `<script>
  const store = { sync: {}, local: { history: [{ name: 'ukazka.3mf', filename: 'ukazka (Q1 Pro).3mf', time: Date.now(),
    report: { changed: true, warnings: ['Ukázkové varování'], notes: ['Ukázková poznámka'] } }] } };
  const area = (name) => ({
    get: async (key) => ({ [key]: store[name][key] }),
    set: async (obj) => Object.assign(store[name], obj),
  });
  window.chrome = {
    runtime: {
      getURL: (p) => '/' + p,
      sendMessage: async (m) => { if (m.type === 'save') { const a = document.createElement('a'); a.href = m.url; a.download = m.filename; a.click(); } return { id: 1 }; },
    },
    storage: { sync: area('sync'), local: area('local') },
    downloads: { download: async (o) => { console.log('download', o.filename); const a = document.createElement('a'); a.href = o.url; a.download = o.filename; a.click(); return 1; } },
  };
</script>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname === '/' ? '/popup.html' : url.pathname)));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = fs.readFileSync(file);
  if (file.endsWith('popup.html')) body = body.toString().replace('<head>', `<head>${STUB}`);
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
}).listen(PORT, () => console.log(`Popup preview: http://localhost:${PORT}/popup.html`));
