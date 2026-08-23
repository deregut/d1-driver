# ☁️ D1 Drive

A personal cloud drive that runs **entirely on Cloudflare** — no servers, no S3 bill.

- **Frontend + API:** [Cloudflare Pages](https://pages.cloudflare.com/) (static UI + Pages Functions)
- **File storage:** [Cloudflare D1](https://developers.cloudflare.com/d1/) (SQLite) — every file is chunked into BLOB rows
- **WebDAV:** built in at `/dav/` — mount your drive from macOS Finder, Windows Explorer, Cyberduck, or rclone

<p align="center"><em>Dark glassmorphism UI · drag & drop · grid/list views · move / rename / delete / preview</em></p>

---

## ✨ Features

| Feature | How |
|---|---|
| Upload files | Button or drag & drop anywhere; chunked 4 MB pieces × 3 parallel, real progress bars, auto-retry |
| Create folders | Sidebar button; WebDAV `MKCOL` also supported |
| Delete files/folders | Context menu, multi-select bulk delete; folders delete recursively |
| Move / rename | “Move to…” folder picker dialog; rename via move; WebDAV `MOVE` too |
| Copy | “Copy to…” dialog; recursive folder copy; WebDAV `COPY` |
| Preview | Images, video, audio, and text/code files inline |
| Search & sort | Client-side filter of current folder; sort by name/size/date |
| WebDAV | Full class-1 server: `OPTIONS PROPFIND GET HEAD PUT MKCOL DELETE MOVE COPY` |
| Auth (optional) | HTTP Basic auth over both `/api/*` and `/dav/*` |

## 🧠 How storage works

D1 is SQLite, so files live as **chunks** instead of giant blobs:

```
nodes                       chunks
┌──────────────────────┐    ┌─────────────────────────┐
│ id  path        size │    │ node_id  seq  data      │
│ 1   /a/report.pdf …  │ ←→ │ 1        0    <512 KiB> │
│ 2   /a          (dir)│    │ 1        1    <512 KiB> │
└──────────────────────┘    │ …                       │
                            └─────────────────────────┘
```

- Files are split into **512 KiB BLOB rows**, far below D1 per-value limits.
- Uploads stream as **4 MB pieces** (8 chunks each), so nothing ever exceeds Cloudflare's request limits.
- Downloads re-assemble chunks in order and stream back.
- Folders are explicit rows, so empty folders survive sync clients.

## 🚀 Deploy (5 minutes)

> Requires a free Cloudflare account and Node ≥ 18.

```bash
# 1. install
npm install

# 2. create the database
npx wrangler d1 create d1-drive
# → copy the printed database_id into wrangler.toml

# 3. create tables (remote)
npx wrangler d1 execute d1-drive --remote --file=schema.sql

# 4. deploy Pages project (first run creates the project)
npx wrangler pages deploy
```

Open the printed `https://<project>.pages.dev` and you're done.
WebDAV endpoint: `https://<project>.pages.dev/dav/`

### Optional: enable authentication

Set two variables on your Pages project (**Settings → Variables**) or uncomment them in `wrangler.toml`:

```
AUTH_USER=you@example.com
AUTH_PASSWORD=something-long-and-random
```

When set, browsers visiting the site get a native login prompt, and WebDAV clients use standard Basic auth. Leave unset for a public drive.

## 💻 Local development

```bash
npx wrangler d1 execute d1-drive --local --file=schema.sql   # local tables
npm run dev                                                  # http://localhost:8788
```

Reset local data anytime:

```bash
npx wrangler d1 execute d1-drive --local --command "DELETE FROM chunks; DELETE FROM nodes;"
```

Smoke-test everything (30 checks: CRUD, chunked upload integrity, all WebDAV verbs):

```bash
sh scripts/smoke-test.sh        # while npm run dev is running
```

## 🔌 Connecting WebDAV clients

Mount URL is always `https://<your-domain>/dav/` (credentials = your `AUTH_*` vars).

### rclone

```ini
[d1drive]
type = webdav
url = https://<project>.pages.dev/dav/
vendor = other
user = you@example.com
pass = <run: rclone obscure yourpassword>
```

```bash
rclone ls d1drive:
rclone copy ~/Videos/big.mp4 d1drive:Movies/
```

### macOS Finder
Finder → ⌘K → `https://<project>.pages.dev/dav/`

### Windows Explorer
```
net use W: https://<project>.pages.dev/dav/ /user:you@example.com yourpassword
```
(If Windows refuses Basic auth over HTTPS, enable `BasicAuthLevel` in WebClient registry settings — standard Windows quirk.)

### Cyberduck / WinSCP / Mountain Duck
Any WebDAV (HTTPS) connection works.

## 📁 Project structure

```
d1-drive/
├── public/                  # static frontend (deployed by Pages)
│   ├── index.html           # app shell
│   ├── style.css            # dark glass theme
│   └── app.js               # SPA logic: nav, uploads, dialogs, preview
├── functions/               # Pages Functions (serverless backend)
│   ├── _middleware.js       # optional Basic auth guard
│   ├── lib/
│   │   ├── store.js         # D1 data layer (chunking, move/copy/delete)
│   │   └── auth.js          # timing-safe Basic auth
│   ├── api/[[path]].js      # JSON API for the web UI
│   └── dav/[[path]].js      # WebDAV server (RFC 4918 subset)
├── scripts/smoke-test.sh    # end-to-end test suite (30 checks)
├── schema.sql               # D1 schema
└── wrangler.toml            # bindings config
```

## ⚠️ Limitations & honest notes

- **D1 size ceiling:** databases max out around **10 GB** (Cloudflare plan limit). The sidebar ring tracks usage against that. For bigger libraries, point `store.js` at R2 — the API surface stays identical.
- **Max upload:** 1 GB per file by default (`upload-init` guard); memory-bound assembly favors smaller files.
- **No range requests yet:** video seeks download whole-file previews only (progressive playback still works).
- **No locks / versioning:** advertised as DAV class 1, which is what rclone/Finder/Cyberduck need for file transfer.
- **Public instance?** Anyone with the URL can read/write unless you set `AUTH_USER`/`AUTH_PASSWORD`. Seriously, set them.

## 📜 License

MIT — do whatever you want, no warranty.
