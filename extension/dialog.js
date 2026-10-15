// Save dialog: shows what the conversion changed and asks what to save.

import { t, translatePage } from './lib/i18n.js';
import { el, renderReport } from './lib/report-view.js';
import { loadSettings } from './lib/settings.js';

await loadSettings(); // sets the language
translatePage();

const id = new URLSearchParams(location.search).get('job');
const key = `job:${id}`;
const job = (await chrome.storage.session.get(key))[key];
const $ = (x) => document.getElementById(x);

if (!job) {
  $('title').textContent = t('jobGone');
  $('report').append(el('p', { className: 'done', textContent: t('jobGoneText') }));
} else {
  document.title = t('saveTitle', { name: job.name });
  $('title').textContent = job.name;
  const r = job.report;
  const to = r.diff?.settings.highlights.find((h) => h.key === 'printer_settings_id')?.after || 'QIDI';
  $('subtitle').textContent = `${t('sources')[r.source] || r.source}${r.sourcePrinter ? ` · ${r.sourcePrinter}` : ''} → ${to}`;
  $('name-converted').textContent = job.convertedName;
  $('name-both').textContent = `${job.name} + ${job.convertedName}`;
  $('name-original').textContent = job.name;
  if (job.manual) {
    // The user already has the original of a file they picked themselves.
    $('btn-original').hidden = true;
    $('btn-both').hidden = true;
  }
  $('choice').hidden = false;
  $('report').append(renderReport(r));

  for (const button of document.querySelectorAll('[data-action]')) {
    button.addEventListener('click', () => act(button.dataset.action));
  }
  document.querySelector('.primary').focus();
}

async function act(action) {
  for (const b of document.querySelectorAll('[data-action]')) b.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'job-action', id, action });
  // The service worker closes this window; show the outcome if it does not.
  $('choice').replaceChildren(el('p', {
    className: 'done',
    textContent: res?.error
      ? t('error', { error: res.error })
      : res?.saved?.length ? t('saved', { names: res.saved.join(', ') }) : t('savedNothing'),
  }));
}
