package app.nametag;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Environment;
import android.provider.Settings;
import android.content.Intent;
import android.content.UriPermission;
import android.media.MediaScannerConnection;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import android.util.Base64;
import android.webkit.MimeTypeMap;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.RandomAccessFile;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.LinkedHashSet;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.Locale;

/**
 * NameTag folder access on Android through the Storage Access Framework: the person picks a folder with the
 * system picker, and the app lists, reads, writes and renames documents inside it (in place, like desktop).
 * Every call gets the folder's tree URI plus a document id; ids come from list().
 */
@CapacitorPlugin(name = "NameTagFolders")
public class FoldersPlugin extends Plugin {

    private static final String[] COLS = {
        Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE,
        Document.COLUMN_SIZE, Document.COLUMN_LAST_MODIFIED
    };

    /** Capacitor runs plugin methods one at a time on a single thread. File reads / writes / renames go to this
     *  pool instead, so several can be in flight at once (call.resolve / reject are safe from any thread). */
    private static final java.util.concurrent.ExecutorService POOL = java.util.concurrent.Executors.newFixedThreadPool(4);

    private ContentResolver resolver() { return getContext().getContentResolver(); }

    private Uri tree(PluginCall call) {
        String u = call.getString("uri");
        if (u == null) throw new IllegalArgumentException("Missing folder uri");
        return Uri.parse(u);
    }

    private Uri doc(Uri tree, String id) { return DocumentsContract.buildDocumentUriUsingTree(tree, id); }

    private JSObject describe(Uri tree, String id) {
        JSObject o = new JSObject();
        try (Cursor c = resolver().query(doc(tree, id), COLS, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                o.put("id", c.getString(0));
                o.put("name", c.getString(1));
                o.put("isDir", Document.MIME_TYPE_DIR.equals(c.getString(2)));
                o.put("size", c.isNull(3) ? 0 : c.getLong(3));
                o.put("mtime", c.isNull(4) ? 0 : c.getLong(4));
            }
        } catch (Exception ignored) { }
        return o;
    }

    @PluginMethod
    public void pick(PluginCall call) {
        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION | Intent.FLAG_GRANT_PREFIX_URI_PERMISSION);
        startActivityForResult(call, i, "pickResult");
    }

    @ActivityCallback
    private void pickResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        if (result.getResultCode() != Activity.RESULT_OK || data == null || data.getData() == null) {
            call.reject("Folder selection cancelled", "CANCELLED");
            return;
        }
        Uri tree = data.getData();
        try {
            resolver().takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
        } catch (Exception ignored) { /* some providers do not offer persistable access; this session still works */ }
        String rootId = DocumentsContract.getTreeDocumentId(tree);
        JSObject info = describe(tree, rootId);
        JSObject r = new JSObject();
        r.put("uri", tree.toString());
        r.put("rootId", rootId);
        r.put("name", info.optString("name", "Folder"));
        call.resolve(r);
    }

    @PluginMethod
    public void hasAccess(PluginCall call) {
        try {
            Uri tree = tree(call);
            boolean ok = false;
            for (UriPermission p : resolver().getPersistedUriPermissions()) {
                if (p.getUri().equals(tree) && p.isReadPermission() && p.isWritePermission()) { ok = true; break; }
            }
            if (!ok) { // not persisted, but maybe granted for this session
                try (Cursor c = resolver().query(doc(tree, DocumentsContract.getTreeDocumentId(tree)), COLS, null, null, null)) { ok = c != null && c.moveToFirst(); }
                catch (Exception ignored) { ok = false; }
            }
            JSObject r = new JSObject(); r.put("granted", ok); call.resolve(r);
        } catch (Exception e) { call.reject(e.getMessage(), e); }
    }

    /** Lists children of a folder (optionally the whole subtree). Paths are relative to the given folder. */
    @PluginMethod
    public void list(PluginCall call) {
        try {
            Uri tree = tree(call);
            String start = call.getString("id", DocumentsContract.getTreeDocumentId(tree));
            boolean recursive = call.getBoolean("recursive", true);
            JSArray out = new JSArray();
            ArrayDeque<String[]> queue = new ArrayDeque<>();
            queue.add(new String[] { start, "" });
            while (!queue.isEmpty()) {
                String[] cur = queue.poll();
                Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, cur[0]);
                try (Cursor c = resolver().query(children, COLS, null, null, null)) {
                    if (c == null) continue;
                    while (c.moveToNext()) {
                        String id = c.getString(0);
                        String name = c.getString(1);
                        if (name == null) continue;
                        boolean dir = Document.MIME_TYPE_DIR.equals(c.getString(2));
                        String path = cur[1].isEmpty() ? name : cur[1] + "/" + name;
                        JSObject e = new JSObject();
                        e.put("id", id);
                        e.put("name", name);
                        e.put("path", path);
                        e.put("isDir", dir);
                        e.put("size", c.isNull(3) ? 0 : c.getLong(3));
                        e.put("mtime", c.isNull(4) ? 0 : c.getLong(4));
                        out.put(e);
                        if (dir && recursive) queue.add(new String[] { id, path });
                    }
                }
            }
            JSObject r = new JSObject(); r.put("entries", out); call.resolve(r);
        } catch (Exception e) { call.reject("Could not read the folder: " + e.getMessage(), e); }
    }

    /** Reads a byte range as base64 (seeks when the provider allows it). */
    @PluginMethod
    public void read(PluginCall call) { POOL.execute(() -> readImpl(call)); }

    private void readImpl(PluginCall call) {
        try {
            Uri tree = tree(call);
            Uri d = doc(tree, call.getString("id"));
            long offset = call.getData().optLong("offset", 0);
            long length = call.getData().optLong("length", -1);
            ByteArrayOutputStream bo = new ByteArrayOutputStream(length > 0 ? (int) Math.min(length, 8 * 1024 * 1024) : 65536);
            byte[] buf = new byte[65536];
            long remaining = length < 0 ? Long.MAX_VALUE : length;
            boolean done = false;
            try (ParcelFileDescriptor pfd = resolver().openFileDescriptor(d, "r")) {
                if (pfd != null) {
                    try (FileInputStream in = new FileInputStream(pfd.getFileDescriptor())) {
                        in.getChannel().position(offset);
                        while (remaining > 0) {
                            int n = in.read(buf, 0, (int) Math.min(buf.length, remaining));
                            if (n < 0) break;
                            bo.write(buf, 0, n); remaining -= n;
                        }
                        done = true;
                    }
                }
            } catch (Exception seekFailed) { bo.reset(); remaining = length < 0 ? Long.MAX_VALUE : length; }
            if (!done) {
                try (InputStream in = resolver().openInputStream(d)) {
                    if (in == null) throw new IllegalStateException("Cannot open file");
                    long skip = offset;
                    while (skip > 0) { long s = in.skip(skip); if (s <= 0) { if (in.read() < 0) break; s = 1; } skip -= s; }
                    while (remaining > 0) {
                        int n = in.read(buf, 0, (int) Math.min(buf.length, remaining));
                        if (n < 0) break;
                        bo.write(buf, 0, n); remaining -= n;
                    }
                }
            }
            JSObject r = new JSObject(); r.put("data", Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP)); call.resolve(r);
        } catch (Exception e) { call.reject("Could not read the file: " + e.getMessage(), e); }
    }

    /** Writes base64 data: replaces (or appends to) an existing document, or creates a new one in a folder. */
    @PluginMethod
    public void write(PluginCall call) { POOL.execute(() -> writeImpl(call)); }

    private void writeImpl(PluginCall call) {
        try {
            Uri tree = tree(call);
            String id = call.getString("id");
            boolean append = call.getBoolean("append", false);
            byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            Uri target;
            if (id == null) {
                String name = call.getString("name");
                Uri parent = doc(tree, call.getString("parentId", DocumentsContract.getTreeDocumentId(tree)));
                target = DocumentsContract.createDocument(resolver(), parent, mimeFor(name), name);
                if (target == null) throw new IllegalStateException("Could not create " + name);
                id = DocumentsContract.getDocumentId(target);
            } else {
                target = doc(tree, id);
            }
            try (OutputStream os = resolver().openOutputStream(target, append ? "wa" : "wt")) {
                if (os == null) throw new IllegalStateException("Cannot open file for writing");
                os.write(data);
            }
            JSObject r = new JSObject(); r.put("id", id); call.resolve(r);
        } catch (Exception e) { call.reject("Could not write the file: " + e.getMessage(), e); }
    }

    /** Overwrites bytes at an offset inside an existing file (length unchanged). Used to patch the tag at the start of a song. */
    @PluginMethod
    public void writeAt(PluginCall call) { POOL.execute(() -> writeAtImpl(call)); }

    private void writeAtImpl(PluginCall call) {
        try {
            Uri tree = tree(call);
            Uri d = doc(tree, call.getString("id"));
            long offset = call.getData().optLong("offset", 0);
            byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            try (ParcelFileDescriptor pfd = resolver().openFileDescriptor(d, "rw")) {
                if (pfd == null) throw new IllegalStateException("Cannot open file for writing");
                long before = pfd.getStatSize();
                try (java.io.FileOutputStream out = new java.io.FileOutputStream(pfd.getFileDescriptor())) {
                    java.nio.channels.FileChannel ch = out.getChannel();
                    ch.position(offset);
                    java.nio.ByteBuffer bb = java.nio.ByteBuffer.wrap(data);
                    while (bb.hasRemaining()) ch.write(bb);
                }
                JSObject r = new JSObject(); r.put("before", before); r.put("after", pfd.getStatSize()); call.resolve(r);
            }
        } catch (Exception e) { call.reject("Could not patch the file: " + e.getMessage(), e); }
    }

    /** Renames in place. Returns the new id and the name the provider actually used. */
    @PluginMethod
    public void rename(PluginCall call) { POOL.execute(() -> renameImpl(call)); }

    private void renameImpl(PluginCall call) {
        try {
            Uri tree = tree(call);
            String id = call.getString("id");
            String name = call.getString("name");
            Uri renamed = DocumentsContract.renameDocument(resolver(), doc(tree, id), name);
            String newId = renamed != null ? DocumentsContract.getDocumentId(renamed) : id;
            JSObject info = describe(tree, newId);
            JSObject r = new JSObject();
            r.put("id", newId);
            r.put("name", info.optString("name", name));
            call.resolve(r);
        } catch (Exception e) { call.reject("Rename failed: " + e.getMessage(), e); }
    }

    @PluginMethod
    public void delete(PluginCall call) { POOL.execute(() -> deleteImpl(call)); }

    private void deleteImpl(PluginCall call) {
        try {
            Uri tree = tree(call);
            boolean ok = DocumentsContract.deleteDocument(resolver(), doc(tree, call.getString("id")));
            JSObject r = new JSObject(); r.put("deleted", ok); call.resolve(r);
        } catch (Exception e) { call.reject("Delete failed: " + e.getMessage(), e); }
    }

    // ---- keep-alive: a foreground service while a rename / tag save runs, so Android does not suspend the app
    private void keepAlive(PluginCall call, boolean start) {
        try {
            Context c = getContext();
            Intent i = new Intent(c, KeepAliveService.class);
            if (!start) { c.stopService(i); call.resolve(); return; }
            i.putExtra(KeepAliveService.EXTRA_TITLE, call.getString("title", "NameTag"));
            i.putExtra(KeepAliveService.EXTRA_TEXT, call.getString("text", "Working…"));
            i.putExtra(KeepAliveService.EXTRA_DONE, call.getInt("done", 0));
            i.putExtra(KeepAliveService.EXTRA_TOTAL, call.getInt("total", 0));
            androidx.core.content.ContextCompat.startForegroundService(c, i);
            call.resolve();
        } catch (Exception e) { call.resolve(); /* best effort: the job itself still runs */ }
    }

    @PluginMethod public void startKeepAlive(PluginCall call) { keepAlive(call, true); }

    @PluginMethod public void updateKeepAlive(PluginCall call) { keepAlive(call, true); }

    @PluginMethod public void stopKeepAlive(PluginCall call) { keepAlive(call, false); }

    /* ================================================================ direct file access ("All files access")
     * Used by the in-app file browser: whole internal storage and SD cards as plain paths, so several folders and
     * files can be picked at once and read / renamed / written without going through the document provider. */

    private boolean hasAllFiles() {
        Context c = getContext();
        if (Build.VERSION.SDK_INT >= 30) return Environment.isExternalStorageManager();
        return c.checkSelfPermission(android.Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    @PluginMethod
    public void storageAccess(PluginCall call) {
        JSObject r = new JSObject(); r.put("granted", hasAllFiles()); r.put("sdk", Build.VERSION.SDK_INT); call.resolve(r);
    }

    /** Opens the system screen where the person switches "All files access" on for this app (a normal permission prompt before Android 11). */
    @PluginMethod
    public void requestStorageAccess(PluginCall call) {
        try {
            Context c = getContext();
            if (Build.VERSION.SDK_INT >= 30) {
                Intent i = new Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, Uri.parse("package:" + c.getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try { c.startActivity(i); }
                catch (Exception e) { Intent j = new Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION); j.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); c.startActivity(j); }
            } else {
                androidx.core.app.ActivityCompat.requestPermissions(getActivity(), new String[] { android.Manifest.permission.READ_EXTERNAL_STORAGE, android.Manifest.permission.WRITE_EXTERNAL_STORAGE }, 9001);
            }
            call.resolve();
        } catch (Exception e) { call.reject("Could not open the permission screen: " + e.getMessage(), e); }
    }

    /** Storage volumes: internal storage first, then SD cards / USB drives that are mounted. */
    @PluginMethod
    public void fsRoots(PluginCall call) {
        try {
            JSArray arr = new JSArray();
            File internal = Environment.getExternalStorageDirectory();
            JSObject a = new JSObject(); a.put("name", "Internal storage"); a.put("path", internal.getAbsolutePath()); arr.put(a);
            File[] dirs = getContext().getExternalFilesDirs(null);
            if (dirs != null) for (File d : dirs) {
                if (d == null) continue;
                String p = d.getAbsolutePath(); int k = p.indexOf("/Android/data");
                if (k <= 0) continue;
                String root = p.substring(0, k);
                if (root.equals(internal.getAbsolutePath())) continue;
                JSObject o = new JSObject(); o.put("name", new File(root).getName().isEmpty() ? "SD card" : "SD card (" + new File(root).getName() + ")"); o.put("path", root); arr.put(o);
            }
            JSObject r = new JSObject(); r.put("roots", arr); call.resolve(r);
        } catch (Exception e) { call.reject("Could not list storage: " + e.getMessage(), e); }
    }

    private static JSObject fileInfo(File f, String relPath) {
        JSObject o = new JSObject();
        o.put("name", f.getName()); o.put("isDir", f.isDirectory());
        o.put("size", f.isDirectory() ? 0 : f.length()); o.put("mtime", f.lastModified());
        if (relPath != null) o.put("path", relPath);
        return o;
    }

    /** One folder level, folders first. */
    @PluginMethod
    public void fsList(PluginCall call) { POOL.execute(() -> fsListImpl(call)); }
    private void fsListImpl(PluginCall call) {
        try {
            File dir = new File(call.getString("path", ""));
            File[] kids = dir.listFiles();
            JSArray arr = new JSArray();
            if (kids != null) for (File k : kids) arr.put(fileInfo(k, null));
            JSObject r = new JSObject(); r.put("entries", arr); r.put("readable", kids != null); call.resolve(r);
        } catch (Exception e) { call.reject("Could not list the folder: " + e.getMessage(), e); }
    }

    /** Everything below a folder, with paths relative to it. */
    @PluginMethod
    public void fsListAll(PluginCall call) { POOL.execute(() -> fsListAllImpl(call)); }
    private void fsListAllImpl(PluginCall call) {
        try {
            File base = new File(call.getString("path", ""));
            JSArray arr = new JSArray();
            ArrayDeque<File> q = new ArrayDeque<>(); ArrayDeque<String> qp = new ArrayDeque<>();
            q.add(base); qp.add("");
            while (!q.isEmpty()) {
                File dir = q.poll(); String prefix = qp.poll();
                File[] kids = dir.listFiles();
                if (kids == null) continue;
                for (File k : kids) {
                    String rel = prefix.isEmpty() ? k.getName() : prefix + "/" + k.getName();
                    arr.put(fileInfo(k, rel));
                    if (k.isDirectory()) { q.add(k); qp.add(rel); }
                }
            }
            JSObject r = new JSObject(); r.put("entries", arr); call.resolve(r);
        } catch (Exception e) { call.reject("Could not list the folder: " + e.getMessage(), e); }
    }

    @PluginMethod
    public void fsStat(PluginCall call) {
        try {
            File f = new File(call.getString("path", ""));
            JSObject r = new JSObject(); r.put("exists", f.exists()); r.put("isDir", f.isDirectory()); r.put("size", f.length()); r.put("mtime", f.lastModified());
            call.resolve(r);
        } catch (Exception e) { call.reject("Could not read file information: " + e.getMessage(), e); }
    }

    @PluginMethod
    public void fsRead(PluginCall call) { POOL.execute(() -> fsReadImpl(call)); }
    private void fsReadImpl(PluginCall call) {
        try (RandomAccessFile raf = new RandomAccessFile(new File(call.getString("path", "")), "r")) {
            long offset = call.getData().optLong("offset", 0);
            long length = call.getData().optLong("length", -1);
            long avail = Math.max(0, raf.length() - offset);
            int n = (int) (length < 0 ? Math.min(avail, 64L * 1024 * 1024) : Math.min(avail, length));
            byte[] buf = new byte[n];
            raf.seek(offset); raf.readFully(buf);
            JSObject r = new JSObject(); r.put("data", Base64.encodeToString(buf, Base64.NO_WRAP)); call.resolve(r);
        } catch (Exception e) { call.reject("Could not read the file: " + e.getMessage(), e); }
    }

    /** Writes base64 data; creates missing folders. append=false replaces the file. */
    @PluginMethod
    public void fsWrite(PluginCall call) { POOL.execute(() -> fsWriteImpl(call)); }
    private void fsWriteImpl(PluginCall call) {
        try {
            File f = new File(call.getString("path", ""));
            File parent = f.getParentFile(); if (parent != null && !parent.exists()) parent.mkdirs();
            byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            try (java.io.FileOutputStream os = new java.io.FileOutputStream(f, call.getBoolean("append", false))) { os.write(data); }
            call.resolve();
        } catch (Exception e) { call.reject("Could not write the file: " + e.getMessage(), e); }
    }

    /** Overwrites bytes at an offset without changing the file length. */
    @PluginMethod
    public void fsWriteAt(PluginCall call) { POOL.execute(() -> fsWriteAtImpl(call)); }
    private void fsWriteAtImpl(PluginCall call) {
        try (RandomAccessFile raf = new RandomAccessFile(new File(call.getString("path", "")), "rw")) {
            long before = raf.length();
            byte[] data = Base64.decode(call.getString("data", ""), Base64.DEFAULT);
            raf.seek(call.getData().optLong("offset", 0)); raf.write(data);
            JSObject r = new JSObject(); r.put("before", before); r.put("after", raf.length()); call.resolve(r);
        } catch (Exception e) { call.reject("Could not patch the file: " + e.getMessage(), e); }
    }

    /** Renames or moves. Refuses to replace an existing item (a case-only change of the same name is fine). */
    @PluginMethod
    public void fsRename(PluginCall call) { POOL.execute(() -> fsRenameImpl(call)); }
    private void fsRenameImpl(PluginCall call) {
        try {
            File from = new File(call.getString("from", "")); File to = new File(call.getString("to", ""));
            if (!from.exists()) throw new IllegalStateException("Not found: " + from.getName());
            boolean caseOnly = from.getParentFile() != null && from.getParentFile().equals(to.getParentFile()) && from.getName().equalsIgnoreCase(to.getName());
            if (to.exists() && !caseOnly) throw new IllegalStateException("\"" + to.getName() + "\" already exists");
            File parent = to.getParentFile(); if (parent != null && !parent.exists()) parent.mkdirs();
            if (!from.renameTo(to)) throw new IllegalStateException("Android refused to rename \"" + from.getName() + "\"");
            call.resolve();
        } catch (Exception e) { call.reject("Rename failed: " + e.getMessage(), e); }
    }

    @PluginMethod
    public void fsDelete(PluginCall call) { POOL.execute(() -> fsDeleteImpl(call)); }
    private void fsDeleteImpl(PluginCall call) {
        try {
            File f = new File(call.getString("path", ""));
            JSObject r = new JSObject(); r.put("deleted", f.delete()); call.resolve(r);
        } catch (Exception e) { call.reject("Delete failed: " + e.getMessage(), e); }
    }

    /* ================================================================ media library re-index
     * After a rename or tag save, Android's media library (MediaStore) still shows the old file names and old
     * tags until it happens to rescan. scanMedia asks it to look again at exactly the files that changed:
     * new paths are (re)indexed with their new tags, old paths that no longer exist are dropped.
     *   paths: absolute file paths (in-app browser / All files access)
     *   uri + ids: a picked folder (Storage Access Framework); document ids of the phone's own storage and
     *              SD cards ("primary:Music/a.mp3", "1234-ABCD:Music/a.mp3") are turned into file paths. */
    @PluginMethod
    public void scanMedia(PluginCall call) { POOL.execute(() -> scanMediaImpl(call)); }

    private void scanMediaImpl(PluginCall call) {
        try {
            LinkedHashSet<String> want = new LinkedHashSet<>();
            JSArray paths = call.getArray("paths");
            if (paths != null) for (int i = 0; i < paths.length(); i++) { String p = paths.optString(i, null); if (p != null && !p.isEmpty()) want.add(p); }
            String uri = call.getString("uri");
            JSArray ids = call.getArray("ids");
            if (uri != null && ids != null) {
                Uri tree = Uri.parse(uri);
                for (int i = 0; i < ids.length(); i++) { String p = pathForDocId(tree, ids.optString(i, null)); if (p != null) want.add(p); }
            }
            // Before Android 10 the scanner does not walk into folders: list renamed folders' files explicitly.
            if (Build.VERSION.SDK_INT < 29) {
                for (String p : new java.util.ArrayList<>(want)) {
                    File f = new File(p);
                    if (!f.isDirectory()) continue;
                    ArrayDeque<File> q = new ArrayDeque<>(); q.add(f);
                    while (!q.isEmpty() && want.size() < 50000) {
                        File[] kids = q.poll().listFiles(); if (kids == null) continue;
                        for (File k : kids) { if (k.isDirectory()) q.add(k); else want.add(k.getAbsolutePath()); }
                    }
                }
            }
            JSObject r = new JSObject();
            r.put("requested", want.size());
            if (want.isEmpty()) { r.put("scanned", 0); call.resolve(r); return; }
            String[] arr = want.toArray(new String[0]);
            CountDownLatch latch = new CountDownLatch(arr.length);
            AtomicInteger indexed = new AtomicInteger();
            MediaScannerConnection.scanFile(getContext(), arr, null, (path, u) -> { if (u != null) indexed.incrementAndGet(); latch.countDown(); });
            boolean finished = latch.await(Math.min(300, 30 + arr.length / 20), TimeUnit.SECONDS);
            r.put("scanned", arr.length - (int) latch.getCount());
            r.put("indexed", indexed.get());
            r.put("finished", finished);
            call.resolve(r);
        } catch (Exception e) { call.reject("Could not update the media library: " + e.getMessage(), e); }
    }

    /** File path behind a document of Android's own storage provider, or null for other providers (cloud, Downloads ids). */
    private static String pathForDocId(Uri tree, String id) {
        if (id == null || tree == null || !"com.android.externalstorage.documents".equals(tree.getAuthority())) return null;
        int c = id.indexOf(':');
        if (c <= 0) return null;
        String vol = id.substring(0, c); String rel = id.substring(c + 1);
        String base;
        if ("primary".equalsIgnoreCase(vol)) base = Environment.getExternalStorageDirectory().getAbsolutePath();
        else if ("home".equalsIgnoreCase(vol)) base = new File(Environment.getExternalStorageDirectory(), "Documents").getAbsolutePath();
        else if ("raw".equalsIgnoreCase(vol)) return rel;
        else base = "/storage/" + vol;
        return rel.isEmpty() ? base : base + "/" + rel;
    }

    private static String mimeFor(String name) {
        int dot = name == null ? -1 : name.lastIndexOf('.');
        if (dot > 0) {
            String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
            if (ext.equals("json")) return "application/json";
            String m = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (m != null) return m;
        }
        return "application/octet-stream";
    }
}
