// Runs conversions for the service worker: gets the 3MF (download, page blob
// or popup upload), converts it and keeps blob: URLs of both the original and
// the converted file until the user decides which to save.

import { convert3mf } from './lib/convert.js';
import { LocalizedError, setLanguage } from './lib/i18n.js';
import { conversionOptions, loadBundle } from './lib/settings.js';
import { deleteUpload, getUpload } from './lib/uploads.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'revoke') {
    for (const url of msg.urls || []) if (url) URL.revokeObjectURL(url);
    sendResponse({});
    return false;
  }
  if (msg.type !== 'convert') return false;
  convert(msg).then(sendResponse, (e) => sendResponse({ fatal: String(e?.message || e) }));
  return true;
});

// Offscreen documents only get chrome.runtime, so the service worker passes
// the settings and imported user presets along.
async function convert({ url, base64, uploadKey, settings, userPresets }) {
  setLanguage(settings.language);
  const bytes = uploadKey ? await fromUpload(uploadKey) : base64 ? fromBase64(base64) : await download(url);
  const originalUrl = URL.createObjectURL(new Blob([bytes], { type: 'model/3mf' }));
  try {
    const bundle = await loadBundle(settings.printer, userPresets);
    const { bytes: out, report } = convert3mf(bytes, bundle, conversionOptions(settings));
    const convertedUrl = report.changed ? URL.createObjectURL(new Blob([out], { type: 'model/3mf' })) : undefined;
    return { originalUrl, convertedUrl, report, printerModel: bundle.printer.model };
  } catch (e) {
    console.error('3MF conversion failed', e);
    return { originalUrl, error: String(e?.message || e) };
  }
}

async function fromUpload(key) {
  const blob = await getUpload(key);
  await deleteUpload(key);
  if (!blob) throw new LocalizedError('errNoUpload');
  return new Uint8Array(await blob.arrayBuffer());
}

async function download(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new LocalizedError('errDownload', { status: res.status });
  return new Uint8Array(await res.arrayBuffer());
}

function fromBase64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
