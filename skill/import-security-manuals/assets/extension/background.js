import { createBackgroundRuntime } from './background-runtime.js';
createBackgroundRuntime({ chrome });
/** One workspace receives source tabs handed over through the extension action. */
const pendingSources = new Set();
let routing = Promise.resolve();
let openingWorkspaceId = null;
chrome.action.onClicked.addListener((tab) => {
  if (!Number.isInteger(tab.id) || tab.id <= 0) return;
  const route = async () => {
    const url = chrome.runtime.getURL('panel.html');
    let workspace;
    try {
      workspace = (await chrome.runtime.sendMessage({ type: 'manualdock:locate-workspace' }))
        ?.workspace;
    } catch {
      /* No workspace has registered yet. */
    }
    if (!workspace && openingWorkspaceId != null) {
      try {
        workspace = await chrome.tabs.get(openingWorkspaceId);
      } catch {
        openingWorkspaceId = null;
      }
    }
    pendingSources.add(tab.id);
    if (!workspace) {
      const created = await chrome.tabs.create({ url: url + '?tab=' + tab.id });
      openingWorkspaceId = created.id;
      return;
    }
    await chrome.tabs.update(workspace.id, { active: true });
    if (workspace.windowId != null)
      await chrome.windows.update(workspace.windowId, { focused: true });
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'manualdock:add-source',
        tabId: tab.id,
        workspaceTabId: workspace.id,
      });
      if (result?.accepted) pendingSources.delete(tab.id);
    } catch {
      /* The loading workspace takes the queue through its ready handshake. */
    }
  };
  routing = routing
    .then(route, route)
    .catch((error) => console.warn('ManualDock workspace:', error));
  return routing;
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id || message?.type !== 'manualdock:ready') return;
  openingWorkspaceId = sender.tab?.id ?? openingWorkspaceId;
  respond({ tabIds: [...pendingSources] });
  pendingSources.clear();
});
