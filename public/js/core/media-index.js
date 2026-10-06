// Android media library re-index. After a rename or tag save, music players, Gallery and Files read
// Android's media library (MediaStore), which still holds the old names and old tags until Android happens to
// rescan. So every job that changed files on the phone ends by asking Android to rescan exactly those files:
// new paths are indexed with their new tags, old paths are dropped. This is on by default; it is a no-op in
// the browser, for ZIPs and imports, and on app builds without the native scanMedia method.
//
// Opt out (not normally needed): localStorage['nametag.mediaIndex'] = 'off'.

const KEY = 'nametag.mediaIndex';

export function mediaIndexEnabled() {
  try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; }
}
export function setMediaIndexEnabled(on) {
  try { if (on) localStorage.removeItem(KEY); else localStorage.setItem(KEY, 'off'); } catch { /* ignore */ }
}

const plugin = () => (typeof window !== 'undefined' && window.Capacitor?.isNativePlatform?.() ? window.Capacitor?.Plugins?.NameTagFolders : null);

/**
 * Re-index the files `root` changed since the last call. `root` may be a folder-scoped stand-in from the batch
 * screen ({ scopeOf }). Never throws; resolves to the native result ({ requested, scanned, indexed }) or null.
 */
export async function reindexMedia(root) {
  const src = root?.scopeOf || root;
  if (!src || typeof src.takeMediaChanges !== 'function') return null;
  const req = src.takeMediaChanges();
  if (!req || !mediaIndexEnabled()) return null;
  const P = plugin();
  if (!P || typeof P.scanMedia !== 'function') return null;
  try { return await P.scanMedia(req); } catch (e) { console.warn('Media library re-index failed', e); return null; }
}
