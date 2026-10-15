// Intercepts 3MF downloads from MakerWorld and Printables, converts them for
// the chosen QIDI printer and asks in a dialog window what to save: the
// original, the converted file or both. The conversion runs in an offscreen
// document, which (unlike the service worker) can hand files to
// chrome.downloads as blob: URLs.

import { LocalizedError, t } from './lib/i18n.js';
import { addHistory, loadSettings, loadUserPresets, outputName } from './lib/settings.js';

const SOURCE_HOSTS = [
  /(^|\.)makerworld\.com$/,
  /(^|\.)bblmw\.com$/,
  /(^|\.)bambulab\.(com|cn)$/,
  /(^|\.)printables\.com$/,
  /(^|\.)prusa3d\.com$/,
];

// Downloads started by this extension, by URL, kept in session storage so a
// restarted service worker still knows them. They must not be intercepted
// again and need their file name re-suggested: this listener also runs for
// them, and an empty suggest() would name a blob: download after its UUID.
const OWN = 'ownDownloads';

async function save(url, filename) {
  const { [OWN]: own = {} } = await chrome.storage.session.get(OWN);
  own[url] = safeFileName(filename);
  await chrome.storage.session.set({ [OWN]: own });
  return chrome.downloads.download({ url, filename: own[url], conflictAction: 'uniquify' });
}

async function takeOwn(url) {
  const { [OWN]: own = {} } = await chrome.storage.session.get(OWN);
  if (!(url in own)) return undefined;
  const name = own[url];
  delete own[url];
  await chrome.storage.session.set({ [OWN]: own });
  return name;
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  decide(item).then((decision) => {
    if (decision.filename) suggest({ filename: decision.filename, conflictAction: 'uniquify' });
    else suggest();
    if (decision.intercept) {
      chrome.downloads.cancel(item.id).then(() => chrome.downloads.erase({ id: item.id })).catch(() => {});
      handle(item, decision.settings);
    }
  });
  return true;
});

async function decide(item) {
  const own = await takeOwn(item.url);
  if (own !== undefined) return { filename: own };
  if (item.byExtensionId === chrome.runtime.id || !is3mf(item) || !fromSourceSite(item)) return {};
  const settings = await loadSettings();
  return settings.enabled ? { intercept: true, settings } : {};
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Only this extension's own pages talk to the service worker.
  if (sender.id !== chrome.runtime.id || msg?.target === 'offscreen') return false;
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
  if (/3mf|3dmanufacturing/i.test(item.mime || '')) return true;
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
  let name = (item.filename || '').split(/[\\/]/).pop() || fileNameFromUrl(url);
  if (!/\.3mf$/i.test(name)) name += '.3mf';
  try {
    const source = url.startsWith('blob:') ? { base64: await fetchBlobFromPage(url) } : { url };
    await startJob({ name, source, settings, manual: false });
  } catch (e) {
    console.error('3MF download failed', e);
    await addHistory({ name, error: String(e?.message || e) });
    notify(t('notifyFailedTitle'), t('notifyFailedOriginal', { name, error: e?.message || e }));
    // Fall back to the original download so nothing is lost.
    if (!url.startsWith('blob:')) await save(url, name);
  }
}

// Converts the file and opens the dialog asking what to save.
async function startJob({ name, source, settings, manual }) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'convert',
    ...source,
    settings,
    userPresets: await loadUserPresets(),
  });
  if (!res) throw new LocalizedError('errNoResponse');
  if (res.fatal) throw new Error(res.fatal);
  const { originalUrl, convertedUrl, report, error } = res;
  if (error || !report.changed) {
    // Nothing to choose: save the original as it was downloaded.
    if (!manual) await save(originalUrl, name);
    revokeLater([originalUrl, convertedUrl]);
    await addHistory(error ? { name, error } : { name, filename: name, report });
    if (error) notify(t('notifyConversionFailed'), manual ? `${name}: ${error}` : t('notifySavedOriginal', { name, error }));
    else notify(t('notifyUnchanged', { name }), report.notes.map((n) => t(n.id, n.params)).join('\n'));
    return { done: true };
  }
  const id = crypto.randomUUID();
  const convertedName = outputName(name, settings.suffix, { printer: { model: res.printerModel } });
  const job = { id, name, convertedName, manual, originalUrl, convertedUrl, report };
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
  return safeFileName(filename);
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
    justification: 'Converting downloaded 3MF files and holding them until the user chooses what to save.',
  });
}

// blob: URLs only resolve inside the page that created them; try every open
// tab of that site.
async function fetchBlobFromPage(url) {
  const origin = new URL(new URL(url).pathname).origin;
  const tabs = await chrome.tabs.query({ url: `${origin}/*` });
  for (const tab of tabs) {
    try {
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
      if (result) return result;
    } catch {
      // Not the tab that created the blob.
    }
  }
  throw new LocalizedError('errPageClosed');
}

function fileNameFromUrl(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'model.3mf';
  } catch {
    return 'model.3mf';
  }
}

// chrome.downloads rejects names with path separators or reserved characters.
function safeFileName(name) {
  const clean = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 200);
  return clean || 'model.3mf';
}

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title,
    message: String(message).slice(0, 400),
  });
}
