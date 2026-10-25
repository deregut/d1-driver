// ─────────────────────────────────────────────────────────────────────────────
// store.js — D1 data layer for D1 Drive.
// Files are split into CHUNK_SIZE blobs in table `chunks`; metadata in `nodes`.
// ─────────────────────────────────────────────────────────────────────────────

export const CHUNK_SIZE = 512 * 1024; // 512 KiB per D1 row — safely under limits
const INSERT_BATCH = 8;               // chunks per db.batch() (8 × 512KiB = 4MiB)
const PARAM_BATCH = 80;               // max bound params per statement (D1 limit: 100)
const READ_PAGE = 4;                  // chunk rows per SELECT when reading (4 × 512KiB = 2MiB)

// One HTTP upload piece = up to 8 chunks. Chunk seq = pieceSeq * CHUNKS_PER_PIECE + i,
// so pieces can be uploaded in parallel / out of order without seq collisions.
export const CHUNKS_PER_PIECE = 8;
export const PIECE_MAX = CHUNKS_PER_PIECE * CHUNK_SIZE; // 4 MiB

// Max file size. Pages Functions (free) have 128 MB memory and downloads are
// assembled in memory, so keep this well below that.
export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MiB

// Rows being written by writeFile/copy live under this (never-listed) parent
// until they are swapped into place atomically.
const STAGE = '/.__stage__';
const STAGE_TTL_MS = 60 * 60 * 1000;
const rand = () => Math.random().toString(36).slice(2, 10);

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

// Store one upload piece (<= 4 MiB). It is split into 512 KiB rows because a
// single D1 row/BLOB cannot exceed ~2 MB.
export async function putPiece(db, id, pieceSeq, bytes) {
  if (bytes.byteLength > PIECE_MAX) {
    throw new StoreError(`Piece too large (max ${PIECE_MAX} bytes)`, 413);
  }
  if (!Number.isInteger(pieceSeq) || pieceSeq < 0) throw new StoreError('Bad seq', 400);
  const n = await db.prepare('SELECT is_folder FROM nodes WHERE id = ?').bind(id).first();
  if (!n || n.is_folder) throw new StoreError('Upload target not found', 404);
  const stmts = [];
  for (let i = 0; i * CHUNK_SIZE < bytes.byteLength; i++) {
    stmts.push(
      db.prepare('INSERT OR REPLACE INTO chunks (node_id, seq, data) VALUES (?, ?, ?)')
        .bind(id, pieceSeq * CHUNKS_PER_PIECE + i,
              bytes.slice(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, bytes.byteLength))));
  }
  if (stmts.length) await db.batch(stmts);
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
// The new content is staged under a hidden parent, verified, and then swapped in
// with the old file removal inside one batch (transaction), so a failure midway
// never leaves a half-written or missing file.
export async function writeFile(db, path, bytes, mime) {
  path = assertChildPath(path);
  if (bytes.byteLength > MAX_FILE_SIZE) throw new StoreError('File too large (max 50 MB)', 413);
  await mustBeFolder(db, parentOf(path));
  const prev = await getNode(db, path);
  if (prev && prev.is_folder) throw new StoreError('A folder exists at that path', 409);

  const t = now();
  // Opportunistic cleanup of abandoned staging rows.
  await db.batch([
    db.prepare('DELETE FROM chunks WHERE node_id IN (SELECT id FROM nodes WHERE parent_path = ? AND updated_at < ?)')
      .bind(STAGE, t - STAGE_TTL_MS),
    db.prepare('DELETE FROM nodes WHERE parent_path = ? AND updated_at < ?').bind(STAGE, t - STAGE_TTL_MS),
  ]);

  const stagePath = `${STAGE}/${t}-${rand()}`;
  const r = await db.prepare(
    'INSERT INTO nodes (path, parent_path, name, is_folder, size, mime, created_at, updated_at) ' +
    'VALUES (?, ?, ?, 0, ?, ?, ?, ?) RETURNING id'
  ).bind(stagePath, STAGE, baseName(path), bytes.byteLength, mime || guessMime(path),
         (prev && prev.created_at) || t, t).first();
  const id = r.id;
  try {
    await insertChunks(db, id, bytes);
    const agg = await db.prepare(
      'SELECT COALESCE(SUM(LENGTH(data)),0) AS bytes FROM chunks WHERE node_id = ?'
    ).bind(id).first();
    if (agg.bytes !== bytes.byteLength) throw new StoreError('Write verification failed', 500);
  } catch (e) {
    try { await dropChunks(db, id); await deleteRow(db, id); } catch { /* best effort */ }
    throw e;
  }
  const stmts = [];
  if (prev) {
    stmts.push(db.prepare('DELETE FROM chunks WHERE node_id = ?').bind(prev.id));
    stmts.push(db.prepare('DELETE FROM nodes WHERE id = ?').bind(prev.id));
  }
  stmts.push(db.prepare('UPDATE nodes SET path = ?, parent_path = ?, name = ?, updated_at = ? WHERE id = ?')
    .bind(path, normPath(parentOf(path)), baseName(path), now(), id));
  await db.batch(stmts);
  return id;
}

// ── File read ───────────────────────────────────────────────────────────────
export async function readFile(db, path) {
  const node = await getNode(db, path);
  if (!node) throw new StoreError('Not found', 404);
  if (node.is_folder) throw new StoreError('Is a folder', 400);
  // Pre-allocate the output buffer and fill it page by page, so the file is
  // never held in memory twice (Pages Functions: 128 MB limit).
  let out = new Uint8Array(node.size || 0);
  let o = 0;
  let offset = 0;
  while (true) {
    const page = await db.prepare(
      'SELECT data FROM chunks WHERE node_id = ? ORDER BY seq LIMIT ? OFFSET ?'
    ).bind(node.id, READ_PAGE, offset).all();
    for (const row of page.results) {
      const part = new Uint8Array(row.data);
      if (o + part.length > out.length) {           // size metadata off: grow
        const bigger = new Uint8Array(o + part.length);
        bigger.set(out.subarray(0, o));
        out = bigger;
      }
      out.set(part, o);
      o += part.length;
    }
    if (page.results.length < READ_PAGE) break;
    offset += READ_PAGE;
  }
  if (o !== out.length) out = out.subarray(0, o);
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
  if (dest && dest.is_folder) {
    // Merge not supported for folders — keep it predictable.
    throw new StoreError('Target folder already exists', 409);
  }

  const subtree = await selectSubtree(db, from);
  const stmts = [];
  if (dest) { // overwrite an existing file: removed in the same transaction as the rename
    stmts.push(db.prepare('DELETE FROM chunks WHERE node_id = ?').bind(dest.id));
    stmts.push(db.prepare('DELETE FROM nodes WHERE id = ?').bind(dest.id));
  }
  for (const row of subtree) {
    const newPath = to + row.path.slice(from.length);
    const newParent = newPath === to ? normPath(parentOf(to)) : parentOf(newPath);
    const newName = newPath === to ? baseName(to) : row.name;
    stmts.push(db.prepare('UPDATE nodes SET path=?, parent_path=?, name=? WHERE id=?')
      .bind(newPath, newParent, newName, row.id));
  }
  // One transaction when it fits; very large trees are applied in slices.
  for (let i = 0; i < stmts.length; i += 400) await db.batch(stmts.slice(i, i + 400));
}

// Copy a file or a whole folder tree. With { overwrite: true } an existing
// *file* at the destination is replaced atomically; folders must be removed by
// the caller first.
export async function copyNode(db, from, to, { overwrite = false } = {}) {
  from = assertChildPath(from);
  to = assertChildPath(to);
  if (from === to) return 0;
  if ((to + '/').startsWith(from + '/')) throw new StoreError('Cannot copy into itself', 400);
  const src = await getNode(db, from);
  if (!src) throw new StoreError('Source not found', 404);
  await mustBeFolder(db, parentOf(to));
  const dest = await getNode(db, to);
  if (dest && !!dest.is_folder !== !!src.is_folder) throw new StoreError('Target exists with a different type', 409);
  if (dest && (!overwrite || dest.is_folder)) throw new StoreError('Target already exists', 409);

  const t = now();
  const insNode = (path, parent, name, row) => db.prepare(
    'INSERT INTO nodes (path, parent_path, name, is_folder, size, mime, created_at, updated_at) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(path, parent, name, row.is_folder, row.size, row.mime, row.created_at || t, t);
  const insChunks = (newPath, oldId) => db.prepare(
    'INSERT INTO chunks (node_id, seq, data) ' +
    'SELECT (SELECT id FROM nodes WHERE path = ?), seq, data FROM chunks WHERE node_id = ?'
  ).bind(newPath, oldId);

  // Single file replacing an existing file: stage, then swap — all in one batch.
  if (dest) {
    const stagePath = `${STAGE}/${t}-${rand()}`;
    await db.batch([
      insNode(stagePath, STAGE, baseName(to), src),
      insChunks(stagePath, src.id),
      db.prepare('DELETE FROM chunks WHERE node_id = ?').bind(dest.id),
      db.prepare('DELETE FROM nodes WHERE id = ?').bind(dest.id),
      db.prepare('UPDATE nodes SET path = ?, parent_path = ?, name = ? WHERE path = ?')
        .bind(to, normPath(parentOf(to)), baseName(to), stagePath),
    ]);
    return 1;
  }

  const subtree = await selectSubtree(db, from);
  const stmts = [];
  for (const row of subtree) {
    const newPath = to + row.path.slice(from.length);
    const newParent = newPath === to ? normPath(parentOf(to)) : parentOf(newPath);
    const newName = newPath === to ? baseName(to) : row.name;
    stmts.push(insNode(newPath, newParent, newName, row));
    if (!row.is_folder) stmts.push(insChunks(newPath, row.id));
  }
  // ~20 files per round trip keeps us far below the 50-queries-per-request limit.
  for (let i = 0; i < stmts.length; i += 40) await db.batch(stmts.slice(i, i + 40));
  return subtree.length;
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
