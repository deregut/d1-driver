// ─────────────────────────────────────────────────────────────────────────────
// /dav/* — WebDAV Class 1 endpoint backed by D1.
//
// Supported methods:
//   OPTIONS   → capability discovery (DAV: 1)
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
function hrefFor(node) {
  const segs = String(node.path).split('/').filter(Boolean);
  let h = BASE + (segs.length ? '/' + segs.map(encodeURIComponent).join('/') : '');
  if (node.is_folder && !h.endsWith('/')) h += '/';
  return h;
}

const xmlEsc = (s) =>
  String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function httpDate(ms) {
  return new Date(ms || 0).toUTCString();
}
function isoDate(ms) {
  return new Date(ms || 0).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function propfindXml(hrefBase, node) {
  void hrefBase;
  const isFolder = !!node.is_folder;
  const href = hrefFor(node);
  const parts = [];
  parts.push(`<D:href>${xmlEsc(href)}</D:href>`);
  parts.push('<D:propstat><D:prop xmlns:b="urn:webdav:*">');
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
  parts.push(`<D:supportedlock/>`);
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

function parseDestination(request) {
  const dest = request.headers.get('Destination');
  if (!dest) return null;
  let u;
  try { u = new URL(dest, request.url); } catch { return null; }
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
  const { bytes } = await store.readFile(db, path);
  const fname = encodeURIComponent(node.name);
  const headers = {
    'content-type': node.mime || 'application/octet-stream',
    'content-length': String(bytes.byteLength),
    'content-disposition': `inline; filename*=UTF-8''${fname}`,
    'accept-ranges': 'none',
    'last-modified': httpDate(node.updated_at),
    etag: `"${node.size}-${node.updated_at}"`,
  };
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(bytes, { status: 200, headers });
}

async function handlePut(request, db, path) {
  if (path === '/') return new Response('400 Invalid target', { status: 400 });
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
  if (!dest || dest === '/') return new Response('400 Bad Destination', { status: 400 });
  if (!dest.startsWith('/') ) return new Response('502 Bad Gateway', { status: 502 });
  const overwrite = (request.headers.get('Overwrite') || 'T').toUpperCase() !== 'F';

  const srcNode = await store.getNode(db, path);
  if (!srcNode) return new Response('404 Not Found', { status: 404 });

  const destNode = await store.getNode(db, dest);
  if (destNode && !overwrite) return new Response('412 Precondition Failed', { status: 412 });
  if (path === dest) return new Response('403 Forbidden', { status: 403 });

  // Ensure destination parent chain exists (lenient like PUT).
  await store.mkdirp(db, store.parentOf(dest));
  const existed = Boolean(await store.getNode(db, dest));

  if (isMove) {
    if (existed) await store.deleteNode(db, dest);
    await store.moveNode(db, path, dest);
  } else {
    if (existed) await store.deleteNode(db, dest);
    await store.copyNode(db, path, dest);
  }
  return new Response(null, { status: existed ? 204 : 201 });
}

export async function onRequest({ request, env }) {
  const db = env.DB;
  const url = new URL(request.url);
  const path = decodeDavPath(url.pathname);
  const method = request.method.toUpperCase();

  const davHeaders = () => ({
    DAV: '1',
    'ms-author-via': 'DAV',
    Allow: 'OPTIONS, GET, HEAD, PUT, PROPFIND, MKCOL, DELETE, MOVE, COPY',
    'content-length': '0',
  });

  try {
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
    console.error('WebDAV error:', err);
    return new Response('500 Internal Server Error', { status: 500 });
  }
}

// Silence unused-var lint about authEnabled import (auth is enforced in middleware).
void authEnabled;
