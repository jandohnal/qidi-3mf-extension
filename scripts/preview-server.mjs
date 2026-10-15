// Serves the extension folder with a stubbed `chrome.*` API so its pages can
// be looked at in a normal browser tab:
//   http://localhost:5199/popup.html
//   http://localhost:5199/dialog.html?job=demo   (needs --sample <file.3mf>)
// Usage: node scripts/preview-server.mjs [port] [--sample <file.3mf>]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..', 'extension');
const args = process.argv.slice(2);
const sampleIdx = args.indexOf('--sample');
const SAMPLE = sampleIdx >= 0 ? args[sampleIdx + 1] : undefined;
const PORT = Number(args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--sample') || 5199);
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' };

const STUB = `<script>
  const store = { sync: {}, session: {}, local: { history: [{ name: 'ukazka.3mf', filename: 'ukazka (Q1 Pro).3mf', time: Date.now(),
    report: { changed: true, warnings: ['Ukázkové varování'], notes: ['Ukázková poznámka'] } }] } };
  // dialog.html?job=demo converts the sample file into a job on first read.
  async function demoJob() {
    const { convert3mf } = await import('/lib/convert.js');
    const bundle = await (await fetch('/profiles/printer.json')).json();
    const bytes = new Uint8Array(await (await fetch('/__sample.3mf')).arrayBuffer());
    const { report } = convert3mf(bytes, bundle, {});
    const name = ${JSON.stringify(SAMPLE ? path.basename(SAMPLE) : 'sample.3mf')};
    return { id: 'demo', name, convertedName: name.replace(/\\.3mf$/i, '') + ' (Q1 Pro).3mf', manual: false, report };
  }
  const area = (name) => ({
    get: async (key) => {
      if (name === 'session' && key === 'job:demo' && !store.session[key]) store.session[key] = await demoJob();
      return { [key]: store[name][key] };
    },
    set: async (obj) => Object.assign(store[name], obj),
  });
  window.chrome = {
    runtime: {
      getURL: (p) => '/' + p,
      sendMessage: async (m) => {
        console.log('message', JSON.stringify(m));
        if (m.type === 'job-action') return { saved: m.action === 'cancel' ? [] : [m.action] };
        return {};
      },
    },
    storage: { sync: area('sync'), local: area('local'), session: area('session') },
  };
</script>`;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__sample.3mf' && SAMPLE) {
    res.writeHead(200, { 'content-type': 'application/octet-stream' }).end(fs.readFileSync(SAMPLE));
    return;
  }
  const file = path.join(ROOT, path.normalize(decodeURIComponent(url.pathname === '/' ? '/popup.html' : url.pathname)));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('not found');
    return;
  }
  let body = fs.readFileSync(file);
  if (/(popup|dialog)\.html$/.test(file)) body = body.toString().replace('<head>', `<head>${STUB}`);
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body);
}).listen(PORT, () => console.log(`Preview: http://localhost:${PORT}/popup.html${SAMPLE ? `, http://localhost:${PORT}/dialog.html?job=demo` : ''}`));
