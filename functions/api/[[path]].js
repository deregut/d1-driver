// ─────────────────────────────────────────────────────────────────────────────
// /api/* — JSON API used by the web UI.
// Routes:
//   GET    /api/list      ?path=/            → folder listing
//   GET    /api/dirs                         → all folders (for move dialog)
//   GET    /api/usage                        → storage stats
//   GET    /api/download  ?path=             → file bytes
//   POST   /api/mkdir     {path}             → create folder
//   POST   /api/upload-init  {path,size,mime}→ begin chunked upload → {id}
//   POST   /api/upload-piece?id=&seq= (binary body) → store one chunk
//   POST   /api/upload-finish{id,size}       → verify + finalize
//   POST   /api/delete    {path}
//   POST   /api/move      {from,to}
//   POST   /api/copy      {from,to}
// ─────────────────────────────────────────────────────────────────────────────
import * as store from '../lib/store.js';

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function itemDto(row) {
  return {
    name: row.name,
    path: row.path,
    type: row.is_folder ? 'folder' : 'file',
    size: row.size,
    mime: row.mime,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function onRequest({ request, env }) {
  const db = env.DB;
  const url = new URL(request.url);
  const route = url.pathname.slice(4); // strip '/api'
  const method = request.method;

  try {
    // ── Reads ────────────────────────────────────────────────────────────
    if (method === 'GET' && route === '/list') {
      const path = store.normPath(url.searchParams.get('path') || '/');
      const node = await store.getNode(db, path);
      if (!node) return json({ error: 'Folder not found' }, 404);
      if (!node.is_folder) return json({ error: 'Not a folder' }, 400);
      const children = await store.listChildren(db, path);
      return json({ path, items: children.map(itemDto) });
    }

    if (method === 'GET' && route === '/dirs') {
      return json({ folders: await store.listAllFolders(db) });
    }

    if (method === 'GET' && route === '/usage') {
      return json(await store.getUsage(db));
    }

    if ((method === 'GET' || method === 'HEAD') && route === '/download') {
      const path = store.assertChildPath(url.searchParams.get('path') || '');
      const { node, bytes } = await store.readFile(db, path);
      const fname = encodeURIComponent(node.name);
      return new Response(bytes, {
        headers: {
          'content-type': node.mime || 'application/octet-stream',
          'content-length': String(bytes.byteLength),
          'content-disposition':
            `inline; filename*=UTF-8''${fname}`,
          'cache-control': 'private, no-cache',
          'etag': `"${node.size}-${node.updated_at}"`,
        },
      });
    }

    // ── Writes ───────────────────────────────────────────────────────────
    if (method === 'POST' && route === '/mkdir') {
      const body = await readJson(request);
      const path = store.assertChildPath(body.path);
      await store.createFolder(db, path);
      return json({ ok: true, path });
    }

    if (method === 'POST' && route === '/upload-init') {
      const body = await readJson(request);
      const path = store.assertChildPath(body.path);
      const size = Number(body.size) || 0;
      if (size > 1024 * 1024 * 1024) return json({ error: 'Max file size is 1 GB' }, 400);
      const id = await store.initFile(db, path, body.mime, size);
      return json({ ok: true, id });
    }

    if (method === 'POST' && route === '/upload-piece') {
      const id = Number(url.searchParams.get('id'));
      const seq = Number(url.searchParams.get('seq'));
      if (!Number.isInteger(id) || !Number.isInteger(seq)) {
        return json({ error: 'Bad id/seq' }, 400);
      }
      const buf = new Uint8Array(await request.arrayBuffer());
      if (!buf.byteLength) return json({ error: 'Empty chunk' }, 400);
      await store.putChunk(db, id, seq, buf);
      return json({ ok: true, received: buf.byteLength });
    }

    if (method === 'POST' && route === '/upload-finish') {
      const body = await readJson(request);
      const id = Number(body.id);
      const size = Number(body.size) || 0;
      if (!Number.isInteger(id)) return json({ error: 'Bad id' }, 400);
      const bytes = await store.finishFile(db, id, size);
      return json({ ok: true, size: bytes });
    }

    if (method === 'POST' && route === '/delete') {
      const body = await readJson(request);
      const path = store.assertChildPath(body.path);
      await store.deleteNode(db, path);
      return json({ ok: true });
    }

    if (method === 'POST' && route === '/move') {
      const body = await readJson(request);
      await store.moveNode(db, body.from, body.to);
      return json({ ok: true });
    }

    if (method === 'POST' && route === '/copy') {
      const body = await readJson(request);
      await store.copyNode(db, body.from, body.to);
      return json({ ok: true });
    }

    return json({ error: 'Unknown API route' }, 404);
  } catch (err) {
    if (err instanceof store.StoreError) return json({ error: err.message }, err.status);
    console.error('API error:', err);
    return json({ error: err.message || 'Internal error' }, 500);
  }
}
