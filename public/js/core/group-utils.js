// Pure helpers for folder grouping (no DOM, so they can be tested in Node).

/**
 * Turn an ordered list of rows into list items: a folder header before each folder's rows.
 * Items are {head:true, dir, pos:[positions]} or {pos}. `pos` is an index into the ordered list.
 * Grouping only happens when more than one folder is involved; otherwise the list stays flat.
 */
export function buildItems(count, dirOf, collapsed = new Set()) {
  const order = []; const byDir = new Map();
  for (let p = 0; p < count; p++) {
    const d = dirOf(p);
    if (!byDir.has(d)) { byDir.set(d, []); order.push(d); }
    byDir.get(d).push(p);
  }
  if (order.length < 2) return { grouped: false, items: Array.from({ length: count }, (_, pos) => ({ pos })), dirs: order.map((d) => ({ dir: d, pos: byDir.get(d) })) };
  const items = [];
  for (const d of order) {
    const pos = byDir.get(d);
    items.push({ head: true, dir: d, pos });
    if (!collapsed.has(d)) for (const p of pos) items.push({ pos: p });
  }
  return { grouped: true, items, dirs: order.map((d) => ({ dir: d, pos: byDir.get(d) })) };
}

/** Visit rows in round-robin order across folders, so every folder moves forward together. */
export function interleave(rows, dirOf) {
  const lanes = new Map();
  for (const r of rows) { const d = dirOf(r); if (!lanes.has(d)) lanes.set(d, []); lanes.get(d).push(r); }
  const q = [...lanes.values()]; const out = [];
  for (let i = 0; q.some((l) => i < l.length); i++) for (const l of q) if (i < l.length) out.push(l[i]);
  return out;
}
