const { ipcRenderer, shell, clipboard } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { WebLinksAddon } = require('@xterm/addon-web-links');
const { icon } = require('./icons');
const { version: APP_VERSION } = require('../package.json');

// ANSI slots use the Lightmorphic brand palette (red #F34236, green
// #4BAE4F, amber #FFC006, blue #2295F1, pink #E8207E, cyan #00BCD3) so
// terminal colors read as the color they're named, not washed pastels.
const TERMINAL_THEME = {
  background: '#0b0b10',
  foreground: '#ecebf5',
  cursor: '#ecebf5',
  cursorAccent: '#0b0b10',
  selectionBackground: 'rgba(139, 124, 255, 0.28)',
  black: '#201e31',
  red: '#F34236',
  green: '#4BAE4F',
  yellow: '#FFC006',
  blue: '#2295F1',
  magenta: '#E8207E',
  cyan: '#00BCD3',
  white: '#ecebf5',
  brightBlack: '#57546a',
  brightRed: '#FF6F62',
  brightGreen: '#6FD473',
  brightYellow: '#FFEA3A',
  brightBlue: '#5CB3FF',
  brightMagenta: '#F45CA2',
  brightCyan: '#35E0F0',
  brightWhite: '#ffffff',
};


// Most Linux distros' default shell prompt (`user@host`) is colored via the
// ANSI "green"/"bright green" slot, so we tint that slot with the accent hue
// too — the prompt then visually matches the rest of the app's accent color.
function currentTerminalTheme() {
  const hue = typeof currentAccentHue === 'number' ? currentAccentHue : DEFAULT_ACCENT_HUE;
  // The cursor deliberately stays the plain text color, not the accent —
  // it's a blinking block, and a colored one reads as noise rather than
  // as theming.
  return {
    ...TERMINAL_THEME,
    selectionBackground: hsla(hue, ACCENT_S, ACCENT_L, 0.3),
    green: hsl(hue, ACCENT_S, ACCENT_L),
    brightGreen: hsl(hue, 95, 62),
  };
}

let tabs = [];
let activeTabId = null;
let tabCounter = 0;
let history = [];
let snippets = [];
let sidebarPinned = true;
let sidebarCollapsed = false;
let editingSnippetId = null;
let toastTimer = null;

// ---------- Helpers ----------

function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getCellSize(term) {
  try {
    const dims = term._core._renderService.dimensions.css.cell;
    if (dims && dims.width && dims.height) return { width: dims.width, height: dims.height };
  } catch (err) {
    /* fall through to the estimate below */
  }
  const fontSize = (term.options && term.options.fontSize) || 14;
  return { width: fontSize * 0.6, height: fontSize * 1.2 };
}

function showToast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('visible');
    setTimeout(() => el.classList.add('hidden'), 220);
  }, 2600);
}

function looksLikeSsh(command) {
  return /^\s*ssh\b/i.test(command);
}

// Terminal output can come from an untrusted remote host (SSH session,
// curl'd text, etc.), and WebLinksAddon will detect and offer to open any
// URI-shaped text in it. shell.openExternal on an arbitrary scheme (file:,
// a custom registered protocol, ...) has a real history as an OS-level
// code-execution vector, not just "opens a browser" — only ever hand it
// plain http(s) links.
function openExternalIfHttp(url) {
  try {
    const scheme = new URL(url).protocol;
    if (scheme === 'http:' || scheme === 'https:') shell.openExternal(url);
  } catch (err) {
    /* not a parseable URL — ignore */
  }
}

// ---------- Tabs & terminals ----------

function copySelection(tab) {
  const term = tab.term;
  if (!term.hasSelection()) return;
  clipboard.writeText(term.getSelection());
  term.clearSelection();
}

function pasteIntoTerminal(tab) {
  const text = clipboard.readText();
  if (!text) return;

  if (!/[\r\n]/.test(text)) {
    const outgoing = processUserInput(tab, text);
    if (outgoing) ipcRenderer.send('pty:write', { tabId: tab.id, data: outgoing });
    return;
  }

  // Multi-line paste goes through xterm's own paste path, which honors
  // bracketed paste mode — the same mechanism GNOME Terminal/Console use.
  // A bracketed-paste-aware shell (bash 5.1+, zsh) receives the whole
  // block as one unit, holds it for review, and runs it like a script on
  // Enter — its own line-by-line execution keeps queued lines out of any
  // password or confirmation prompt a command opens partway through.
  tab.term.paste(text);
}

const MAX_TABS = 4;

function createTab() {
  if (tabs.length >= MAX_TABS) {
    showToast(`Maximum of ${MAX_TABS} tabs open at once`);
    return null;
  }
  const id = genId('tab');
  const pane = document.createElement('div');
  pane.className = 'terminal-pane';

  const ghost = document.createElement('div');
  ghost.className = 'autocomplete-ghost';
  pane.appendChild(ghost);

  document.getElementById('terminals').appendChild(pane);

  const term = new Terminal({
    fontFamily: "'Geist Mono', 'Roboto Mono', 'DejaVu Sans Mono', monospace",
    fontSize: 14,
    lineHeight: 1.15,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 8000,
    theme: currentTerminalTheme(),
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.loadAddon(new WebLinksAddon((_event, uri) => openExternalIfHttp(uri)));

  term.open(pane);
  fitAddon.fit();

  // The pane's padding is what offsets xterm's text from the pane edge;
  // the autocomplete ghost needs the same offset. Read from the CSS once
  // here so renderGhost never has to force a style recalc mid-typing.
  const paneStyle = getComputedStyle(pane);
  const tab = {
    id,
    term,
    fitAddon,
    pane,
    ghostEl: ghost,
    ghostOffset: {
      left: parseFloat(paneStyle.paddingLeft) || 0,
      top: parseFloat(paneStyle.paddingTop) || 0,
    },
    inputBuffer: '',
    suggestion: null,
    title: 'Shell',
  };
  tabs.push(tab);

  term.onData((data) => {
    if (!sidebarPinned && !sidebarCollapsed) setSidebarCollapsed(true);
    const outgoing = processUserInput(tab, data);
    if (outgoing) ipcRenderer.send('pty:write', { tabId: tab.id, data: outgoing });
  });
  term.onCursorMove(() => renderGhost(tab));
  term.onResize(({ cols, rows }) => ipcRenderer.send('pty:resize', { tabId: tab.id, cols, rows }));
  term.onTitleChange((title) => {
    if (title) {
      tab.title = title;
      renderTabs();
    }
  });

  // Ctrl+Shift+C copies, Ctrl+Shift+V pastes — plain Ctrl+C/Ctrl+V are left
  // completely alone, so they keep their normal terminal meaning
  // (interrupt, etc.) exactly as before.
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown' || event.altKey) return true;
    if (!(event.ctrlKey || event.metaKey)) return true;
    const key = event.key.toLowerCase();

    if (!event.shiftKey) return true;

    // Returning false only stops xterm's own key handling — it does not
    // stop the browser's native paste action from also firing on the same
    // keypress (xterm's hidden textarea has its own native 'paste' listener),
    // which was pasting everything twice. preventDefault() stops that too.
    if (key === 'c') {
      event.preventDefault();
      copySelection(tab);
      return false;
    }
    if (key === 'v') {
      event.preventDefault();
      pasteIntoTerminal(tab);
      return false;
    }
    return true;
  });

  // xterm clears its own selection on mousedown (any button, including
  // right-click) before our own listeners ever see it — by the time
  // 'contextmenu' fires, term.hasSelection() is already false, so Copy
  // silently did nothing no matter what was selected. A capture-phase
  // listener on the pane runs before xterm's own bubble-phase handler on
  // its inner element, so it can snapshot the selection first.
  let rightClickSelection = '';
  pane.addEventListener('mousedown', (event) => {
    if (event.button === 2) rightClickSelection = term.hasSelection() ? term.getSelection() : '';
  }, true);

  pane.addEventListener('contextmenu', async (event) => {
    event.preventDefault();
    const action = await ipcRenderer.invoke('terminal:context-menu', { hasSelection: !!rightClickSelection });
    if (action === 'copy') {
      if (rightClickSelection) clipboard.writeText(rightClickSelection);
      term.clearSelection();
    } else if (action === 'paste') pasteIntoTerminal(tab);
  });

  // Click-to-position: a real terminal has no concept of "move the
  // cursor here", since the cursor's actual position is owned by the
  // shell's line editor, not us — but we can fake it the way other
  // terminal emulators do, by sending exactly enough Left/Right arrow
  // keys to walk the shell's own cursor from where it is to where the
  // click landed. Only meaningful on the current input row and only for
  // a plain click (not the end of a drag-selection, which already has
  // its own handling above).
  pane.addEventListener('mouseup', (event) => {
    if (event.button !== 0 || term.hasSelection()) return;
    const rect = pane.getBoundingClientRect();
    const cell = getCellSize(term);
    const col = Math.floor((event.clientX - rect.left) / cell.width);
    const row = Math.floor((event.clientY - rect.top) / cell.height);
    const clickedRowAbs = term.buffer.active.viewportY + row;
    const cursorRowAbs = term.buffer.active.baseY + term.buffer.active.cursorY;
    if (clickedRowAbs !== cursorRowAbs) return;
    const delta = col - term.buffer.active.cursorX;
    if (!delta) return;
    const seq = delta > 0 ? '\x1b[C' : '\x1b[D';
    ipcRenderer.send('pty:write', { tabId: tab.id, data: seq.repeat(Math.abs(delta)) });
    clearSuggestion(tab);
  });

  ipcRenderer.send('pty:spawn', { tabId: id, cols: term.cols, rows: term.rows });

  setActiveTab(id);
  renderTabs();
  return tab;
}

function closeTab(id) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx === -1) return;
  const [tab] = tabs.splice(idx, 1);
  ipcRenderer.send('pty:kill', { tabId: id });
  tab.term.dispose();
  tab.pane.remove();

  if (tabs.length === 0) {
    createTab();
    return;
  }
  if (activeTabId === id) {
    const next = tabs[idx] || tabs[idx - 1];
    setActiveTab(next.id);
  }
  renderTabs();
}

function setActiveTab(id) {
  activeTabId = id;
  for (const tab of tabs) {
    const isActive = tab.id === id;
    tab.pane.classList.toggle('active', isActive);
    if (isActive) {
      requestAnimationFrame(() => {
        tab.fitAddon.fit();
        tab.term.focus();
      });
    }
  }
  renderTabs();
}

function cycleTab(direction) {
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  const next = (idx + direction + tabs.length) % tabs.length;
  setActiveTab(tabs[next].id);
}

function renderTabs() {
  const container = document.getElementById('tabs');
  container.innerHTML = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');
    el.dataset.tooltip = tab.title;

    const titleEl = document.createElement('span');
    titleEl.className = 'tab-title';
    titleEl.textContent = tab.title;

    const closeEl = document.createElement('span');
    closeEl.className = 'tab-close';
    closeEl.innerHTML = icon('close');
    closeEl.addEventListener('click', (event) => {
      event.stopPropagation();
      closeTab(tab.id);
    });

    el.append(titleEl, closeEl);
    el.addEventListener('click', () => setActiveTab(tab.id));
    container.appendChild(el);
  }
  updateNewTabButtonState();
}

function updateNewTabButtonState() {
  const btn = document.getElementById('new-tab-btn');
  const atLimit = tabs.length >= MAX_TABS;
  btn.disabled = atLimit;
  btn.dataset.tooltip = atLimit ? `Maximum of ${MAX_TABS} tabs open` : 'New tab (Ctrl+Shift+T)';
}

function activeTab() {
  return tabs.find((t) => t.id === activeTabId) || null;
}

// ---------- Command capture & autocomplete ----------

function findHistorySuggestion(prefix) {
  for (let i = history.length - 1; i >= 0; i--) {
    const command = history[i].command;
    if (command.length > prefix.length && command.startsWith(prefix)) return command;
  }
  return null;
}

function refreshSuggestion(tab) {
  tab.suggestion = tab.inputBuffer ? findHistorySuggestion(tab.inputBuffer) : null;
  renderGhost(tab);
}

function clearSuggestion(tab) {
  tab.suggestion = null;
  renderGhost(tab);
}

function renderGhost(tab) {
  const el = tab.ghostEl;
  const remainder = tab.suggestion ? tab.suggestion.slice(tab.inputBuffer.length) : '';
  if (!remainder) {
    el.style.display = 'none';
    return;
  }
  el.textContent = remainder;
  const cell = getCellSize(tab.term);
  const cursorX = tab.term.buffer.active.cursorX;
  const cursorY = tab.term.buffer.active.cursorY;
  // The ghost div never matched xterm's own font metrics: it was falling
  // back to the app's default 13px UI font instead of the terminal's 14px
  // font-size / 1.15 line-height, so even with the correct top/left the
  // glyphs inside sat in a differently-sized line box and looked shifted
  // up off the real text line. Match them explicitly, every render, so it
  // can't drift from the live terminal's own settings.
  const fontSize = (tab.term.options && tab.term.options.fontSize) || 14;
  el.style.fontSize = `${fontSize}px`;
  el.style.lineHeight = `${cell.height}px`;
  el.style.height = `${cell.height}px`;
  // The ghost is a direct child of .terminal-pane, which is where xterm's
  // own rendered text is inset by the pane's own padding (its containing
  // block for position:absolute is the pane's padding box, not its content
  // box) — without adding that back in, the ghost sits padding-top/-left
  // pixels above and to the left of the real cursor cell instead of right
  // on top of it. Measured once in createTab, not per keystroke.
  const { left: offsetLeft, top: offsetTop } = tab.ghostOffset;
  // The math above lands the ghost exactly on the real cursor cell in
  // every reproduction we've tried, on every DPI scale factor — but on at
  // least one real display it still reads about a pixel low. That's font
  // hinting/antialiasing, not the geometry, so it isn't something the
  // formula above can account for; nudge it down by a hair to compensate.
  const GHOST_VERTICAL_NUDGE = 1;
  el.style.left = `${offsetLeft + cursorX * cell.width}px`;
  el.style.top = `${offsetTop + cursorY * cell.height + GHOST_VERTICAL_NUDGE}px`;
  el.style.display = 'block';
}

// Sends the same thing a user typing "clear" and pressing Enter would —
// rather than xterm's own term.clear(), which only clears the local
// scrollback buffer and does nothing to whatever the shell itself thinks
// is on screen (so a remote SSH session, for instance, would look
// unchanged the moment it next redrew anything).
function clearActiveTerminal() {
  const tab = activeTab();
  if (!tab) return;
  ipcRenderer.send('pty:write', { tabId: tab.id, data: 'clear\r' });
  tab.inputBuffer = '';
  clearSuggestion(tab);
  tab.term.focus();
}

function commitLine(tab) {
  const command = tab.inputBuffer.trim();
  tab.inputBuffer = '';
  clearSuggestion(tab);
  if (command) {
    ipcRenderer.invoke('history:add', command).then((updated) => {
      history = updated;
    });
  }
}

// Returns the data that should actually be written to the pty, having
// interpreted it against our best-effort model of the current input line.
function processUserInput(tab, data) {
  if (data === '\r' || data === '\n') {
    commitLine(tab);
    return data;
  }
  if (data === '\x7f' || data === '\b') {
    tab.inputBuffer = tab.inputBuffer.slice(0, -1);
    refreshSuggestion(tab);
    return data;
  }
  if (data === '\x03') {
    tab.inputBuffer = '';
    clearSuggestion(tab);
    return data;
  }
  if (data === '\t') {
    if (tab.suggestion) {
      const remainder = tab.suggestion.slice(tab.inputBuffer.length);
      tab.inputBuffer = tab.suggestion;
      clearSuggestion(tab);
      return remainder;
    }
    return data;
  }
  if (data.charCodeAt(0) === 27) {
    // Right arrow accepts the suggestion (like a shell's inline autosuggest);
    // any other escape sequence is cursor movement we don't try to model.
    if ((data === '\x1b[C' || data === '\x1bOC') && tab.suggestion) {
      const remainder = tab.suggestion.slice(tab.inputBuffer.length);
      tab.inputBuffer = tab.suggestion;
      clearSuggestion(tab);
      return remainder;
    }
    clearSuggestion(tab);
    return data;
  }
  if (/[\x00-\x08\x0b-\x1f]/.test(data)) {
    // Other control sequences (Ctrl+A/E/K/W, etc.) move or edit the line in
    // ways we don't track; drop the suggestion rather than show something wrong.
    clearSuggestion(tab);
    return data;
  }
  tab.inputBuffer += data;
  refreshSuggestion(tab);
  return data;
}

// ---------- Snippets sidebar ----------

async function loadSnippets() {
  snippets = await ipcRenderer.invoke('snippets:load');
  renderSnippetList(document.getElementById('snippet-search').value);
}

async function persistSnippets() {
  await ipcRenderer.invoke('snippets:save', snippets);
}

function renderSnippetList(filter) {
  const listEl = document.getElementById('snippet-list');
  listEl.innerHTML = '';

  if (!snippets.length) {
    listEl.innerHTML = '<div class="empty-state">No snippets yet.<br>Click "+ New snippet" to save your first shell command.</div>';
    return;
  }

  const q = (filter || '').trim().toLowerCase();
  const filtered = !q
    ? snippets
    : snippets.filter((s) => (s.name && s.name.toLowerCase().includes(q)) || s.command.toLowerCase().includes(q));

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty-state">No snippets match your search.</div>';
    return;
  }

  // Pinned snippets float to the top; Array#sort is stable, so within each
  // group (pinned / not) everything keeps its existing relative order.
  const ordered = [...filtered].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  // Dragging to reorder rewrites the underlying `snippets` array by index,
  // which only means what the user sees while every snippet is visible and
  // in its normal pinned-then-unpinned order — with a search filter active
  // the list is a subset in a different order, so a drag there would move
  // the wrong item. Simplest correct fix: only allow it unfiltered.
  const reorderable = !q;

  for (const snippet of ordered) {
    const item = document.createElement('div');
    item.className = 'snippet-item' + (snippet.name ? '' : ' unnamed');
    item.draggable = reorderable;

    const gripEl = document.createElement('span');
    gripEl.className = 'snippet-grip';
    if (reorderable) {
      gripEl.innerHTML = icon('grip');
      gripEl.dataset.tooltip = 'Drag to reorder';
    }

    const isRemote = looksLikeSsh(snippet.command);
    const iconEl = document.createElement('div');
    iconEl.className = 'snippet-icon' + (isRemote ? ' remote' : '');
    iconEl.textContent = isRemote ? '→' : '$';

    const text = document.createElement('div');
    text.className = 'snippet-text';
    if (snippet.name) {
      const nameEl = document.createElement('span');
      nameEl.className = 'snippet-name';
      nameEl.textContent = snippet.name;
      text.appendChild(nameEl);
    }
    const cmdEl = document.createElement('span');
    cmdEl.className = 'snippet-command';
    cmdEl.textContent = snippet.command;
    text.appendChild(cmdEl);

    const pinBtn = document.createElement('button');
    pinBtn.className = 'snippet-pin-btn' + (snippet.pinned ? ' pinned' : '');
    pinBtn.innerHTML = icon('pin');
    pinBtn.dataset.tooltip = snippet.pinned ? 'Unpin' : `Pin to top (up to ${MAX_PINNED_SNIPPETS})`;
    pinBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleSnippetPin(snippet);
    });

    const editBtn = document.createElement('button');
    editBtn.className = 'snippet-edit-btn';
    editBtn.innerHTML = icon('edit');
    editBtn.dataset.tooltip = 'Edit snippet';
    editBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openSnippetModal(snippet);
    });

    item.append(gripEl, iconEl, text, pinBtn, editBtn);
    item.dataset.tooltip = 'Click to run — Ctrl+Click to type it without pressing Enter';
    item.addEventListener('click', (event) => runSnippet(snippet, event));

    if (reorderable) {
      item.addEventListener('dragstart', (event) => {
        dragSnippetId = snippet.id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', snippet.id);
        item.classList.add('dragging');
      });
      item.addEventListener('dragover', (event) => {
        if (!dragSnippetId || dragSnippetId === snippet.id) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        const before = event.clientY - item.getBoundingClientRect().top < item.offsetHeight / 2;
        item.classList.toggle('drag-over-top', before);
        item.classList.toggle('drag-over-bottom', !before);
      });
      item.addEventListener('dragleave', () => {
        item.classList.remove('drag-over-top', 'drag-over-bottom');
      });
      item.addEventListener('drop', (event) => {
        event.preventDefault();
        const before = event.clientY - item.getBoundingClientRect().top < item.offsetHeight / 2;
        reorderSnippet(dragSnippetId, snippet.id, before);
      });
      item.addEventListener('dragend', () => {
        dragSnippetId = null;
        listEl.querySelectorAll('.snippet-item').forEach((el) => {
          el.classList.remove('dragging', 'drag-over-top', 'drag-over-bottom');
        });
      });
    }

    listEl.appendChild(item);
  }
}

let dragSnippetId = null;

async function reorderSnippet(draggedId, targetId, before) {
  if (!draggedId || draggedId === targetId) return;
  const fromIdx = snippets.findIndex((s) => s.id === draggedId);
  if (fromIdx === -1) return;
  const [moved] = snippets.splice(fromIdx, 1);
  let toIdx = snippets.findIndex((s) => s.id === targetId);
  if (toIdx === -1) toIdx = snippets.length;
  snippets.splice(before ? toIdx : toIdx + 1, 0, moved);
  await persistSnippets();
  renderSnippetList(document.getElementById('snippet-search').value);
}

const MAX_PINNED_SNIPPETS = 3;

async function toggleSnippetPin(snippet) {
  if (!snippet.pinned && snippets.filter((s) => s.pinned).length >= MAX_PINNED_SNIPPETS) {
    showToast(`You can pin up to ${MAX_PINNED_SNIPPETS} snippets`);
    return;
  }
  snippet.pinned = !snippet.pinned;
  await persistSnippets();
  renderSnippetList(document.getElementById('snippet-search').value);
}

function runSnippet(snippet, event) {
  const tab = activeTab();
  if (!tab) return;
  // Ctrl/Cmd+Click types the snippet without submitting it — useful for a
  // snippet that's really a prefix (e.g. "sudo apt install ") meant to be
  // finished by hand rather than run as-is. Keep tab.inputBuffer in sync
  // either way, the same as every other way text reaches the terminal, so
  // autocomplete and history stay correct for whatever happens next.
  const withEnter = !(event && (event.ctrlKey || event.metaKey));
  if (withEnter) {
    ipcRenderer.send('pty:write', { tabId: tab.id, data: snippet.command + '\r' });
    tab.inputBuffer = '';
    clearSuggestion(tab);
  } else {
    ipcRenderer.send('pty:write', { tabId: tab.id, data: snippet.command });
    tab.inputBuffer += snippet.command;
    refreshSuggestion(tab);
  }
  // Clicking a snippet takes focus away from the terminal (it's a sidebar
  // click), so without this the cursor just blinks there uninteractively
  // until the user clicks back into it themselves — whether or not Enter
  // was pressed, the whole point is to keep typing right away.
  tab.term.focus();
  if (!sidebarPinned) setSidebarCollapsed(true);
}

function openSnippetModal(snippet) {
  editingSnippetId = snippet ? snippet.id : null;
  document.getElementById('snippet-modal-title').textContent = snippet ? 'Edit snippet' : 'New snippet';
  document.getElementById('snippet-name-input').value = snippet && snippet.name ? snippet.name : '';
  document.getElementById('snippet-command-input').value = snippet ? snippet.command : '';
  document.getElementById('snippet-delete-btn').classList.toggle('hidden', !snippet);
  document.getElementById('snippet-modal').classList.remove('hidden');
  document.getElementById('snippet-command-input').focus();
}

function closeSnippetModal() {
  document.getElementById('snippet-modal').classList.add('hidden');
  editingSnippetId = null;
}

async function saveSnippetFromModal() {
  const name = document.getElementById('snippet-name-input').value.trim();
  const command = document.getElementById('snippet-command-input').value.trim();
  if (!command) {
    showToast('A command is required');
    return;
  }
  if (editingSnippetId) {
    const existing = snippets.find((s) => s.id === editingSnippetId);
    if (existing) {
      existing.name = name || null;
      existing.command = command;
    }
  } else {
    snippets.push({ id: genId('snippet'), name: name || null, command });
  }
  await persistSnippets();
  closeSnippetModal();
  renderSnippetList(document.getElementById('snippet-search').value);
}

async function deleteSnippetFromModal() {
  if (!editingSnippetId) return;
  snippets = snippets.filter((s) => s.id !== editingSnippetId);
  await persistSnippets();
  closeSnippetModal();
  renderSnippetList(document.getElementById('snippet-search').value);
}

async function exportSnippets() {
  if (!snippets.length) {
    showToast('No snippets to export yet');
    return;
  }
  const result = await ipcRenderer.invoke('snippets:export', snippets);
  if (result.ok) showToast(`Exported to ${result.path}`);
}

async function importSnippets() {
  const result = await ipcRenderer.invoke('snippets:import');
  if (!result.ok) return;
  const incoming = result.snippets || [];
  let added = 0;
  for (const s of incoming) {
    const isDuplicate = snippets.some((existing) => existing.command === s.command && existing.name === s.name);
    if (!isDuplicate) {
      snippets.push(s);
      added += 1;
    }
  }
  await persistSnippets();
  renderSnippetList(document.getElementById('snippet-search').value);
  showToast(added ? `Imported ${added} snippet${added === 1 ? '' : 's'}` : 'No new snippets found in that file');
}

// ---------- Passwords (encrypted, write-only, PIN-gated credentials) ----------
//
// Encryption at rest only protects the file on disk — it does nothing to
// stop someone who's simply sitting at this already-unlocked computer from
// clicking "type into terminal". A separate vault PIN gates every
// credentials:* call in the main process, and auto-locks after a few
// minutes idle, so walking away from the machine matters again.

let vaultHasPin = false;
let vaultUnlocked = false;

async function refreshVaultStatus() {
  const status = await ipcRenderer.invoke('vault:status');
  vaultHasPin = !!(status && status.hasPin);
  vaultUnlocked = !!(status && status.unlocked);
  renderCredentialSection();
}

function renderCredentialSection() {
  const controls = document.getElementById('credential-controls');
  const list = document.getElementById('credential-list');
  controls.innerHTML = '';
  list.innerHTML = '';

  if (!vaultHasPin) {
    controls.innerHTML = `
      <input id="vault-pin-input" class="vault-pin-input" type="password" placeholder="New PIN" autocomplete="off" data-tooltip="Protects saved passwords from anyone else who uses this computer — separate from any system password, never leaves this device" />
      <button id="vault-pin-submit" class="icon-btn accent-icon-btn" data-icon="check" data-tooltip="Set PIN"></button>
    `;
    applyIcons();
    wireVaultPinInput(setupVaultPin);
    return;
  }

  if (!vaultUnlocked) {
    controls.innerHTML = `
      <input id="vault-pin-input" class="vault-pin-input" type="password" placeholder="PIN" autocomplete="off" />
      <button id="vault-pin-submit" class="icon-btn accent-icon-btn" data-icon="unlock" data-tooltip="Unlock"></button>
    `;
    applyIcons();
    wireVaultPinInput(unlockVault);
    return;
  }

  controls.innerHTML = `
    <button id="add-credential-btn" class="icon-btn" data-icon="plus" data-tooltip="Add password"></button>
    <button id="vault-lock-btn" class="icon-btn" data-icon="lock" data-tooltip="Lock now"></button>
  `;
  applyIcons();
  document.getElementById('add-credential-btn').addEventListener('click', () => openCredentialModal());
  document.getElementById('vault-lock-btn').addEventListener('click', lockVaultNow);
  loadCredentials();
}

function wireVaultPinInput(onSubmit) {
  const input = document.getElementById('vault-pin-input');
  document.getElementById('vault-pin-submit').addEventListener('click', onSubmit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') onSubmit();
  });
  input.focus();
}

async function setupVaultPin() {
  const input = document.getElementById('vault-pin-input');
  const pin = input.value;
  if (!pin || pin.length < 4) {
    showToast('PIN must be at least 4 characters');
    return;
  }
  const result = await ipcRenderer.invoke('vault:setPin', pin);
  if (!result || result.error) {
    showToast('Could not set that PIN');
    return;
  }
  await refreshVaultStatus();
}

async function unlockVault() {
  const input = document.getElementById('vault-pin-input');
  const pin = input.value;
  const result = await ipcRenderer.invoke('vault:unlock', pin);
  if (!result || !result.ok) {
    showToast(result && result.error === 'locked-out' ? 'Too many wrong PINs — locked for an hour' : 'Wrong PIN');
    input.value = '';
    input.focus();
    return;
  }
  await refreshVaultStatus();
}

async function lockVaultNow() {
  await ipcRenderer.invoke('vault:lock');
  await refreshVaultStatus();
}

async function loadCredentials() {
  const result = await ipcRenderer.invoke('credentials:list');
  if (!result || result.locked) {
    await refreshVaultStatus();
    return;
  }
  renderCredentialList(result.entries || []);
}

function renderCredentialList(list) {
  const container = document.getElementById('credential-list');
  container.innerHTML = '';
  for (const cred of list) {
    const row = document.createElement('div');
    row.className = 'credential-row';
    row.addEventListener('click', () => typeCredential(cred.id));

    const name = document.createElement('span');
    name.className = 'credential-name';
    name.textContent = cred.name;

    const editBtn = document.createElement('button');
    editBtn.className = 'snippet-edit-btn';
    editBtn.innerHTML = icon('edit');
    editBtn.dataset.tooltip = 'Edit password';
    editBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openCredentialModal(cred);
    });

    row.append(name, editBtn);
    container.appendChild(row);
  }
}

async function typeCredential(id) {
  const tab = activeTab();
  if (!tab) {
    showToast('Open a terminal tab first');
    return;
  }
  const result = await ipcRenderer.invoke('credentials:type', { id, tabId: tab.id });
  if (!result || !result.ok) {
    if (result && result.error === 'locked') {
      showToast('Vault locked — enter your PIN again');
      await refreshVaultStatus();
      return;
    }
    showToast('Could not type that password');
  }
  tab.term.focus();
}

async function deleteCredential(id) {
  await ipcRenderer.invoke('credentials:delete', id);
  await loadCredentials();
}

let editingCredentialId = null;
let credentialDeleteConfirmTimer = null;

function resetCredentialDeleteButton() {
  clearTimeout(credentialDeleteConfirmTimer);
  const btn = document.getElementById('credential-delete-btn');
  btn.classList.remove('armed');
  btn.textContent = 'Delete';
}

function openCredentialModal(cred) {
  editingCredentialId = cred ? cred.id : null;
  document.getElementById('credential-modal-title').textContent = cred ? 'Edit password' : 'New password';
  document.getElementById('credential-name-input').value = cred ? cred.name : '';
  const passwordInput = document.getElementById('credential-password-input');
  passwordInput.value = '';
  passwordInput.placeholder = cred ? 'Leave blank to keep the current password' : '';
  document.getElementById('credential-delete-btn').classList.toggle('hidden', !cred);
  resetCredentialDeleteButton();
  document.getElementById('credential-modal').classList.remove('hidden');
  document.getElementById('credential-name-input').focus();
}
function closeCredentialModal() {
  document.getElementById('credential-modal').classList.add('hidden');
  editingCredentialId = null;
}

async function saveCredentialFromModal() {
  const name = document.getElementById('credential-name-input').value.trim();
  const password = document.getElementById('credential-password-input').value;
  if (!name) {
    showToast('A name is required');
    return;
  }
  if (!editingCredentialId && !password) {
    showToast('A password is required');
    return;
  }

  const result = editingCredentialId
    ? await ipcRenderer.invoke('credentials:update', { id: editingCredentialId, name, password })
    : await ipcRenderer.invoke('credentials:add', { name, password });

  document.getElementById('credential-password-input').value = '';
  if (!result || result.error === 'unavailable') {
    showToast("Secure storage isn't available on this system");
    return;
  }
  if (result.error === 'locked') {
    showToast('Vault locked — enter your PIN again');
    closeCredentialModal();
    await refreshVaultStatus();
    return;
  }
  if (result.error) {
    showToast('Could not save that password');
    return;
  }
  closeCredentialModal();
  await loadCredentials();
}

async function handleCredentialDeleteClick() {
  const btn = document.getElementById('credential-delete-btn');
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed');
    btn.textContent = 'Confirm?';
    clearTimeout(credentialDeleteConfirmTimer);
    credentialDeleteConfirmTimer = setTimeout(resetCredentialDeleteButton, 4000);
    return;
  }
  const id = editingCredentialId;
  resetCredentialDeleteButton();
  closeCredentialModal();
  if (id) await deleteCredential(id);
}

let resetConfirmTimer = null;

function disarmReset() {
  clearTimeout(resetConfirmTimer);
  resetConfirmTimer = null;
  const btn = document.getElementById('reset-data-btn');
  btn.textContent = 'Reset';
  btn.classList.remove('armed');
}

async function handleResetClick() {
  const btn = document.getElementById('reset-data-btn');
  if (!btn.classList.contains('armed')) {
    btn.textContent = 'Confirm?';
    btn.classList.add('armed');
    clearTimeout(resetConfirmTimer);
    resetConfirmTimer = setTimeout(disarmReset, 4000);
    return;
  }
  disarmReset();
  await ipcRenderer.invoke('app:reset');
  // On success the main process wipes everything and relaunches; nothing
  // left to do here.
}

// ---------- Sidebar collapse / pin ----------

function setSidebarCollapsed(collapsed) {
  sidebarCollapsed = collapsed;
  document.getElementById('sidebar').classList.toggle('collapsed', collapsed);
  document.getElementById('sidebar-topbar').classList.toggle('collapsed', collapsed);
  document.getElementById('sidebar-toggle').classList.toggle('active', !collapsed);
  // The terminal refits itself via the ResizeObserver once the slide settles.
}

function toggleSidebar() {
  setSidebarCollapsed(!sidebarCollapsed);
}

function togglePin() {
  sidebarPinned = !sidebarPinned;
  updatePinButton();
  if (sidebarPinned && sidebarCollapsed) setSidebarCollapsed(false);
}

function updatePinButton() {
  const btn = document.getElementById('pin-btn');
  btn.classList.toggle('active', sidebarPinned);
  btn.innerHTML = icon(sidebarPinned ? 'lock' : 'unlock');
  btn.dataset.tooltip = sidebarPinned ? 'Unlock (allow the sidebar to auto-collapse)' : 'Lock the sidebar open';
}

// ---------- Terminal theme ----------

function applyThemeToAllTerminals() {
  const theme = currentTerminalTheme();
  for (const tab of tabs) tab.term.options.theme = theme;
}

// ---------- Accent color ----------
//
// Fifteen hues taken from the Lightmorphic brand palette and converted to
// HSL hue angles, spread for contrast on the dark theme.
const ACCENT_COLORS = [
  { name: 'Red', hue: 355 },
  { name: 'Deep Orange', hue: 15 },
  { name: 'Orange', hue: 27 },
  { name: 'Amber', hue: 45 },
  { name: 'Lime', hue: 66 },
  { name: 'Light Green', hue: 88 },
  { name: 'Green', hue: 142 },
  { name: 'Teal', hue: 174 },
  { name: 'Cyan', hue: 190 },
  { name: 'Light Blue', hue: 199 },
  { name: 'Blue', hue: 217 },
  { name: 'Indigo', hue: 231 },
  { name: 'Deep Purple', hue: 264 },
  { name: 'Purple', hue: 291 },
  { name: 'Pink', hue: 330 },
];
const DEFAULT_ACCENT_HUE = 47; // brand yellow #FBC711
let currentAccentHue = DEFAULT_ACCENT_HUE;

function hsl(h, s, l) {
  return `hsl(${h} ${s}% ${l}%)`;
}
function hsla(h, s, l, a) {
  return `hsl(${h} ${s}% ${l}% / ${a})`;
}

// The accent is used at full strength, so the text on top of it has to
// adapt: light accents (yellow, lime, cyan…) get brand-navy text, dark
// accents (blue, purple…) get white — decided by YIQ brightness.
function hslToRgbBytes(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
}
function accentTextColor(h, s, l) {
  const [r, g, b] = hslToRgbBytes(h, s, l);
  return (r * 299 + g * 587 + b * 114) / 1000 >= 150 ? '#111827' : '#ffffff';
}

// The accent is the full-strength color in both schemes — the same
// color you clicked in the picker — with the text on it flipping
// between brand navy and white based on the accent's own brightness.
const ACCENT_S = 100;
const ACCENT_L = 50;

function applyAccent(hue) {
  currentAccentHue = hue;
  const tertiaryHue = (hue + 60) % 360;
  const root = document.documentElement.style;
  root.setProperty('--primary', hsl(hue, ACCENT_S, ACCENT_L));
  root.setProperty('--primary-on', accentTextColor(hue, ACCENT_S, ACCENT_L));
  root.setProperty('--tertiary', hsl(tertiaryHue, ACCENT_S, ACCENT_L));
  root.setProperty('--tertiary-on', accentTextColor(tertiaryHue, ACCENT_S, ACCENT_L));
  // A deep tint of the accent, for the fill behind accent-colored controls.
  root.setProperty('--primary-container', hsl(hue, 65, 32));
  applyThemeToAllTerminals();
  renderAccentSwatches();
}

function renderAccentSwatches() {
  const container = document.getElementById('accent-swatches');
  if (!container) return;
  container.innerHTML = '';
  for (const accent of ACCENT_COLORS) {
    const isSelected = accent.hue === currentAccentHue;
    const btn = document.createElement('button');
    btn.className = 'accent-swatch' + (isSelected ? ' selected' : '');
    btn.style.background = hsl(accent.hue, ACCENT_S, ACCENT_L);
    btn.dataset.tooltip = accent.name;
    if (isSelected) btn.innerHTML = icon('check');
    btn.addEventListener('click', () => selectAccent(accent.hue));
    container.appendChild(btn);
  }
}

async function selectAccent(hue) {
  applyAccent(hue);
  await ipcRenderer.invoke('accent:set', hue);
  closeAppearancePopover();
}

function closeAppearancePopover() {
  document.getElementById('appearance-popover').classList.add('hidden');
}
function toggleAppearancePopover() {
  document.getElementById('appearance-popover').classList.toggle('hidden');
}

async function loadAccent() {
  const hue = await ipcRenderer.invoke('accent:get');
  applyAccent(typeof hue === 'number' ? hue : DEFAULT_ACCENT_HUE);
}

// ---------- Command history modal ----------

async function loadHistory() {
  history = await ipcRenderer.invoke('history:load');
}

function openHistoryModal() {
  const modal = document.getElementById('history-modal');
  modal.classList.remove('hidden');
  const search = document.getElementById('history-search');
  search.value = '';
  renderHistoryList('');
  search.focus();
}

function closeHistoryModal() {
  document.getElementById('history-modal').classList.add('hidden');
}

function renderHistoryList(filter) {
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '';
  const q = (filter || '').trim().toLowerCase();
  const items = history
    .slice()
    .reverse()
    .filter((h) => !q || h.command.toLowerCase().includes(q));

  if (!items.length) {
    listEl.innerHTML = '<div class="empty-state">No matching commands.</div>';
    return;
  }

  for (const entry of items.slice(0, 300)) {
    const el = document.createElement('div');
    el.className = 'history-item';
    el.textContent = entry.command;
    el.addEventListener('click', () => {
      insertCommand(entry.command);
      closeHistoryModal();
    });
    listEl.appendChild(el);
  }
}

function insertCommand(command) {
  const tab = activeTab();
  if (!tab) return;
  // Clear whatever's on the current input line, then type the command without
  // pressing Enter, so the user can review or edit it before running it.
  ipcRenderer.send('pty:write', { tabId: tab.id, data: '\x15' + command });
  tab.inputBuffer = command;
  clearSuggestion(tab);
  tab.term.focus();
}

// ---------- Updates ----------
//
// One dot carries the whole update UI (Lightmorphic's house update-status
// widget — see the update-widget skill): its plain color IS the interface
// — green up to date, amber ready to download, blue ready to restart —
// with every action built into clicking the dot rather than a separate
// button. No icons sit inside it.

// 2*pi*r for the ring's r=5.7 (set in index.html) — stroke-dashoffset is
// computed against this to trace the download progress ring.
const UPDATE_RING_CIRCUMFERENCE = 2 * Math.PI * 5.7;

let currentUpdateAction = null; // null | 'check' | 'download' | 'install'

// A manual check (clicking the green dot) pulses the dot three times
// (3 × 600ms) and holds the green until the pulses finish — the result
// is buffered so a fast "no update" answer doesn't cut the pulse short.
const MANUAL_PULSE_MS = 1800;
let manualCheckStartedAt = null;
let pendingUpdatePayload = null;

function setUpdateRingProgress(fraction) {
  const ring = document.querySelector('.update-ring-progress');
  const offset = UPDATE_RING_CIRCUMFERENCE * (1 - Math.max(0, Math.min(1, fraction)));
  ring.style.strokeDasharray = String(UPDATE_RING_CIRCUMFERENCE);
  ring.style.strokeDashoffset = String(offset);
}

function setUpdateDot({ cls, tooltip, action = null }) {
  const dot = document.getElementById('update-dot');
  dot.className = `update-dot ${cls}`;
  dot.dataset.tooltip = tooltip;
  currentUpdateAction = action;
}

function applyUpdateState(payload) {
  switch (payload.state) {
    case 'checking':
      setUpdateDot({ cls: 'checking', tooltip: 'Checking for updates…' });
      break;
    case 'available':
      setUpdateDot({
        cls: 'available',
        tooltip: 'Update available — click to download',
        action: 'download',
      });
      break;
    case 'downloading':
      // No percentage in the tooltip — the ring itself is the progress
      // indicator, and the spec is explicit about not duplicating that
      // as text anywhere.
      setUpdateDot({ cls: 'downloading', tooltip: 'Downloading update…' });
      setUpdateRingProgress((payload.percent || 0) / 100);
      break;
    case 'downloaded':
      setUpdateDot({
        cls: 'downloaded',
        tooltip: 'Click to restart the app',
        action: 'install',
      });
      break;
    case 'error':
      if (currentUpdateAction === 'download') showToast('Update failed to download');
      setUpdateDot({ cls: 'error', tooltip: "Can't connect to GitHub" });
      break;
    case 'not-available':
    default:
      setUpdateDot({ cls: 'up-to-date', tooltip: 'Up to date — click to check now', action: 'check' });
      break;
  }
}

function onUpdateState(payload) {
  if (manualCheckStartedAt !== null) {
    // The main process echoes a 'checking' state as soon as the manual
    // check starts — ignore it, the pulsing green dot already says so.
    if (payload.state === 'checking') return;
    const elapsed = Date.now() - manualCheckStartedAt;
    if (elapsed < MANUAL_PULSE_MS) {
      pendingUpdatePayload = payload;
      setTimeout(() => {
        manualCheckStartedAt = null;
        if (pendingUpdatePayload) applyUpdateState(pendingUpdatePayload);
        pendingUpdatePayload = null;
      }, MANUAL_PULSE_MS - elapsed);
      return;
    }
    manualCheckStartedAt = null;
  }
  applyUpdateState(payload);
}

async function handleUpdateDotClick() {
  if (currentUpdateAction === 'download') {
    await ipcRenderer.invoke('update:download');
  } else if (currentUpdateAction === 'install') {
    await ipcRenderer.invoke('update:install');
  } else if (currentUpdateAction === 'check') {
    manualCheckStartedAt = Date.now();
    pendingUpdatePayload = null;
    setUpdateDot({ cls: 'up-to-date pulsing', tooltip: 'Checking for updates…' });
    await ipcRenderer.invoke('update:check');
  }
}

// ---------- Tooltips (rendered at the document level, positioned via JS,
// so they're never clipped by a scrolling/overflow:hidden ancestor like
// the snippet or password lists) ----------

function initGlobalTooltip() {
  const tip = document.createElement('div');
  tip.id = 'global-tooltip';
  document.body.appendChild(tip);
  let currentEl = null;

  function reposition(el) {
    const rect = el.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let top = rect.top - tipRect.height - 8;
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    if (top < 4) top = rect.bottom + 8;
    top = Math.min(top, window.innerHeight - tipRect.height - 4);
    left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  }

  function show(el) {
    if (!el.dataset.tooltip) return;
    currentEl = el;
    tip.textContent = el.dataset.tooltip;
    tip.classList.add('visible');
    reposition(el);
  }
  function hide(el) {
    if (el && el !== currentEl) return;
    currentEl = null;
    tip.classList.remove('visible');
  }

  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest('[data-tooltip]');
    if (el) show(el);
  });
  document.addEventListener('mouseout', (e) => hide(e.target.closest('[data-tooltip]')));
  // Tooltip text can change while still hovered (e.g. the update dot
  // mid-check) — cheap to just re-sync on every mousemove rather than
  // wire a change listener onto every possible tooltip source.
  document.addEventListener('mousemove', () => {
    if (currentEl && currentEl.dataset.tooltip !== tip.textContent) {
      tip.textContent = currentEl.dataset.tooltip;
      reposition(currentEl);
    }
  });
}

// ---------- Wiring ----------

function applyIcons() {
  document.querySelectorAll('[data-icon]').forEach((el) => {
    el.innerHTML = icon(el.dataset.icon);
  });
  document.querySelectorAll('[data-icon-inline]').forEach((el) => {
    const label = el.textContent.trim();
    el.innerHTML = '';
    const iconSpan = document.createElement('span');
    iconSpan.className = 'btn-icon';
    iconSpan.innerHTML = icon(el.dataset.iconInline);
    const labelSpan = document.createElement('span');
    labelSpan.textContent = label;
    el.append(iconSpan, labelSpan);
  });
}

function wireStaticControls() {
  applyIcons();
  updatePinButton();
  document.getElementById('sidebar-toggle').classList.add('active');
  document.getElementById('app-brand-version').textContent = `v${APP_VERSION}`;

  document.getElementById('new-tab-btn').addEventListener('click', () => createTab());
  document.getElementById('clear-btn').addEventListener('click', clearActiveTerminal);
  document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
  document.getElementById('pin-btn').addEventListener('click', togglePin);
  document.getElementById('appearance-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAppearancePopover();
  });
  document.getElementById('appearance-popover').querySelector('.popover-scrim').addEventListener('click', closeAppearancePopover);

  document.getElementById('snippet-search').addEventListener('input', (e) => renderSnippetList(e.target.value));
  document.getElementById('add-snippet-btn').addEventListener('click', () => openSnippetModal(null));
  document.getElementById('export-btn').addEventListener('click', exportSnippets);
  document.getElementById('import-btn').addEventListener('click', importSnippets);

  document.getElementById('snippet-cancel-btn').addEventListener('click', closeSnippetModal);
  document.getElementById('snippet-save-btn').addEventListener('click', saveSnippetFromModal);
  document.getElementById('snippet-delete-btn').addEventListener('click', deleteSnippetFromModal);
  document.getElementById('snippet-modal').querySelector('.modal-scrim').addEventListener('click', closeSnippetModal);

  document.getElementById('credential-cancel-btn').addEventListener('click', closeCredentialModal);
  document.getElementById('credential-save-btn').addEventListener('click', saveCredentialFromModal);
  document.getElementById('credential-delete-btn').addEventListener('click', handleCredentialDeleteClick);
  document.getElementById('credential-modal').querySelector('.modal-scrim').addEventListener('click', closeCredentialModal);
  ipcRenderer.on('vault:state', (_event, payload) => {
    vaultUnlocked = !!(payload && payload.unlocked);
    renderCredentialSection();
  });

  document.getElementById('reset-data-btn').addEventListener('click', handleResetClick);

  document.getElementById('history-search').addEventListener('input', (e) => renderHistoryList(e.target.value));
  document.getElementById('history-modal').querySelector('.modal-scrim').addEventListener('click', closeHistoryModal);

  document.getElementById('btn-min').addEventListener('click', () => ipcRenderer.send('window:minimize'));
  document.getElementById('btn-max').addEventListener('click', () => ipcRenderer.send('window:maximize-toggle'));
  document.getElementById('btn-close').addEventListener('click', () => ipcRenderer.send('window:close'));

  document.getElementById('update-dot').addEventListener('click', handleUpdateDotClick);
  ipcRenderer.on('update:state', (_event, payload) => onUpdateState(payload));

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (mod && e.shiftKey && key === 't') {
      e.preventDefault(); e.stopPropagation();
      createTab();
      return;
    }
    if (mod && e.shiftKey && key === 'w') {
      e.preventDefault(); e.stopPropagation();
      if (activeTabId) closeTab(activeTabId);
      return;
    }
    if (mod && e.shiftKey && (key === 'h' || key === 'f')) {
      e.preventDefault(); e.stopPropagation();
      openHistoryModal();
      return;
    }
    if (mod && e.shiftKey && key === 'b') {
      e.preventDefault(); e.stopPropagation();
      toggleSidebar();
      return;
    }
    if (mod && key === 'tab') {
      e.preventDefault(); e.stopPropagation();
      cycleTab(e.shiftKey ? -1 : 1);
      return;
    }
    if (key === 'escape') {
      if (!document.getElementById('history-modal').classList.contains('hidden')) {
        closeHistoryModal();
        e.preventDefault();
      } else if (!document.getElementById('snippet-modal').classList.contains('hidden')) {
        closeSnippetModal();
        e.preventDefault();
      } else if (!document.getElementById('appearance-popover').classList.contains('hidden')) {
        closeAppearancePopover();
        e.preventDefault();
      }
    }
  }, true);

  ipcRenderer.on('pty:data', (_event, { tabId, data }) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) tab.term.write(data);
  });

  ipcRenderer.on('pty:exit', (_event, { tabId }) => {
    const tab = tabs.find((t) => t.id === tabId);
    if (tab) tab.term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n');
  });

  // One fit per settled resize, not one per animation frame. The sidebar
  // slides shut over ~220ms and this observer fires on every frame of
  // that, so the shell used to get a dozen resizes (SIGWINCHes) in a row
  // — and when the slide was triggered by the first keystroke, bash was
  // redrawing the prompt line against a column count that kept changing
  // while it echoed that keystroke, leaving the letter orphaned on the
  // line. Waiting for the size to hold still gives it exactly one resize.
  let fitTimer = null;
  const resizeObserver = new ResizeObserver(() => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      const tab = activeTab();
      if (tab) tab.fitAddon.fit();
    }, 60);
  });
  resizeObserver.observe(document.getElementById('terminals'));
}

async function bootstrap() {
  initGlobalTooltip();
  wireStaticControls();
  await Promise.all([loadSnippets(), loadHistory(), loadAccent(), refreshVaultStatus()]);
  createTab();
  // Geist Mono loads from disk almost instantly, but xterm measures cell
  // size from whatever font is active at the time — re-fit once it's
  // actually ready so terminal columns don't end up a few pixels off.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      for (const tab of tabs) tab.fitAddon.fit();
    });
  }
}

bootstrap();
