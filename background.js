/**
 * Foxspace – background script
 * Manages workspace state, tab visibility, and messaging.
 */

const COLORS = [
  '#0060df', '#7c6fe0', '#d63535', '#e07c00',
  '#00b15a', '#00adc5', '#9b59b6', '#7a7a8a'
];

let workspaces = [];
let activeWorkspaceId = null;

// In-memory tabId → workspaceId map (source of truth during session)
const tabWsMap = {};

// Ports connected from sidebar panels (one per window)
const sidebarPorts = new Set();

// ─── Helpers ────────────────────────────────────────────────────────────────

function uid() {
  return 'ws_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
}

function makeWorkspace(name) {
  return {
    id: uid(),
    name: name || `Workspace ${workspaces.length + 1}`,
    color: COLORS[workspaces.length % COLORS.length],
    frozen: false,
    createdAt: Date.now()
  };
}

async function saveState() {
  await browser.storage.local.set({ workspaces, activeWorkspaceId });
}

function broadcast(msg) {
  for (const port of sidebarPorts) {
    try { port.postMessage(msg); } catch (_) {}
  }
}

async function tabsSnapshot() {
  const tabs = await browser.tabs.query({ currentWindow: true });
  return tabs.map(t => ({
    id:          t.id,
    title:       t.title,
    url:         t.url,
    favIconUrl:  t.favIconUrl,
    active:      t.active,
    hidden:      t.hidden,
    discarded:   t.discarded,
    pinned:      t.pinned
  }));
}

// ─── Visibility ──────────────────────────────────────────────────────────────

async function applyVisibility() {
  const tabs = await browser.tabs.query({ currentWindow: true });
  const toShow = [];
  const toHide = [];

  for (const tab of tabs) {
    if (tab.pinned) continue; // pinned tabs are always visible
    const wsId = tabWsMap[tab.id] ?? activeWorkspaceId;
    if (wsId === activeWorkspaceId) {
      if (tab.hidden) toShow.push(tab.id);
    } else {
      if (!tab.hidden) toHide.push(tab.id);
    }
  }

  if (toShow.length) await browser.tabs.show(toShow);
  if (toHide.length) await browser.tabs.hide(toHide);
}

// ─── Init ────────────────────────────────────────────────────────────────────

async function init() {
  const stored = await browser.storage.local.get(['workspaces', 'activeWorkspaceId']);

  if (stored.workspaces?.length) {
    workspaces = stored.workspaces;
    activeWorkspaceId = stored.activeWorkspaceId ?? workspaces[0].id;
  } else {
    const defaultWs = makeWorkspace('Default');
    workspaces = [defaultWs];
    activeWorkspaceId = defaultWs.id;
    await saveState();
  }

  // Reconcile existing tabs with stored workspace assignments
  const allTabs = await browser.tabs.query({ currentWindow: true });
  for (const tab of allTabs) {
    let wsId;
    try { wsId = await browser.sessions.getTabValue(tab.id, 'workspaceId'); } catch (_) {}
    if (wsId && workspaces.some(w => w.id === wsId)) {
      tabWsMap[tab.id] = wsId;
    } else {
      tabWsMap[tab.id] = activeWorkspaceId;
      try { await browser.sessions.setTabValue(tab.id, 'workspaceId', activeWorkspaceId); } catch (_) {}
    }
  }

  await applyVisibility();
  await rebuildContextMenu();
}

// ─── Workspace Operations ─────────────────────────────────────────────────────

async function switchWorkspace(wsId) {
  if (wsId === activeWorkspaceId) return;
  if (!workspaces.some(w => w.id === wsId)) return;

  activeWorkspaceId = wsId;
  await saveState();
  await applyVisibility();

  // Activate the first visible tab in the new workspace if none is active
  const visible = await browser.tabs.query({ currentWindow: true, hidden: false, active: false });
  const active  = await browser.tabs.query({ currentWindow: true, hidden: false, active: true });
  if (!active.length && visible.length) {
    await browser.tabs.update(visible[0].id, { active: true });
  }

  broadcast({ type: 'workspaceSwitched', workspaceId: wsId });
}

async function createWorkspace(name) {
  const ws = makeWorkspace(name);
  workspaces.push(ws);
  await saveState();
  await rebuildContextMenu();
  broadcast({ type: 'workspacesUpdated' });
  return ws;
}

async function renameWorkspace(wsId, name) {
  const ws = workspaces.find(w => w.id === wsId);
  if (!ws || !name.trim()) return;
  ws.name = name.trim();
  await saveState();
  await rebuildContextMenu();
  broadcast({ type: 'workspacesUpdated' });
}

async function setWorkspaceColor(wsId, color) {
  const ws = workspaces.find(w => w.id === wsId);
  if (!ws) return;
  ws.color = color;
  await saveState();
  broadcast({ type: 'workspacesUpdated' });
}

async function deleteWorkspace(wsId) {
  if (workspaces.length <= 1) return;
  const idx = workspaces.findIndex(w => w.id === wsId);
  if (idx === -1) return;

  // Reassign orphaned tabs to the first other workspace
  const fallback = workspaces.find(w => w.id !== wsId).id;
  const allTabs = await browser.tabs.query({ currentWindow: true });
  for (const tab of allTabs) {
    if (tabWsMap[tab.id] === wsId) {
      tabWsMap[tab.id] = fallback;
      try { await browser.sessions.setTabValue(tab.id, 'workspaceId', fallback); } catch (_) {}
    }
  }

  workspaces.splice(idx, 1);
  if (activeWorkspaceId === wsId) activeWorkspaceId = fallback;

  await saveState();
  await applyVisibility();
  await rebuildContextMenu();
  broadcast({ type: 'workspacesUpdated' });
}

async function moveTabToWorkspace(tabId, wsId) {
  if (!workspaces.some(w => w.id === wsId)) return;
  tabWsMap[tabId] = wsId;
  try { await browser.sessions.setTabValue(tabId, 'workspaceId', wsId); } catch (_) {}

  if (wsId !== activeWorkspaceId) {
    await browser.tabs.hide([tabId]);
  } else {
    await browser.tabs.show([tabId]);
  }

  broadcast({ type: 'workspacesUpdated' });
}

async function toggleFreezeWorkspace(wsId) {
  const ws = workspaces.find(w => w.id === wsId);
  if (!ws) return;

  ws.frozen = !ws.frozen;

  if (ws.frozen) {
    // Discard (suspend) all non-active tabs in this workspace
    const allTabs = await browser.tabs.query({ currentWindow: true });
    const targets = allTabs.filter(t => tabWsMap[t.id] === wsId && !t.active && !t.discarded);
    for (const tab of targets) {
      try { await browser.tabs.discard(tab.id); } catch (_) {}
    }
  }
  // Unfreeze: discarded tabs reload on next activation — nothing extra needed

  await saveState();
  broadcast({ type: 'workspacesUpdated' });
}

// ─── Tab Event Listeners ──────────────────────────────────────────────────────

browser.tabs.onCreated.addListener(async tab => {
  tabWsMap[tab.id] = activeWorkspaceId;
  try { await browser.sessions.setTabValue(tab.id, 'workspaceId', activeWorkspaceId); } catch (_) {}
  broadcast({ type: 'workspacesUpdated' });
});

browser.tabs.onRemoved.addListener(tabId => {
  delete tabWsMap[tabId];
  broadcast({ type: 'workspacesUpdated' });
});

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.title || changeInfo.favIconUrl || changeInfo.status === 'complete' || changeInfo.discarded != null) {
    broadcast({ type: 'tabUpdated', tabId });
  }
});

browser.tabs.onActivated.addListener(() => {
  broadcast({ type: 'tabUpdated' });
});

browser.tabs.onAttached.addListener(async tabId => {
  tabWsMap[tabId] = activeWorkspaceId;
  try { await browser.sessions.setTabValue(tabId, 'workspaceId', activeWorkspaceId); } catch (_) {}
  broadcast({ type: 'workspacesUpdated' });
});

// ─── Sidebar Port Messaging ───────────────────────────────────────────────────

browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'sidebar') return;

  sidebarPorts.add(port);
  port.onDisconnect.addListener(() => sidebarPorts.delete(port));

  port.onMessage.addListener(async msg => {
    switch (msg.type) {

      case 'getState': {
        const tabs = await tabsSnapshot();
        port.postMessage({
          type: 'state',
          workspaces,
          activeWorkspaceId,
          tabWsMap: { ...tabWsMap },
          tabs
        });
        break;
      }

      case 'switchWorkspace':
        await switchWorkspace(msg.workspaceId);
        break;

      case 'createWorkspace': {
        const ws = await createWorkspace(msg.name);
        port.postMessage({ type: 'workspaceCreated', workspace: ws });
        break;
      }

      case 'renameWorkspace':
        await renameWorkspace(msg.workspaceId, msg.name);
        break;

      case 'setWorkspaceColor':
        await setWorkspaceColor(msg.workspaceId, msg.color);
        break;

      case 'deleteWorkspace':
        await deleteWorkspace(msg.workspaceId);
        break;

      case 'moveTab':
        await moveTabToWorkspace(msg.tabId, msg.workspaceId);
        break;

      case 'freezeWorkspace':
        await toggleFreezeWorkspace(msg.workspaceId);
        break;

      case 'closeTab':
        await browser.tabs.remove(msg.tabId);
        break;

      case 'newTab':
        await browser.tabs.create({});
        break;

      case 'activateTab': {
        const wsId = tabWsMap[msg.tabId];
        if (wsId && wsId !== activeWorkspaceId) await switchWorkspace(wsId);
        await browser.tabs.update(msg.tabId, { active: true });
        break;
      }
    }
  });

  // Greet new sidebar with full state
  tabsSnapshot().then(tabs => {
    port.postMessage({
      type: 'state',
      workspaces,
      activeWorkspaceId,
      tabWsMap: { ...tabWsMap },
      tabs
    });
  });
});

// ─── Context Menu ─────────────────────────────────────────────────────────────

async function rebuildContextMenu() {
  await browser.contextMenus.removeAll();

  browser.contextMenus.create({
    id: 'foxspace-root',
    title: 'Move to Workspace',
    contexts: ['tab']
  });

  for (const ws of workspaces) {
    browser.contextMenus.create({
      id: 'foxspace-ws-' + ws.id,
      parentId: 'foxspace-root',
      title: ws.name,
      contexts: ['tab']
    });
  }

  browser.contextMenus.create({
    id: 'foxspace-sep',
    parentId: 'foxspace-root',
    type: 'separator',
    contexts: ['tab']
  });

  browser.contextMenus.create({
    id: 'foxspace-new',
    parentId: 'foxspace-root',
    title: 'New Workspace…',
    contexts: ['tab']
  });
}

browser.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId.startsWith('foxspace-ws-')) {
    const wsId = info.menuItemId.replace('foxspace-ws-', '');
    await moveTabToWorkspace(tab.id, wsId);
  } else if (info.menuItemId === 'foxspace-new') {
    const ws = await createWorkspace();
    await moveTabToWorkspace(tab.id, ws.id);
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

init();
