/**
 * Foxspace – sidebar script
 * Renders workspaces and tabs; handles all user interactions.
 */

'use strict';

// ─── State ────────────────────────────────────────────────────────────────────

let state = {
  workspaces:       [],
  activeWorkspaceId: null,
  tabWsMap:         {},
  tabs:             []
};

let draggedTabId  = null;
let colorPickerWsId = null;

const PALETTE = [
  '#0060df', '#7c6fe0', '#d63535', '#e07c00',
  '#00b15a', '#00adc5', '#9b59b6', '#7a7a8a'
];

// ─── Port ─────────────────────────────────────────────────────────────────────

let port = null;

function connectPort() {
  port = browser.runtime.connect({ name: 'sidebar' });
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener(() => {
    // Reconnect if background is still alive
    setTimeout(connectPort, 200);
  });
}

function send(msg) {
  try { port.postMessage(msg); } catch (_) {}
}

// ─── Message Handling ─────────────────────────────────────────────────────────

function handleMessage(msg) {
  switch (msg.type) {
    case 'state':
      state.workspaces        = msg.workspaces ?? [];
      state.activeWorkspaceId = msg.activeWorkspaceId;
      state.tabWsMap          = msg.tabWsMap ?? {};
      state.tabs              = msg.tabs ?? [];
      render();
      break;

    case 'workspaceSwitched':
      state.activeWorkspaceId = msg.workspaceId;
      send({ type: 'getState' });
      break;

    case 'workspacesUpdated':
    case 'tabUpdated':
      send({ type: 'getState' });
      break;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function tabsForWorkspace(wsId) {
  return state.tabs.filter(t => (state.tabWsMap[t.id] ?? state.activeWorkspaceId) === wsId);
}

// ─── Render ───────────────────────────────────────────────────────────────────

function render() {
  renderSwitcher();
  renderTabs();
}

// ─── Workspace Switcher ───────────────────────────────────────────────────────

function renderSwitcher() {
  const switcher = document.getElementById('workspace-switcher');
  switcher.innerHTML = '';
  for (const ws of state.workspaces) {
    switcher.appendChild(buildChip(ws));
  }
  updateArrows();
  // Scroll active chip into view
  const activeChip = switcher.querySelector('.ws-chip.is-active');
  if (activeChip) activeChip.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function buildChip(ws) {
  const isActive = ws.id === state.activeWorkspaceId;
  const tabCount = tabsForWorkspace(ws.id).length;

  const chip = document.createElement('div');
  chip.className = [
    'ws-chip',
    isActive  ? 'is-active' : '',
    ws.frozen ? 'is-frozen' : ''
  ].join(' ').trim();
  chip.dataset.wsId = ws.id;
  chip.role = 'tab';
  chip.title = `${ws.name} — ${tabCount} tab${tabCount !== 1 ? 's' : ''}`;

  // Color dot — click to change color
  const dot = document.createElement('div');
  dot.className = 'ws-chip-dot';
  dot.style.background = ws.color;
  dot.title = 'Change color';
  dot.addEventListener('click', e => {
    e.stopPropagation();
    openColorPicker(ws, dot);
  });

  // Name — double-click to rename
  const nameEl = document.createElement('span');
  nameEl.className = 'ws-chip-name';
  nameEl.textContent = ws.name;
  nameEl.setAttribute('contenteditable', 'false');
  nameEl.addEventListener('dblclick', e => {
    e.stopPropagation();
    startRename(ws, nameEl);
  });

  // Tab count
  const countEl = document.createElement('span');
  countEl.className = 'ws-chip-count';
  countEl.textContent = tabCount;

  // Action buttons (visible on hover / active)
  const actions = document.createElement('div');
  actions.className = 'ws-chip-actions';

  const freezeBtn = document.createElement('button');
  freezeBtn.className = 'ws-chip-btn freeze' + (ws.frozen ? ' is-frozen' : '');
  freezeBtn.title = ws.frozen ? 'Unfreeze workspace' : 'Freeze workspace';
  freezeBtn.textContent = '❄';
  freezeBtn.addEventListener('click', e => {
    e.stopPropagation();
    send({ type: 'freezeWorkspace', workspaceId: ws.id });
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'ws-chip-btn delete';
  deleteBtn.title = 'Delete workspace';
  deleteBtn.innerHTML = '&times;';
  deleteBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (state.workspaces.length <= 1) {
      alert('You must have at least one workspace.');
      return;
    }
    if (confirm(`Delete workspace "${ws.name}"?\n\nIts tabs will be moved to another workspace.`)) {
      send({ type: 'deleteWorkspace', workspaceId: ws.id });
    }
  });

  actions.append(freezeBtn, deleteBtn);
  chip.append(dot, nameEl, countEl, actions);

  // Click: switch workspace
  chip.addEventListener('click', () => {
    if (ws.id !== state.activeWorkspaceId) {
      send({ type: 'switchWorkspace', workspaceId: ws.id });
    }
  });

  // Drag-over: drop tab onto this workspace chip
  chip.addEventListener('dragover', e => {
    if (draggedTabId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    chip.classList.add('drag-over');
  });
  chip.addEventListener('dragleave', () => chip.classList.remove('drag-over'));
  chip.addEventListener('drop', e => {
    e.preventDefault();
    chip.classList.remove('drag-over');
    if (draggedTabId != null) {
      send({ type: 'moveTab', tabId: draggedTabId, workspaceId: ws.id });
      draggedTabId = null;
      document.getElementById('drag-hint').hidden = true;
    }
  });

  return chip;
}

// ─── Tab Pane ─────────────────────────────────────────────────────────────────

function renderTabs() {
  const list = document.getElementById('tab-list');
  const scrollTop = list.scrollTop;
  list.innerHTML = '';

  if (!state.activeWorkspaceId) {
    list.scrollTop = scrollTop;
    return;
  }

  const wsTabs     = tabsForWorkspace(state.activeWorkspaceId);
  const pinned     = wsTabs.filter(t => t.pinned);
  const regular    = wsTabs.filter(t => !t.pinned);

  if (wsTabs.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'ws-empty';
    empty.textContent = 'No tabs';
    list.appendChild(empty);
  } else {
    if (pinned.length > 0) {
      const label = document.createElement('div');
      label.className = 'tab-section-label';
      label.textContent = 'Pinned';
      list.appendChild(label);
      for (const tab of pinned) list.appendChild(buildTabRow(tab));
    }

    if (pinned.length > 0 && regular.length > 0) {
      const divider = document.createElement('div');
      divider.className = 'tab-section-divider';
      list.appendChild(divider);
    }

    for (const tab of regular) list.appendChild(buildTabRow(tab));
  }

  list.scrollTop = scrollTop;
}

// ─── Rename ───────────────────────────────────────────────────────────────────

function startRename(ws, nameEl) {
  nameEl.setAttribute('contenteditable', 'true');
  nameEl.focus();

  // Select all text
  const range = document.createRange();
  range.selectNodeContents(nameEl);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);

  function commit() {
    nameEl.setAttribute('contenteditable', 'false');
    const newName = nameEl.textContent.trim();
    if (newName && newName !== ws.name) {
      send({ type: 'renameWorkspace', workspaceId: ws.id, name: newName });
    } else {
      nameEl.textContent = ws.name; // revert
    }
    nameEl.removeEventListener('blur', commit);
    nameEl.removeEventListener('keydown', onKey);
  }

  function onKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') {
      nameEl.textContent = ws.name;
      nameEl.setAttribute('contenteditable', 'false');
      nameEl.removeEventListener('blur', commit);
      nameEl.removeEventListener('keydown', onKey);
    }
  }

  nameEl.addEventListener('blur', commit);
  nameEl.addEventListener('keydown', onKey);
}

// ─── Color Picker ─────────────────────────────────────────────────────────────

function openColorPicker(ws, anchor) {
  const picker = document.getElementById('color-picker');
  const grid   = document.getElementById('color-grid');

  if (!picker.hidden && colorPickerWsId === ws.id) {
    picker.hidden = true;
    colorPickerWsId = null;
    return;
  }

  colorPickerWsId = ws.id;
  grid.innerHTML = '';

  for (const color of PALETTE) {
    const swatch = document.createElement('button');
    swatch.className = 'color-swatch' + (color === ws.color ? ' is-selected' : '');
    swatch.style.background = color;
    swatch.title = color;
    swatch.addEventListener('click', () => {
      send({ type: 'setWorkspaceColor', workspaceId: ws.id, color });
      picker.hidden = true;
      colorPickerWsId = null;
    });
    grid.appendChild(swatch);
  }

  // Position below the dot
  const rect = anchor.getBoundingClientRect();
  picker.style.top  = (rect.bottom + 6) + 'px';
  picker.style.left = rect.left + 'px';
  picker.hidden = false;
}

document.addEventListener('click', e => {
  const picker = document.getElementById('color-picker');
  if (!picker.hidden && !picker.contains(e.target) && !e.target.classList.contains('ws-chip-dot')) {
    picker.hidden = true;
    colorPickerWsId = null;
  }
});

// ─── Tab Row ──────────────────────────────────────────────────────────────────

function buildTabRow(tab) {
  const row = document.createElement('div');
  row.className = [
    'tab-row',
    tab.active    ? 'is-active-tab' : '',
    tab.discarded ? 'is-discarded'  : ''
  ].join(' ').trim();
  row.dataset.tabId = tab.id;
  row.draggable = true;
  row.title = tab.url ?? '';

  // Favicon
  let faviconEl;
  if (tab.favIconUrl && !tab.favIconUrl.startsWith('chrome://')) {
    faviconEl = document.createElement('img');
    faviconEl.className = 'tab-favicon';
    faviconEl.src = tab.favIconUrl;
    faviconEl.alt = '';
    faviconEl.addEventListener('error', () => {
      const ph = document.createElement('div');
      ph.className = 'tab-favicon-placeholder';
      faviconEl.replaceWith(ph);
    });
  } else {
    faviconEl = document.createElement('div');
    faviconEl.className = 'tab-favicon-placeholder';
  }

  // Title
  const titleEl = document.createElement('span');
  titleEl.className = 'tab-title';
  titleEl.textContent = tab.title || 'New Tab';

  // Frozen badge
  const badge = document.createElement('span');
  badge.className = 'tab-freeze-badge';
  badge.textContent = tab.discarded ? '❄' : '';
  badge.title = tab.discarded ? 'Tab is frozen (will reload on click)' : '';

  // Close button
  const closeBtn = document.createElement('button');
  closeBtn.className = 'tab-close';
  closeBtn.title = 'Close tab';
  closeBtn.innerHTML = '&times;';
  closeBtn.addEventListener('click', e => {
    e.stopPropagation();
    send({ type: 'closeTab', tabId: tab.id });
  });

  row.append(faviconEl, titleEl, badge, closeBtn);

  // Activate on click
  row.addEventListener('click', () => {
    send({ type: 'activateTab', tabId: tab.id });
  });

  // Drag to move
  row.addEventListener('dragstart', e => {
    draggedTabId = tab.id;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(tab.id));
    row.classList.add('is-dragging');
    document.getElementById('drag-hint').hidden = false;
  });

  row.addEventListener('dragend', () => {
    draggedTabId = null;
    row.classList.remove('is-dragging');
    document.getElementById('drag-hint').hidden = true;
  });

  return row;
}

// ─── Switcher Arrows ──────────────────────────────────────────────────────────

function switcherStep(dir) {
  const idx  = state.workspaces.findIndex(ws => ws.id === state.activeWorkspaceId);
  const next = state.workspaces[idx + dir];
  if (next) send({ type: 'switchWorkspace', workspaceId: next.id });
}

function updateArrows() {
  const idx = state.workspaces.findIndex(ws => ws.id === state.activeWorkspaceId);
  document.getElementById('switcher-prev').disabled = idx <= 0;
  document.getElementById('switcher-next').disabled = idx >= state.workspaces.length - 1;
}

document.getElementById('switcher-prev').addEventListener('click', () => switcherStep(-1));
document.getElementById('switcher-next').addEventListener('click', () => switcherStep(1));

// ─── New Workspace Button ─────────────────────────────────────────────────────

document.getElementById('btn-add-workspace').addEventListener('click', () => {
  const name = prompt('Workspace name:', `Workspace ${state.workspaces.length + 1}`);
  if (name === null) return; // cancelled
  send({ type: 'createWorkspace', name: name.trim() || `Workspace ${state.workspaces.length + 1}` });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

connectPort();
