// Intercepts 3MF downloads from MakerWorld and Printables and saves a copy
// converted for the QIDI printer instead. The conversion itself runs in an
// offscreen document, which (unlike the service worker) can hand the result to
// chrome.downloads as a blob: URL.

import { addHistory, loadSettings, outputName } from './lib/settings.js';

const SOURCE_HOSTS = [
  /(^|\.)makerworld\.com$/,
  /(^|\.)bblmw\.com$/,
  /(^|\.)bambulab\.(com|cn)$/,
  /(^|\.)printables\.com$/,
  /(^|\.)prusa3d\.com$/,
];

// Downloads started by this extension must not be intercepted again.
const ownDownloads = new Set();

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (ownDownloads.has(item.id) || item.byExtensionId === chrome.runtime.id || !is3mf(item) || !fromSourceSite(item)) {
    suggest();
    return;
  }
  // The decision needs the settings, so answer asynchronously.
  loadSettings().then((settings) => {
    if (!settings.enabled) {
      suggest();
      return;
    }
    chrome.downloads.cancel(item.id).then(() => chrome.downloads.erase({ id: item.id }));
    suggest();
    handle(item, settings);
  });
  return true;
});

function is3mf(item) {
  if ((item.filename || '').toLowerCase().endsWith('.3mf')) return true;
  try {
    return new URL(item.finalUrl || item.url).pathname.toLowerCase().endsWith('.3mf');
  } catch {
    return false;
  }
}

function fromSourceSite(item) {
  return [item.referrer, item.url, item.finalUrl].some((u) => {
    try {
      const url = new URL(u);
      const host = url.protocol === 'blob:' ? new URL(url.pathname).hostname : url.hostname;
      return SOURCE_HOSTS.some((re) => re.test(host));
    } catch {
      return false;
    }
  });
}

async function handle(item, settings) {
  const url = item.finalUrl || item.url;
  const name = (item.filename || '').split(/[\\/]/).pop() || fileNameFromUrl(url);
  try {
    const source = url.startsWith('blob:') ? { base64: await fetchBlobFromPage(url) } : { url };
    await ensureOffscreen();
    const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'convert', ...source, settings });
    if (res?.error) throw new Error(res.error);
    const { blobUrl, report } = res;
    const filename = report.changed ? outputName(name, settings.suffix) : name;
    const id = await chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify' });
    ownDownloads.add(id);
    await addHistory({ name, filename, report });
    notify(report.changed ? `Převedeno: ${filename}` : `Beze změny: ${filename}`, summary(report));
  } catch (e) {
    console.error('3MF conversion failed', e);
    await addHistory({ name, error: String(e?.message || e) });
    notify('Převod se nepovedl', `${name}: ${e?.message || e}. Stahuji původní soubor.`);
    // Fall back to the original download so nothing is lost.
    if (!url.startsWith('blob:')) {
      const id = await chrome.downloads.download({ url, filename: name, conflictAction: 'uniquify' });
      ownDownloads.add(id);
    }
  }
}

async function ensureOffscreen() {
  const path = 'offscreen.html';
  const existing = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(path)],
  });
  if (existing.length) return;
  await chrome.offscreen.createDocument({
    url: path,
    reasons: ['BLOBS'],
    justification: 'Converting downloaded 3MF files and saving the result.',
  });
}

// blob: URLs only resolve inside the page that created them.
async function fetchBlobFromPage(url) {
  const origin = new URL(new URL(url).pathname).origin;
  const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
  if (!tab) throw new Error('stránka, která soubor vytvořila, už není otevřená');
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [url],
    func: async (blobUrl) => {
      const buf = new Uint8Array(await (await fetch(blobUrl)).arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    },
  });
  return result;
}

function fileNameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'model.3mf';
  } catch {
    return 'model.3mf';
  }
}

function summary(report) {
  return [...report.warnings.map((w) => `⚠ ${w}`), ...report.notes].join('\n').slice(0, 400);
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
}
