package app.nametag;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.UriPermission;
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
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
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
