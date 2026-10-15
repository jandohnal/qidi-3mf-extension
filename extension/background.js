// Intercepts 3MF downloads from MakerWorld and Printables, converts them for
// the QIDI printer and asks in a dialog window what to save: the original, the
// converted file or both. The conversion runs in an offscreen document, which
// (unlike the service worker) can hand files to chrome.downloads as blob: URLs.

import { addHistory, loadSettings, outputName } from './lib/settings.js';

const SOURCE_HOSTS = [
  /(^|\.)makerworld\.com$/,
  /(^|\.)bblmw\.com$/,
  /(^|\.)bambulab\.(com|cn)$/,
  /(^|\.)printables\.com$/,
  /(^|\.)prusa3d\.com$/,
];

// Downloads started by this extension, by URL: they must not be intercepted
// again, and need their file name re-suggested here. This listener also runs
// for them, and an empty suggest() would make Chrome name a blob: download
// after the blob's UUID.
const ownDownloads = new Map();

function save(url, filename) {
  ownDownloads.set(url, filename);
  return chrome.downloads.download({ url, filename, conflictAction: 'uniquify' });
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const own = ownDownloads.get(item.url);
  if (own !== undefined) {
    ownDownloads.delete(item.url);
    suggest({ filename: own, conflictAction: 'uniquify' });
    return;
  }
  if (item.byExtensionId === chrome.runtime.id || !is3mf(item) || !fromSourceSite(item)) {
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const reply = (p) => p.then((r) => sendResponse(r ?? {}), (e) => sendResponse({ error: String(e?.message || e) }));
  if (msg?.type === 'job-action') {
    reply(finishJob(msg.id, msg.action));
    return true;
  }
  if (msg?.type === 'convert-upload') {
    // Manual conversion from the popup; the file waits in IndexedDB.
    reply(loadSettings().then((settings) => startJob({ name: msg.name, source: { uploadKey: msg.key }, settings, manual: true })));
    return true;
  }
  return false;
});

// Closing the dialog window without choosing saves nothing.
chrome.windows.onRemoved.addListener(async (windowId) => {
  const job = await findJob((j) => j.windowId === windowId);
  if (job) await finishJob(job.id, 'cancel');
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
    await startJob({ name, source, settings, manual: false });
  } catch (e) {
    console.error('3MF download failed', e);
    await addHistory({ name, error: String(e?.message || e) });
    notify('Soubor se nepodařilo zpracovat', `${name}: ${e?.message || e}. Stahuji původní soubor.`);
    // Fall back to the original download so nothing is lost.
    if (!url.startsWith('blob:')) await save(url, name);
  }
}

// Converts the file and opens the dialog asking what to save.
async function startJob({ name, source, settings, manual }) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'convert', ...source, settings });
  if (!res) throw new Error('převod neodpověděl');
  const { originalUrl, convertedUrl, report, error } = res;
  if (error || !report.changed) {
    // Nothing to choose: save the original as it was downloaded.
    if (!manual && originalUrl) await save(originalUrl, name);
    revokeLater([originalUrl, convertedUrl]);
    await addHistory(error ? { name, error } : { name, filename: name, report });
    notify(error ? 'Převod se nepovedl' : `Beze změny: ${name}`,
      error ? `${name}: ${error}${manual ? '' : '. Uložen původní soubor.'}` : report.notes.join('\n'));
    return { done: true };
  }
  const id = crypto.randomUUID();
  const job = { id, name, convertedName: outputName(name, settings.suffix), manual, originalUrl, convertedUrl, report };
  await chrome.storage.session.set({ [`job:${id}`]: job });
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(`dialog.html?job=${id}`),
    type: 'popup',
    width: 820,
    height: 900,
    focused: true,
  });
  await chrome.storage.session.set({ [`job:${id}`]: { ...job, windowId: win.id } });
  return { id };
}

async function finishJob(id, action) {
  const key = `job:${id}`;
  const job = (await chrome.storage.session.get(key))[key];
  if (!job) return { done: true };
  await chrome.storage.session.remove(key);
  const saved = [];
  if (action === 'original' || action === 'both') saved.push(await saveNamed(job.originalUrl, job.name));
  if (action === 'converted' || action === 'both') saved.push(await saveNamed(job.convertedUrl, job.convertedName));
  await addHistory({
    name: job.name,
    filename: saved.length ? saved.join(' + ') : undefined,
    report: { ...job.report, diff: undefined },
    action,
  });
  revokeLater([job.originalUrl, job.convertedUrl]);
  if (job.windowId !== undefined) chrome.windows.remove(job.windowId).catch(() => {});
  return { done: true, saved };
}

// Blobs must live until Chrome has read them; downloads start right away.
function revokeLater(urls) {
  setTimeout(() => {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'revoke', urls }).catch(() => {});
  }, 60_000);
}

async function saveNamed(url, filename) {
  await save(url, filename);
  return filename;
}

async function findJob(match) {
  const all = await chrome.storage.session.get(null);
  return Object.entries(all).filter(([k]) => k.startsWith('job:')).map(([, v]) => v).find(match);
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

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message,
  });
}
