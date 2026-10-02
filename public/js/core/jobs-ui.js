// The job tray: a non-blocking strip at the top of the page showing running and finished renames / tag saves.
import { h, icon } from './ui.js';
import { onJobs, cancelJob, dismissJob } from './jobs.js';

const cards = new Map(); // job -> { el, bar, count, label, state }
const nf = (n) => Number(n || 0).toLocaleString('en-US');
const ICON = { running: 'refresh-cw', done: 'circle-check', partial: 'triangle-alert', cancelled: 'triangle-alert', error: 'circle-x' };

function build(job) {
  const bar = h('span');
  const count = h('span', { class: 'job-count' });
  const label = h('span', { class: 'job-label mono' });
  const title = h('strong', { class: 'job-title' });
  const ic = h('span', { class: 'job-ic', 'aria-hidden': 'true' });
  const msg = h('p', { class: 'job-msg' });
  const note = h('p', { class: 'job-note' }, 'You can switch screens or apps. This keeps running.');
  const actions = h('div', { class: 'job-actions' });
  const el = h('section', { class: 'job', 'aria-label': job.title }, ic,
    h('div', { class: 'job-main' }, title, msg, h('div', { class: 'progress-bar' }, bar), h('div', { class: 'job-meta' }, count, label), note),
    actions);
  return { el, bar, count, label, title, ic, msg, note, actions, state: null };
}

function paint(job, c) {
  const r = job.result;
  const state = job.status;
  if (c.state !== state) {
    c.state = state;
    c.el.className = `job is-${state}`;
    c.ic.replaceChildren(icon(ICON[state] || 'info'));
    c.actions.replaceChildren();
    if (state === 'running') {
      c.actions.append(h('button', { type: 'button', class: 'btn btn-sm', onclick: () => cancelJob(job) }, icon('x'), h('span', null, 'Stop')));
    } else {
      (r?.actions || (r?.action ? [r.action] : [])).forEach((act, i) => c.actions.append(h('button', { type: 'button', class: `btn btn-sm ${i === 0 ? 'btn-primary' : ''}`, onclick: () => { dismissJob(job); act.onClick(); } }, act.label)));
      c.actions.append(h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Dismiss', title: 'Dismiss', onclick: () => dismissJob(job) }, icon('x')));
      c.el.querySelector('.job-details')?.remove();
      if (r?.details?.length) c.el.querySelector('.job-main').append(h('details', { class: 'job-details' }, h('summary', null, `${r.details.length} problem${r.details.length === 1 ? '' : 's'}`), h('ul', { class: 'mono small' }, r.details.slice(0, 200).map((d) => h('li', null, d)))));
    }
  }
  const total = job.total || 0;
  const pct = total ? Math.min(100, Math.round((job.done / total) * 100)) : 0;
  if (state === 'running') {
    c.title.textContent = job.title;
    c.msg.textContent = '';
    c.bar.style.width = `${pct}%`;
    c.bar.parentElement.removeAttribute('hidden');
    c.count.textContent = total ? `${nf(job.done)} of ${nf(total)} (${pct}%)` : `${nf(job.done)} done`;
    c.label.textContent = job.label || '';
    c.note.hidden = false;
  } else {
    c.title.textContent = job.title;
    c.msg.textContent = r?.message || '';
    c.bar.parentElement.setAttribute('hidden', '');
    c.count.textContent = ''; c.label.textContent = ''; c.note.hidden = true;
  }
}

export function mountJobTray(host) {
  const sync = (jobs) => {
    for (const job of jobs) {
      let c = cards.get(job);
      if (!c) { c = build(job); cards.set(job, c); host.append(c.el); }
      paint(job, c);
    }
    for (const [job, c] of cards) if (!jobs.includes(job)) { c.el.remove(); cards.delete(job); }
    host.hidden = !jobs.length;
    // Lists elsewhere on the page size themselves from the viewport; tell them how much room the tray takes.
    document.documentElement.style.setProperty('--jobs-h', jobs.length ? `${Math.ceil(host.getBoundingClientRect().height) + 12}px` : '0px');
  };
  onJobs(sync);
  host.hidden = true;
  window.addEventListener('resize', () => { if (!host.hidden) document.documentElement.style.setProperty('--jobs-h', `${Math.ceil(host.getBoundingClientRect().height) + 12}px`); });
}
