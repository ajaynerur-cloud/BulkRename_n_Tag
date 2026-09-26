// Restore UI piece: shows where saved paths point and lets the person re-point them to this computer.
import { h, icon, btn } from './ui.js';
import { isIdentity } from './remap.js';

/**
 * Panel shown above every restore preview: explains where the saved paths point and lets the person
 * re-point them to the folder on this computer.
 */
export function remapPanel({ manifest, rootName, remap, matched, total, allowDirs = true, dirsNote = '', onChange, onDetect, onPickFolder, samples = [] }) {
  const src = { dir: 'a folder', zip: 'a ZIP archive', mem: 'imported files', files: 'selected files' }[manifest.source] || 'a folder';
  const all = matched === total;
  const stripIn = h('input', { class: 'input input-num', type: 'number', min: 0, max: 20, value: remap.strip || 0, 'aria-label': 'Leading folders to skip' });
  const prefIn = h('input', { class: 'input mono', value: remap.prefix || '', placeholder: 'e.g. Music/Album', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Subfolder in the opened location' });
  const byName = h('input', { type: 'checkbox', class: 'check', checked: !!remap.byName && allowDirs, disabled: !allowDirs });
  const emit = () => onChange({ ...remap, strip: Math.max(0, parseInt(stripIn.value, 10) || 0), prefix: prefIn.value, byName: byName.checked });
  stripIn.addEventListener('change', emit); prefIn.addEventListener('change', emit); byName.addEventListener('change', emit);
  return h('div', { class: 'panel remap' },
    h('div', { class: 'panel-head' }, icon('folder-open'), h('h3', null, 'Where are the files now?')),
    h('p', { class: 'muted' }, `This file was made for ${src} named "${manifest.root}". Paths inside it are relative, so it works on any computer once they line up with the location you opened ("${rootName}").`),
    h('p', { class: `remap-status ${all ? 'ok' : matched ? 'warn' : 'bad'}` }, icon(all ? 'circle-check' : 'triangle-alert'),
      h('span', null, total ? `${matched} of ${total} items found here${isIdentity(remap) ? '' : ' with the path adjustments below'}.` : 'Nothing to match.')),
    !all ? h('p', { class: 'field-help' }, matched ? 'Some items are missing. They may already be restored, deleted, or in another folder. Adjust the paths or choose the right folder.' : 'Nothing lines up yet. Choose the folder that holds the files, or adjust the paths.') : null,
    h('div', { class: 'field-row' },
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Skip leading folders of saved paths'), stripIn),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Files are inside this subfolder here'), prefIn)),
    h('label', { class: 'field field-check' }, byName, h('span', null, 'Find subfolders that moved (by unique file names)'),
      h('small', { class: 'field-help' }, allowDirs ? 'Useful when folders were reorganised after the change.' : (dirsNote || 'Not available for this file.'))),
    remap.byName && remap.dirs?.length ? h('ul', { class: 'remap-dirs mono' }, remap.dirs.slice(0, 6).map(([a, b]) => h('li', null, h('span', { class: 'ex-old' }, a || '(top)'), h('span', { class: 'ex-new' }, b || '(top)')))) : null,
    samples.length ? h('div', { class: 'remap-samples' }, h('p', { class: 'field-label' }, 'Examples'),
      h('ul', { class: 'examples mono' }, samples.slice(0, 3).map(([a, b]) => h('li', null, h('span', { class: 'ex-old' }, a), h('span', { class: 'ex-new' }, b))))) : null,
    h('div', { class: 'btn-row' },
      onPickFolder ? btn('Choose the folder on this computer…', onPickFolder, { ic: 'folder-open', cls: 'btn-sm' }) : null,
      btn('Detect again', onDetect, { ic: 'wand-sparkles', cls: 'btn-sm btn-ghost' })));
}
