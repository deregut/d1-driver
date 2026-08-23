// ─────────────────────────────────────────────────────────────────────────────
// store.js — D1 data layer for D1 Drive.
// Files are split into CHUNK_SIZE blobs in table `chunks`; metadata in `nodes`.
// ─────────────────────────────────────────────────────────────────────────────

export const CHUNK_SIZE = 512 * 1024; // 512 KiB per D1 row — safely under limits
const INSERT_BATCH = 8;               // chunks per db.batch() (8 × 512KiB = 4MiB)
const PARAM_BATCH = 80;               // max bound params per statement (D1 limit: 100)
const READ_PAGE = 16;                 // chunk rows per SELECT when reading

export class StoreError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function now() { return Date.now(); }

// ── Path helpers ────────────────────────────────────────────────────────────
export function normPath(p) {
  if (p === null || p === undefined) return '/';
  p = String(p).replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!p.startsWith('/')) p = '/' + p;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p || '/';
}

export function parentOf(p) {
  p = normPath(p);
  if (p === '/') return null;
  const i = p.lastIndexOf('/');
  return i === 0 ? '/' : p.slice(0, i);
}

export function baseName(p) {
  p = normPath(p);
  if (p === '/') return '';
  return p.slice(p.lastIndexOf('/') + 1);
}

export function joinPath(parent, name) {
  parent = normPath(parent);
  return parent === '/' ? '/' + name : parent + '/' + name;
}

const NAME_RE = /[\/\x00-\x1f]/;
export function assertName(name) {
  name = String(name ?? '').trim();
  if (!name || name === '.' || name === '..' || NAME_RE.test(name) || name.length > 255) {
    throw new StoreError('Invalid name', 400);
  }
  return name;
}

export function assertChildPath(path) {
  path = normPath(path);
  if (path === '/') throw new StoreError('Reserved path', 400);
  if (path.length > 1024) throw new StoreError('Path too long', 400);
  assertName(baseName(path));
  return path;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// ── Reads ───────────────────────────────────────────────────────────────────
export async function getNode(db, path) {
  path = normPath(path);
  if (path === '/') {
    return { id: 0, path: '/', parent_path: '', name: '', is_folder: 1,
             size: 0, mime: '', created_at: 0, updated_at: 0 };
  }
  return await db.prepare('SELECT * FROM nodes WHERE path = ?').bind(path).first();
}

export async function listChildren(db, path) {
  path = normPath(path);
  const r = await db.prepare(
    'SELECT path, name, is_folder, size, mime, created_at, updated_at ' +
    'FROM nodes WHERE parent_path = ? ' +
    'ORDER BY is_folder DESC, name COLLATE NOCASE'
  ).bind(path).all();
  return r.results;
}

export async function listAllFolders(db) {
  const r = await db.prepare(
    "SELECT path FROM nodes WHERE is_folder = 1 ORDER BY path"
  ).all();
  return ['/', ...r.results.map((r) => r.path)];
}

export async function getUsage(db) {
  const f = await db.prepare(
    "SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM nodes WHERE is_folder = 0"
  ).first();
  const d = await db.prepare(
    "SELECT COUNT(*) AS folders FROM nodes WHERE is_folder = 1"
  ).first();
  return { files: f.files, bytes: f.bytes, folders: d.folders };
}

async function selectSubtree(db, path) {
  path = normPath(path);
  const like = escapeLike(path) + '/%';
  const r = await db.prepare(
    "SELECT * FROM nodes WHERE path = ? OR path LIKE ? ESCAPE '\\' ORDER BY path"
  ).bind(path, like).all();
  return r.results;
}

// ── Folder operations ───────────────────────────────────────────────────────
async function mustBeFolder(db, path) {
  const n = await getNode(db, path);
  if (!n) throw new StoreError(`Folder not found: ${path}`, 409);
  if (!n.is_folder) throw new StoreError(`Not a folder: ${path}`, 409);
  return n;
}

export async function createFolder(db, path) {
  path = assertChildPath(path);
  const existing = await getNode(db, path);
  if (existing) throw new StoreError('Already exists', 409);
  await mustBeFolder(db, parentOf(path));
  const t = now();
  await db.prepare(
    'INSERT INTO nodes (path, parent_path, name, is_folder, size, mime, created_at, updated_at) ' +
    'VALUES (?, ?, ?, 1, 0, ?, ?, ?)'
  ).bind(path, normPath(parentOf(path)), baseName(path), '', t, t).run();
}

// Create every missing folder along a path (like mkdir -p).
export async function mkdirp(db, path) {
  path = normPath(path);
  if (path === '/') return;
  const segs = path.split('/').filter(Boolean);
  let cur = '';
  for (const seg of segs) {
    cur += '/' + seg;
    const n = await getNode(db, cur);
    if (!n) await createFolder(db, cur);
    else if (!n.is_folder) throw new StoreError(`A file exists at ${cur}`, 409);
  }
}

// ── File write (chunked) ────────────────────────────────────────────────────
async function insertChunks(db, nodeId, bytes) {
  const total = Math.ceil(bytes.byteLength / CHUNK_SIZE) || 0;
  let batch = [];
  for (let seq = 0; seq < total; seq++) {
    batch.push(db.prepare('INSERT INTO chunks (node_id, seq, data) VALUES (?, ?, ?)')
      .bind(nodeId, seq, bytes.slice(seq * CHUNK_SIZE, (seq + 1) * CHUNK_SIZE)));
    if (batch.length >= INSERT_BATCH) { await db.batch(batch); batch = []; }
  }
  if (batch.length) await db.batch(batch);
}

async function dropChunks(db, nodeId) {
  await db.prepare('DELETE FROM chunks WHERE node_id = ?').bind(nodeId).run();
}

// Create a fresh file node; silently replaces an existing file at the same path.
// Returns the new node id. Does NOT write payload (used by chunked upload init).
export async function initFile(db, path, mime, sizeHint = 0) {
  path = assertChildPath(path);
  await mustBeFolder(db, parentOf(path));
  const prev = await getNode(db, path);
  if (prev && prev.is_folder) throw new StoreError('A folder exists at that path', 409);
  if (prev) { await dropChunks(db, prev.id); await deleteRow(db, prev.id); }
  const t = now();
  const r = await db.prepare(
    'INSERT INTO nodes (path, parent_path, name, is_folder, size, mime, created_at, updated_at) ' +
    'VALUES (?, ?, ?, 0, ?, ?, ?, ?) RETURNING id'
  ).bind(path, normPath(parentOf(path)), baseName(path), sizeHint, mime || guessMime(path), t, t)
   .first();
  return r.id;
}

export async function putChunk(db, id, seq, bytes) {
  const n = await db.prepare('SELECT is_folder FROM nodes WHERE id = ?').bind(id).first();
  if (!n || n.is_folder) throw new StoreError('Upload target not found', 404);
  await db.prepare('INSERT OR REPLACE INTO chunks (node_id, seq, data) VALUES (?, ?, ?)')
    .bind(id, seq | 0, bytes).run();
}

// Finalize a chunked upload: verify received bytes and set final size.
export async function finishFile(db, id, expectedSize) {
  const agg = await db.prepare(
    'SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)),0) AS bytes FROM chunks WHERE node_id = ?'
  ).bind(id).first();
  if (agg.bytes !== expectedSize) {
    throw new StoreError(`Size mismatch: sent ${agg.bytes} bytes, expected ${expectedSize}`, 400);
  }
  await db.prepare('UPDATE nodes SET size = ?, updated_at = ? WHERE id = ?')
    .bind(expectedSize, now(), id).run();
  return agg.bytes;
}

// One-shot write of a whole file from a single buffer.
export async function writeFile(db, path, bytes, mime) {
  path = assertChildPath(path);
  const id = await initFile(db, path, mime, bytes.byteLength);
  await insertChunks(db, id, bytes);
  return id;
}

// ── File read ───────────────────────────────────────────────────────────────
export async function readFile(db, path) {
  const node = await getNode(db, path);
  if (!node) throw new StoreError('Not found', 404);
  if (node.is_folder) throw new StoreError('Is a folder', 400);
  const parts = [];
  let offset = 0;
  while (true) {
    const page = await db.prepare(
      'SELECT data FROM chunks WHERE node_id = ? ORDER BY seq LIMIT ? OFFSET ?'
    ).bind(node.id, READ_PAGE, offset).all();
    for (const row of page.results) parts.push(new Uint8Array(row.data));
    if (page.results.length < READ_PAGE) break;
    offset += READ_PAGE;
  }
  const total = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { node, bytes: out };
}

// ── Delete / Move / Copy (recursive) ────────────────────────────────────────
async function deleteRow(db, id) {
  await db.prepare('DELETE FROM nodes WHERE id = ?').bind(id).run();
}

export async function deleteNode(db, path) {
  path = assertChildPath(path);
  const subtree = await selectSubtree(db, path);
  if (!subtree.length) throw new StoreError('Not found', 404);
  const ids = subtree.map((r) => r.id);
  const stmts = [];
  for (let i = 0; i < ids.length; i += PARAM_BATCH) {
    const slice = ids.slice(i, i + PARAM_BATCH);
    stmts.push(db.prepare(
      `DELETE FROM chunks WHERE node_id IN (${slice.map(() => '?').join(',')})`
    ).bind(...slice));
  }
  for (let i = 0; i < ids.length; i += PARAM_BATCH) {
    const slice = ids.slice(i, i + PARAM_BATCH);
    stmts.push(db.prepare(
      `DELETE FROM nodes WHERE id IN (${slice.map(() => '?').join(',')})`
    ).bind(...slice));
  }
  await db.batch(stmts);
}

export async function moveNode(db, from, to) {
  from = assertChildPath(from);
  to = assertChildPath(to);
  if (from === to) return;
  if ((to + '/').startsWith(from + '/')) throw new StoreError('Cannot move into itself', 400);
  const src = await getNode(db, from);
  if (!src) throw new StoreError('Source not found', 404);
  await mustBeFolder(db, parentOf(to));

  const dest = await getNode(db, to);
  if (dest && !!dest.is_folder !== !!src.is_folder) {
    throw new StoreError('Target exists with a different type', 409);
  }
  if (dest && !dest.is_folder) {
    // Overwrite an existing file at destination.
    await dropChunks(db, dest.id);
    await deleteRow(db, dest.id);
  } else if (dest && dest.is_folder) {
    // Merge not supported for folders — keep it predictable.
    throw new StoreError('Target folder already exists', 409);
  }

  const subtree = await selectSubtree(db, from);
  const stmts = [];
  for (const row of subtree) {
    const newPath = to + row.path.slice(from.length);
    const newParent = newPath === to ? normPath(parentOf(to)) : parentOf(newPath);
    const newName = newPath === to ? baseName(to) : row.name;
    stmts.push(db.prepare('UPDATE nodes SET path=?, parent_path=?, name=? WHERE id=?')
      .bind(newPath, newParent, newName, row.id));
    if (stmts.length >= PARAM_BATCH) { await db.batch(stmts); stmts.length = 0; }
  }
  if (stmts.length) await db.batch(stmts);
}

export async function copyNode(db, from, to) {
  from = assertChildPath(from);
  to = assertChildPath(to);
  if (from === to) return;
  if ((to + '/').startsWith(from + '/')) throw new StoreError('Cannot copy into itself', 400);
  const src = await getNode(db, from);
  if (!src) throw new StoreError('Source not found', 404);
  await mustBeFolder(db, parentOf(to));
  const dest = await getNode(db, to);
  if (dest && !!dest.is_folder !== !!src.is_folder) throw new StoreError('Target exists with a different type', 409);
  if (dest) throw new StoreError('Target already exists', 409);

  const subtree = await selectSubtree(db, from);
  const t = now();
  const idMap = new Map(); // old id -> new id

  async function cloneRow(row, newPath) {
    const newParent = newPath === to ? normPath(parentOf(to)) : parentOf(newPath);
    const newName = newPath === to ? baseName(to) : row.name;
    const r = await db.prepare(
      'INSERT INTO nodes (path, parent_path, name, is_folder, size, mime, created_at, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id'
    ).bind(newPath, newParent, newName, row.is_folder, row.size, row.mime,
           row.created_at || t, t).first();
    idMap.set(row.id, r.id);
    if (!row.is_folder) {
      await db.batch([
        db.prepare('INSERT INTO chunks (node_id, seq, data) SELECT ?, seq, data FROM chunks WHERE node_id = ?')
          .bind(r.id, row.id),
      ]);
    }
  }

  // Parents before children: rows are ordered by path, so prefix order holds.
  for (const row of subtree) {
    const newPath = to + row.path.slice(from.length);
    await cloneRow(row, newPath);
  }
  return idMap.size;
}

// ── Mime sniffing (best effort by extension) ────────────────────────────────
const MIME_MAP = {
  txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', log: 'text/plain',
  html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', ts: 'text/typescript',
  json: 'application/json', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', bmp: 'image/bmp',
  avif: 'image/avif',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
export function guessMime(nameOrPath) {
  const ext = String(nameOrPath).split('.').pop().toLowerCase();
  return MIME_MAP[ext] || 'application/octet-stream';
}
