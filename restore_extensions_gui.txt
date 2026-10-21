#!/usr/bin/env python3
"""
Restore original file names / extensions (window version). Works with ANY restore JSON.

1. Choose WHERE the files are: a folder or a ZIP (a ZIP is never changed; it is restored into a folder you choose).
2. Choose WHICH restore file to use: find it automatically, pick one that was found, or browse for your own.
   Any JSON that lists renames works: NameTag undo files, rename-map.json, lists of {"original","renamed"},
   {"from","to"} or {"old","new"} records, {"a.txt": "a.js"} mappings, lists of pairs, ... Which side is the
   .txt copy is detected automatically.
3. Press Preview (changes nothing) or Restore.

Needs Python 3.8+ with tkinter (included with the python.org installers on Windows/macOS;
on Linux:  sudo apt install python3-tk).
"""
import json
import os
import queue
import re
import shutil
import tempfile
import threading
import zipfile
import tkinter as tk
from tkinter import ttk, filedialog, messagebox

HERE = os.path.dirname(os.path.abspath(__file__))
TMP_PREFIX = ".nametag-tmp-"

class RestoreError(Exception):
    pass


KEYWORDS = ("rename", "restore", "undo", "map", "manifest", "nametag", "revert", "backup", "original", "extension")
# Field names recognised in "record" style files, e.g. {"original": "a.js", "renamed": "a.txt"}
ORIG_KEYS = ("original", "orig", "original_name", "original_path", "originalname", "originalpath", "original_file",
             "old", "old_name", "old_path", "oldname", "oldpath", "old_file", "from", "src", "source", "source_path",
             "src_path", "before", "previous", "prev", "name", "path", "file")
NEW_KEYS = ("renamed", "renamed_name", "renamed_path", "renamed_file", "new", "new_name", "new_path", "newname",
            "newpath", "new_file", "to", "dst", "dest", "destination", "target", "target_path", "dst_path", "after",
            "current", "current_name", "current_path", "txt", "txt_name", "txt_path", "output")


def native(p):
    return os.path.join(*p.replace("\\", "/").split("/"))


# ------------------------------------------------------------------ reading any restore file
def _s(v):
    return v if isinstance(v, str) and v.strip() else None


def _pathy(s):
    return isinstance(s, str) and ("." in s or "/" in s or "\\" in s)


def _record_pair(d):
    low = {re.sub(r"[\s\-]+", "_", k.lower()): v for k, v in d.items() if isinstance(k, str)}
    a = next((_s(low[k]) for k in ORIG_KEYS if _s(low.get(k))), None)
    b = next((_s(low[k]) for k in NEW_KEYS if _s(low.get(k))), None)
    return (a, b) if a and b and a != b else None


def _is_mapping(d):
    items = list(d.items())
    return bool(items) and all(isinstance(v, str) for _, v in items) and \
        sum(1 for k, v in items if _pathy(k) and _pathy(v)) >= max(1, len(items) * 0.5)


def _collect(node, pairs, singles, depth=0):
    if depth > 8:
        return
    if isinstance(node, dict):
        rp = _record_pair(node)
        if rp:
            pairs.append(rp)
            return
        if _is_mapping(node):
            pairs.extend((k, v) for k, v in node.items() if k != v)
            return
        for k, v in node.items():
            if isinstance(v, dict):
                if _pathy(k):  # {"a.txt": {"original": "a.js"}}
                    inner = next((_s(v.get(x)) for x in ORIG_KEYS + NEW_KEYS if _s(v.get(x))), None)
                    if inner and inner != k:
                        pairs.append((k, inner))
                        continue
                _collect(v, pairs, singles, depth + 1)
            elif isinstance(v, list):
                _collect(v, pairs, singles, depth + 1)
    elif isinstance(node, list):
        if node and all(isinstance(x, str) for x in node):
            singles.extend(x for x in node if _pathy(x))
            return
        for x in node:
            if isinstance(x, (list, tuple)) and len(x) == 2 and all(isinstance(y, str) for y in x):
                pairs.append((x[0], x[1]))
            elif isinstance(x, (dict, list)):
                _collect(x, pairs, singles, depth + 1)


def _describe(data):
    t = json.dumps(data, ensure_ascii=False)[:300]
    if isinstance(data, dict):
        return f"an object with keys: {', '.join(list(map(str, data))[:12])}\n  start: {t}"
    if isinstance(data, list):
        return f"a list of {len(data)} item(s)\n  start: {t}"
    return t


def segs(p):
    p = p.replace("\\", "/")
    p = re.sub(r"^[A-Za-z]:", "", p)
    parts = [x for x in p.split("/") if x not in ("", ".")]
    if ".." in parts:
        raise RestoreError(f"Unsafe path in the restore file: {p}")
    return parts


def read_json(path):
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            return json.load(f)
    except (OSError, ValueError) as e:
        raise RestoreError(f"Cannot read {os.path.basename(path)} as JSON: {e}")


def _is_tmp(parts):
    return bool(parts) and parts[-1].startswith(TMP_PREFIX)


def parse_restore_json(path):
    """Any JSON that lists renames. Returns {entries: [options], strict, root, created, desc}.
    An 'option' is (current_segments, original_segments); several options = direction decided by what exists."""
    data = read_json(path)
    root = data.get("root") if isinstance(data, dict) and isinstance(data.get("root"), str) else None
    created = data.get("createdAt") if isinstance(data, dict) and isinstance(data.get("createdAt"), str) else None
    # NameTag undo file: exact direction and order are known
    if isinstance(data, dict) and data.get("app") == "NameTag" and isinstance(data.get("operations"), list):
        ops = data["operations"]
        if data.get("status") == "in-progress" and isinstance(data.get("doneIdx"), list):
            ops = [ops[i] for i in sorted(data["doneIdx"]) if 0 <= i < len(ops)]
        entries = []
        for o in ops:
            if isinstance(o, dict) and isinstance(o.get("from"), str) and isinstance(o.get("to"), str):
                entries.append([(segs(o["to"]), segs(o["from"]))])
        if not entries:
            raise RestoreError("This NameTag file has no rename operations.")
        return {"entries": entries, "strict": True, "root": root, "created": created, "desc": "NameTag undo file"}
    pairs, singles = [], []
    _collect(data, pairs, singles)
    entries = []
    for a, b in pairs:
        A, B = segs(a), segs(b)
        if not A or not B or A == B:
            continue
        ta, tb = a.lower().endswith(".txt"), b.lower().endswith(".txt")
        if ta and not tb:
            entries.append([(A, B)])        # a is the .txt copy, b the original
        elif tb and not ta:
            entries.append([(B, A)])
        else:
            entries.append([(A, B), (B, A)])  # decided by which one exists
    if not entries:
        for s in singles:  # only original names are listed: the .txt copy is name.txt or name.ext.txt
            S = segs(s)
            if not S:
                continue
            stem = S[:-1] + [S[-1].rsplit(".", 1)[0] + ".txt"] if "." in S[-1] else S[:-1] + [S[-1] + ".txt"]
            entries.append([(stem, S), (S[:-1] + [S[-1] + ".txt"], S)])
    if not entries:
        raise RestoreError("No renamed-file pairs could be found in this JSON file.\n"
                           f"It is {_describe(data)}\n"
                           "Expected pairs such as {\"original\": ..., \"renamed\": ...}, {\"from\": ..., \"to\": ...} "
                           "or {\"a.txt\": \"a.js\"}.")
    return {"entries": entries, "strict": False, "root": root, "created": created, "desc": "restore map"}


# ------------------------------------------------------------------ finding the files
def find_jsons(folder, depth=4):
    """Candidate restore files inside folder: .json / .json.txt whose name hints at a rename map."""
    keyed, other = [], []
    base_depth = folder.rstrip(os.sep).count(os.sep)
    for dirpath, dirnames, filenames in os.walk(folder):
        if dirpath.count(os.sep) - base_depth >= depth:
            dirnames[:] = []
        dirnames[:] = [d for d in dirnames if d not in (".git", "node_modules", ".gradle")]
        for n in filenames:
            low = n.lower()
            keyword = any(k in low for k in KEYWORDS)
            if not (low.endswith((".json", ".json.txt")) or (low.endswith(".txt") and keyword)):
                continue
            p = os.path.join(dirpath, n)
            try:
                if os.path.getsize(p) > 50 * 1024 * 1024:
                    continue
            except OSError:
                continue
            (keyed if any(k in low for k in KEYWORDS) else other).append(p)
    out = []
    for p in sorted(keyed, key=os.path.basename, reverse=True) + (sorted(other)[:60] if not keyed else []):
        try:
            parse_restore_json(p)
            out.append(p)
        except RestoreError:
            pass
    return out


def zip_jsons(zip_path):
    with zipfile.ZipFile(zip_path) as z:
        names = [n for n in z.namelist() if not n.endswith("/") and (n.lower().endswith((".json", ".json.txt")) or (
            n.lower().endswith(".txt") and any(k in os.path.basename(n).lower() for k in KEYWORDS)))]
    keyed = [n for n in names if any(k in os.path.basename(n).lower() for k in KEYWORDS)]
    return sorted(keyed or names[:60], key=os.path.basename, reverse=True)


def extract_zip(zip_path, out, log):
    if os.path.exists(out) and os.listdir(out):
        raise RestoreError(f"The output folder is not empty:\n{out}\nChoose another folder.")
    os.makedirs(out, exist_ok=True)
    root = os.path.realpath(out)
    with zipfile.ZipFile(zip_path) as z:
        for n in z.namelist():
            real = os.path.realpath(os.path.join(out, n))
            if real != root and not real.startswith(root + os.sep):
                raise RestoreError(f"Unsafe path in ZIP: {n}")
        log(f"Extracting {os.path.basename(zip_path)} ...")
        z.extractall(out)
        for i in z.infolist():  # put executable bits back
            mode = (i.external_attr >> 16) & 0o777
            if mode and not i.is_dir():
                try:
                    os.chmod(os.path.join(out, i.filename), mode)
                except OSError:
                    pass


def rezip(folder, zip_path):
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for dirpath, _d, files in os.walk(folder):
            for n in sorted(files):
                full = os.path.join(dirpath, n)
                zi = zipfile.ZipInfo.from_file(full, os.path.relpath(full, os.path.dirname(folder)))
                zi.compress_type = zipfile.ZIP_DEFLATED
                with open(full, "rb") as f:
                    z.writestr(zi, f.read())


def _pick(opts, base, k):
    """Match the disk: ('ok'|'already'|'missing', current_path, destination_path). The current file must
    exist for 'ok'; with two possible directions the one whose file exists wins."""
    paths = []
    for cur, orig in opts:
        if len(cur) <= k or len(orig) <= k:
            continue
        paths.append((os.path.join(base, *cur[k:]), os.path.join(base, *orig[k:])))
    for cp, dp in paths:
        if os.path.lexists(cp):
            return "ok", cp, dp
    for cp, dp in paths:
        if os.path.lexists(dp):
            return "already", cp, dp
    return ("missing",) + (paths[0] if paths else (None, None))


def prepare(work, jpath):
    """Matches the restore file against the files on disk. Returns the plan (nothing is renamed yet)."""
    spec = parse_restore_json(jpath)
    entries = spec["entries"]
    real = [e for e in entries if not _is_tmp(e[0][0])]
    sample = real if len(real) <= 800 else real[::len(real) // 800 + 1]
    bases = [work]
    if spec["root"]:
        bases.append(os.path.join(work, spec["root"]))
    try:
        bases += [os.path.join(work, d) for d in sorted(os.listdir(work)) if os.path.isdir(os.path.join(work, d))][:12]
    except OSError:
        pass
    bases = [b for i, b in enumerate(bases) if os.path.isdir(b) and b not in bases[:i]]
    best = None
    for bi, b in enumerate(bases):
        for k in range(0, 11):  # k = leading folders of the saved paths to skip (e.g. C:\Users\me\Downloads\...)
            sc = sum(1 for opts in sample if _pick(opts, b, k)[0] != "missing")
            key = (sc, -k, -bi)
            if best is None or key > best[0]:
                best = (key, b, k)
    (_, _, _), base, k = best
    plan = []
    index = None
    for opts in entries:
        st, cp, dp = _pick(opts, base, k)
        if st == "missing" and not spec["strict"] and not _is_tmp(opts[0][0]):
            if index is None:  # last resort: find the renamed file by its unique name anywhere below
                index = {}
                for dp_, dn, fn in os.walk(work):
                    dn[:] = [d for d in dn if d not in (".git", "node_modules")]
                    for n in fn:
                        index.setdefault(n.lower(), []).append(os.path.join(dp_, n))
            hits = index.get(opts[0][0][-1].lower(), [])
            if len(hits) == 1:
                st, cp, dp = "ok", hits[0], os.path.join(os.path.dirname(hits[0]), opts[0][1][-1])
        if cp is None:
            continue
        plan.append({"cur": cp, "dst": dp, "status": st, "tmp": _is_tmp(opts[0][0])})
    found = sum(1 for p in plan if p["status"] != "missing" and not p["tmp"])
    total = sum(1 for p in plan if not p["tmp"])
    if found == 0:
        ex = [os.path.join(*o[0][0]) for o in real[:3]]
        raise RestoreError(f"None of the {total} files listed in {os.path.basename(jpath)} were found in\n{work}\n"
                           f"For example it expects: {', '.join(ex)}\n"
                           "Check that you chose the right folder/ZIP and the right restore file.")
    return {"spec": spec, "plan": plan, "base": base, "skip": k, "found": found, "total": total}


def execute(prep, dry_run, log, rel_to=None):
    """Renames the files back. A NameTag file is undone backwards (exact order); other maps in listed order."""
    plan = prep["plan"]
    items = list(reversed(plan)) if prep["spec"]["strict"] else plan
    ok = already = missing = blocked = failed = 0
    shown = 0
    for p in items:
        src, dst = p["cur"], p["dst"]
        rel = lambda x: os.path.relpath(x, rel_to or prep["base"])
        if not os.path.lexists(src):
            if os.path.lexists(dst):
                already += 1
            elif not p["tmp"]:
                missing += 1
                log(f"missing   {rel(src)}")
            continue
        if os.path.lexists(dst) and os.path.normcase(src) != os.path.normcase(dst):
            blocked += 1
            log(f"blocked   {rel(src)}  (target {os.path.basename(dst)} already exists)")
            continue
        if dry_run:
            ok += 1
            shown += 1
            if shown <= 300:
                log(f"{rel(src)}  ->  {os.path.basename(dst)}")
            continue
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            os.rename(src, dst)
            ok += 1
        except OSError as e:
            failed += 1
            log(f"FAILED    {rel(src)}: {e}")
    return ok, already, missing, blocked, failed


def choose_best_json(work, cands):
    """Several candidates: use the one that matches the most files on disk."""
    best = None
    for p in cands:
        try:
            pr = prepare(work, p)
            key = (pr["found"], os.path.basename(p))
        except RestoreError:
            continue
        if best is None or key > best[0]:
            best = (key, p)
    return best[1] if best else None



def run_job(cfg, log):
    """cfg: source, kind('folder'|'zip'), json (path or ''), zip_member (restore file inside the ZIP, optional),
    dry, out, rezip. Returns a summary string."""
    source, kind = cfg["source"], cfg["kind"]
    tmp = None
    try:
        if kind == "zip":
            if not os.path.isfile(source):
                raise RestoreError("Choose a ZIP file first.")
            if cfg["dry"]:
                tmp = tempfile.mkdtemp(prefix="restore-preview-")
                work = os.path.join(tmp, "x")
                extract_zip(source, work, log)
            else:
                if not cfg["out"]:
                    raise RestoreError("Choose the folder where the restored files should go.")
                work = cfg["out"]
                extract_zip(source, work, log)
        else:
            if not os.path.isdir(source):
                raise RestoreError("Choose a folder first.")
            work = source

        jpath = cfg["json"]
        if not jpath and cfg.get("zip_member"):
            hit = os.path.join(work, native(cfg["zip_member"]))
            jpath = hit if os.path.isfile(hit) else ""
        if not jpath:
            cands = find_jsons(work) or find_jsons(HERE)
            if not cands:
                raise RestoreError("No restore .json was found inside the folder/ZIP or next to this script.\n"
                                   "Choose it with 'Choose the .json from my computer'.")
            jpath = choose_best_json(work, cands) if len(cands) > 1 else cands[0]
            if not jpath:
                jpath = cands[0]
        elif not os.path.isfile(jpath):
            raise RestoreError(f"Restore file not found:\n{jpath}")
        prep = prepare(work, jpath)
        log(f"Restore file: {jpath}  ({prep['spec']['desc']})")
        log(f"Files in    : {prep['base']}")
        log(f"{prep['found']} of {prep['total']} listed files found here.\n")
        ok, already, missing, blocked, failed = execute(prep, cfg["dry"], log, rel_to=work)
        if cfg["rezip"] and kind == "zip" and not cfg["dry"]:
            zp = os.path.normpath(cfg["out"]) + ".zip"
            rezip(prep["base"], zp)
            log(f"\nWrote {zp}")
        verb = "would be restored" if cfg["dry"] else "restored"
        return f"{ok} {verb}, {already} already restored, {missing} missing, {blocked} blocked, {failed} failed."
    finally:
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)


# ------------------------------------------------------------------ window
class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Restore original extensions")
        self.minsize(720, 640)
        self.q = queue.Queue()
        self.busy = False
        self.kind = tk.StringVar(value="folder")
        self.source = tk.StringVar()
        self.jmode = tk.StringVar(value="auto")
        self.jpath = tk.StringVar()
        self.found = tk.StringVar()
        self.out = tk.StringVar()
        self.rezip = tk.BooleanVar(value=False)
        self.status = tk.StringVar(value="Choose a folder or ZIP to begin.")
        self._build()
        self._sync()
        self.after(100, self._poll)

    def _build(self):
        pad = {"padx": 10, "pady": 4}
        root = ttk.Frame(self, padding=8)
        root.pack(fill="both", expand=True)

        # 1. where
        f1 = ttk.LabelFrame(root, text="1. Where are the files to restore?", padding=8)
        f1.pack(fill="x", **pad)
        r = ttk.Frame(f1); r.pack(fill="x")
        ttk.Radiobutton(r, text="A folder", variable=self.kind, value="folder", command=self._sync).pack(side="left")
        ttk.Radiobutton(r, text="A ZIP file", variable=self.kind, value="zip", command=self._sync).pack(side="left", padx=16)
        r = ttk.Frame(f1); r.pack(fill="x", pady=(6, 0))
        ttk.Entry(r, textvariable=self.source).pack(side="left", fill="x", expand=True)
        ttk.Button(r, text="Browse...", command=self._browse_source).pack(side="left", padx=(6, 0))
        self.zipbox = ttk.Frame(f1)
        ttk.Label(self.zipbox, text="Restore the ZIP into this folder (a ZIP is never modified):").pack(anchor="w", pady=(8, 0))
        r = ttk.Frame(self.zipbox); r.pack(fill="x")
        ttk.Entry(r, textvariable=self.out).pack(side="left", fill="x", expand=True)
        ttk.Button(r, text="Browse...", command=self._browse_out).pack(side="left", padx=(6, 0))
        ttk.Checkbutton(self.zipbox, text="Also create a restored ZIP next to that folder", variable=self.rezip).pack(anchor="w", pady=(4, 0))

        # 2. which json
        f2 = ttk.LabelFrame(root, text="2. Which restore file (.json) should be used?", padding=8)
        f2.pack(fill="x", **pad)
        ttk.Radiobutton(f2, text="Find it automatically (inside the folder/ZIP, or next to this script)", variable=self.jmode, value="auto", command=self._sync).pack(anchor="w")
        r = ttk.Frame(f2); r.pack(fill="x", pady=(2, 0))
        ttk.Radiobutton(f2, text="Pick one that was found in the folder/ZIP", variable=self.jmode, value="found", command=self._sync).pack(anchor="w", pady=(4, 0))
        r = ttk.Frame(f2); r.pack(fill="x", padx=(22, 0))
        self.combo = ttk.Combobox(r, textvariable=self.found, state="readonly", values=[])
        self.combo.pack(side="left", fill="x", expand=True)
        ttk.Button(r, text="Search again", command=self._scan).pack(side="left", padx=(6, 0))
        ttk.Radiobutton(f2, text="Choose the .json from my computer", variable=self.jmode, value="file", command=self._sync).pack(anchor="w", pady=(4, 0))
        r = ttk.Frame(f2); r.pack(fill="x", padx=(22, 0))
        self.jentry = ttk.Entry(r, textvariable=self.jpath)
        self.jentry.pack(side="left", fill="x", expand=True)
        self.jbrowse = ttk.Button(r, text="Browse...", command=self._browse_json)
        self.jbrowse.pack(side="left", padx=(6, 0))

        # 3. actions
        f3 = ttk.Frame(root); f3.pack(fill="x", **pad)
        self.bprev = ttk.Button(f3, text="Preview (change nothing)", command=lambda: self._go(True))
        self.bprev.pack(side="left")
        self.brest = ttk.Button(f3, text="Restore original extensions", command=lambda: self._go(False))
        self.brest.pack(side="left", padx=8)
        self.bar = ttk.Progressbar(f3, mode="indeterminate", length=120)
        self.bar.pack(side="right")

        # log
        f4 = ttk.LabelFrame(root, text="Log", padding=4)
        f4.pack(fill="both", expand=True, **pad)
        self.text = tk.Text(f4, height=14, wrap="none", font=("Consolas" if os.name == "nt" else "Menlo" if os.uname().sysname == "Darwin" else "DejaVu Sans Mono", 9))
        sy = ttk.Scrollbar(f4, command=self.text.yview); self.text.configure(yscrollcommand=sy.set)
        sy.pack(side="right", fill="y"); self.text.pack(fill="both", expand=True)
        ttk.Label(root, textvariable=self.status).pack(fill="x", padx=10, pady=(0, 4))

    # ---- helpers
    def _sync(self):
        if self.kind.get() == "zip":
            self.zipbox.pack(fill="x")
        else:
            self.zipbox.pack_forget()
        self.combo.configure(state="readonly" if self.jmode.get() == "found" else "disabled")
        st = "normal" if self.jmode.get() == "file" else "disabled"
        self.jentry.configure(state=st); self.jbrowse.configure(state=st)

    def _browse_source(self):
        if self.kind.get() == "zip":
            p = filedialog.askopenfilename(title="Choose the ZIP", filetypes=[("ZIP archive", "*.zip"), ("All files", "*.*")])
        else:
            p = filedialog.askdirectory(title="Choose the folder")
        if p:
            self.source.set(os.path.normpath(p))
            if self.kind.get() == "zip" and not self.out.get():
                self.out.set(os.path.splitext(os.path.normpath(p))[0] + "_restored")
            self._scan()

    def _browse_out(self):
        p = filedialog.askdirectory(title="Folder for the restored files (empty or new)", mustexist=False)
        if p:
            self.out.set(os.path.normpath(p))

    def _browse_json(self):
        p = filedialog.askopenfilename(title="Choose the restore file", filetypes=[("Restore file (.json)", "*.json *.txt"), ("All files", "*.*")])
        if p:
            self.jpath.set(os.path.normpath(p))

    def _scan(self):
        src = self.source.get().strip()
        names = []
        try:
            if src and self.kind.get() == "zip" and os.path.isfile(src):
                names = [f"[in ZIP] {n}" for n in zip_jsons(src)]
            elif src and os.path.isdir(src):
                names = find_jsons(src)
        except (OSError, zipfile.BadZipFile) as e:
            self._log(f"Could not search: {e}")
        self.combo.configure(values=names)
        self.found.set(names[0] if names else "")
        self.status.set(f"{len(names)} restore file(s) found." if src else "Choose a folder or ZIP to begin.")

    def _log(self, s):
        self.q.put(("log", s))

    def _poll(self):
        try:
            while True:
                k, v = self.q.get_nowait()
                if k == "log":
                    self.text.insert("end", v + "\n"); self.text.see("end")
                elif k == "done":
                    self._finish(*v)
        except queue.Empty:
            pass
        self.after(100, self._poll)

    def _finish(self, ok, msg, dry):
        self.busy = False
        self.bar.stop()
        for b in (self.bprev, self.brest):
            b.configure(state="normal")
        self.status.set(msg.splitlines()[0])
        self.text.insert("end", "\n" + msg + "\n"); self.text.see("end")
        (messagebox.showinfo if ok else messagebox.showerror)("Preview" if dry and ok else "Restore" if ok else "Problem", msg)

    def _go(self, dry):
        if self.busy:
            return
        src = self.source.get().strip()
        if not src:
            messagebox.showwarning("Restore", "Choose a folder or ZIP first.")
            return
        mode = self.jmode.get()
        jpath = ""
        extra_from_zip = None
        if mode == "file":
            jpath = self.jpath.get().strip()
            if not jpath:
                messagebox.showwarning("Restore", "Choose the restore .json file, or pick another option.")
                return
        elif mode == "found":
            sel = self.found.get()
            if not sel:
                messagebox.showwarning("Restore", "No restore file was found in the folder/ZIP. Use 'Choose the .json from my computer'.")
                return
            if sel.startswith("[in ZIP] "):
                extra_from_zip = sel[len("[in ZIP] "):]
            else:
                jpath = sel
        out = self.out.get().strip()
        if self.kind.get() == "zip" and not dry and not out:
            messagebox.showwarning("Restore", "Choose the folder where the restored files should go.")
            return
        if not dry and not messagebox.askyesno("Restore", "Put the original extensions back now?"):
            return
        cfg = {"source": src, "kind": self.kind.get(), "json": jpath, "dry": dry, "out": out, "rezip": self.rezip.get(), "zip_member": extra_from_zip}
        self.text.delete("1.0", "end")
        self.busy = True
        self.bar.start(12)
        for b in (self.bprev, self.brest):
            b.configure(state="disabled")
        self.status.set("Working...")
        threading.Thread(target=self._worker, args=(cfg, dry), daemon=True).start()

    def _worker(self, cfg, dry):
        try:
            msg = run_job(cfg, self._log)
            self.q.put(("done", (True, msg, dry)))
        except RestoreError as e:
            self.q.put(("done", (False, str(e), dry)))
        except Exception as e:  # unexpected: show it instead of dying silently
            self.q.put(("done", (False, f"Unexpected error: {e}", dry)))


if __name__ == "__main__":
    App().mainloop()
