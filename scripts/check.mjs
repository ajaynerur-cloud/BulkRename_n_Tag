// Syntax-checks every JS file and verifies that every asset the service worker precaches exists.
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const root = new URL('../public/', import.meta.url).pathname;
const walk = (d) => readdirSync(d).flatMap((n) => { const p = join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
let bad = 0;
for (const f of walk(join(root, 'js'))) if (f.endsWith('.js')) { try { execFileSync(process.execPath, ['--check', f]); } catch (e) { bad++; console.error(String(e.stderr)); } }
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const assets = [...sw.matchAll(/'([^'\s]+\.(?:html|js|css|woff2|png|svg|webmanifest))'/g)].map((m) => m[1]);
for (const a of assets) if (!existsSync(join(root, a))) { bad++; console.error('Missing precached asset:', a); }
const jsFiles = walk(join(root, 'js')).map((f) => f.slice(root.length));
for (const f of jsFiles) if (!assets.includes(f)) { bad++; console.error('Not precached by sw.js:', f); }
console.log(bad ? `${bad} problem(s)` : `OK: ${jsFiles.length} modules, ${assets.length} precached assets`);
process.exitCode = bad ? 1 : 0;
