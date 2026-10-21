# OBSDWEB

An [Obsidian](https://obsidian.md) editor that runs locally, gated by a password, ready to tunnel.

A lightweight web frontend for editing a Markdown vault directly in the browser. It reads and writes `.md` files straight from a local vault directory through a small zero-dependency Node.js HTTP server — no Obsidian app required.

## Features

- Full vault browser (sidebar tree of directories and `.md` files)
- Markdown editor with live preview and split view
- `[[wikilinks]]` resolution (with `#heading` and `|alias` support)
- Auto-save (debounced 700 ms after the last keystroke)
- Dark / light themes
- Optional password gate with scrypt-hashed credentials and session cookies
- Zero external dependencies — Node built-ins only, no build step

## Requirements

- [Node.js](https://nodejs.org) (any modern version)

## Quick start

```bash
node server.mjs                       # uses the default vault
node server.mjs /path/to/vault        # use a specific vault
node server.mjs --vault /path/to/vault --port 9000
```

Then open http://localhost:8787.

### Configuration

| Option | CLI flag | Env var | Default |
| ------ | -------- | ------- | ------- |
| Vault path | positional or `--vault` / `-v` | `VAULT_PATH` | `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/me` |
| Port | `--port` / `-p` | `PORT` | `8787` |

Any of the env vars above can also be set in a `.env` file in the project root. Real environment variables take precedence over `.env`, and CLI flags win over both.

### Password gate (recommended)

Without configuration the server stays open. To protect it with a password, create a `.env` file:

```bash
# Generate a scrypt hash for your password:
node hash-password.mjs my-secret-password

# Paste the printed line into .env:
APP_PASSWORD_HASH=<salt>:<hash>
```

Alternative (less secure, plaintext):

```env
APP_PASSWORD=my-secret-password
```

Optional settings:

```env
# Vault to serve (alternative to the CLI flag / VAULT_PATH env var)
VAULT_PATH=/path/to/your/vault

SESSION_SECRET=<random-hex>   # keep sessions valid across restarts
SESSION_TTL_HOURS=168         # session lifetime (default: 7 days)
```

Restart the server after editing `.env`. Unauthenticated requests are redirected to `/login` (the REST API returns `401`).

## Tunneling

The server binds to a plain local HTTP port, so you can expose it with any tunnel tool:

```bash
# cloudflared
cloudflared tunnel --url http://localhost:8787

# or reach it on your Tailscale network directly
```

Enable the password gate before exposing it to the internet — the tunnel only provides transport, not authentication.

## User guide

- **Sidebar** — click a file to open it in a tab; directories expand/collapse. Toggle it with `Cmd/Ctrl+B`.
- **Tabs** — multiple files stay open across the top; close a tab to drop unsaved state (saves happen automatically).
- **Editor** — type normally; changes auto-save ~700 ms after you stop typing.
- **View modes** — `Cmd/Ctrl+E` cycles between edit, split, and preview.
- **Save** — `Cmd/Ctrl+S` forces an immediate save (though auto-save usually has you covered).
- **Wikilinks** — write `[[My Note]]`, `[[My Note#Heading]]`, or `[[My Note|nice title]]`. Links resolve by full path first, then by filename (case-insensitive, `.md` optional).
- **Themes** — switch between dark and light from the UI.

## REST API

All routes under `/api/`, with vault-relative paths:

| Method | Path       | Purpose |
| ------ | ---------- | ------- |
| GET    | `/api/tree`            | Recursively list directories and `.md` files |
| GET    | `/api/file?path=...`   | Read a file (`{ content, mtime }`) |
| PUT    | `/api/file`            | Create/update a file (atomic temp + rename) |
| POST   | `/api/file`            | Create a file only if it doesn't exist (`201` / `409`) |
| DELETE | `/api/file?path=...`   | Delete a file |

## Project layout

- `server.mjs` — zero-dependency Node HTTP server (static files + JSON REST API)
- `hash-password.mjs` — generates an `APP_PASSWORD_HASH` for `.env`
- `public/index.html` — page shell
- `public/app.js` — client logic (CodeMirror 6, marked, tabs, tree, wikilinks, themes)
- `public/style.css` — styling and dark/light theme variables
