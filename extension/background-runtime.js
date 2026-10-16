import { SourceSession } from './session.js';
import { createRotationController } from './rotation-controller.js';
import * as taskStore from './task-store.js';
import { redact } from './recovery.js';
import { cleanChapter, ruleSignature, validateProfile } from './profiles.js';

const TYPE = 'manualdock:runtime';
const KEY = 'background-runtime-v1';
const ALARM = 'manualdock:recovery';
const METHODS = new Set([
  'initialize',
  'scanDirectory',
  'adopt',
  'refresh',
  'start',
  'captureCurrent',
  'pause',
]);

/** Owns running work. A panel is only a subscriber and may disappear at any time. */
export function createBackgroundRuntime({
  chrome,
  store = taskStore,
  createSession = (options) => new SourceSession(options),
  createRotation = createRotationController,
  timers = globalThis,
} = {}) {
  const sessions = new Map(),
    rotations = new Map();
  let writes = Promise.resolve(),
    heartbeat = null,
    lastSaved = '',
    restoring = true;
  const snapshot = (session) => {
    const { pages, ...metadata } = session.task || {};
    return {
      tabId: session.tabId,
      purpose: session.purpose,
      state: session.getState(),
      task: session.task ? metadata : null,
      profile: session.profile,
      draft: session.draft,
      busy: session.busy,
      initialized: session.initialized,
      connected: session.connected,
      closed: session.closed,
      deleted: session.deleted,
      error: session.error,
      title: session.title,
      address: session.address,
      operation: session.operation,
    };
  };
  const broadcast = (message) =>
    chrome.runtime.sendMessage({ type: TYPE + ':changed', ...message }).catch(() => {});
  function persist() {
    const value = {
      sources: [...sessions.values()]
        .filter((s) => !s.closed)
        .map((s) => ({
          tabId: s.tabId,
          purpose: s.purpose,
          taskId: s.task?.taskId,
          initialized: s.initialized,
        })),
      rotations: [...rotations]
        .filter(([tabId]) => sessions.has(tabId) && !sessions.get(tabId).closed)
        .map(([tabId, value]) => ({ tabId, ...value })),
    };
    const encoded = JSON.stringify(value);
    if (restoring || encoded === lastSaved) return writes;
    lastSaved = encoded;
    writes = writes.catch(() => {}).then(() => store.setSetting(KEY, value));
    return writes;
  }
  function keepActive() {
    const active =
      [...sessions.values()].some((s) => s.busy) ||
      [...rotations.values()].some((r) => r.state?.running);
    // Chrome may suspend an idle worker. Only active work keeps its context alive;
    // the alarm below restores persisted tasks after an unexpected worker restart.
    if (active && heartbeat === null)
      heartbeat = timers.setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
    if (!active && heartbeat !== null) {
      timers.clearInterval(heartbeat);
      heartbeat = null;
    }
  }
  const rotation = createRotation({
    chrome,
    onChange(tabId, state) {
      const previous = rotations.get(tabId) || {};
      rotations.set(tabId, { ...previous, state, resume: rotation.resumeData?.(tabId) || state });
      void persist().catch(report);
      keepActive();
      void broadcast({ rotation: { tabId, state } });
    },
  });
  function report(error) {
    console.warn('ManualDock background:', redact(error?.message || String(error)));
  }
  function ensure(tabId, purpose) {
    if (!Number.isInteger(tabId) || tabId <= 0 || !['document', 'rotation'].includes(purpose))
      throw new Error('来源参数无效');
    const existing = sessions.get(tabId);
    if (existing) {
      if (existing.purpose !== purpose) throw new Error('来源用途不一致，请使用独立标签页');
      return existing;
    }
    if ([...sessions.values()].filter((s) => !s.closed).length >= 8)
      throw new Error('最多同时连接 8 个来源；请关闭不用的来源标签页，或暂停后在工作台移除来源。');
    const session = createSession({
      tabId,
      purpose,
      onChange(_state, s) {
        keepActive();
        void persist().catch(report);
        void broadcast({ source: snapshot(s) });
      },
      onError: report,
    });
    sessions.set(tabId, session);
    return session;
  }
  async function connect(session) {
    try {
      await session.connect();
    } catch (error) {
      // Failed first connections must not occupy source slots across restarts.
      // This removes only the registration, never a saved task or chapter.
      if (
        sessions.get(session.tabId) === session &&
        !session.connected &&
        !session.task &&
        !session.busy
      ) {
        session.dispose();
        sessions.delete(session.tabId);
        await persist();
      }
      throw error;
    }
  }
  async function canRestoreBoundTask(taskId) {
    if (typeof taskId !== 'string' || !taskId.trim()) return false;
    const task = await store.loadTask(taskId);
    if (!task?.queue?.length || !task.profile) return false;
    const profile = validateProfile(task.profile);
    // Restore an existing archive without allowing initialization to detect a
    // replacement rule or discover an unfinished task's empty directory.
    if (!profile.tocSelector.trim()) return false;
    if (profile.contentSelector.trim()) return true;
    if (task.validation?.signature !== ruleSignature(profile)) return false;
    const samples = (profile.samples || []).map((sample) => cleanChapter(sample, profile));
    return samples.length === 2 && samples.every(Boolean) && samples[0].key !== samples[1].key;
  }
  const ready = (async () => {
    const saved = await store.getSetting(KEY);
    for (const descriptor of saved?.sources || []) {
      try {
        const session = ensure(descriptor.tabId, descriptor.purpose);
        await connect(session);
        if (
          session.purpose === 'document' &&
          (descriptor.initialized || (await canRestoreBoundTask(descriptor.taskId)))
        )
          await session.initialize({ taskId: descriptor.taskId });
      } catch (error) {
        report(error);
      }
    }
    for (const item of saved?.rotations || []) {
      if (!sessions.has(item.tabId)) continue;
      rotations.set(item.tabId, item);
      if (item.state?.running) await rotation.start(item.tabId, item.config, item.resume);
    }
    restoring = false;
    await persist();
    keepActive();
  })();
  async function request(message) {
    await ready;
    const { action, tabId } = message;
    if (action === 'list') return [...sessions.values()].map(snapshot);
    if (action === 'connect') {
      const session = ensure(tabId, message.purpose);
      if (!session.connected && !session.closed) await connect(session);
      await persist();
      return snapshot(session);
    }
    const session = sessions.get(tabId);
    if (!session) throw new Error('后台未找到此来源，请重新连接');
    if (action.startsWith('rotation:')) {
      if (session.purpose !== 'rotation') throw new Error('此来源不是轮换管理页');
      const method = action.slice(9);
      if (method === 'snapshot') return rotation.snapshot(tabId);
      if (method === 'config') return rotations.get(tabId)?.config || null;
      if (method === 'stop') {
        const result = await rotation.stop(tabId);
        await persist();
        return result;
      }
      if (method !== 'start') throw new Error('不支持的轮换操作');
      rotations.set(tabId, { config: message.config, state: { running: false } });
      const result = await rotation.start(tabId, message.config);
      await persist();
      return result;
    }
    if (action === 'remove') {
      if (session.busy || session.getState().canPause || (await rotation.snapshot(tabId)).running)
        throw new Error('来源仍在运行，请先暂停或停止');
      session.dispose();
      sessions.delete(tabId);
      rotations.delete(tabId);
      await persist();
      return true;
    }
    if (!METHODS.has(action) || session.purpose !== 'document') throw new Error('不支持的来源操作');
    // Collection is an acknowledged command, not a minutes-long message handler.
    // Closing or refreshing the sender cannot cancel the operation.
    if (action === 'start') {
      void session
        .start(...(message.args || []))
        .catch(report)
        .finally(keepActive);
    } else await session[action](...(message.args || []));
    keepActive();
    await persist();
    return snapshot(session);
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (
      message?.type !== TYPE ||
      sender.id !== chrome.runtime.id ||
      !sender.url?.startsWith(chrome.runtime.getURL('panel.html'))
    )
      return;
    request(message).then(
      (value) => respond({ value }),
      (error) => respond({ error: redact(error.message) }),
    );
    return true;
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    const session = sessions.get(tabId);
    if (session) void session.close().then(persist).catch(report);
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM) return;
    void ready
      .then(() =>
        Promise.all(
          [...sessions.values()]
            .filter((s) => s.purpose === 'document' && !s.busy && !s.closed)
            .map((s) => s.refresh()),
        ),
      )
      .catch(report);
  });
  void chrome.alarms.create(ALARM, { periodInMinutes: 1 });
  return { ready, request };
}
