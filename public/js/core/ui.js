// Small DOM toolkit: element builder, icons, toasts, dialogs, menus, progress, virtual list, downloads.

const SVG_NS = 'http://www.w3.org/2000/svg';

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && typeof v !== 'string' && k !== 'list') el[k] = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function icon(name, cls = '') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `ic ${cls}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

export const btn = (label, onClick, { cls = '', ic, title, type = 'button', disabled } = {}) =>
  h('button', { type, class: `btn ${cls}`.trim(), onclick: onClick, title, disabled, 'aria-label': !label && title ? title : null }, ic ? icon(ic) : null, label ? h('span', null, label) : null);

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }

// ---------- toasts ----------
export function toast(message, { type = 'info', action, timeout = 4500 } = {}) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(host); }
  const ico = { success: 'circle-check', error: 'circle-x', warn: 'triangle-alert', info: 'info' }[type] || 'info';
  const t = h('div', { class: `toast toast-${type}` }, icon(ico), h('span', { class: 'toast-msg' }, message));
  const close = () => { t.classList.add('out'); setTimeout(() => t.remove(), 200); };
  if (action) t.append(h('button', { class: 'btn btn-sm btn-ghost', type: 'button', onclick: () => { close(); action.onClick(); } }, action.label));
  t.append(h('button', { class: 'btn-icon', type: 'button', 'aria-label': 'Dismiss', onclick: close }, icon('x')));
  host.append(t);
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ---------- dialogs ----------
/**
 * openDialog({ title, body (Node|string), actions: [{label, value, cls, primary}], wide, onOpen })
 * Resolves with the chosen action value (or null when dismissed).
 */
export function openDialog({ title, body, actions = [{ label: 'Close', value: null }], wide = false, onOpen, validate } = {}) {
  return new Promise((resolve) => {
    const dlg = h('dialog', { class: `dialog ${wide ? 'dialog-wide' : ''}` });
    const form = h('form', { method: 'dialog' });
    const head = h('header', { class: 'dialog-head' }, h('h2', null, title),
      h('button', { type: 'button', class: 'btn-icon', 'aria-label': 'Close', onclick: () => finish(null) }, icon('x')));
    const content = h('div', { class: 'dialog-body' }, typeof body === 'string' ? h('p', null, body) : body);
    const foot = h('footer', { class: 'dialog-foot' });
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    for (const a of actions) {
      foot.append(h('button', {
        type: a.primary ? 'submit' : 'button',
        class: `btn ${a.cls || (a.primary ? 'btn-primary' : '')}`,
        onclick: (e) => {
          e.preventDefault();
          if (a.value !== null && validate && !validate(a.value)) return;
          finish(typeof a.value === 'function' ? a.value() : a.value);
        },
      }, a.label));
    }
    form.append(head, content, foot);
    dlg.append(form);
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); finish(null); });
    document.body.append(dlg);
    dlg.showModal();
    onOpen?.(dlg);
  });
}

export async function confirmDialog(title, message, { okText = 'Continue', danger = false, cancelText = 'Cancel' } = {}) {
  const r = await openDialog({
    title,
    body: typeof message === 'string' ? h('p', null, message) : message,
    actions: [{ label: cancelText, value: false }, { label: okText, value: true, primary: true, cls: danger ? 'btn-danger' : 'btn-primary' }],
  });
  return r === true;
}

export async function promptDialog(title, label, value = '', { okText = 'Save', placeholder = '' } = {}) {
  const input = h('input', { class: 'input', value, placeholder, 'aria-label': label });
  const r = await openDialog({
    title,
    body: h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input),
    actions: [{ label: 'Cancel', value: null }, { label: okText, value: () => input.value, primary: true }],
    onOpen: () => { input.focus(); input.select(); },
  });
  return r == null ? null : r;
}

// ---------- progress ----------
export function progress(title, { cancellable = true } = {}) {
  const bar = h('div', { class: 'progress-bar' }, h('span'));
  const label = h('p', { class: 'progress-label' }, 'Starting…');
  const count = h('p', { class: 'progress-count' });
  const state = { cancelled: false };
  const dlg = h('dialog', { class: 'dialog dialog-progress' },
    h('div', { class: 'dialog-body' }, h('h2', null, title), bar, label, count,
      cancellable ? h('div', { class: 'dialog-foot' }, h('button', { type: 'button', class: 'btn', onclick: () => { state.cancelled = true; label.textContent = 'Stopping after the current item…'; } }, 'Stop')) : null));
  dlg.addEventListener('cancel', (e) => e.preventDefault());
  document.body.append(dlg);
  dlg.showModal();
  let lastPaint = 0;
  return {
    get cancelled() { return state.cancelled; },
    set(done, total, text) {
      const now = performance.now();
      if (now - lastPaint < 60 && done !== total) return;
      lastPaint = now;
      bar.firstChild.style.width = total ? `${Math.round((done / total) * 100)}%` : '0%';
      if (text != null) label.textContent = text;
      count.textContent = total ? `${done.toLocaleString('en-US')} of ${total.toLocaleString('en-US')}` : '';
    },
    close() { dlg.close(); dlg.remove(); },
  };
}

/** Yield to the event loop so progress paints. */
export const tick = () => new Promise((r) => setTimeout(r, 0));

// ---------- menus ----------
let openMenuEl = null;
export function closeMenu() { if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; } }

export function menu(anchor, items, { align = 'start' } = {}) {
  closeMenu();
  const m = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { m.append(h('div', { class: 'menu-sep', role: 'separator' })); continue; }
    if (it.header) { m.append(h('div', { class: 'menu-header' }, it.header)); continue; }
    m.append(h('button', {
      type: 'button', role: 'menuitem', class: `menu-item ${it.danger ? 'danger' : ''}`, disabled: it.disabled,
      onclick: () => { closeMenu(); it.onClick?.(); },
    }, it.icon ? icon(it.icon) : h('span', { class: 'ic' }), h('span', { class: 'menu-text' }, h('span', null, it.label), it.hint ? h('small', null, it.hint) : null)));
  }
  document.body.append(m);
  const r = anchor.getBoundingClientRect();
  const mw = m.offsetWidth; const mh = m.offsetHeight;
  let left = align === 'end' ? r.right - mw : r.left;
  left = Math.max(8, Math.min(left, window.innerWidth - mw - 8));
  let top = r.bottom + 4;
  if (top + mh > window.innerHeight - 8) top = Math.max(8, r.top - mh - 4);
  m.style.left = `${left + window.scrollX}px`;
  m.style.top = `${top + window.scrollY}px`;
  openMenuEl = m;
  const first = m.querySelector('.menu-item:not([disabled])');
  first?.focus();
  m.addEventListener('keydown', (e) => {
    const list = [...m.querySelectorAll('.menu-item:not([disabled])')];
    const i = list.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); list[(i + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(i - 1 + list.length) % list.length]?.focus(); }
    else if (e.key === 'Escape') { closeMenu(); anchor.focus(); }
  });
  return m;
}

document.addEventListener('pointerdown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('[data-menu-anchor]')) closeMenu();
}, true);
window.addEventListener('resize', closeMenu);

// ---------- virtual list ----------
export class VirtualList {
  /**
   * @param {HTMLElement} viewport scrolling element
   * @param {{rowHeight: number|(()=>number), renderRow: (el:HTMLElement, index:number)=>void, overscan?: number}} opts
   */
  constructor(viewport, { rowHeight, renderRow, overscan = 8, className = 'vrow' }) {
    this.vp = viewport;
    this.rowHeightFn = typeof rowHeight === 'function' ? rowHeight : () => rowHeight;
    this.renderRow = renderRow;
    this.overscan = overscan;
    this.className = className;
    this.count = 0;
    this.spacer = h('div', { class: 'vspacer' });
    this.vp.append(this.spacer);
    this.pool = new Map();
    this.range = [0, -1];
    this.vp.addEventListener('scroll', () => this.update(), { passive: true });
    this.ro = new ResizeObserver(() => this.refresh());
    this.ro.observe(this.vp);
  }

  setCount(n) { this.count = n; this.refresh(); }

  refresh() {
    this.rh = this.rowHeightFn();
    this.spacer.style.height = `${this.count * this.rh}px`;
    this.range = [0, -1];
    for (const el of this.pool.values()) el.remove();
    this.pool.clear();
    this.update();
  }

  update() {
    const rh = this.rh || this.rowHeightFn();
    const top = this.vp.scrollTop;
    const height = this.vp.clientHeight || 600;
    const start = Math.max(0, Math.floor(top / rh) - this.overscan);
    const end = Math.min(this.count - 1, Math.ceil((top + height) / rh) + this.overscan);
    if (start === this.range[0] && end === this.range[1]) return;
    this.range = [start, end];
    for (const [i, el] of this.pool) if (i < start || i > end) { el.remove(); this.pool.delete(i); }
    for (let i = start; i <= end; i++) {
      if (this.pool.has(i)) continue;
      const el = h('div', { class: this.className, role: 'row' });
      el.style.transform = `translateY(${i * rh}px)`;
      el.style.height = `${rh}px`;
      this.renderRow(el, i);
      this.spacer.append(el);
      this.pool.set(i, el);
    }
  }

  /** Re-render visible rows without resetting scroll. */
  repaint() { for (const [i, el] of this.pool) { el.textContent = ''; this.renderRow(el, i); } }

  scrollToIndex(i) {
    const rh = this.rh || this.rowHeightFn();
    const top = i * rh;
    if (top < this.vp.scrollTop || top + rh > this.vp.scrollTop + this.vp.clientHeight) this.vp.scrollTop = top - this.vp.clientHeight / 2;
  }
}

// ---------- layout ----------
/** Phone layout (bottom navigation, one pane at a time). Keep in sync with the 767px breakpoint in app.css. */
export const isCompact = () => typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches;
export const isCoarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
/** Row height for virtual lists: two-line rows on narrow phones, taller rows for touch. */
export const rowHeightFor = (twoLine, touch, fine) => () => (typeof matchMedia === 'function' && matchMedia('(max-width: 640px)').matches ? twoLine : isCoarse() ? touch : fine);

// ---------- files ----------
/** True inside the Android app (Capacitor), where the web view cannot follow download links. */
export const isNativeApp = () => !!window.Capacitor?.isNativePlatform?.();

export function download(blob, filename) {
  if (isNativeApp()) return nativeSave(blob, filename);
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, style: 'display:none' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return Promise.resolve(true);
}

/** base64 of a Blob slice (3-byte aligned chunks keep the pieces concatenable). */
async function sliceBase64(blob, start, end) {
  const buf = new Uint8Array(await blob.slice(start, end).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * Android app: write the file to Documents/NameTag (visible in the Files app), written in chunks so large
 * ZIPs do not need one huge string, then offer the share sheet. Falls back to the app cache + share sheet
 * when public storage is not allowed.
 */
async function nativeSave(blob, filename) {
  const P = window.Capacitor?.Plugins || {};
  const FS = P.Filesystem;
  const safe = String(filename).replace(/[\\/:*?"<>|]+/g, '_');
  if (!FS) { toast('Saving is not available in this build.', { type: 'error' }); return false; }
  const CHUNK = 3 * 1024 * 1024;
  const writeTo = async (directory, path) => {
    for (let pos = 0, first = true; pos < blob.size || first; pos += CHUNK, first = false) {
      const data = await sliceBase64(blob, pos, Math.min(blob.size, pos + CHUNK));
      if (first) await FS.writeFile({ path, data, directory, recursive: true });
      else await FS.appendFile({ path, data, directory });
    }
    return (await FS.getUri({ path, directory })).uri;
  };
  const share = async (uri) => { try { await P.Share?.share({ title: safe, files: [uri], dialogTitle: `Share ${safe}` }); } catch { /* dismissed */ } };
  try {
    try { const st = await FS.checkPermissions(); if (st.publicStorage !== 'granted') await FS.requestPermissions(); } catch { /* Android 11+: not needed */ }
    const uri = await writeTo('DOCUMENTS', `NameTag/${safe}`);
    toast(`Saved to Documents/NameTag/${safe}`, { type: 'success', timeout: 9000, action: P.Share ? { label: 'Share', onClick: () => share(uri) } : null });
    return true;
  } catch (e) {
    try {
      const uri = await writeTo('CACHE', `exports/${safe}`);
      await share(uri);
      return true;
    } catch (e2) {
      toast(`Could not save ${safe}: ${e2.message || e.message}`, { type: 'error' });
      return false;
    }
  }
}

/** Save with the native picker when available, otherwise download. Returns false when the person cancels. */
export async function saveBlob(blob, suggestedName, { description = 'File', accept } = {}) {
  if (window.showSaveFilePicker) {
    try {
      const opts = { suggestedName };
      if (accept) opts.types = [{ description, accept }];
      const fh = await window.showSaveFilePicker(opts);
      const w = await fh.createWritable();
      await w.write(blob);
      await w.close();
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
      console.warn('Save picker failed, downloading instead', e);
    }
  }
  return download(blob, suggestedName);
}

export function pickFiles({ accept = '', multiple = true, directory = false } = {}) {
  if (directory && isNativeApp()) {
    // Android's file chooser cannot return a folder; pick several files (or a ZIP) instead.
    toast('Android cannot pick a whole folder here. Select all the files inside it, or open a ZIP of the folder.', { timeout: 8000 });
    directory = false; multiple = true;
  }
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept, multiple, style: 'display:none' });
    if (directory) { input.webkitdirectory = true; input.setAttribute('webkitdirectory', ''); }
    input.addEventListener('change', () => { resolve([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

export async function readFileText(file) { return typeof file.text === 'function' ? file.text() : new Response(file).text(); }

// ---------- schema forms ----------
/**
 * Render fields from a schema. Field: {key, label, type, options, placeholder, help, showIf(values), min, max, step, mono, rows}
 * Types: text textarea number checkbox select segment row info
 */
export function renderFields(fields, values, onChange) {
  const root = h('div', { class: 'fields' });
  const vis = [];
  const emit = () => { for (const [el, f] of vis) el.hidden = !f.showIf(values); onChange(values); };
  const build = (f) => {
    if (f.type === 'row') {
      const row = h('div', { class: 'field-row' }, f.fields.map(build));
      if (f.showIf) vis.push([row, f]);
      return row;
    }
    if (f.type === 'info') {
      const el = h('p', { class: 'field-info' }, f.label);
      if (f.showIf) vis.push([el, f]);
      return el;
    }
    const id = `f-${Math.random().toString(36).slice(2, 9)}`;
    let control;
    const v = values[f.key];
    switch (f.type) {
      case 'textarea':
        control = h('textarea', { id, class: `input ${f.mono ? 'mono' : ''}`, rows: f.rows || 4, placeholder: f.placeholder || '', spellcheck: 'false' });
        control.value = v ?? '';
        control.addEventListener('input', () => { values[f.key] = control.value; emit(); });
        break;
      case 'number':
        control = h('input', { id, type: 'number', class: 'input input-num', min: f.min, max: f.max, step: f.step || 1, value: v ?? '' });
        control.addEventListener('input', () => { values[f.key] = control.value === '' ? '' : Number(control.value); emit(); });
        break;
      case 'checkbox': {
        control = h('input', { id, type: 'checkbox', class: 'check' });
        control.checked = !!v;
        control.addEventListener('change', () => { values[f.key] = control.checked; emit(); });
        const wrap = h('label', { class: 'field field-check', for: id }, control, h('span', null, f.label), f.help ? h('small', { class: 'field-help' }, f.help) : null);
        if (f.showIf) vis.push([wrap, f]);
        return wrap;
      }
      case 'select':
        control = h('select', { id, class: 'input' }, f.options.map(([val, lab]) => h('option', { value: val }, lab)));
        control.value = v ?? f.options[0][0];
        control.addEventListener('change', () => { values[f.key] = control.value; emit(); });
        break;
      case 'segment': {
        control = h('div', { class: 'segment', role: 'radiogroup', 'aria-labelledby': `${id}-l` });
        for (const [val, lab] of f.options) {
          const b = h('button', { type: 'button', class: 'seg', role: 'radio', 'aria-checked': String(v === val) }, lab);
          b.addEventListener('click', () => {
            values[f.key] = val;
            control.querySelectorAll('.seg').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
            emit();
          });
          control.append(b);
        }
        break;
      }
      default:
        control = h('input', { id, class: `input ${f.mono ? 'mono' : ''}`, value: v ?? '', placeholder: f.placeholder || '', spellcheck: 'false', autocomplete: 'off' });
        control.addEventListener('input', () => { values[f.key] = control.value; emit(); });
    }
    const wrap = h('div', { class: `field ${f.wide ? 'field-wide' : ''}` },
      h('label', { class: 'field-label', id: `${id}-l`, for: id }, f.label), control,
      f.help ? h('small', { class: 'field-help' }, f.help) : null);
    if (f.showIf) vis.push([wrap, f]);
    return wrap;
  };
  for (const f of fields) root.append(build(f));
  for (const [el, f] of vis) el.hidden = !f.showIf(values);
  return root;
}
