// Same inline-SVG icon set as the app itself (src/icons.js), copied by
// hand rather than built, since this is a plain static site with no build
// step. Applied to any element with a data-icon attribute on load.

function svg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

const SITE_ICONS = {
  sidebar: svg('<rect x="3" y="4" width="18" height="16" rx="3"/><line x1="9.5" y1="4" x2="9.5" y2="20"/>'),
  lock: svg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  minimize: svg('<line x1="5" y1="12" x2="19" y2="12"/>'),
  maximize: svg('<rect x="5" y="5" width="14" height="14" rx="2.5"/>'),
  closeWindow: svg('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>'),
  palette: svg('<path d="M12 3a9 9 0 1 0 0 18h.6a2 2 0 0 0 2-2 2 2 0 0 1 2-2h.6A3.8 3.8 0 0 0 21 13.2 9 9 0 0 0 12 3z"/><circle cx="7.8" cy="10.2" r="1.15" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1.15" fill="currentColor" stroke="none"/><circle cx="16.2" cy="10.2" r="1.15" fill="currentColor" stroke="none"/>'),
  dollar: '$',
  arrow: '→',
  externalLink: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><line x1="10" y1="14" x2="21" y2="3"/>'),
};

document.querySelectorAll('[data-icon]').forEach((el) => {
  el.innerHTML = SITE_ICONS[el.dataset.icon] || '';
});
