// ─────────────────────────────────────────────────────────────────────────────
// /dav/* — WebDAV Class 1 endpoint backed by D1.
//
// Supported methods:
//   OPTIONS   → capability discovery (DAV: 1, 2)
//   LOCK/UNLOCK/PROPPATCH → accepted but stateless (no real locking); they exist so
//             macOS Finder / Office / iOS apps treat the share as writable
//   PROPFIND  → Depth: 0/1 listing (207 Multistatus)
//   GET/HEAD  → download file
//   PUT       → upload/create or overwrite file (parents auto-created)
//   MKCOL     → create folder
//   DELETE    → recursive delete
//   MOVE      → move/rename (Overwrite: T/F honored)
//   COPY      → deep copy   (Overwrite: T/F honored)
//
// Mount URL: https://<your-pages-domain>/dav/
// ─────────────────────────────────────────────────────────────────────────────
import * as store from '../lib/store.js';
import { authEnabled } from '../lib/auth.js';

const BASE = '/dav';

// Decode a percent-encoded URL path into an internal store path.
function decodeDavPath(pathname) {
  let p = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname;
  try {
    p = p.split('/').map((s) => {
      try { return decodeURIComponent(s); } catch { return s; }
    }).join('/');
  } catch { /* keep raw */ }
  return store.normPath(p);
}

// Build the WebDAV href for a node ('/dav/a/b/', collections end with '/')
function safeEnc(seg) {
  try { return encodeURIComponent(seg); }
  catch { return encodeURIComponent(String(seg).replace(/[\ud800-\udfff]/g, '\ufffd')); }
}
function hrefFor(node) {
  const segs = String(node.path).split('/').filter(Boolean);
  let h = BASE + (segs.length ? '/' + segs.map(safeEnc).join('/') : '');
  if (node.is_folder && !h.endsWith('/')) h += '/';
  return h;
}

const xmlEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function validDate(ms) {
  const d = new Date(Number(ms) || 0);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}
function httpDate(ms) { return validDate(ms).toUTCString(); }
function isoDate(ms) { return validDate(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }

const LOCK_PROPS =
  '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope>' +
  '<D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock><D:lockdiscovery/>';

function propfindXml(hrefBase, node) {
  void hrefBase;
  const isFolder = !!node.is_folder;
  const href = hrefFor(node);
  const parts = [];
  parts.push(`<D:href>${xmlEsc(href)}</D:href>`);
  parts.push('<D:propstat><D:prop>');
  parts.push(isFolder
    ? '<D:resourcetype><D:collection/></D:resourcetype>'
    : '<D:resourcetype/>');
  parts.push(`<D:displayname>${xmlEsc(node.name || 'root')}</D:displayname>`);
  if (!isFolder) {
    parts.push(`<D:getcontentlength>${node.size}</D:getcontentlength>`);
    parts.push(`<D:getcontenttype>${xmlEsc(node.mime || 'application/octet-stream')}</D:getcontenttype>`);
    parts.push(`<D:getetag>"${node.size}-${node.updated_at}"</D:getetag>`);
  }
  parts.push(`<D:getlastmodified>${httpDate(node.updated_at)}</D:getlastmodified>`);
  parts.push(`<D:creationdate>${isoDate(node.created_at)}</D:creationdate>`);
  parts.push(LOCK_PROPS);
  parts.push('</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>');
  return `<D:response>${parts.join('')}</D:response>`;
}

const multistatus = (responses) =>
  '<?xml version="1.0" encoding="utf-8"?>\n' +
  `<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;

const xmlResponse = (body, status = 207) =>
  new Response(body, {
    status,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
  });

// Returns an internal path, 'EXTERNAL' (other host / outside /dav) or null (missing/invalid).
function parseDestination(request) {
  const dest = request.headers.get('Destination');
  if (!dest) return null;
  let u;
  try { u = new URL(dest, request.url); } catch { return null; }
  if (u.host !== new URL(request.url).host) return 'EXTERNAL';
  if (u.pathname !== BASE && !u.pathname.startsWith(BASE + '/')) return 'EXTERNAL';
  return decodeDavPath(u.pathname);
}

async function handleGet(request, db, path) {
  if (path === '/') {
    return new Response('D1 Drive WebDAV — this is the root collection.\n', {
      status: 200,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
  }
  const node = await store.getNode(db, path);
  if (!node) return new Response('404 Not Found', { status: 404 });
  if (node.is_folder) {
    return new Response('405 Cannot GET a collection', { status: 405 });
  }
  const fname = safeEnc(node.name);
  const headers = {
    'content-type': node.mime || 'application/octet-stream',
    'content-length': String(node.size),
    'content-disposition': `inline; filename*=UTF-8''${fname}`,
    'accept-ranges': 'none',
    'last-modified': httpDate(node.updated_at),
    etag: `"${node.size}-${node.updated_at}"`,
  };
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  const { bytes } = await store.readFile(db, path);
  headers['content-length'] = String(bytes.byteLength);
  return new Response(bytes, { status: 200, headers });
}

async function handlePut(request, db, path) {
  if (path === '/') return new Response('400 Invalid target', { status: 400 });
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > store.MAX_FILE_SIZE) return new Response('413 File too large (max 50 MB)', { status: 413 });
  // Lenient: auto-create parent collections so drag-drop "just works".
  await store.mkdirp(db, store.parentOf(path));
  const existing = await store.getNode(db, path);
  const buf = await request.arrayBuffer();
  const mime = request.headers.get('content-type')?.split(';')[0] ||
               store.guessMime(path);
  await store.writeFile(db, path, buf, mime);
  return new Response(null, { status: existing ? 204 : 201 });
}

async function handleMkcol(request, db, path) {
  if (path === '/') return new Response('405 Method Not Allowed', { status: 405 });
  const existing = await store.getNode(db, path);
  if (existing) return new Response('405 Method Not Allowed', { status: 405 });
  const parent = await store.getNode(db, store.parentOf(path));
  if (!parent || !parent.is_folder) return new Response('409 Conflict', { status: 409 });
  await store.createFolder(db, path);
  return new Response(null, { status: 201 });
}

async function handleDelete(db, path) {
  if (path === '/') return new Response('403 Forbidden', { status: 403 });
  await store.deleteNode(db, path);
  return new Response(null, { status: 204 });
}

async function handleMoveCopy(request, db, path, isMove) {
  const dest = parseDestination(request);
  if (dest === 'EXTERNAL') return new Response('502 Destination must be on this server under /dav/', { status: 502 });
  if (!dest || dest === '/') return new Response('400 Bad Destination', { status: 400 });
  const overwrite = (request.headers.get('Overwrite') || 'T').toUpperCase() !== 'F';

  const srcNode = await store.getNode(db, path);
  if (!srcNode) return new Response('404 Not Found', { status: 404 });
  if (path === dest) return new Response('403 Forbidden', { status: 403 });
  if ((dest + '/').startsWith(path + '/')) return new Response('403 Cannot copy/move into itself', { status: 403 });

  const destNode = await store.getNode(db, dest);
  if (destNode && !overwrite) return new Response('412 Precondition Failed', { status: 412 });

  // Ensure destination parent chain exists (lenient like PUT).
  await store.mkdirp(db, store.parentOf(dest));

  // Replacing a folder, or replacing across types, needs the old target gone first.
  // File → file replacement is done atomically inside moveNode/copyNode.
  if (destNode && (destNode.is_folder || srcNode.is_folder)) await store.deleteNode(db, dest);

  if (isMove) await store.moveNode(db, path, dest);
  else await store.copyNode(db, path, dest, { overwrite: true });
  return new Response(null, { status: destNode ? 204 : 201 });
}

// Stateless "lock": enough for clients that insist on LOCK before writing.
async function handleLock(request, db, path) {
  let created = false;
  let node = await store.getNode(db, path);
  if (!node) {
    await store.mkdirp(db, store.parentOf(path));
    await store.writeFile(db, path, new ArrayBuffer(0), '');
    node = await store.getNode(db, path);
    created = true;
  }
  const ifHdr = request.headers.get('If') || '';
  const token = (ifHdr.match(/<(opaquelocktoken:[^>]+)>/) || [])[1] || 'opaquelocktoken:' + crypto.randomUUID();
  const m = /Second-(\d+)/i.exec(request.headers.get('Timeout') || '');
  const timeout = m ? Math.min(Number(m[1]), 86400) : 3600;
  const body =
    '<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock>' +
    '<D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>0</D:depth>' +
    `<D:timeout>Second-${timeout}</D:timeout><D:locktoken><D:href>${xmlEsc(token)}</D:href></D:locktoken>` +
    `<D:lockroot><D:href>${xmlEsc(hrefFor(node))}</D:href></D:lockroot>` +
    '</D:activelock></D:lockdiscovery></D:prop>';
  return new Response(body, {
    status: created ? 201 : 200,
    headers: { 'content-type': 'application/xml; charset=utf-8', 'Lock-Token': `<${token}>` },
  });
}

async function handleProppatch(db, path) {
  const node = await store.getNode(db, path);
  if (!node) return new Response('404 Not Found', { status: 404 });
  return xmlResponse(multistatus([
    `<D:response><D:href>${xmlEsc(hrefFor(node))}</D:href><D:propstat><D:prop/>` +
    '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>',
  ]));
}

// ── Optional CORS (for browser-based WebDAV apps). Off unless DAV_CORS_ORIGINS is set
// ("*" or a comma-separated list of origins).
function corsOrigin(request, env) {
  const cfg = (env.DAV_CORS_ORIGINS || '').trim();
  if (!cfg) return null;
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  if (cfg === '*') return origin;
  return cfg.split(',').map((x) => x.trim()).includes(origin) ? origin : null;
}
function withCors(res, request, env) {
  const origin = corsOrigin(request, env);
  if (!origin) return res;
  const r = new Response(res.body, res);
  r.headers.set('Access-Control-Allow-Origin', origin);
  r.headers.set('Access-Control-Allow-Credentials', 'true');
  r.headers.set('Access-Control-Allow-Methods', ALLOW);
  r.headers.set('Access-Control-Allow-Headers',
    request.headers.get('Access-Control-Request-Headers') ||
    'Authorization, Depth, Destination, Overwrite, Content-Type, If, Lock-Token, Timeout');
  r.headers.set('Access-Control-Expose-Headers', 'DAV, Allow, Lock-Token, Content-Length, ETag, Last-Modified');
  r.headers.set('Vary', 'Origin');
  return r;
}

const ALLOW = 'OPTIONS, GET, HEAD, PUT, PROPFIND, PROPPATCH, MKCOL, DELETE, MOVE, COPY, LOCK, UNLOCK';

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS' && request.headers.has('Access-Control-Request-Method')) {
    return withCors(new Response(null, { status: 204 }), request, env);   // CORS preflight
  }
  const res = await handle({ request, env });
  return withCors(res, request, env);
}

async function handle({ request, env }) {
  const method = request.method.toUpperCase();
  try {
    const db = env.DB;
    if (!db) return new Response('500 D1 binding "DB" is not configured', { status: 500 });
    const url = new URL(request.url);
    const path = decodeDavPath(url.pathname);

    const davHeaders = () => ({ DAV: '1, 2', 'ms-author-via': 'DAV', Allow: ALLOW });

    switch (method) {
      case 'OPTIONS':
        return new Response(null, { status: 200, headers: davHeaders() });

      case 'PROPFIND': {
        const depthHeader = (request.headers.get('Depth') ?? '1').trim();
        if (depthHeader === 'infinity') {
          // RFC 4918 allows refusing infinite depth.
          return new Response(
            '<?xml version="1.0" encoding="utf-8"?>\n<D:error xmlns:D="DAV:"><D:propfind-finite-depth/></D:error>',
            { status: 403, headers: { 'content-type': 'application/xml; charset=utf-8' } });
        }
        const node = await store.getNode(db, path);
        if (!node) return new Response('404 Not Found', { status: 404 });
        const responses = [propfindXml(url.pathname, node)];
        if (depthHeader !== '0' && node.is_folder) {
          const children = await store.listChildren(db, path);
          for (const c of children) responses.push(propfindXml(url.pathname, c));
        }
        return xmlResponse(multistatus(responses));
      }

      case 'PROPPATCH':
        return await handleProppatch(db, path);

      case 'LOCK':
        return await handleLock(request, db, path);

      case 'UNLOCK':
        return new Response(null, { status: 204 });

      case 'GET':
      case 'HEAD':
        return await handleGet(request, db, path);

      case 'PUT':
        return await handlePut(request, db, path);

      case 'MKCOL':
        return await handleMkcol(request, db, path);

      case 'DELETE':
        return await handleDelete(db, path);

      case 'MOVE':
        return await handleMoveCopy(request, db, path, true);

      case 'COPY':
        return await handleMoveCopy(request, db, path, false);

      default:
        return new Response(`405 Method ${method} Not Allowed`, {
          status: 405,
          headers: davHeaders(),
        });
    }
  } catch (err) {
    if (err instanceof store.StoreError) {
      return new Response(err.status + ' ' + err.message, { status: err.status });
    }
    console.error('WebDAV error:', method, err && err.stack || err);
    // Set DAV_DEBUG=1 (var or secret) to see the real error text in the response body.
    const detail = env.DAV_DEBUG ? ` — ${err && err.message ? err.message : String(err)}` : '';
    return new Response('500 Internal Server Error' + detail, { status: 500 });
  }
}

// Silence unused-var lint about authEnabled import (auth is enforced in middleware).
void authEnabled;
