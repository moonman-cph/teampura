// shared-nav.js — single source of truth for the left navigation.
// Auto-detects the active page and injects nav HTML into <nav id="left-nav">.
// orgchart-specific items (Simulate, Import CSV, Clear/Reset) are only rendered
// on orgchart.html; all event-listener wiring remains in orgchart.html's own script.

(function () {
  const page = location.pathname.split('/').pop() || 'orgchart.html';

  function item(href, label, svgPath, opts = {}) {
    const isActive = href === page || (href === 'orgchart.html' && page === '');
    const cls = 'nav-item' + (isActive ? ' active' : '');
    const id  = opts.id    ? ` id="${opts.id}"` : '';
    const sty = opts.style ? ` style="${opts.style}"` : '';
    return `<a class="${cls}" href="${href}"${id}${sty}>${svgPath}${label}</a>`;
  }

  // ── SVG icons ──────────────────────────────────────────────────────────────
  const ico = {
    dashboard: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.5L8 2l6 4.5V14a1 1 0 01-1 1H3a1 1 0 01-1-1V6.5z"/><path d="M6 15v-5h4v5"/></svg>`,
    orgchart:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="3" r="1.8"/><circle cx="3" cy="12" r="1.8"/><circle cx="13" cy="12" r="1.8"/><line x1="8" y1="4.8" x2="3" y2="10.2"/><line x1="8" y1="4.8" x2="13" y2="10.2"/></svg>`,
    ai:        `<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1l1.5 3.5L13 6l-3.5 1.5L8 11l-1.5-3.5L3 6l3.5-1.5z"/><path d="M13 10l.8 1.8L15.5 12l-1.7.8L13 15l-.8-1.7L10.5 12l1.7-.8z" opacity="0.6"/></svg>`,
    directory: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.5"/><path d="M1 14c0-3 2-5 5-5"/><line x1="10" y1="7" x2="15" y2="7"/><line x1="10" y1="10" x2="15" y2="10"/><line x1="10" y1="13" x2="13" y2="13"/></svg>`,
    paybands:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="3" width="14" height="3" rx="1"/><rect x="1" y="8" width="10" height="3" rx="1"/><rect x="1" y="13" width="6" height="2" rx="1" opacity="0.5"/></svg>`,
    simulate:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2h4M7 2v4L3 13a1 1 0 00.9 1.5h8.2A1 1 0 0013 13L9 6V2"/><path d="M5 10.5h6" opacity="0.5"/></svg>`,
    snapshots: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><polyline points="8,4 8,8 11,10"/></svg>`,
    changelog: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h10M3 6h10M3 9h6M3 12h4"/><circle cx="13" cy="11.5" r="2.5"/><path d="M12.2 11.5l.8.8 1.5-1.5" stroke-width="1.3"/></svg>`,
    settings:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v1.5M8 13.5V15M1 8h1.5M13.5 8H15M3.05 3.05l1.06 1.06M11.89 11.89l1.06 1.06M3.05 12.95l1.06-1.06M11.89 4.11l1.06-1.06"/></svg>`,
    importcsv: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1v9M5 7l3 3 3-3"/><path d="M2 11v2a1 1 0 001 1h10a1 1 0 001-1v-2"/></svg>`,
    clearEmp:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="5" r="2.5"/><path d="M1 14c0-3 2-5 5-5h2"/><line x1="10" y1="10" x2="15" y2="15"/><line x1="15" y1="10" x2="10" y2="15"/></svg>`,
    clearStr:  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>`,
    clearData: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><polyline points="3,4 13,4"/><path d="M5 4V3a1 1 0 011-1h4a1 1 0 011 1v1"/><path d="M6 7v5M10 7v5"/><rect x="4" y="4" width="8" height="10" rx="1"/></svg>`,
    reset:       `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M1 1l14 14M1 8a7 7 0 0 1 12-4.9M15 8a7 7 0 0 1-12 4.9"/></svg>`,
    permissions: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1l5 2v4c0 3-2.2 5.5-5 6.5C5.2 12.5 3 10 3 7V3z"/><path d="M6 8l1.5 1.5L10 6" stroke-width="1.4"/></svg>`,
  };

  // ── Admin section: hrefs differ on orgchart vs other pages ────────────────
  const onOrgchart = page === 'orgchart.html' || page === '';

  const simulateHref  = onOrgchart ? '#' : 'orgchart.html';
  const snapshotsHref = onOrgchart ? '#' : 'orgchart.html#snapshots';
  const settingsHref  = onOrgchart ? '#' : 'orgchart.html#settings';

  const simulateId  = onOrgchart ? { id: 'simulate-nav-btn' }  : {};
  const snapshotsId = onOrgchart ? { id: 'snapshots-nav-btn' } : {};
  const settingsId  = onOrgchart ? { id: 'settings-nav-btn' }  : {};

  const danger = 'color:var(--danger,#e05252);';

  // ── orgchart-only admin items ──────────────────────────────────────────────
  const orgchartOnlyItems = onOrgchart ? `
      ${item('#', 'Import CSV',       ico.importcsv, { id: 'import-csv-btn' })}
      ${item('#', 'Clear Employees',  ico.clearEmp,  { id: 'clear-employees-btn', style: danger })}
      ${item('#', 'Clear Structure',  ico.clearStr,  { id: 'clear-structure-btn', style: danger })}
      ${item('#', 'Clear Data',       ico.clearData, { id: 'clear-data-btn',      style: danger })}
      ${item('#', 'Reset Data',       ico.reset,     { id: 'reset-data-btn',      style: danger })}` : '';

  // ── Full nav HTML ──────────────────────────────────────────────────────────
  const html = `
  <div id="nav-logo">
    <img src="/images/teampura-petrol-small.svg" alt="Teampura" class="nav-logo-img">
  </div>
  <div id="nav-body">
    <div class="nav-section">
      ${item('dashboard.html', 'Dashboard',    ico.dashboard)}
      ${item('orgchart.html',  'Org Chart',    ico.orgchart)}
      ${item('ai.html',        'AI Assistant', ico.ai)}
    </div>
    <div class="nav-section">
      <div class="nav-section-label">People</div>
      ${item('directory.html', 'Directory', ico.directory)}
      ${item('paybands.html',  'Pay Bands', ico.paybands)}
    </div>
    <div class="nav-spacer"></div>
    <div class="nav-section">
      <div class="nav-section-label">Admin</div>
      ${item(simulateHref,  'Simulate',  ico.simulate,  simulateId)}
      ${item(snapshotsHref, 'Snapshots', ico.snapshots, snapshotsId)}
      ${item('permissions.html', 'Permissions', ico.permissions)}
      ${item('changelog.html', 'Changelog', ico.changelog)}
      ${item(settingsHref,  'Settings',  ico.settings,  settingsId)}
      ${orgchartOnlyItems}
    </div>
  </div>
  <div id="nav-footer">
    <div class="nav-user-avatar">DM</div>
    <div class="nav-user-info">
      <div class="nav-user-name">David Miller</div>
      <div class="nav-user-role">HR Admin</div>
    </div>
  </div>`;

  // Script is placed immediately after <nav id="left-nav"> in each page,
  // so the element already exists when this runs synchronously.
  const nav = document.getElementById('left-nav');
  if (nav) nav.innerHTML = html;
})();
