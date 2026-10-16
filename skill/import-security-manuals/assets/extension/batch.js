import { SourceSession } from './session.js';
import { redact } from './recovery.js';
import { subscribeTasks } from './task-store.js';
import { resolveSourcePurpose } from './source-connector.js';

const MAX_SOURCES = 8;
const LABELS = {
  initializing: '正在识别',
  scanning: '正在扫描目录',
  ready: '准备就绪',
  connected: '已连接，请先识别与校准',
  needs_calibration: '待识别，请校准',
  running: '正在采集',
  paused: '已暂停',
  retry_wait: '等待自动重试',
  waiting_login: '等待重新登录',
  finished: '已处理当前发现的章节',
  closed: '来源已关闭',
  deleted: '任务已删除',
};

/** Renders source sessions; production proxies execute work in the background. */
export function setupBatch({
  initialTabId = null,
  restoreSources = async () => [],
  getDefaultPurpose = () => 'document',
  onError = () => {},
  onSelect = () => {},
  getSelected = () => null,
  onChange = () => {},
  onAdded = () => {},
  onRemoved = () => {},
  createSession = (options) => new SourceSession(options),
} = {}) {
  const $ = (id) => document.getElementById(id);
  const controls = {
    refresh: $('batch-connect'),
    start: $('batch-start-all'),
    pause: $('batch-pause-all'),
    status: $('batch-status'),
    list: $('batch-list'),
    previous: $('batch-prev'),
    next: $('batch-next'),
    page: $('batch-page'),
  };
  const sessions = new Map();
  const connections = new WeakMap();
  const listeners = [];
  let disposed = false;
  let page = 0;
  let pageSize = 2;
  const workspace = chrome.tabs.getCurrent().catch(() => null);
  const listen = (element, event, callback) => {
    if (!element) return;
    element.addEventListener(event, callback);
    listeners.push(() => element.removeEventListener(event, callback));
  };
  const status = (message) => {
    if (controls.status) controls.status.textContent = redact(message);
  };
  const report = (error, session) => {
    if (!session) status(error?.message || String(error));
    onError(error, session);
  };
  const isAttached = (session) =>
    !disposed && !session.disposed && sessions.get(session.tabId) === session;
  const canConnect = (session) => isAttached(session) && !session.closed;
  const canRemove = (session) => {
    const state = session.getState();
    return !state.busy && !state.canPause;
  };
  const sourceCount = () => [...sessions.values()].filter((s) => !s.closed && !s.disposed).length;
  function listSessions({ purpose } = {}) {
    return [...sessions.values()].filter((session) => !purpose || session.purpose === purpose);
  }
  async function removeSource(tabId) {
    const session = sessions.get(tabId);
    if (!session || disposed) return false;
    if (!canRemove(session)) throw new Error('此来源仍在运行，请先暂停或停止后再移除');
    // Keep the row until the background confirms removal. A rejected command
    // must not hide a source that still owns a slot or running work.
    if (session.remove) await session.remove();
    if (!isAttached(session)) return false;
    session.dispose();
    sessions.delete(tabId);
    onRemoved(session);
    render();
    return true;
  }
  function selectSource(tabId) {
    const session = sessions.get(tabId);
    if (!session || disposed) return;
    Promise.resolve(onSelect(session)).catch((error) => report(error, session));
  }
  function row(session) {
    const state = session.getState();
    const element = document.createElement('article');
    element.className = 'batch-item';
    element.dataset.tabId = String(session.tabId);
    element.dataset.selected = String(getSelected() === session);
    const line = (className, value) => {
      const text = document.createElement('div');
      text.className = className;
      text.textContent = redact(value || '');
      text.title = text.textContent;
      element.append(text);
      return text;
    };
    line('batch-title', state.product || `来源 ${session.tabId}`);
    line('batch-source', state.address);
    line(
      'batch-progress',
      `${LABELS[state.status] || state.status}${state.initialized && state.status !== 'needs_calibration' ? ` · 已保存 ${state.progress.captured}/${state.progress.total} 章${state.progress.issues ? ` · ${state.progress.issues} 章待核对` : ''}` : ''}`,
    );
    const error = line('batch-error', state.error);
    error.hidden = !state.error;
    const actions = document.createElement('div');
    actions.className = 'batch-actions';
    const button = (className, label, disabled, action) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.className = className;
      element.textContent = label;
      element.disabled = disabled;
      element.addEventListener('click', () =>
        Promise.resolve(action()).catch((error) => report(error, session)),
      );
      actions.append(element);
    };
    button('batch-current', '记录当前章', !(state.canCaptureCurrent ?? state.canStart), () =>
      session.captureCurrent(),
    );
    button(
      'batch-start primary',
      state.progress.captured ? '继续采集' : '采集整本',
      !state.canStart,
      () => session.start(),
    );
    button('batch-pause', '暂停', !state.canPause, () => session.pause());
    button(
      'batch-select',
      state.initialized && state.status !== 'needs_calibration' ? '查看与校准' : '识别与校准',
      false,
      () => selectSource(session.tabId),
    );
    button('batch-remove quiet', '移除', !canRemove(session), () => {
      if (
        !canRemove(session) ||
        !window.confirm('从工作台移除此来源？已保存的任务和章节仍保留在资料库，不会删除。')
      )
        return;
      return removeSource(session.tabId);
    });
    element.append(actions);
    return element;
  }
  function startableSessions() {
    const items = listSessions({ purpose: 'document' });
    const claimed = new Set(
      items
        .filter((session) => session.getState().canPause)
        .map((session) => session.getState().taskId)
        .filter(Boolean),
    );
    return items.filter((session) => {
      const state = session.getState();
      if (!state.canStartBatch || (state.taskId && claimed.has(state.taskId))) return false;
      if (state.taskId) claimed.add(state.taskId);
      return true;
    });
  }
  function render() {
    if (disposed || !controls.list) return;
    const items = listSessions({ purpose: 'document' });
    const states = items.map((session) => session.getState());
    const scanning = states.filter((state) =>
      ['scanning', 'initializing'].includes(state.status),
    ).length;
    const running = states.filter((state) => state.status === 'running').length;
    const ready = startableSessions();
    const unprepared = states.filter(
      (state) => !state.initialized || state.status === 'needs_calibration',
    ).length;
    status(
      items.length
        ? `${items.length} 个文档来源 · ${ready.length} 个可批量采集 · ${unprepared} 个待识别或校准 · ${scanning} 个扫描中 · ${running} 个采集中`
        : '在上方粘贴文档 URL 连接来源。连接后可识别目录或采集，不会自动启动。',
    );
    const height = controls.list.firstElementChild?.getBoundingClientRect().height || 0;
    const gap = parseFloat(window.getComputedStyle(controls.list).rowGap) || 0;
    if (height > 0 && controls.list.clientHeight > 0)
      pageSize = Math.max(1, Math.floor((controls.list.clientHeight + gap) / (height + gap)));
    const pages = Math.max(1, Math.ceil(items.length / pageSize));
    page = Math.min(page, pages - 1);
    controls.list.replaceChildren(...items.slice(page * pageSize, (page + 1) * pageSize).map(row));
    if (controls.page)
      controls.page.textContent = `${page + 1} / ${pages} · ${items.length} 个来源`;
    if (controls.previous) controls.previous.disabled = page === 0;
    if (controls.next) controls.next.disabled = page + 1 >= pages;
    if (controls.start) {
      controls.start.textContent = `开始已就绪（${ready.length}）`;
      controls.start.disabled = !ready.length;
      controls.start.title =
        '仅启动已识别、目录具备验证条件且有待采集章节的来源；同一任务只启动一次';
    }
    if (controls.pause)
      controls.pause.disabled = !items.some((session) => session.getState().canPause);
  }
  function connectSession(session, notifyAdded = false) {
    if (!canConnect(session)) return;
    const pending = connections.get(session);
    if (pending) return pending;
    // A replacement for the same tab owns a different connection and completion.
    const connection = Promise.resolve().then(async () => {
      if (!canConnect(session)) return;
      try {
        await session.connect();
      } catch (error) {
        if (!canConnect(session)) return;
        // A rejected registration is not a source. Remove only its local
        // placeholder; never send a remove command to the background owner.
        if (!session.connected && !session.task && !session.busy) {
          session.dispose();
          sessions.delete(session.tabId);
          onRemoved(session);
          render();
        }
        throw error;
      }
      if (!canConnect(session)) return;
      render();
      if (!canConnect(session)) return;
      if (notifyAdded) await onAdded(session);
      if (canConnect(session)) return session;
    });
    connections.set(session, connection);
    return connection.finally(() => {
      if (connections.get(session) === connection) connections.delete(session);
    });
  }
  async function addSource(tabId, { purpose = 'document' } = {}) {
    if (disposed || !Number.isInteger(tabId) || tabId <= 0) return;
    if (!['document', 'rotation'].includes(purpose)) throw new Error('不支持的来源用途');
    const tab = await chrome.tabs.get(tabId);
    if (disposed) return;
    if (!tab || tab.id !== tabId) throw new Error('无法读取来源标签页，请重新连接');
    const address = /^chrome-error:/i.test(tab.url || '') ? tab.pendingUrl : tab.url;
    purpose = resolveSourcePurpose(address, purpose);
    // Recheck identity and capacity after tabs.get: initial, ready and action can overlap.
    const existing = sessions.get(tabId);
    if (existing) {
      if (existing.purpose !== purpose)
        throw new Error('此标签页已用于其他用途，请使用独立标签页；已有来源用途不会自动更改');
      if (!canConnect(existing)) return;
      if (!existing.connected || connections.has(existing)) return connectSession(existing);
      return existing;
    }
    if (sourceCount() >= MAX_SOURCES) {
      status(
        `工作台最多同时连接 ${MAX_SOURCES} 个来源；请关闭不用的来源标签页，或暂停后移除来源。已保存章节会保留。`,
      );
      return;
    }
    const session = createSession({
      tabId,
      purpose,
      onChange: (_state, session) => {
        if (!isAttached(session)) return;
        render();
        onChange(session);
      },
      onError: (error, session) => {
        if (canConnect(session)) report(error, session);
      },
    });
    sessions.set(tabId, session);
    render();
    status(`已加入 ${sessions.size} 个来源。请保留来源页；任务由扩展后台执行。`);
    return connectSession(session, true);
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    listeners.splice(0).forEach((remove) => remove());
    sessions.forEach((session) => session.dispose());
  }
  const receive = (message, sender, respond) => {
    if (disposed || sender?.id !== chrome.runtime.id) return;
    if (message?.type === 'manualdock:locate-workspace') {
      workspace
        .then((current) =>
          respond({
            workspace: !disposed && current ? { id: current.id, windowId: current.windowId } : null,
          }),
        )
        .catch(() => respond({ workspace: null }));
      return true;
    }
    if (
      disposed ||
      sender?.id !== chrome.runtime.id ||
      message?.type !== 'manualdock:add-source' ||
      !Number.isInteger(message.tabId) ||
      message.tabId <= 0
    )
      return;
    workspace
      .then((current) => {
        if (disposed || !current || message.workspaceTabId !== current.id) {
          respond({ accepted: false });
          return;
        }
        return addSource(message.tabId, { purpose: getDefaultPurpose() }).then((session) =>
          respond({ accepted: Boolean(session) }),
        );
      })
      .catch((error) => {
        report(error);
        respond({ accepted: false });
      });
    return true;
  };
  chrome.runtime.onMessage.addListener(receive);
  listeners.push(() => chrome.runtime.onMessage.removeListener(receive));
  const removed = (tabId) => {
    const session = sessions.get(tabId);
    if (session) session.close().catch((error) => report(error, session));
  };
  chrome.tabs.onRemoved.addListener(removed);
  listeners.push(() => chrome.tabs.onRemoved.removeListener(removed));
  listeners.push(
    subscribeTasks((change) => {
      sessions.forEach((session) => {
        if (
          session.purpose === 'document' &&
          session.task?.taskId === change?.taskId &&
          !session.busy
        )
          session.refresh().catch((error) => report(error, session));
      });
    }),
  );
  listen(controls.refresh, 'click', () =>
    listSessions({ purpose: 'document' }).forEach((session) =>
      session.refresh().catch((error) => report(error, session)),
    ),
  );
  listen(controls.start, 'click', () =>
    startableSessions().forEach((session) =>
      session.start().catch((error) => report(error, session)),
    ),
  );
  listen(controls.pause, 'click', () =>
    listSessions({ purpose: 'document' }).forEach((session) => {
      if (session.getState().canPause) session.pause().catch((error) => report(error, session));
    }),
  );
  listen(controls.previous, 'click', () => {
    page = Math.max(0, page - 1);
    render();
  });
  listen(controls.next, 'click', () => {
    page++;
    render();
  });
  listen(window, 'resize', render);
  listen(window, 'pagehide', dispose);
  if (typeof ResizeObserver === 'function' && controls.list) {
    const observer = new ResizeObserver(render);
    observer.observe(controls.list);
    listeners.push(() => observer.disconnect());
  }
  render();
  if (Number.isInteger(initialTabId) && initialTabId > 0)
    addSource(initialTabId, { purpose: getDefaultPurpose() }).catch(report);
  const ready = workspace
    .then(() => chrome.runtime.sendMessage({ type: 'manualdock:ready' }))
    .then(async (response) => {
      if (disposed) return;
      for (const source of await restoreSources())
        await addSource(source.tabId, { purpose: source.purpose }).catch(report);
      for (const tabId of response?.tabIds || [])
        await addSource(tabId, { purpose: getDefaultPurpose() }).catch(report);
    })
    .catch(report);
  return {
    publish: render,
    dispose,
    addSource,
    removeSource,
    getSession: (tabId) => sessions.get(tabId),
    listSessions,
    canAddSource: () => sourceCount() < MAX_SOURCES,
    selectSource,
    ready,
  };
}
