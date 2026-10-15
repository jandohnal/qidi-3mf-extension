// Runs conversions for the service worker: fetches the 3MF, converts it and
// returns a blob: URL chrome.downloads can save.

import { convert3mf } from './lib/convert.js';
import { loadBundle } from './lib/settings.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen' || msg.type !== 'convert') return false;
  convert(msg).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

async function convert({ url, base64, settings }) {
  const bytes = base64 ? fromBase64(base64) : await download(url);
  const { bytes: out, report } = convert3mf(bytes, await loadBundle(), settings);
  const blobUrl = URL.createObjectURL(new Blob([out], { type: 'model/3mf' }));
  // The download has long started by then.
  setTimeout(() => URL.revokeObjectURL(blobUrl), 10 * 60 * 1000);
  return { blobUrl, report };
}

async function download(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`stažení selhalo (HTTP ${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
}

function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
