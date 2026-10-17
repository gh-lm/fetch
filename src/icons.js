// A small, self-contained icon set drawn in a minimal, single-stroke style
// (24x24 grid, 1.6px rounded strokes) — no font files, no CDN, nothing
// fetched at runtime. Every icon is inline SVG so the app never depends on
// a network connection to render its UI.

function svg(inner, { viewBox = '0 0 24 24', extra = '' } = {}) {
  return `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" ${extra}>${inner}</svg>`;
}

const ICONS = {
  sidebar: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><line x1="9.5" y1="4" x2="9.5" y2="20"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  unlock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2.3"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  close: svg('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  minimize: svg('<line x1="5" y1="12" x2="19" y2="12"/>'),
  maximize: svg('<rect x="5" y="5" width="14" height="14" rx="2.5"/>'),
  closeWindow: svg('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  import: svg('<path d="M12 3v12"/><path d="M7.5 10.5 12 15l4.5-4.5"/><path d="M5 20h14"/>'),
  export: svg('<path d="M12 21V9"/><path d="M7.5 13.5 12 9l4.5 4.5"/><path d="M5 4h14"/>'),
  palette: svg('<path d="M12 3a9 9 0 1 0 0 18h.6a2 2 0 0 0 2-2 2 2 0 0 1 2-2h.6A3.8 3.8 0 0 0 21 13.2 9 9 0 0 0 12 3z"/><circle cx="7.8" cy="10.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="16.2" cy="10.2" r="1.15" fill="currentColor" stroke="none"/>'),
  check: svg('<path d="M4.5 12.5 9.5 17.5 19.5 6.5"/>'),
  pin: svg('<path d="M12 21s-7-7.5-7-12a7 7 0 0 1 14 0c0 4.5-7 12-7 12z"/><circle cx="12" cy="9" r="2.2"/>'),
  clear: svg('<line x1="18" y1="3" x2="10.5" y2="10.5"/><path d="M10.5 10.5 4.5 19.5h11z"/><line x1="7.3" y1="14.5" x2="6.3" y2="18.7"/><line x1="10.5" y1="14.5" x2="10.5" y2="19"/><line x1="13.7" y1="14.5" x2="14.2" y2="18.7"/>'),
  grip: svg('<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>'),
};

function icon(name) {
  return ICONS[name] || '';
}

module.exports = { icon, ICONS };
