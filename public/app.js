/* D1 Drive — frontend app */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  path: '/',
  items: [],
  filtered: [],
  sel: new Set(),          // selected paths
  view: localStorage.getItem('d1.view') || 'grid',
  sort: localStorage.getItem('d1.sort') || 'name-asc',
  filter: '',
  loadedPath: null,
};

/* ── helpers ─────────────────────────────────────────────────────────── */

function fmtBytes(n) {
  if (n === 0) return '0 B';
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i === 0 ? 0 : 1).replace(/\.0$/, '') + ' ' + u[i];
}

function fmtDate(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const diff = (Date.now() - ms) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 7 * 86400) return `${Math.floor(diff / 86400)}d ago`;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3200);
}

async function api(route, opts = {}) {
  const r = await fetch('/api' + route, { credentials: 'same-origin', ...opts });
  if (r.status === 401) {
    toast('Sign-in required — reload to enter credentials', 'err');
    throw new Error('401');
  }
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data?.error || r.statusText || 'Request failed');
  return data;
}
const jsonReq = (route, body) =>
  api(route, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

function validName(name) {
  name = name.trim();
  if (!name || name === '.' || name === '..') return null;
  if (/[\\/\x00-\x1f]/.test(name) || name.length > 255) return null;
  return name;
}

/* ── file-type icons ─────────────────────────────────────────────────── */

const GLYPHS = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M3.5 17.5l4.8-4.8a1.4 1.4 0 0 1 2 0l6.7 6.7m0 0L14.6 17a1.4 1.4 0 0 1 2 0l2.9 2.9"/>',
  video: '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M10 9.2v5.6l4.8-2.8L10 9.2z" fill="currentColor" stroke="none"/>',
  audio: '<path d="M9 18V6l11-2v12"/><circle cx="6.6" cy="18" r="2.6"/><circle cx="17.6" cy="16" r="2.6"/>',
  pdf: '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M8.5 13h7M8.5 16.5h7"/>',
  code: '<path d="M8.5 7L4 12l4.5 5M15.5 7L20 12l-4.5 5"/>',
  archive: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M12 3.5v4m0 2v1.5m0 2.5v2.5M9.5 20v-3.5h5V20"/>',
  doc: '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4M8.5 12h7M8.5 15.5h7M8.5 19h4"/>',
  sheet: '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 9.5h16M4 15h16M9.5 4v16M15 4v16"/>',
  slide: '<rect x="4" y="4.5" width="16" height="12" rx="2"/><path d="M12 16.5v3M8.5 21.5h7M9.5 12l2.5-4 2.5 4"/>',
  file: '<path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v4h4"/>',
};

const CODE_EXT = new Set(['js','mjs','ts','tsx','jsx','html','htm','css','scss','json','xml','yml','yaml','py','rb','go','rs','java','c','cpp','h','sh','bat','ps1','sql','toml','ini','conf']);
const ARCHIVE_EXT = new Set(['zip','rar','7z','tar','gz','bz2','xz','iso','dmg']);

function category(item) {
  if (item.type === 'folder') return 'folder';
  const ext = item.name.split('.').pop().toLowerCase();
  const m = item.mime || '';
  if (ext === 'pdf' || m === 'application/pdf') return 'pdf';
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (CODE_EXT.has(ext)) return 'code';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (['doc','docx','rtf','odt'].includes(ext)) return 'doc';
  if (['xls','xlsx','csv','ods'].includes(ext)) return 'sheet';
  if (['ppt','pptx','odp'].includes(ext)) return 'slide';
  if (['txt','md','log'].includes(ext)) return 'doc';
  return 'file';
}
const GRAD = { folder:'g-folder', image:'g-image', video:'g-video', audio:'g-audio', pdf:'g-pdf', code:'g-code', archive:'g-archive', doc:'g-doc', sheet:'g-sheet', slide:'g-slide', file:'g-file' };

const ftileSvg = (cat) => `<svg viewBox="0 0 24 24">${GLYPHS[cat]}</svg>`;

const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4 10-10"/></svg>';

/* ── rendering ───────────────────────────────────────────────────────── */

function applyFilterSort() {
  const f = state.filter.toLowerCase();
  let items = state.items.filter((i) => !f || i.name.toLowerCase().includes(f));
  const [key, dir] = state.sort.split('-');
  const mul = dir === 'desc' ? -1 : 1;
  items = items.slice().sort((a, b) => {
    if (key === 'size') return (a.size - b.size) * mul;
    if (key === 'date') return (a.updated_at - b.updated_at) * mul;
    return a.name.localeCompare(b.name, undefined, { numeric: true }) * mul;
  });
  // folders first
  items.sort((a, b) => (b.type === 'folder') - (a.type === 'folder'));
  state.filtered = items;
}

function render() {
  renderCrumbs();
  applyFilterSort();
  const items = state.filtered;
  $('#empty').hidden = items.length > 0 || state.loadedPath === null;

  if (state.view === 'grid') {
    $('#grid').style.display = '';
    $('#list-wrap').hidden = true;
    $('#grid').innerHTML = items.map(tileHtml).join('');
    bindTileEvents($('#grid'));
  } else {
    $('#grid').style.display = 'none';
    $('#list-wrap').hidden = false;
    $('#list-body').innerHTML = items.map(rowHtml).join('');
    bindTileEvents($('#list-body'));
  }
  updateBulkbar();
  $('#btn-view').innerHTML = state.view === 'grid'
    ? '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M4 10h16M4 15.5h16M10.5 10V20"/></svg>'
    : '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>';
}

function tileHtml(item) {
  const cat = category(item);
  const sel = state.sel.has(item.path);
  const meta = item.type === 'folder'
    ? 'Folder'
    : fmtBytes(item.size);
  return `
  <div class="tile ${sel ? 'selected' : ''}" data-path="${escAttr(item.path)}" data-type="${item.type}">
    <button class="pick ${sel ? 'checked' : ''}" title="Select">${CHECK_SVG}</button>
    <div class="ftile ${GRAD[cat]}">${ftileSvg(cat)}</div>
    <span class="name">${escHtml(item.name)}</span>
    <span class="meta">${meta}</span>
  </div>`;
}

function rowHtml(item) {
  const cat = category(item);
  const sel = state.sel.has(item.path);
  return `
  <tr class="row ${sel ? 'selected' : ''}" data-path="${escAttr(item.path)}" data-type="${item.type}">
    <td class="pick-cell"><button class="pick ${sel ? 'checked' : ''}" title="Select">${CHECK_SVG}</button></td>
    <td><div class="cell-name"><div class="ftile ${GRAD[cat]}">${ftileSvg(cat)}</div><span class="name">${escHtml(item.name)}</span></div></td>
    <td class="meta">${item.type === 'folder' ? '—' : fmtBytes(item.size)}</td>
    <td class="meta">${fmtDate(item.updated_at)}</td>
    <td class="meta"></td>
  </tr>`;
}

function escHtml(s) { return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escAttr(s) { return escHtml(s); }

function renderCrumbs() {
  const parts = state.path.split('/').filter(Boolean);
  let html = `<a href="#" data-crumb="/">Home</a>`;
  let acc = '';
  for (const p of parts) {
    acc += '/' + p;
    html += `<span class="sep">›</span><a href="#" data-crumb="${escAttr(acc)}">${escHtml(p)}</a>`;
  }
  $('#breadcrumbs').innerHTML = html || `<span class="here">Home</span>`;
}

async function load(path) {
  $('#skeleton').hidden = false;
  $('#empty').hidden = true;
  $('#skeleton').innerHTML = Array.from({ length: 8 }, () => '<div class="skeleton-tile"></div>').join('');
  $('#grid').style.display = 'none';
  $('#list-wrap').hidden = true;
  try {
    const data = await api('/list?path=' + encodeURIComponent(path));
    state.path = data.path || path;
    state.items = data.items;
    state.sel.clear();
    state.loadedPath = state.path;
    history.replaceState(null, '', '#' + encodeURIComponent(state.path));
    render();
  } catch (e) {
    if (e.message !== '401') toast(e.message, 'err');
  } finally {
    $('#skeleton').hidden = true;
    if (state.view === 'grid') $('#grid').style.display = '';
    else $('#list-wrap').hidden = false;
  }
}

/* ── selection & bulk bar ────────────────────────────────────────────── */

function toggleSel(path) {
  state.sel.has(path) ? state.sel.delete(path) : state.sel.add(path);
  refreshSelection();
}
function refreshSelection() {
  $$('.tile, tr.row').forEach((el) => {
    const on = state.sel.has(el.dataset.path);
    el.classList.toggle('selected', on);
    const pick = $('.pick', el);
    if (pick) pick.classList.toggle('checked', on);
  });
  updateBulkbar();
}
function updateBulkbar() {
  const n = state.sel.size;
  $('#bulkbar').hidden = n === 0;
  if (n) $('#bulk-count').textContent = `${n} item${n > 1 ? 's' : ''} selected`;
}

async function bulkDelete() {
  const n = state.sel.size;
  if (!n) return;
  const ok = await confirmModal(`Delete ${n} item${n > 1 ? 's' : ''}?`, 'Folders are deleted recursively along with everything inside. This cannot be undone.');
  if (!ok) return;
  let done = 0, fail = 0;
  for (const p of [...state.sel]) {
    try { await jsonReq('/delete', { path: p }); done++; }
    catch (e) { fail++; console.error(e); }
  }
  state.sel.clear();
  toast(`Deleted ${done}${fail ? `, failed ${fail}` : ''}`, fail ? 'err' : 'ok');
  await load(state.path);
}

/* ── context menu ────────────────────────────────────────────────────── */

const CM_ACTIONS = [
  { id: 'open', label: 'Open', icon: '<path d="M14 4h6v6M20 4l-9 9M10 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-4"/>' },
  { id: 'download', label: 'Download', icon: '<path d="M12 4v11m0 0l-4-4m4 4l4-4M5 20h14"/>' },
  { id: 'copylink', label: 'Copy direct link', icon: '<path d="M10 14a4 4 0 0 0 6 .4l3-3a4 4 0 0 0-5.6-5.6l-1.5 1.5M14 10a4 4 0 0 0-6-.4l-3 3a4 4 0 0 0 5.6 5.6l1.5-1.5"/>' },
  '-',
  { id: 'rename', label: 'Rename', icon: '<path d="M15 5l4 4L8 20H4v-4L15 5zM13 7l4 4"/>' },
  { id: 'move', label: 'Move to…', icon: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zm6 5h6m0 0l-2.5-2.5M15 12l-2.5 2.5"/>' },
  { id: 'copyto', label: 'Copy to…', icon: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>' },
  '-',
  { id: 'delete', label: 'Delete', icon: '<path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0l1 13a1 1 0 0 0 1 .9h8a1 1 0 0 0 1-.9L18 7M10 11v6M14 11v6"/>', destructive: true },
];

function openCtxMenu(x, y, items) {
  const menu = $('#ctxmenu');
  menu.innerHTML = CM_ACTIONS.map((a) =>
    a === '-' ? '<hr>' :
    `<button data-act="${a.id}" class="${a.destructive ? 'destructive' : ''}">
       <svg viewBox="0 0 24 24">${a.icon}</svg>${a.label}</button>`).join('');
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 10) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 10) + 'px';
  menu.onclick = async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    hideCtxMenu();
    await handleAction(btn.dataset.act, items);
  };
}
function hideCtxMenu() { $('#ctxmenu').hidden = true; }

async function handleAction(act, items) {
  const one = items.length === 1 ? items[0] : null;
  try {
    switch (act) {
      case 'open':
        if (one) openItem(one);
        break;
      case 'download':
        for (const it of items) if (it.type === 'file') downloadFile(it.path);
        break;
      case 'copylink':
        if (one && one.type === 'file') {
          const url = location.origin + '/api/download?path=' + encodeURIComponent(one.path);
          await navigator.clipboard.writeText(url);
          toast('Link copied', 'ok');
        }
        break;
      case 'rename': {
        if (!one) break;
        const name = await promptModal('Rename', one.name, (v) =>
          validName(v) ? '' : 'Invalid name (no slashes, not empty)');
        if (name && name !== one.name) {
          await jsonReq('/move', { from: one.path, to: joinName(parentOf(one.path), name) });
          toast('Renamed', 'ok');
          await load(state.path);
        }
        break;
      }
      case 'move': {
        const dest = await folderPickerModal(`Move ${items.length > 1 ? items.length + ' items' : '“' + items[0].name + '”'}`);
        if (dest === null) break;
        for (const it of items) {
          const target = dest === '/' ? '/' + it.name : dest + '/' + it.name;
          await jsonReq('/move', { from: it.path, to: target });
        }
        toast('Moved', 'ok');
        state.sel.clear();
        await load(state.path);
        break;
      }
      case 'copyto': {
        const dest = await folderPickerModal(`Copy ${items.length > 1 ? items.length + ' items' : '“' + items[0].name + '”'}`);
        if (dest === null) break;
        for (const it of items) {
          const target = dest === '/' ? '/' + it.name : dest + '/' + it.name;
          await jsonReq('/copy', { from: it.path, to: target });
        }
        toast('Copied', 'ok');
        await load(state.path);
        break;
      }
      case 'delete':
        state.sel = new Set(items.map((i) => i.path));
        refreshSelection();
        await bulkDelete();
        break;
    }
  } catch (e) { toast(e.message, 'err'); }
}

function parentOf(p) { return p.slice(0, p.lastIndexOf('/')) || '/'; }
function joinName(dir, name) { return dir === '/' ? '/' + name : dir + '/' + name; }

function downloadFile(path) {
  const a = document.createElement('a');
  a.href = '/api/download?path=' + encodeURIComponent(path);
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function openItem(item) {
  if (item.type === 'folder') { load(item.path); return; }
  previewItem(item);
}

/* ── modals ──────────────────────────────────────────────────────────── */

function buildModal(title, bodyEl, actions) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal glass"><h3></h3><div class="body"></div><div class="actions"></div></div>`;
  $('h3', back).textContent = title;
  $('.body', back).appendChild(bodyEl);
  const actRow = $('.actions', back);
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn small ' + (a.cls || 'ghost');
    b.textContent = a.label;
    b.onclick = () => (a.onClick ? a.onClick(back, close) : close(undefined));
    actRow.appendChild(b);
  }
  function close(result) { back.remove(); back._resolve(result); }
  back._close = close;
  const escKey = (e) => { if (e.key === 'Escape' && back.isConnected) close(undefined); };
  document.addEventListener('keydown', escKey);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(undefined); });
  $('#modal-root').appendChild(back);
  return new Promise((res) => { back._resolve = res; });
}

function promptModal(title, initial = '', validate) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<input type="text" spellcheck="false">`;
  const input = $('input', wrap);
  input.value = initial;
  const err = document.createElement('p');
  err.className = 'msg'; err.style.color = '#ff8fa5'; err.style.marginTop = '8px';
  wrap.appendChild(err);
  setTimeout(() => { input.focus(); input.select(); });
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      const v = input.value.trim();
      const problem = validate?.(v);
      if (problem) { err.textContent = problem; return; }
      wrap.closest('.modal-back')?._close?.(v);
    }
  };
  return buildModal(title, wrap, [
    { label: 'Cancel' },
    { label: 'Save', cls: 'primary', onClick: (back, close) => {
      const v = input.value.trim();
      const problem = validate?.(v);
      if (problem) { err.textContent = problem; return; }
      close(v);
    } },
  ]);
}

function confirmModal(title, msg) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<p class="msg"></p>`;
  $('p', wrap).textContent = msg;
  return buildModal(title, wrap, [
    { label: 'Cancel' },
    { label: 'Delete', cls: 'danger', onClick: (back, close) => close(true) },
  ]).then((v) => v === true);
}

async function folderPickerModal(title) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <input type="search" placeholder="Filter folders…">
    <div class="folder-pick"></div>`;
  let folders = [];
  let chosen = state.path;
  try { folders = (await api('/dirs')).folders; } catch { folders = ['/']; }

  function paint(filter = '') {
    const list = folders.filter((f) => !filter || f.toLowerCase().includes(filter.toLowerCase()));
    $('.folder-pick', wrap).innerHTML =
      list.map((f) => `
        <label class="${f === chosen ? 'sel' : ''}" data-f="${escAttr(f)}">
          <input type="radio" name="fpick" ${f === chosen ? 'checked' : ''}>
          <svg viewBox="0 0 24 24">${GLYPHS.folder}</svg>
          <span>${escHtml(f === '/' ? '/ (root)' : f)}</span>
        </label>`).join('') || '<p class="msg">No match</p>';
    $$('.folder-pick label', wrap).forEach((lab) => {
      lab.onclick = () => { chosen = lab.dataset.f; paint($('.pick-filter', wrap)?.value ?? $('input', wrap).value); };
    });
  }
  paint();
  $('input[type=search]', wrap).oninput = (e) => paint(e.target.value);

  const result = await buildModal(title, wrap, [
    { label: 'Cancel' },
    { label: 'Choose', cls: 'primary', onClick: (back, close) => close(chosen) },
  ]);
  return result;   // string or undefined(cancel)
}

/* ── preview ─────────────────────────────────────────────────────────── */

const TEXT_EXT = new Set(['txt','md','log','json','csv','yml','yaml','xml','ini','conf','toml','env','gitignore']);

async function previewItem(item) {
  const cat = category(item);
  const url = '/api/download?path=' + encodeURIComponent(item.path);
  const body = document.createElement('div');
  body.className = 'preview-body';
  body.innerHTML = `<div class="preview-name">${escHtml(item.name)} · ${fmtBytes(item.size)}</div>`;
  const holder = document.createElement('div');

  try {
    if (cat === 'image' && ext(item.name) !== 'svg') {
      holder.innerHTML = `<img src="${url}" alt="">`;
      body.prepend(holder);
    } else if (cat === 'video') {
      holder.innerHTML = `<video src="${url}" controls autoplay muted></video>`;
      body.prepend(holder);
    } else if (cat === 'audio') {
      holder.innerHTML = `<audio src="${url}" controls autoplay></audio>`;
      body.prepend(holder);
    } else if (TEXT_EXT.has(ext(item.name)) || item.mime.startsWith('text/') ||
               ['json','javascript','typescript','css','html','markdown','xml','yaml'].some((t) => item.mime.includes(t))) {
      if (item.size <= 512 * 1024) {
        const text = await fetch(url, { credentials: 'same-origin' }).then((r) => r.text());
        holder.innerHTML = `<pre></pre>`;
        $('pre', holder).textContent = text;
      } else {
        holder.innerHTML = `<p class="msg">Text file too large to preview — use Download.</p>`;
      }
      body.prepend(holder);
    } else {
      holder.innerHTML = `<p class="msg">No inline preview for this type.</p>`;
      body.prepend(holder);
    }
  } catch { /* fall through */ }

  await buildModal(item.name, body, [
    { label: 'Download', cls: 'primary', onClick: () => downloadFile(item.path) },
    { label: 'Close' },
  ]);
}

function ext(name) { return (name.split('.').pop() || '').toLowerCase(); }

/* ── uploads ─────────────────────────────────────────────────────────── */

const PIECE_SIZE = 4 * 1024 * 1024;     // bytes per HTTP request (8 × 512 KiB chunks)
const PIECE_PARALLEL = 3;
const MAX_FILE_SIZE = 50 * 1024 * 1024; // keep in sync with store.js

let trayVisible = false;

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  trayVisible = true;
  $('#upload-tray').hidden = false;

  for (const file of files) uploadOne(file);
}

async function uploadOne(file) {
  if (file.size > MAX_FILE_SIZE) {
    toast(`${file.name}: too large (max ${fmtBytes(MAX_FILE_SIZE)})`, 'err');
    return;
  }
  const el = document.createElement('div');
  el.className = 'up-item';
  el.innerHTML = `
    <div class="row1"><span class="nm">${escHtml(file.name)}</span><span class="st">0%</span></div>
    <div class="up-bar"><i></i></div>`;
  $('#upload-list').appendChild(el);
  const bar = $('.up-bar i', el), st = $('.st', el), nm = $('.nm', el);

  const setPct = (p, label) => {
    bar.style.width = p + '%';
    st.textContent = label ?? (p >= 100 ? 'finishing…' : p + '%');
  };

  try {
    nm.textContent = file.name.length > 34 ? file.name.slice(0, 31) + '…' : file.name;
    const target = joinName(state.path, file.name);

    const init = await jsonReq('/upload-init', {
      path: target,
      size: file.size,
      mime: file.type || '',
    });
    const id = init.id;
    const totalPieces = Math.max(1, Math.ceil(file.size / PIECE_SIZE));
    let doneBytes = 0;
    setPct(1);

    let nextSeq = 0;
    const workers = Array.from({ length: Math.min(PIECE_PARALLEL, totalPieces) }, async () => {
      while (nextSeq < totalPieces) {
        const seq = nextSeq++;
        const start = seq * PIECE_SIZE;
        const blob = file.slice(start, Math.min(start + PIECE_SIZE, file.size));
        await sendPieceWithRetry(id, seq, blob);
        doneBytes += blob.size;
        setPct(Math.min(99, Math.round((doneBytes / file.size) * 100)));
      }
    });
    await Promise.all(workers);
    await jsonReq('/upload-finish', { id, size: file.size });
    el.classList.add('done');
    setPct(100, '✓ done');
    setTimeout(() => el.remove(), 2500);
    if (state.path === parentOf(target)) await load(state.path);
    refreshUsage();
  } catch (e) {
    el.classList.add('err');
    st.textContent = 'failed';
    nm.title = e.message;
    toast(`Upload failed: ${e.message}`, 'err');
  }
}

async function sendPieceWithRetry(id, seq, blob) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`/api/upload-piece?id=${id}&seq=${seq}`, {
        method: 'POST',
        credentials: 'same-origin',
        body: blob,
      });
      if (!r.ok) {
        const data = await r.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${r.status}`);
      }
      return;
    } catch (e) { lastErr = e; await new Promise((res) => setTimeout(res, 600 * (attempt + 1))); }
  }
  throw lastErr;
}

function refreshUsage() {
  api('/usage').then((u) => {
    const LIMIT = 500 * 1024 ** 2; // D1 free plan: 500 MB per database
    const pct = Math.min(100, (u.bytes / LIMIT) * 100);
    $('#storage-used').textContent = fmtBytes(u.bytes) + ' used';
    $('#storage-files').textContent = `${u.files} files · ${u.folders} folders`;
    $('#ring-pct').textContent = pct < 0.1 ? '0%' : pct.toFixed(pct < 10 ? 1 : 0) + '%';
    requestAnimationFrame(() => {
      $('#ring-fg').style.strokeDashoffset = String(264 * (1 - pct / 100));
    });
  }).catch(() => {});
}

/* ── events ──────────────────────────────────────────────────────────── */

function bindTileEvents(root) {
  root.addEventListener('click', (e) => {
    const tile = e.target.closest('[data-path]');
    if (!tile) return;
    const path = tile.dataset.path;
    const item = state.items.find((i) => i.path === path);
    if (!item) return;

    if (e.target.closest('.pick')) { toggleSel(path); return; }
    if (e.metaKey || e.ctrlKey) { toggleSel(path); return; }
    if (state.sel.size && !e.shiftKey) { state.sel.clear(); refreshSelection(); }
    openItem(item);
  });

  root.addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('[data-path]');
    if (!tile) return;
    e.preventDefault();
    const path = tile.dataset.path;
    const item = state.items.find((i) => i.path === path);
    if (!state.sel.has(path)) { state.sel.clear(); state.sel.add(path); refreshSelection(); }
    const items = state.sel.size > 1
      ? state.filtered.filter((i) => state.sel.has(i.path))
      : [item];
    openCtxMenu(e.clientX, e.clientY, items);
  });
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('#ctxmenu')) hideCtxMenu();
});

$('#breadcrumbs').addEventListener('click', (e) => {
  const a = e.target.closest('[data-crumb]');
  if (a) { e.preventDefault(); load(a.dataset.crumb); }
});

$('#btn-upload').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => { uploadFiles(e.target.files); e.target.value = ''; };

$('#btn-mkdir').onclick = async () => {
  const name = await promptModal('New folder', '', (v) =>
    validName(v) ? '' : 'Invalid folder name');
  if (!name) return;
  try {
    await jsonReq('/mkdir', { path: joinName(state.path, name) });
    toast('Folder created', 'ok');
    await load(state.path);
  } catch (e) { toast(e.message, 'err'); }
};

$('#btn-view').onclick = () => {
  state.view = state.view === 'grid' ? 'list' : 'grid';
  localStorage.setItem('d1.view', state.view);
  render();
};

$('#sort').value = state.sort;
$('#sort').onchange = (e) => {
  state.sort = e.target.value;
  localStorage.setItem('d1.sort', state.sort);
  render();
};

$('#search').oninput = (e) => { state.filter = e.target.value.trim(); render(); };

$('#bulk-delete').onclick = bulkDelete;
$('#bulk-clear').onclick = () => { state.sel.clear(); refreshSelection(); };
$('#bulk-move').onclick = () => {
  const items = state.filtered.filter((i) => state.sel.has(i.path));
  if (items.length) handleAction('move', items);
};

$('#tray-close').onclick = () => { $('#upload-tray').hidden = true; };

// keyboard
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if ($('.modal-back')) return;
  if (e.key === 'Escape') { state.sel.clear(); refreshSelection(); hideCtxMenu(); }
  if ((e.key === 'Backspace') && state.path !== '/') load(parentOf(state.path));
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    state.sel = new Set(state.filtered.map((i) => i.path));
    refreshSelection();
  }
  if (e.key === 'Delete' && state.sel.size) bulkDelete();
});

// drag & drop
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  $('#drop-overlay').hidden = false;
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; $('#drop-overlay').hidden = true; }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('#drop-overlay').hidden = true;
  if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
});

/* ── boot ────────────────────────────────────────────────────────────── */

(function boot() {
  $('#dav-url').textContent = location.origin + '/dav/';
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  load(hash.startsWith('/') ? hash : '/');
  refreshUsage();
})();
