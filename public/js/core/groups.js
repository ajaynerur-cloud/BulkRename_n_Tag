// Folder grouping for the long file lists (Renamer preview, Tag editor). Pure helpers plus the shared header row.
import { h, icon } from './ui.js';
export { buildItems, interleave } from './group-utils.js';

const nf = (n) => Number(n || 0).toLocaleString('en-US');
const CHIP = { saving: ['Saving', 'is-run'], waiting: ['Waiting', ''], done: ['Saved', 'is-ok'], failed: ['Problem', 'is-bad'] };

/**
 * Fill a list row with a folder header.
 * opts: {label, title, total, sel, changedLabel, state, collapsed, onToggle, onCheck(on), onEdit?}
 */
export function renderFolderHead(el, { label, title, total, sel, changedLabel = '', state = '', collapsed = false, onToggle, onCheck, onEdit }) {
  const all = total > 0 && sel === total;
  el.className = `vrow fhead ${sel ? 'is-sel' : ''}`;
  el.setAttribute('role', 'row');
  const box = h('input', { type: 'checkbox', class: 'check', checked: all, 'aria-label': `Select everything in ${label}`, onchange: (e) => onCheck(e.target.checked) });
  box.indeterminate = !all && sel > 0;
  const chip = CHIP[state];
  el.append(...[
    box,
    h('button', { type: 'button', class: 'fchev', 'aria-expanded': String(!collapsed), 'aria-label': collapsed ? `Show ${label}` : `Hide ${label}`, onclick: onToggle }, icon(collapsed ? 'chevron-right' : 'chevron-down')),
    h('span', { class: 'ficon', 'aria-hidden': 'true' }, icon('folder')),
    h('span', { class: 'fname mono', title: title || label }, label),
    h('span', { class: 'fmeta' }, `${nf(total)} file${total === 1 ? '' : 's'}`, changedLabel ? [' · ', h('b', null, changedLabel)] : null),
    chip ? h('span', { class: `fchip ${chip[1]}` }, chip[0]) : null,
    onEdit ? h('button', { type: 'button', class: 'btn btn-sm fedit', onclick: onEdit }, icon('pencil'), h('span', null, 'Edit folder')) : null,
  ].filter(Boolean));
}
