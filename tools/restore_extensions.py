#!/usr/bin/env python3
"""
Put original file names / extensions back from ANY restore JSON.

Typical use: every extension in a project was changed to .txt (for example before uploading to git) and a
JSON file (rename-map.json, nametag-rename-*.json, ...) recorded the original names. Run this script
in the project folder and everything goes back:

    python restore_extensions.py                 # folder = where this script is, json found automatically
    python restore_extensions.py path/to/folder  # a specific folder
    python restore_extensions.py project.zip     # a ZIP: extracted to <name>_restored/, then restored
    python restore_extensions.py --json my-map.json
    python restore_extensions.py --dry-run       # show what would happen, change nothing
    python restore_extensions.py --yes           # do not ask for confirmation

Any JSON that lists renames is understood, for example:
    NameTag undo file       {"operations": [{"from": "a.js", "to": "a.txt"}, ...]}
    list of records         [{"original": "src/a.js", "renamed": "src/a.txt"}, ...]   (old/new, from/to, src/dst ...)
    mapping                 {"src/a.txt": "src/a.js"}  or  {"src/a.js": "src/a.txt"}
    list of pairs           [["src/a.js", "src/a.txt"], ...]
    list of original paths  ["src/a.js", ...]          (the .txt copy is a.txt or a.js.txt)
    wrapped in an object    {"files": [...]}, {"map": {...}}, ...
Which side is the .txt copy is detected automatically. Paths may use / or \\ and may be absolute (C:\\...).
The script and the JSON may also be named *.txt (restore_extensions.txt, nametag-rename-...txt): "python restore_extensions.txt" works too.
If no JSON is found, you are asked for its path. Python 3.8+, standard library only.
"""
import argparse
import json
import os
import re
import sys
import zipfile

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



def ask_for_json():
    print("No restore JSON was found.")
    while True:
        try:
            p = input("Path to the restore .json (empty to quit): ").strip().strip('"').strip("'")
        except EOFError:
            raise SystemExit("No restore file given.")
        if not p:
            raise SystemExit("Cancelled.")
        p = os.path.expanduser(p)
        if os.path.isfile(p):
            return p
        print(f"  Not found: {p}")


def main():
    ap = argparse.ArgumentParser(description="Restore original names/extensions from any restore JSON")
    ap.add_argument("target", nargs="?", help="folder or .zip to restore (default: the folder of this script)")
    ap.add_argument("--json", help="the restore .json (default: found automatically, otherwise asked)")
    ap.add_argument("--dry-run", action="store_true", help="show what would be renamed, change nothing")
    ap.add_argument("--yes", "-y", action="store_true", help="do not ask for confirmation")
    ap.add_argument("--rezip", action="store_true", help="with a ZIP target: also write <name>_restored.zip")
    a = ap.parse_args()

    target = os.path.abspath(a.target) if a.target else HERE
    is_zip = os.path.isfile(target) and target.lower().endswith(".zip")
    if not is_zip and not os.path.isdir(target):
        raise SystemExit(f"Not a folder or ZIP: {target}")
    zip_src = target
    try:
        if is_zip:
            target = os.path.splitext(zip_src)[0] + "_restored"
            extract_zip(zip_src, target, print)
        jpath = a.json
        if not jpath:
            cands = find_jsons(target) or (find_jsons(HERE) if HERE != target else [])
            jpath = choose_best_json(target, cands) if len(cands) > 1 else (cands[0] if cands else None)
            if len(cands) > 1 and jpath:
                print(f"{len(cands)} restore files found, using the best match: {jpath}")
            if not jpath:
                jpath = ask_for_json()
        prep = prepare(target, jpath)
        spec = prep["spec"]
        print(f"Restore file : {jpath}  ({spec['desc']})")
        print(f"Folder       : {prep['base']}")
        print(f"Found        : {prep['found']} of {prep['total']} listed files here")
        if not a.dry_run and not a.yes:
            try:
                if input("Restore the original names now? [y/N] ").strip().lower() not in ("y", "yes"):
                    raise SystemExit("Cancelled, nothing changed.")
            except EOFError:
                raise SystemExit("Cancelled, nothing changed.")
        ok, already, missing, blocked, failed = execute(prep, a.dry_run, print)
    except RestoreError as e:
        raise SystemExit(f"\nERROR: {e}")
    verb = "would be restored" if a.dry_run else "restored"
    print(f"\n{ok} {verb}, {already} already restored, {missing} missing, {blocked} blocked, {failed} failed.")
    if a.rezip and is_zip and not a.dry_run:
        rezip(prep["base"], target + ".zip")
        print(f"Wrote {target}.zip")
    return 1 if (failed or blocked) else 0


if __name__ == "__main__":
    sys.exit(main())
