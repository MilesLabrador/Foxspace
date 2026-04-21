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

let expandedSet   = new Set(); // workspace IDs currently showing their tabs
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
      // Auto-expand active workspace
      if (state.activeWorkspaceId) expandedSet.add(state.activeWorkspaceId);
      render();
      break;

    case 'workspaceSwitched':
      state.activeWorkspaceId = msg.workspaceId;
      expandedSet.add(msg.workspaceId);
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
  const list = document.getElementById('workspace-list');

  // Preserve scroll position
  const scrollTop = list.scrollTop;

  list.innerHTML = '';

  for (const ws of state.workspaces) {
    list.appendChild(buildWorkspaceRow(ws));

    if (expandedSet.has(ws.id)) {
      const wsTabs = tabsForWorkspace(ws.id);
      if (wsTabs.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'ws-empty';
        empty.textContent = 'No tabs';
        list.appendChild(empty);
      } else {
        for (const tab of wsTabs) {
          list.appendChild(buildTabRow(tab));
        }
      }
    }
  }

  list.scrollTop = scrollTop;
}

// ─── Workspace Row ────────────────────────────────────────────────────────────

function buildWorkspaceRow(ws) {
  const isActive   = ws.id === state.activeWorkspaceId;
  const isExpanded = expandedSet.has(ws.id);
  const tabCount   = tabsForWorkspace(ws.id).length;

  const row = document.createElement('div');
  row.className = [
    'workspace-row',
    isActive   ? 'is-active'   : '',
    isExpanded ? 'is-expanded' : '',
    ws.frozen  ? 'is-frozen'   : ''
  ].join(' ').trim();
  row.dataset.wsId = ws.id;
  row.role = 'listitem';
  row.title = `${ws.name} — ${tabCount} tab${tabCount !== 1 ? 's' : ''}`;

  // Color dot
  const colorDot = document.createElement('div');
  colorDot.className = 'ws-color';
  colorDot.style.background = ws.color;
  colorDot.title = 'Change color';
  colorDot.addEventListener('click', e => {
    e.stopPropagation();
    openColorPicker(ws, colorDot);
  });

  // Name (double-click to rename)
  const nameEl = document.createElement('div');
  nameEl.className = 'ws-name';
  nameEl.textContent = ws.name;
  nameEl.setAttribute('contenteditable', 'false');
  nameEl.addEventListener('dblclick', e => {
    e.stopPropagation();
    startRename(ws, nameEl);
  });

  // Tab count
  const countEl = document.createElement('span');
  countEl.className = 'ws-count';
  countEl.textContent = tabCount;

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'ws-actions';

  const freezeBtn = document.createElement('button');
  freezeBtn.className = 'ws-btn freeze' + (ws.frozen ? ' is-frozen' : '');
  freezeBtn.title = ws.frozen ? 'Unfreeze workspace' : 'Freeze workspace (suspend all tabs)';
  freezeBtn.innerHTML = '❄';
  freezeBtn.addEventListener('click', e => {
    e.stopPropagation();
    send({ type: 'freezeWorkspace', workspaceId: ws.id });
  });

  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'ws-btn delete';
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

  // Chevron
  const chevron = document.createElement('span');
  chevron.className = 'ws-chevron';
  chevron.innerHTML = '&#9658;'; // ▶

  row.append(colorDot, nameEl, countEl, actions, chevron);

  // ── Row click: switch or toggle expand ──
  row.addEventListener('click', () => {
    if (ws.id !== state.activeWorkspaceId) {
      send({ type: 'switchWorkspace', workspaceId: ws.id });
    } else {
      if (expandedSet.has(ws.id)) expandedSet.delete(ws.id);
      else expandedSet.add(ws.id);
      render();
    }
  });

  // ── Drag-over: drop tab onto workspace ──
  row.addEventListener('dragover', e => {
    if (draggedTabId == null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    row.classList.add('drag-over');
  });

  row.addEventListener('dragleave', () => row.classList.remove('drag-over'));

  row.addEventListener('drop', e => {
    e.preventDefault();
    row.classList.remove('drag-over');
    if (draggedTabId != null) {
      send({ type: 'moveTab', tabId: draggedTabId, workspaceId: ws.id });
      draggedTabId = null;
      document.getElementById('drag-hint').hidden = true;
    }
  });

  return row;
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
  if (!picker.hidden && !picker.contains(e.target) && !e.target.classList.contains('ws-color')) {
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

// ─── New Workspace Button ─────────────────────────────────────────────────────

document.getElementById('btn-add-workspace').addEventListener('click', () => {
  const name = prompt('Workspace name:', `Workspace ${state.workspaces.length + 1}`);
  if (name === null) return; // cancelled
  send({ type: 'createWorkspace', name: name.trim() || `Workspace ${state.workspaces.length + 1}` });
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

connectPort();
