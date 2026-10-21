import { EditorView, basicSetup } from "https://esm.sh/codemirror@6.0.1";
import { EditorState } from "https://esm.sh/@codemirror/state@^6.0.0?target=es2022";
import { markdown } from "https://esm.sh/@codemirror/lang-markdown@6.2.4";
import { oneDark } from "https://esm.sh/@codemirror/theme-one-dark@6.1.2";
import { marked } from "https://esm.sh/marked@12.0.2";
import { Decoration, ViewPlugin, keymap } from "https://esm.sh/@codemirror/view@^6.0.0?target=es2022";
import { syntaxTree } from "https://esm.sh/@codemirror/language@^6.0.0?target=es2022";
import { autocompletion, startCompletion } from "https://esm.sh/@codemirror/autocomplete@^6.0.0?target=es2022";
import { javascriptLanguage, typescriptLanguage, jsxLanguage, tsxLanguage } from "https://esm.sh/@codemirror/lang-javascript@^6.0.0?target=es2022";
import { pythonLanguage } from "https://esm.sh/@codemirror/lang-python@^6.0.0?target=es2022";
import { jsonLanguage } from "https://esm.sh/@codemirror/lang-json@^6.0.0?target=es2022";
import { htmlLanguage } from "https://esm.sh/@codemirror/lang-html@^6.0.0?target=es2022";
import { cssLanguage } from "https://esm.sh/@codemirror/lang-css@^6.0.0?target=es2022";

const codeLanguages = (info) => {
  switch (info.trim().toLowerCase()) {
    case "js":
    case "javascript":
      return javascriptLanguage;
    case "jsx":
      return jsxLanguage;
    case "ts":
    case "typescript":
      return typescriptLanguage;
    case "tsx":
      return tsxLanguage;
    case "py":
    case "python":
      return pythonLanguage;
    case "json":
      return jsonLanguage;
    case "html":
    case "htm":
      return htmlLanguage;
    case "css":
      return cssLanguage;
    default:
      return null;
  }
};

const $ = (s) => document.querySelector(s);
const editorEl = $("#editor");
const previewEl = $("#preview");
const tabsEl = $("#tabs");
const scrollLeftEl = $("#scroll-left");
const scrollRightEl = $("#scroll-right");
const treeEl = $("#tree");
const statusEl = $("#status");
const pathEl = $("#path");
const titleEl = $("#note-title");
const paletteEl = $("#palette");
const paletteInput = $("#palette-input");
const paletteResults = $("#palette-results");
const backlinksEl = $("#backlinks");
const backlinksListEl = $("#backlinks-list");

const tabs = new Map(); // path -> { name, content, dirty }
let order = [];        // tab order
let activePath = null;
let saveTimer = null;
let theme = localStorage.getItem("theme") || "dark";
let viewMode = "edit"; // edit | split | preview
let previewTimer = null;
let sidebarVisible = localStorage.getItem("sidebar") !== "hidden";
const wikilinkByPath = new Map();      // lowercased path (no .md) -> real path
const wikilinkByBasename = new Map();  // lowercased basename (no .md) -> real path
const allNotes = [];                   // [{ name, path }] for the command palette

const basename = (p) => p.split("/").pop();
const noteTitle = (p) => basename(p).replace(/\.md$/i, "");
const status = (t) => (statusEl.textContent = t);
const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
let paletteList = [];
let paletteIndex = 0;

/* Styling/pointer for wikilinks inside the editor */
const wikilinkMark = Decoration.mark({ class: "cm-wikilink" });
const wikilinkHighlighter = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.compute(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.compute(update.view);
      }
    }
    compute(view) {
      const re = /\[\[([^\[\]|#]+?)(?:#([^\[\]|]+?))?(?:\|([^\[\]#]+?))?\]\]/g;
      const ranges = [];
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);
        let m;
        re.lastIndex = 0;
        while ((m = re.exec(text))) {
          ranges.push(wikilinkMark.range(from + m.index, from + m.index + m[0].length));
        }
      }
      return Decoration.set(ranges);
    }
  },
  { decorations: (v) => v.decorations }
);

/* Background styling for fenced code blocks and inline code in the editor */
const codeBlockLine = Decoration.line({ class: "cm-codeblock" });
const inlineCodeMark = Decoration.mark({ class: "cm-inline-code" });
const codeHighlighter = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.compute(view);
    }
    update(update) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = this.compute(update.view);
      }
    }
    compute(view) {
      const decos = [];
      const doc = view.state.doc;
      const tree = syntaxTree(view.state);
      tree.iterate({
        enter(node) {
          if (node.type.name === "FencedCode") {
            // Line decorations must be zero-length: add one per line.
            let pos = node.from;
            while (pos < node.to) {
              const line = doc.lineAt(pos);
              decos.push(codeBlockLine.range(line.from));
              pos = line.to + 1;
            }
          } else if (node.type.name === "InlineCode") {
            decos.push(inlineCodeMark.range(node.from, node.to));
          }
        },
      });
      return Decoration.set(decos, true);
    }
  },
  { decorations: (v) => v.decorations }
);

// Tab: indent list items, otherwise insert a literal tab character.
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+/;

const tabCommand = ({ state, dispatch }) => {
  const { from, to } = state.selection.main;
  const line = state.doc.lineAt(from);
  if (LIST_RE.test(line.text)) {
    dispatch(state.update({
      changes: { from: line.from, insert: "\t" },
      selection: { anchor: from + 1, head: to + 1 },
      userEvent: "input",
    }));
    return true;
  }
  if (state.selection.ranges.some((r) => !r.empty)) return false;
  dispatch(state.update(state.replaceSelection("\t"), { userEvent: "input" }));
  return true;
};

const listOutdent = ({ state, dispatch }) => {
  const { from, to } = state.selection.main;
  const line = state.doc.lineAt(from);
  const m = LIST_RE.exec(line.text);
  if (!m || !m[1]) return false; // no leading indentation to remove
  const ws = m[1];
  const remove = ws.includes("\t") ? 1 : Math.min(ws.length, 4);
  dispatch(state.update({
    changes: { from: line.from, to: line.from + remove },
    selection: { anchor: Math.max(line.from, from - remove), head: Math.max(line.from, to - remove) },
    userEvent: "input",
  }));
  return true;
};

// Wrap/unwrap the selection with a marker, e.g. "**" for bold or "*" for italics.
const toggleWrap = (marker) => ({ state, dispatch }) => {
  const { from, to } = state.selection.main;
  const len = marker.length;
  const before = state.doc.sliceString(from - len, from);
  const after = state.doc.sliceString(to, to + len);
  if (before === marker && after === marker) {
    dispatch(state.update({
      changes: [
        { from: from - len, to: from },
        { from: to, to: to + len },
      ],
      selection: { anchor: from - len, head: to - len },
      userEvent: "input",
    }));
  } else {
    const text = state.doc.sliceString(from, to);
    dispatch(state.update({
      changes: { from, to, insert: marker + text + marker },
      selection: { anchor: from + len, head: to + len },
      userEvent: "input",
    }));
  }
  return true;
};

/* Wikilink autocomplete: show notes when typing [[ */
const wikilinkCompletions = (context) => {
  const match = context.matchBefore(/\[\[([^\[\]\n]*)$/);
  if (!match) return null;
  const query = match.text.slice(2).toLowerCase();
  const from = match.from + 2;
  const options = [];
  for (const n of allNotes) {
    const target = n.path.replace(/\.md$/i, "");
    if (target.toLowerCase().includes(query)) {
      options.push({
        label: n.name.replace(/\.md$/i, ""),
        detail: n.path.replace(/\.md$/i, ""),
        type: "text",
        apply: target + "]]",
      });
    }
  }
  options.sort((a, b) => {
    const al = a.label.toLowerCase();
    const bl = b.label.toLowerCase();
    const aStart = al.startsWith(query);
    const bStart = bl.startsWith(query);
    if (aStart !== bStart) return aStart ? -1 : 1;
    return al.localeCompare(bl);
  });
  return {
    from,
    options: options.slice(0, 100),
    validFor: /^[^\[\]\n]*$/,
  };
};

const wikilinkAutocomplete = autocompletion({ override: [wikilinkCompletions] });

const wikilinkAutocompleteTrigger = EditorView.updateListener.of((update) => {
  if (!update.docChanged) return;
  if (!update.transactions.some((tr) => tr.isUserEvent("input.type"))) return;
  const view = update.view;
  const pos = view.state.selection.main.head;
  if (pos >= 2 && view.state.doc.sliceString(pos - 2, pos) === "[[") {
    setTimeout(() => startCompletion(view), 0);
  }
});

function makeState(content) {
  return EditorState.create({
    doc: content,
    extensions: [
      keymap.of([
        { key: "Tab", run: tabCommand },
        { key: "Shift-Tab", run: listOutdent },
        { key: "Mod-b", run: toggleWrap("**") },
        { key: "Mod-i", run: toggleWrap("*") },
      ]),
      basicSetup,
      markdown({ codeLanguages }),
      EditorView.lineWrapping,
      ...(theme === "dark" ? [oneDark] : []),
      wikilinkHighlighter,
      codeHighlighter,
      wikilinkAutocomplete,
      wikilinkAutocompleteTrigger,
      EditorView.updateListener.of((u) => {
        if (!u.docChanged) return;
        const tab = tabs.get(activePath);
        if (!tab) return;
        const content = u.state.doc.toString();
        if (content === tab.content) return; // no real change (e.g. theme rebuild)
        tab.content = content;
        tab.dirty = true;
        renderTabs();
        scheduleSave(activePath);
        schedulePreview();
      }),
    ],
  });
}

const view = new EditorView({ parent: editorEl });

/* ---------- saving ---------- */

function scheduleSave(path) {
  status("Saving…");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => doSave(path), 700);
}

async function doSave(path) {
  const tab = tabs.get(path);
  if (!tab) return;
  const content = tab.content;
  try {
    const res = await fetch("/api/file", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    if (res.ok) {
      tab.dirty = false;
      renderTabs();
      if (path === activePath) status("Saved ✓");
    } else {
      status("Save failed");
    }
  } catch {
    status("Save failed (offline?)");
  }
}

/* ---------- tabs ---------- */

function renderTabs() {
  tabsEl.innerHTML = "";
  for (const path of order) {
    const tab = tabs.get(path);
    const el = document.createElement("div");
    el.className = "tab" + (path === activePath ? " active" : "") + (tab.dirty ? " dirty" : "");
    el.innerHTML = `<span class="dot">•</span><span>${tab.name}</span><span class="close">×</span>`;
    el.onclick = (e) => {
      if (e.target.classList.contains("close")) closeTab(path);
      else activateTab(path);
    };
    tabsEl.appendChild(el);
  }
  updateTabScroll();
}

function activateTab(path) {
  const tab = tabs.get(path);
  if (!tab) return;
  activePath = path;
  view.setState(makeState(tab.content));
  pathEl.textContent = path;
  titleEl.textContent = noteTitle(path);
  renderTabs();
  renderTreeActive();
  if (viewMode !== "edit") renderPreview();
  status(tab.dirty ? "Dirty" : "Saved ✓");
  updateEmptyState();
  renderBacklinks(path);
}

async function openTab(path) {
  if (tabs.has(path)) return activateTab(path);
  try {
    const res = await fetch("/api/file?path=" + encodeURIComponent(path));
    if (!res.ok) throw new Error();
    const data = await res.json();
    tabs.set(path, { name: basename(path), content: data.content, dirty: false });
    order.push(path);
    activateTab(path);
  } catch {
    status("Error loading note");
  }
}

function closeTab(path) {
  const tab = tabs.get(path);
  if (tab && tab.dirty) doSave(path); // flush pending edit
  tabs.delete(path);
  order = order.filter((p) => p !== path);
  if (activePath === path) {
    activePath = order[order.length - 1] || null;
    if (activePath) {
      const t = tabs.get(activePath);
      view.setState(makeState(t.content));
      pathEl.textContent = activePath;
      titleEl.textContent = noteTitle(activePath);
    } else {
      view.setState(makeState(""));
      pathEl.textContent = "";
      titleEl.textContent = "";
      status("Ready");
    }
  }
  renderTabs();
  renderTreeActive();
  updateEmptyState();
  renderBacklinks(activePath);
}

function updateEmptyState() {
  $("#empty-state").classList.toggle("hidden", !!activePath);
}

/* ---------- tab scrolling (chevrons) ---------- */

function updateTabScroll() {
  const overflow = tabsEl.scrollWidth > tabsEl.clientWidth + 1;
  scrollLeftEl.classList.toggle("visible", overflow);
  scrollRightEl.classList.toggle("visible", overflow);
}

scrollLeftEl.onclick = () => tabsEl.scrollBy({ left: -200, behavior: "smooth" });
scrollRightEl.onclick = () => tabsEl.scrollBy({ left: 200, behavior: "smooth" });

/* ---------- sidebar tree ---------- */

async function loadTree() {
  const res = await fetch("/api/tree");
  const tree = await res.json();
  treeEl.innerHTML = "";
  renderTreeNodes(tree, treeEl);
  renderTreeActive();
  buildWikilinkIndex(tree);
}

function buildWikilinkIndex(nodes) {
  wikilinkByPath.clear();
  wikilinkByBasename.clear();
  allNotes.length = 0;
  const walk = (list) => {
    for (const n of list) {
      if (n.type === "file") {
        allNotes.push({ name: n.name, path: n.path });
        const key = n.path.toLowerCase().replace(/\.md$/i, "");
        wikilinkByPath.set(key, n.path);
        const base = n.name.toLowerCase().replace(/\.md$/i, "");
        if (!wikilinkByBasename.has(base)) wikilinkByBasename.set(base, n.path);
      } else if (n.children) {
        walk(n.children);
      }
    }
  };
  walk(nodes);
}

function resolveWikilink(target) {
  const key = (target || "").trim().toLowerCase().replace(/\.md$/i, "");
  if (!key) return null;
  return wikilinkByPath.get(key) || wikilinkByBasename.get(key.split("/").pop());
}

function renderTreeNodes(nodes, parent) {
  for (const n of nodes) {
    const el = document.createElement("div");
    el.className = "tree-item " + n.type;
    el.textContent = n.name;
    el.title = n.path;
    el.dataset.path = n.path;
    if (n.type === "dir") {
      el.classList.add("open");
      const kids = document.createElement("div");
      kids.className = "tree-children open";
      renderTreeNodes(n.children, kids);
      el.onclick = () => {
        el.classList.toggle("open");
        kids.classList.toggle("open");
      };
      parent.appendChild(el);
      parent.appendChild(kids);
    } else {
      el.onclick = () => openTab(n.path);
      parent.appendChild(el);
    }
  }
}

function renderTreeActive() {
  document.querySelectorAll(".tree-item.file").forEach((el) => {
    el.classList.toggle("active", el.dataset.path === activePath);
  });
}

async function renderBacklinks(path) {
  if (!path) {
    backlinksEl.classList.add("hidden");
    backlinksListEl.innerHTML = "";
    return;
  }
  try {
    const res = await fetch("/api/backlinks?path=" + encodeURIComponent(path));
    if (!res.ok) throw new Error();
    const data = await res.json();
    backlinksListEl.innerHTML = "";
    if (!data.results.length) {
      backlinksEl.classList.add("hidden");
      return;
    }
    backlinksEl.classList.remove("hidden");
    for (const b of data.results) {
      const el = document.createElement("div");
      el.className = "backlink-item";
      el.textContent = b.name;
      el.title = b.path;
      el.onclick = () => openTab(b.path);
      backlinksListEl.appendChild(el);
    }
  } catch {
    backlinksEl.classList.add("hidden");
  }
}

/* ---------- preview ---------- */

function renderPreview() {
  const tab = tabs.get(activePath);
  if (!tab) {
    previewEl.innerHTML = "";
    return;
  }
  const container = document.createElement("div");
  container.className = "note-content";
  container.innerHTML = marked.parse(tab.content);
  linkifyWikilinks(container);
  previewEl.innerHTML = "";
  previewEl.appendChild(container);
}

function linkifyWikilinks(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue || !/\[\[/.test(node.nodeValue)) return NodeFilter.FILTER_REJECT;
      let el = node.parentElement;
      while (el && el !== root) {
        if (el.tagName === "CODE" || el.tagName === "PRE") return NodeFilter.FILTER_REJECT;
        el = el.parentElement;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  const re = /\[\[([^\[\]|#]+?)(?:#([^\[\]|]+?))?(?:\|([^\[\]#]+?))?\]\]/g;
  for (const node of textNodes) {
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const target = m[1].trim();
      const alias = m[3] ? m[3].trim() : null;
      const a = document.createElement("a");
      a.className = "wikilink";
      a.href = "#";
      a.dataset.target = target;
      a.title = "Alt+click to open";
      a.textContent = alias || target;
      frag.appendChild(a);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    node.parentNode.replaceChild(frag, node);
  }
}

function openWikilink(target) {
  const path = resolveWikilink(target);
  if (path) openTab(path);
  else status(`Note not found: ${target}`);
}

previewEl.addEventListener("click", (e) => {
  const a = e.target.closest("a.wikilink");
  if (!a) return;
  e.preventDefault();
  if (e.altKey) openWikilink(a.dataset.target);
});

editorEl.addEventListener("click", (e) => {
  if (!e.altKey) return;
  const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
  if (pos == null) return;
  const line = view.state.doc.lineAt(pos);
  const re = /\[\[([^\[\]|#]+?)(?:#([^\[\]|]+?))?(?:\|([^\[\]#]+?))?\]\]/g;
  let m;
  while ((m = re.exec(line.text))) {
    const start = line.from + m.index;
    const end = start + m[0].length;
    if (pos >= start && pos <= end) {
      openWikilink(m[1].trim());
      return;
    }
  }
});

function schedulePreview() {
  if (viewMode === "edit") return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 150);
}

const VIEW_MODES = ["edit", "split", "preview"];

function applyViewMode() {
  editorEl.classList.toggle("hidden", viewMode === "preview");
  previewEl.classList.toggle("hidden", viewMode === "edit");
  editorEl.classList.toggle("split", viewMode === "split");
  previewEl.classList.toggle("split", viewMode === "split");
  $("#toggle-preview").textContent = viewMode;
  if (viewMode !== "edit") renderPreview();
}

function cycleViewMode() {
  viewMode = VIEW_MODES[(VIEW_MODES.indexOf(viewMode) + 1) % VIEW_MODES.length];
  applyViewMode();
}

/* ---------- new note ---------- */

function promptNoteName() {
  return new Promise((resolve) => {
    const dialog = $("#note-dialog");
    const input = $("#note-dialog-input");

    const cleanup = () => {
      dialog.classList.add("hidden");
      input.value = "";
      input.onkeydown = null;
      $("#note-dialog-create").onclick = null;
      $("#note-dialog-cancel").onclick = null;
      dialog.onmousedown = null;
    };
    const submit = () => {
      const name = input.value.trim();
      cleanup();
      resolve(name || null);
    };
    const cancel = () => {
      cleanup();
      resolve(null);
    };

    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    $("#note-dialog-create").onclick = submit;
    $("#note-dialog-cancel").onclick = cancel;
    dialog.onmousedown = (e) => {
      if (e.target === dialog) cancel();
    };

    dialog.classList.remove("hidden");
    input.focus();
  });
}

async function newNote() {
  const name = await promptNoteName();
  if (!name) return;
  const path = name.endsWith(".md") ? name : name + ".md";
  const res = await fetch("/api/file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content: "" }),
  });
  if (res.ok || res.status === 409) {
    await loadTree();
    await openTab(path);
    view.focus();
  } else {
    status("Could not create note");
  }
}

$("#new-note").onclick = newNote;
$("#empty-new-note").onclick = newNote;

$("#toggle-preview").onclick = cycleViewMode;

document.addEventListener("keydown", (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === "s") {
    e.preventDefault();
    if (activePath) doSave(activePath);
  }
  if (mod && e.key.toLowerCase() === "e") {
    e.preventDefault();
    cycleViewMode();
  }
  if (mod && e.key.toLowerCase() === "o") {
    e.preventDefault();
    openPalette();
  }
  if (mod && e.altKey && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newNote();
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === "d") {
    e.preventDefault();
    toggleTheme();
  }
  if (mod && e.shiftKey && e.key.toLowerCase() === "l") {
    e.preventDefault();
    toggleSidebar();
  }
});

window.addEventListener("beforeunload", () => {
  if (activePath && tabs.get(activePath)?.dirty) doSave(activePath);
});

/* ---------- theme ---------- */

function applyTheme() {
  document.body.classList.toggle("light", theme === "light");
  if (activePath) {
    const tab = tabs.get(activePath);
    view.setState(makeState(tab.content));
  }
}

function toggleTheme() {
  theme = theme === "dark" ? "light" : "dark";
  localStorage.setItem("theme", theme);
  applyTheme();
}

$("#toggle-theme").onclick = toggleTheme;

$("#logout").onclick = () => {
  location.href = "/logout";
};

/* ---------- sidebar ---------- */

function applySidebar() {
  $("#sidebar").classList.toggle("collapsed", !sidebarVisible);
  $("#open-sidebar").classList.toggle("visible", !sidebarVisible);
  updateTabScroll();
}

function toggleSidebar() {
  sidebarVisible = !sidebarVisible;
  localStorage.setItem("sidebar", sidebarVisible ? "visible" : "hidden");
  applySidebar();
}

$("#toggle-sidebar").onclick = toggleSidebar;
$("#open-sidebar").onclick = toggleSidebar;

/* ---------- command palette (Cmd/Ctrl+O) ---------- */

function openPalette() {
  paletteEl.classList.remove("hidden");
  paletteInput.value = "";
  paletteIndex = 0;
  renderPalette("");
  paletteInput.focus();
}

function closePalette() {
  paletteEl.classList.add("hidden");
  paletteInput.blur();
}

let searchSeq = 0;
let paletteSearchTimer = null;

async function renderPalette(query) {
  const q = query.trim().toLowerCase();
  const seq = ++searchSeq;

  const nameMatches = allNotes.filter((n) => {
    if (!q) return true;
    return n.name.toLowerCase().includes(q) || n.path.toLowerCase().includes(q);
  });
  nameMatches.sort((a, b) => {
    const an = a.name.toLowerCase();
    const bn = b.name.toLowerCase();
    const aStart = an.startsWith(q);
    const bStart = bn.startsWith(q);
    if (aStart !== bStart) return aStart ? -1 : 1;
    return an.localeCompare(bn);
  });

  let contentMatches = [];
  if (q) {
    try {
      const res = await fetch("/api/search?q=" + encodeURIComponent(query.trim()));
      if (res.ok && seq === searchSeq) {
        const data = await res.json();
        const seen = new Set(nameMatches.map((n) => n.path));
        contentMatches = data.results
          .filter((r) => !seen.has(r.path))
          .map((r) => ({
            type: "search",
            path: r.path,
            name: r.name,
            snippet: (r.snippets[0] || {}).text || "",
          }));
      }
    } catch {}
  }

  if (seq !== searchSeq) return;

  paletteList = [
    ...nameMatches.map((n) => ({ type: "note", path: n.path, name: n.name })),
    ...contentMatches,
  ];
  paletteIndex = Math.min(paletteIndex, Math.max(0, paletteList.length - 1));
  renderPaletteItems();
}

function renderPaletteItems() {
  paletteResults.innerHTML = "";
  if (!paletteList.length) {
    const empty = document.createElement("div");
    empty.className = "palette-empty";
    empty.textContent = "No notes found";
    paletteResults.appendChild(empty);
    return;
  }
  paletteList.forEach((n, i) => {
    const el = document.createElement("div");
    el.className = "palette-item" + (i === paletteIndex ? " selected" : "");
    if (n.type === "search") {
      el.innerHTML = `<div class="p-title">${escapeHtml(n.name)}</div><div class="p-snippet">${escapeHtml(n.snippet)}</div>`;
    } else {
      el.innerHTML = `<div class="p-title">${escapeHtml(n.name)}</div><div class="p-path">${escapeHtml(n.path)}</div>`;
    }
    el.onmousedown = (e) => {
      e.preventDefault();
      openTab(n.path);
      closePalette();
    };
    el.onmouseenter = () => {
      paletteIndex = i;
      highlightPalette();
    };
    paletteResults.appendChild(el);
  });
}

function highlightPalette() {
  paletteResults.querySelectorAll(".palette-item").forEach((el, i) => {
    el.classList.toggle("selected", i === paletteIndex);
  });
}

function scrollPaletteSelection() {
  const sel = paletteResults.querySelector(".palette-item.selected");
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

paletteInput.addEventListener("input", () => {
  paletteIndex = 0;
  clearTimeout(paletteSearchTimer);
  paletteSearchTimer = setTimeout(() => renderPalette(paletteInput.value), 150);
});

paletteInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (paletteList.length) paletteIndex = Math.min(paletteIndex + 1, paletteList.length - 1);
    highlightPalette();
    scrollPaletteSelection();
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    paletteIndex = Math.max(paletteIndex - 1, 0);
    highlightPalette();
    scrollPaletteSelection();
  } else if (e.key === "Enter") {
    e.preventDefault();
    const n = paletteList[paletteIndex];
    if (n) {
      openTab(n.path);
      closePalette();
    }
  } else if (e.key === "Escape") {
    e.preventDefault();
    closePalette();
  }
});

paletteEl.addEventListener("mousedown", (e) => {
  if (e.target === paletteEl) closePalette();
});

/* ---------- daily note ---------- */

async function openDailyNote() {
  const now = new Date();
  const name = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-') + '.md';

  try {
    let res = await fetch('/api/file?path=' + encodeURIComponent(name));
    if (res.status === 404) {
      res = await fetch('/api/file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: name, content: '# Hello\n' }),
      });
      if (!res.ok && res.status !== 409) throw new Error('create failed');
      await loadTree();
    } else if (!res.ok) {
      throw new Error('load failed');
    }
    await openTab(name);
  } catch {
    status("Couldn't open today's note");
  }
}

/* ---------- external changes (SSE) ---------- */

async function refreshActiveNote() {
  if (!activePath) return;
  const tab = tabs.get(activePath);
  if (tab && tab.dirty) {
    status("Changed on disk (unsaved edits kept)");
    return;
  }
  try {
    const res = await fetch("/api/file?path=" + encodeURIComponent(activePath));
    if (!res.ok) return;
    const data = await res.json();
    if (tab) {
      tab.content = data.content;
      tab.dirty = false;
    }
    view.setState(makeState(data.content));
    if (viewMode !== "edit") renderPreview();
    renderTabs();
    status("Reloaded from disk");
  } catch {}
}

function watchVault() {
  try {
    const es = new EventSource("/api/events");
    es.onmessage = () => {
      loadTree();
      renderBacklinks(activePath);
      refreshActiveNote();
    };
  } catch {}
}

/* ---------- init ---------- */

applyTheme();
applySidebar();
applyViewMode();
updateEmptyState();
updateTabScroll();
window.addEventListener("resize", updateTabScroll);
watchVault();

(async () => {
  await loadTree();
  await openDailyNote();
})();
