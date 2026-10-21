# AGENTS.md

Guidance for AI agents working in this repository.

## Project

`obsidian-web` is a lightweight web frontend for editing an [Obsidian](https://obsidian.md) vault in the browser. It reads and writes Markdown files directly from a local vault directory through a small Node.js HTTP server, no Obsidian app required.

## Architecture

- `server.mjs` — zero-dependency Node HTTP server (Node built-ins only). Serves static files and a JSON REST API.
- `public/index.html` — page shell (sidebar, tab bar, editor, preview, status bar).
- `public/app.js` — client logic: CodeMirror 6 editor, markdown preview (marked), tab management, sidebar tree, wikilink resolution, themes.
- `public/style.css` — all styling, dark/light themes via CSS variables.

Client libraries are loaded as ES modules from `https://esm.sh/...` (CodeMirror, marked). There is no build step and no `package.json`.

## Running

```bash
node server.mjs                       # uses the default vault
node server.mjs /path/to/vault        # positional vault path
node server.mjs --vault /path/to/vault --port 9000
```

Open `http://localhost:8787`.

Vault path resolution order: CLI argument (`node server.mjs <path>` or `--vault <path>`) > `VAULT_PATH` env var > default `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/me`.

Port: `--port <n>` / `-p <n>` CLI flag or `PORT` env var. Defaults to `8787`.

## REST API

All routes under `/api/`:

| Method | Path       | Purpose |
| ------ | ---------- | ------- |
| GET    | `/api/tree`            | Recursively list directories and `.md` files (skips hidden entries) |
| GET    | `/api/file?path=...`   | Read a file: `{ content, mtime }` |
| PUT    | `/api/file`            | Create/update a file (body: `{ path, content }`), atomic write via temp + rename |
| POST   | `/api/file`            | Create a file only if it does not exist (201 created / 409 conflict) |
| DELETE | `/api/file?path=...`   | Delete a file |

Errors return `{ ok: false, error }`.

## Key conventions

- Paths in the API are vault-relative and validated by `safePath()` in `server.mjs`, which rejects any path escaping the vault root.
- All file content is UTF-8 text.
- No external npm dependencies — keep the server on Node built-ins (`node:http`, `node:fs/promises`, `node:path`, `node:url`).
- The client auto-saves edits 700 ms after the last keystroke (debounced via `scheduleSave`).
- Keyboard shortcuts: `Cmd/Ctrl+S` save, `Cmd/Ctrl+E` cycle edit/split/preview, `Cmd/Ctrl+B` toggle sidebar.
- Wikilinks `[[target]]` (with optional `#heading` and `|alias`) resolve by full path first, then by basename (case-insensitive, `.md` optional).

## Editing tips

- When adding a client library, use `https://esm.sh/<pkg>` imports in `public/app.js` rather than adding npm dependencies.
- New UI should follow the existing CSS-variable color scheme in `:root` and `body.light` so it respects the theme toggle.
- Keep the server stateless; all state (tabs, theme, sidebar) lives in the browser.

## Coordination (multi-agent)

More than one agent may work in this repo. To avoid stepping on each other:

- **Read before you edit.** Re-read a file immediately before changing it — it may have changed since you last looked.
- **Commit often, pull first.** Small commits with clear messages; run `git status` (and `git pull` if needed) before starting a task.
- **Don't edit the same file concurrently.** Declare what you're working on in this section before starting a non-trivial change.
- **One live server at a time.** The dev server runs on `:8787`; only one agent should run/restart it. Use a separate port (e.g. `:8790`) for throwaway test servers and kill them afterward.
- **Secrets stay out of git.** `.env` is gitignored. Never commit real passwords, hashes, or session exports.

### Work lanes

- (fill in: which agent owns `server.mjs` / API vs `public/` UI)
