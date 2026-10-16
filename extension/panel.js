import { renderLibrary, libraryPageSize } from './library-view.js';
import { setupBatch } from './batch.js';
import { setupSourceControls } from './source-controls.js';
import {
  createRemoteSession,
  createRemoteRotationController,
  listBackgroundSources,
} from './runtime-client.js';
import { parseArchive, mergeArchive } from './archive.js';
import {
  validateProfile,
  cleanChapter,
  jobKey,
  exportProfile,
  normalizeDocumentURL,
  reviseProfile,
  bindProfile,
  specificationURL,
  specificationTaskId,
  selectSavedProfile,
  ruleSignature,
} from './profiles.js';
import { classifyBind } from './bind-check.js';
import { redact, scheduleRecovery, savedChapterCount } from './recovery.js';
import { createTask, ImportEngine } from './engine.js';
import { createBrowserIO } from './browser-io.js';
import {
  saveTask,
  saveWholeTask,
  loadTask,
  listTasks,
  saveProfile,
  loadProfiles,
  setSetting,
  getSetting,
  listSettings,
  deleteSetting,
  deleteTask,
  subscribeTasks,
  restoreWholeTask,
} from './task-store.js';
import { buildExports, contentHash, hasMissingExamples } from './core.js';
import { parseSpecification } from './openapi.js';
import {
  RETRY_INTERVAL_MS,
  classifyRecoveryError,
  recoveryError,
  resetRetryableChapters,
  taskHasRetryableWork,
  resetInterruptedChapters,
  collectionMessage,
} from './recovery.js';
import { AutoRetryClock } from './auto-retry.js';
const $ = (id) => document.getElementById(id);
const rotationDrafts = new WeakMap();
const documentDrafts = new WeakMap();
const documentScans = new WeakSet();
const pendingDocumentResults = new WeakSet();
const rotationStates = new Map();
const normalRotationTabs = new Set();
let rotationController = null;
let tabId = Number(new URL(location.href).searchParams.get('tab')),
  io = createBrowserIO(tabId);
let batch = null,
  sourceControls = null,
  selectedSession = null,
  rotationSession = null,
  rotationSelectionPending = false,
  rotationSelectionGeneration = 0,
  selectionGeneration = 0,
  selectionPending = false,
  readOnlyTask = false,
  libraryPage = 0,
  chapterPage = 0,
  rotationPage = 0,
  selectedChapterKey = null;
let profile = null,
  task = null,
  engine = null,
  busy = false,
  mode = 'web',
  sourceOrigin = '',
  sourcePath = '/',
  rotationConfig = null,
  rotationVerified = false,
  rotationBusy = false,
  rotationPoll = null;
let initialized = false,
  heldTaskId = null,
  sampleSlots = [null, null],
  sampleProfileId = '',
  rotationTrialGeneration = 0;
let runGeneration = 0,
  detectionWarnings = [],
  lastWebTask = null;
const retryClock = new AutoRetryClock({
  getTask: () => (task?.autoRecovery?.sourceTabId === tabId ? task : null),
  retry: retryAutomatically,
  onError: error,
});
const labels = {
  needs_calibration: '待识别或需校准',
  retry_wait: '等待自动重试',
  ready: '准备就绪',
  running: '正在采集',
  paused: '已暂停',
  waiting_login: '等待重新登录',
  finished: '已处理当前发现的章节',
  pending: '待处理',
  processing: '读取中',
  captured: '已采集',
  review: '待核对',
  failed: '失败',
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function showMode(value) {
  if (
    value === 'web' &&
    selectedSession &&
    pendingDocumentResults.has(selectedSession) &&
    !busy &&
    !selectionPending &&
    !readOnlyTask
  ) {
    applyDocumentResult(selectedSession);
    $('product').value = task?.product || '';
    $('version').value = task?.version || '';
    render();
  }
  if (mode !== value) {
    $('source-url').value = '';
    clearError();
  }
  if (
    value === 'web' &&
    !task &&
    !profile &&
    selectedSession?.task &&
    !busy &&
    !selectionPending &&
    !readOnlyTask
  ) {
    task = selectedSession.task;
    profile = selectedSession.profile;
    if (profile) populateProfile();
    if (!$('product').value) $('product').value = task.product || '';
    if (!$('version').value) $('version').value = task.version || '';
    render();
  }
  document.querySelector('.app').dataset.currentMode = value;
  if (mode === 'web' && value !== 'web' && task?.sourceKind === 'web') lastWebTask = task;
  if (
    value === 'web' &&
    !busy &&
    task?.sourceKind === 'openapi' &&
    lastWebTask &&
    lastWebTask.profileId === profile?.id
  ) {
    task = lastWebTask;
    $('product').value = task.product;
    $('version').value = task.version;
    render();
    refreshRetryClock();
  }
  if (
    value === 'web' &&
    selectedSession &&
    !busy &&
    !selectionPending &&
    !readOnlyTask &&
    task?.taskId &&
    task.taskId === selectedSession.task?.taskId
  ) {
    refreshProfileInputs(profile, selectedSession.profile);
    task = selectedSession.task;
    profile = selectedSession.profile;
    render();
  }
  mode = value;
  document
    .querySelectorAll('[data-panel]')
    .forEach((el) => (el.hidden = el.dataset.panel !== value));
  document.querySelectorAll('[data-mode]').forEach((el) => {
    if (el.dataset.mode === value) el.setAttribute('aria-current', 'page');
    else el.removeAttribute('aria-current');
  });
  $('document-meta').hidden = !['web', 'spec'].includes(value);
  $('export-step').hidden = value !== 'web';
  if (value === 'web' && !profile) showOperation('identify');
  sourceControls?.refresh();
  renderConnection();
}
// Every message shown in the console goes through redact(): a URL token or an
// Authorization header carried in an exception must never reach the UI.
function error(e) {
  $('error').textContent = redact(e.message || String(e));
  $('error').hidden = !$('error').textContent.trim();
}
function clearError() {
  $('error').textContent = '';
  $('error').hidden = true;
}
function previewText(page) {
  const note = (label) => '[图片：' + (label?.trim() || '未命名图片') + '，导出离线HTML可查看]';
  return String(page.markdown || page.text || '')
    .replace(/!\[((?:\\.|[^\]])*)\]\(\s*<?data:image\/[^)]+\)/gi, (_match, label) =>
      note(label.replace(/\\([\[\]\\])/g, '$1')),
    )
    .replace(/<img\b[^>]*>/gi, (tag) =>
      /\bsrc\s*=\s*["']?data:image\//i.test(tag)
        ? note(tag.match(/\balt\s*=\s*(["'])(.*?)\1/i)?.[2])
        : tag,
    )
    .replace(/data:image\/[^\s"'<>)]*/gi, note('内嵌图片'));
}
function render() {
  const sourceBusy = busy || selectionPending || Boolean(selectedSession?.busy);
  const queue = task?.queue || [];
  for (const [id, value] of Object.entries({
    found: queue.length,
    captured: queue.filter((c) => c.status === 'captured').length,
    remaining: queue.filter((c) => ['pending', 'processing', 'waiting_login'].includes(c.status))
      .length,
    issues: queue.filter((c) => ['failed', 'review'].includes(c.status)).length,
  }))
    $(id).textContent = value;
  $('status').textContent = task
    ? (labels[task.status] || task.status) +
      (queue.find((c) => c.status === 'processing')
        ? ' · ' + queue.find((c) => c.status === 'processing').title
        : '')
    : selectedSession
      ? '已连接，待识别'
      : chrome.runtime?.onMessage
        ? '尚未连接文档页'
        : '准备就绪';
  if (selectedSession?.getState().status === 'needs_calibration')
    $('status').textContent = '待识别或需校准';
  if (selectedSession?.getState().status === 'scanning')
    $('status').textContent = '正在扫描目录，可切换或连接其他来源';
  renderChapters(queue);
  $('diagnostics').textContent = JSON.stringify(
    {
      recognition: detectionWarnings,
      warnings: task?.discoveryWarnings || [],
      scan: task?.scanDiagnostics || {},
    },
    null,
    2,
  );
  const last = task?.pages?.[selectedChapterKey] || Object.values(task?.pages || {}).at(-1);
  if (last) $('preview').textContent = previewText(last);
  document
    .querySelectorAll(
      '[data-panel="web"] button,[data-panel="web"] input,[data-panel="web"] select',
    )
    .forEach(
      (el) =>
        (el.disabled =
          !el.matches('[data-close-dialog],#collection-message') &&
          (sourceBusy ||
            readOnlyTask ||
            (!el.matches('[data-operation]') &&
              (!initialized ||
                (!profile &&
                  ![
                    'detect',
                    'scan',
                    'import-profile',
                    'open-calibration',
                    'pick-toc',
                    'pick-content',
                  ].includes(el.id)))))),
    );
  document
    .querySelectorAll('#product,#version,[data-panel="spec"] input,[data-panel="spec"] button')
    .forEach((el) => (el.disabled = busy || (mode === 'web' && Boolean(selectedSession?.busy))));
  renderRotationControls();
  renderErrorLog();
  $('pause').disabled =
    readOnlyTask ||
    selectionPending ||
    (selectedSession
      ? (!documentScans.has(selectedSession) && task?.taskId !== selectedSession.task?.taskId) ||
        !selectedSession.getState().canPause
      : !engine?.running && !task?.autoRecovery?.enabled);
  renderRecognition(queue);
  const scanning = selectedSession?.operation === 'scanning';
  $('cancel-scan').hidden = !scanning;
  $('cancel-scan').disabled = !scanning;
  $('open-calibration').hidden = Boolean(scanning);
  if (scanning) {
    $('recognition-message').textContent =
      '正在读取目录；已加载的目录直接读取，未加载分支的展开等待上限为 12 秒。可停止本次扫描。';
    $('recognition-message').dataset.state = 'waiting';
  }
  $('scan').title =
    task?.scanDiagnostics?.pendingBranches > 0
      ? '展开尚未加载的分支；展开等待上限为 12 秒，可暂停'
      : '快速读取已加载目录；尚未识别时自动识别';
  $('error').hidden = !$('error').textContent.trim();
  const message = collectionMessage(
    task,
    task?.taskId === selectedSession?.task?.taskId ? selectedSession?.getState().error : '',
  );
  $('collection-message').textContent = message ? `查看详情 › ${message}` : '';
  $('collection-message').title = message;
  $('retry-status').hidden = Boolean(message);
  $('collection-message').hidden = !message;
  $('issues').title =
    `${queue.filter((c) => c.status === 'failed').length} 章失败，${queue.filter((c) => c.status === 'review').length} 章正文待核对`;
  const recovery = task?.autoRecovery;
  $('retry-status').textContent = recovery?.enabled
    ? recovery.nextAttemptAt
      ? `等待恢复 · 下次 ${new Date(recovery.nextAttemptAt).toLocaleTimeString()} · 已尝试 ${recovery.attempts || 0} 次${task.recovery?.reason === 'auth' ? ' · 请在原标签页重新登录' : ''}`
      : '已启用断线恢复；短暂异常先快速重试，连续失败逐步延长至 3 分钟。'
    : message
      ? '已保存正文保留；可在右侧“章节目录”查看各章结果。'
      : '采集在后台运行；保留原手册页，可刷新或关闭控制页。';
  document.querySelectorAll('[data-export]').forEach((el) => (el.disabled = !task?.queue.length));
  if (selectedSession) batch?.publish();
  sourceControls?.refresh();
}
function canResumeSelectedDraft() {
  const session = selectedSession;
  if (
    !session?.getState().canResume ||
    task?.taskId !== session.task?.taskId ||
    !sameProfileRevision(profile, session.profile)
  )
    return false;
  const candidate = {
    ...profile,
    pathPrefix: $('scope').value.trim(),
    tocSelector: $('toc-selector').value.trim(),
    contentSelector: $('content-selector').value.trim(),
    hashMode: $('hash-mode').value,
  };
  return (
    ruleSignature(candidate) === ruleSignature(session.profile) &&
    JSON.stringify(sampleSlots.filter(Boolean)) === JSON.stringify(session.profile.samples || []) &&
    JSON.stringify(profile.samples || []) === JSON.stringify(session.profile.samples || []) &&
    ($('product').value.trim() || profile.name) === session.task.product &&
    ($('version').value.trim() || '未知') === session.task.version
  );
}
function renderRecognition(queue) {
  const toc = Boolean(profile?.tocSelector),
    body = Boolean(profile?.contentSelector),
    count = queue.length,
    hasSamples = profile?.samples?.length >= 2;
  $('directory-state').textContent = count ? `${count} 个章节` : toc ? '未找到章节' : '未识别';
  $('article-state').textContent = body ? '已定位' : '默认提取 · 待核对';
  const warnings = [
    ...new Set([selectedSession?.error, ...detectionWarnings, ...(task?.discoveryWarnings || [])]),
  ].filter(
    (message) =>
      Boolean(message) &&
      !(toc && /未自动识别目录/.test(message)) &&
      !(body && /未自动识别正文/.test(message)),
  );
  let message = '识别完成，可开始采集。',
    state = 'ready';
  if (!initialized) {
    message =
      chrome.runtime?.onMessage && !selectedSession
        ? '尚未连接文档页，请在顶部粘贴文档 URL 并连接。'
        : '正在检查目录与正文…';
    state = 'waiting';
  } else if (!profile) {
    message = '尚未识别此页面，可点击“快速识别目录”或“手动校准”选择区域。';
    state = 'attention';
  } else if (!toc) {
    message = '未识别目录，请在下方手动选择目录区域。';
    state = 'attention';
  } else if (!count || (count < 2 && !hasSamples)) {
    message = count
      ? '当前只找到一个章节；请检查目录范围，至少需要两章验证。'
      : '未找到可采集章节，请选择正确目录并重新扫描。';
    state = 'attention';
  } else if (!body) {
    message = '正文将使用默认区域提取，请核对预览；开始时仍会验证两章。不准确时手动选择正文区域。';
    state = 'attention';
  } else if (warnings.length) {
    message = '有识别提示，请核对目录与正文后开始。';
    state = 'attention';
  }
  $('recognition-message').textContent = [message, ...warnings].join(' ');
  $('recognition-message').dataset.state = state;
  if (initialized && profile && (!toc || !body || count < 2)) $('calibration').open = true;
  // Validation samples prove extraction, not that the current directory has chapters.
  if (!toc || !count || (count < 2 && !hasSamples)) $('start').disabled = true;
  if (!count) $('retry').disabled = true;
  if (selectedSession?.draft) {
    if (!canResumeSelectedDraft()) {
      $('start').disabled = true;
      $('retry').disabled = true;
    }
    $('capture-current').disabled = true;
  }
  $('start').textContent = canResumeSelectedDraft()
    ? '重新检查并继续采集'
    : task?.pages && Object.keys(task.pages).length
      ? '继续采集'
      : '开始采集';
}
function populateProfile() {
  if (!profile) return;
  if (sampleProfileId !== profile.id) {
    sampleProfileId = profile.id;
    sampleSlots = [profile.samples[0] || null, profile.samples[1] || null];
  }
  $('scope').value = profile.pathPrefix;
  $('toc-selector').value = profile.tocSelector;
  $('content-selector').value = profile.contentSelector;
  $('hash-mode').value = profile.hashMode;
  renderSamples();
  $('profile-status').textContent =
    `${profile.adapterId === 'sangfor' ? '内置树目录适配' : '通用识别'} · ${profile.name}`;
}
function renderSamples() {
  $('samples').textContent = sampleSlots.some(Boolean)
    ? sampleSlots
        .map((chapter, index) => `${index ? 'B' : 'A'}：${chapter?.title || '尚未选择'}`)
        .join('；')
    : '尚未选择示例章节；开始时会使用目录中的前两章验证';
}
const profileFields = {
  scope: 'pathPrefix',
  toc: 'tocSelector',
  content: 'contentSelector',
  hashMode: 'hashMode',
};
const profileInputs = {
  scope: 'scope',
  toc: 'toc-selector',
  content: 'content-selector',
  hashMode: 'hash-mode',
};
function sameProfileRevision(previous, next) {
  return previous && next && previous.id === next.id && previous.revision === next.revision;
}
function refreshDocumentDraft(session) {
  const draft = documentDrafts.get(session);
  if (
    !draft ||
    draft.task?.taskId !== session.task?.taskId ||
    !sameProfileRevision(draft.profile, session.profile)
  )
    return;
  // Repair only fields that still contain the previous confirmed value. Keep
  // unsaved calibration and product/version edits separate from worker updates.
  for (const [field, key] of Object.entries(profileFields))
    if (draft[field].trim() === draft.profile[key]) draft[field] = session.profile[key];
  if (!draft.samplesEdited) draft.samples = [...session.profile.samples];
  draft.profile = session.profile;
  draft.task = session.task;
}
function refreshProfileInputs(previous, next) {
  if (!sameProfileRevision(previous, next)) return;
  for (const [field, key] of Object.entries(profileFields)) {
    const input = $(profileInputs[field]);
    if (input.value.trim() === previous[key]) input.value = next[key];
  }
  if (JSON.stringify(sampleSlots.filter(Boolean)) === JSON.stringify(previous.samples)) {
    sampleSlots = [next.samples[0] || null, next.samples[1] || null];
    renderSamples();
  }
}
function syncTaskProfile() {
  if (task?.profileId === profile?.id && task?.profileRevision === profile?.revision)
    task.profile = JSON.parse(JSON.stringify(profile));
}
function currentProfile() {
  if (!profile) throw new Error('请先识别或导入规则');
  const next = reviseProfile(profile, {
    pathPrefix: $('scope').value.trim(),
    tocSelector: $('toc-selector').value.trim(),
    contentSelector: $('content-selector').value.trim(),
    hashMode: $('hash-mode').value,
  });
  const changed = next.id !== profile.id;
  profile = next;
  if (changed) {
    task = null;
    populateProfile();
  }
  syncTaskProfile();
  return profile;
}

async function locked(action, { source = true, initialization = false } = {}) {
  if (
    busy ||
    selectionPending ||
    (source && selectedSession?.busy) ||
    (source && !initialized && !initialization)
  )
    return;
  let succeeded = false;
  busy = true;
  clearError();
  render();
  try {
    await navigator.locks.request(
      source ? `source-tab:${tabId}` : 'local-spec-import',
      { ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error('另一个控制页正在使用这个标签页，请先暂停');
        await action();
        succeeded = true;
      },
    );
  } catch (e) {
    error(e);
  } finally {
    busy = false;
    if (
      succeeded &&
      source &&
      selectedSession &&
      !selectedSession.draft &&
      task?.sourceKind === 'web' &&
      profile &&
      task.profileId === profile.id &&
      task.profileRevision === profile.revision
    ) {
      await selectedSession.adopt(task, profile);
    }
    render();
  }
}
async function ensureTask({ reload = false, recover = false } = {}) {
  profile = currentProfile();
  const product = $('product').value.trim() || profile.name,
    version = $('version').value.trim() || '未知';
  const id = jobKey(profile, product, version);
  if (task?.taskId !== id || reload) {
    const saved = await loadTask(id);
    if (saved) task = saved;
    else {
      const deleted = await getSetting('deleted-task:' + id);
      if (task?.taskId === id && (deleted || task.storageRevision))
        throw new Error('任务已删除，请重新识别以建立新任务；原任务不会自动恢复');
      if (deleted) {
        profile = validateProfile({ ...profile, id: crypto.randomUUID(), revision: 1 });
        populateProfile();
      }
      task = createTask(profile, product, version);
    }
  }
  if (recover) {
    if (task.status === 'running') task.status = 'paused';
    for (const c of task.queue) if (c.status === 'processing') c.status = 'pending';
  }
  syncTaskProfile();
  return task;
}
async function withTaskLock(action) {
  await ensureTask();
  const id = task.taskId;
  if (heldTaskId === id) return action();
  if (heldTaskId) throw new Error('采集中不能切换规则');
  return navigator.locks.request('task:' + id, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('这份手册正在另一个控制页采集');
    heldTaskId = id;
    try {
      await ensureTask({ reload: true, recover: true });
      return await action();
    } finally {
      heldTaskId = null;
    }
  });
}

async function scan({ quick = false } = {}) {
  return withTaskLock(async () => {
    engine = new ImportEngine(task, {
      discover: (p) => io.discover(p, { expand: !quick }),
      capture: io.capture,
      save: saveTask,
      onChange: render,
    });
    try {
      await engine.scan();
    } catch (failure) {
      task.status = 'needs_calibration';
      render();
      throw failure;
    }
    render();
    return task.queue;
  });
}
function applyDocumentResult(session) {
  const result = session.draft || session;
  task = result.task;
  profile = result.profile;
  detectionWarnings = result.warnings || task?.discoveryWarnings || [];
  if (profile) populateProfile();
  pendingDocumentResults.delete(session);
}

/** Directory work belongs to the source, not the currently visible panel. */
async function scanSelected({ detect: shouldDetect = false, expand = false } = {}) {
  const session = selectedSession;
  if (!session) return locked(shouldDetect ? detect : () => scan({ quick: !expand }));
  if (busy || selectionPending || readOnlyTask || session.busy) return;
  shouldDetect ||= !profile;
  const inputProfile = shouldDetect ? null : currentProfile();
  const product = $('product').value.trim();
  const version = $('version').value.trim();
  documentDrafts.delete(session);
  documentScans.add(session);
  clearError();
  try {
    const scanning = session.scanDirectory({
      detect: shouldDetect,
      profile: inputProfile,
      product,
      version,
      expand,
    });
    render();
    await scanning;
  } catch {
    // The session retains its error for this source's row and calibration view.
  } finally {
    documentScans.delete(session);
    pendingDocumentResults.add(session);
    if (
      selectedSession === session &&
      !selectionPending &&
      !busy &&
      !readOnlyTask &&
      task?.sourceKind !== 'openapi'
    ) {
      applyDocumentResult(session);
      render();
    }
  }
}

async function previewCurrent({
  sourceIO = io,
  sourceProfile = profile,
  sourceTabId = tabId,
  isCurrent = () => true,
} = {}) {
  const current = await sourceIO.tab();
  if (!isCurrent()) return;
  await sourceIO.install();
  if (!isCurrent()) return;
  const result = await chrome.scripting.executeScript({
    target: { tabId: sourceTabId },
    args: [
      {
        entry: sourceProfile.entry,
        profile: sourceProfile,
        selector: sourceProfile.contentSelector,
        expectedURL: current.url,
        previewOnly: true,
      },
    ],
    func: (opts) => globalThis.ManualCapture.capture(opts),
  });
  const page = result[0]?.result;
  if (isCurrent() && ['ok', 'preview'].includes(page?.status))
    $('preview').textContent = previewText(page);
}

async function detect() {
  detectionWarnings = [];
  const result = await io.detect();
  detectionWarnings = result.warnings || [];
  const candidate = validateProfile(result.profile);
  const matches = [...(await loadProfiles()), ...(task?.profile ? [task.profile] : [])].filter(
    (saved) => ruleSignature(saved) === ruleSignature(candidate),
  );
  const selected = selectSavedProfile(candidate.entry, matches, await listTasks());
  profile = selected.profile ||
    matches[0] || { ...candidate, id: crypto.randomUUID(), revision: 1, samples: [] };
  task = selected.task || null;
  readOnlyTask = false;
  populateProfile();
  await scan({ quick: true });
  await previewCurrent();
}
/** Manual region picking needs a source address, not a successful automatic scan. */
async function ensureCalibrationProfile() {
  if (profile) return;
  const current = await io.tab();
  const url = new URL(current.url);
  profile = validateProfile({
    schemaVersion: 1,
    adapterId: 'generic',
    name: current.title || url.hostname,
    entry: url.href,
    pathPrefix: url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/',
    hashMode: /^#!?\//.test(url.hash) ? 'route' : url.hash ? 'anchor' : 'none',
    queryKeys: [...new Set(url.searchParams.keys())],
    tocSelector: '',
    contentSelector: '',
    samples: [],
  });
  task = null;
  populateProfile();
}
async function selectRegion(kind) {
  await ensureCalibrationProfile();
  const control = await chrome.tabs.getCurrent();
  await chrome.tabs.update(tabId, { active: true });
  let picked;
  try {
    picked = await io.pick(kind, currentProfile());
  } finally {
    if (control?.id) await chrome.tabs.update(control.id, { active: true });
  }
  if (!picked) throw new Error('未选择页面区域');
  if (kind === 'toc' || kind === 'content') {
    profile = {
      ...currentProfile(),
      id: crypto.randomUUID(),
      revision: 1,
      samples: [],
      [kind === 'toc' ? 'tocSelector' : 'contentSelector']: picked.selector,
    };
    if (picked.frameSelector) profile.frameSelector = picked.frameSelector;
    else delete profile.frameSelector;
    populateProfile();
    task = null;
  }
  return picked;
}
async function sample(index) {
  const picked = await selectRegion('sample');
  const chapter = cleanChapter(picked, currentProfile());
  if (!chapter) throw new Error('所选章节不在当前手册范围内，请重新识别或检查范围');
  sampleSlots[index] = chapter;
  profile = { ...profile, samples: sampleSlots.every(Boolean) ? [...sampleSlots] : [] };
  syncTaskProfile();
  populateProfile();
}
async function verifyAndSave(shouldContinue = () => true) {
  if (!shouldContinue()) throw recoveryError('采集已暂停', 'CANCELLED');
  profile = currentProfile();
  if (sampleSlots.some(Boolean) && !sampleSlots.every(Boolean))
    throw new Error('请补选另一个示例章节 A 或 B');
  if (sampleSlots.every(Boolean)) profile.samples = [...sampleSlots];
  if (profile.samples.length < 2) {
    const queue = task?.queue?.length >= 2 ? task.queue : await scan({ quick: true });
    if (queue.length < 2) throw new Error('需要两个不同章节来验证规则，请点选示例A和B');
    profile.samples = queue.slice(0, 2).map((c) => cleanChapter(c, profile));
  }
  sampleSlots = [...profile.samples];
  syncTaskProfile();
  $('profile-status').textContent = '正在打开两个示例，核对正文切换…';
  if (!shouldContinue()) throw recoveryError('采集已暂停', 'CANCELLED');
  const result = await io.verifySamples(profile, { shouldContinue });
  if (result?.verified !== true) throw new Error('两个示例章节尚未验证成功，请检查正文区域');
  await saveProfile(profile);
  if (task) {
    task.validation = { signature: ruleSignature(profile), verifiedAt: new Date().toISOString() };
    await saveTask(task);
  }
  populateProfile();
  $('profile-status').textContent = '两个示例验证通过，规则已保存';
  $('preview').textContent = result.previews
    .map((p) => p.title + '\n' + previewText(p))
    .join('\n\n────────\n\n');
}
async function isRotating() {
  await io.install();
  const r = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      running: Boolean(
        globalThis.SecurityNavigationRotation?.snapshot().running ||
        globalThis.SangforMenuRotation?.snapshot().running,
      ),
    }),
  });
  return r[0]?.result?.running;
}
function refreshRetryClock() {
  if (!retryClock.running) retryClock.refresh();
}
async function pauseImport() {
  runGeneration++;
  retryClock.dispose();
  engine?.pause();
  const current = task;
  if (!current) return;
  current.autoRecovery = { ...current.autoRecovery, enabled: false, nextAttemptAt: null };
  $('status').textContent = engine?.running ? '将在当前章节保存后暂停…' : '已暂停自动恢复';
  render();
  if (heldTaskId === current.taskId) return;
  await navigator.locks.request('task:' + current.taskId, { ifAvailable: true }, async (lock) => {
    if (!lock) return;
    const saved = await loadTask(current.taskId);
    if (!saved) return;
    saved.autoRecovery = { ...saved.autoRecovery, enabled: false, nextAttemptAt: null };
    if (saved.status !== 'finished') saved.status = 'paused';
    await saveTask(saved);
    if (task?.taskId === current.taskId) {
      task.autoRecovery = saved.autoRecovery;
      task.status = saved.status;
      render();
    }
  });
}
function stillSelected(taskId) {
  if (!task || task.taskId !== taskId || !profile) return false;
  const candidate = reviseProfile(profile, {
    pathPrefix: $('scope').value.trim(),
    tocSelector: $('toc-selector').value.trim(),
    contentSelector: $('content-selector').value.trim(),
    hashMode: $('hash-mode').value,
  });
  return (
    jobKey(
      candidate,
      $('product').value.trim() || profile.name,
      $('version').value.trim() || '未知',
    ) === taskId
  );
}
async function retryAutomatically(taskId) {
  if (!task?.autoRecovery?.enabled || task.taskId !== taskId) return;
  if (!stillSelected(taskId)) {
    await pauseImport();
    return;
  }
  // A concurrent scan or another controller must not cause a tight retry loop.
  const expectedAttemptAt = task.autoRecovery.nextAttemptAt;
  task.autoRecovery.nextAttemptAt = Date.now() + RETRY_INTERVAL_MS;
  if (busy || rotationBusy || selectionPending || !initialized) return;
  await locked(() => run(false, { automatic: true, expectedTaskId: taskId, expectedAttemptAt }));
}
async function run(
  retry = false,
  { automatic = false, expectedTaskId = null, expectedAttemptAt = null } = {},
) {
  const generation = ++runGeneration;
  return withTaskLock(async () => {
    if (generation !== runGeneration) return;
    if (
      automatic &&
      (task.taskId !== expectedTaskId ||
        !task.autoRecovery?.enabled ||
        task.autoRecovery.sourceTabId !== tabId ||
        task.autoRecovery.nextAttemptAt !== expectedAttemptAt)
    )
      return;
    const savedBefore = savedChapterCount(task);
    task.autoRecovery = {
      ...task.autoRecovery,
      enabled: true,
      nextAttemptAt: null,
      attempts: (task.autoRecovery?.attempts || 0) + (automatic ? 1 : 0),
      sourceTabId: tabId,
    };
    render();
    await saveTask(task);
    await setSetting('recovery-tab:' + tabId, task.taskId);
    try {
      if (generation !== runGeneration) return;
      const reconnect = automatic || taskHasRetryableWork(task) || task.recovery?.scope === 'task';
      let rotationCheckDeferred = false;
      try {
        if (await isRotating()) throw new Error('此标签页正在导航轮换，请另开手册标签页采集');
      } catch (error) {
        if (!reconnect || classifyRecoveryError(error).reason !== 'network') throw error;
        rotationCheckDeferred = true;
      }
      if (reconnect) {
        const state = await io.recover(profile);
        if (state?.status === 'auth')
          throw recoveryError('登录已失效，请在原页面重新登录', 'AUTH_REQUIRED');
      }
      if (rotationCheckDeferred && (await isRotating()))
        throw new Error('此标签页正在导航轮换，请另开手册标签页采集');
      if (io.prepare) {
        const shouldContinue = () => generation === runGeneration;
        const prepared = await io.prepare(profile, task.queue, { shouldContinue });
        if (prepared?.status === 'auth')
          throw recoveryError('登录已失效，请在原页面重新登录', 'AUTH_REQUIRED');
        if (!shouldContinue()) return;
        if (prepared?.status !== 'ok') throw new Error('页面定位尚未确认，请重新校准');
        if (prepared.changed) {
          if (!prepared.verified) throw new Error('更新的页面定位尚未验证，请重新校准');
          const candidate = validateProfile(prepared.profile);
          const staged = {
            ...task,
            profile: candidate,
            validation: {
              signature: ruleSignature(candidate),
              verifiedAt: new Date().toISOString(),
            },
          };
          await saveTask(staged, null, { shouldContinue });
          task = staged;
          profile = candidate;
          populateProfile();
          if (!shouldContinue()) return;
          await saveProfile(profile);
        }
      }
      if (reconnect && !automatic && generation === runGeneration) resetInterruptedChapters(task);
      if (generation !== runGeneration) return;
      if (task.validation?.signature !== ruleSignature(profile))
        await verifyAndSave(() => generation === runGeneration);
      if (generation !== runGeneration) return;
      if (automatic) resetRetryableChapters(task);
      // Re-collecting a "review" chapter replaces its saved page, so never do it
      // silently; failed chapters carry no kept body and are safe to retry.
      else if (retry) {
        const reviews = task.queue.filter(
          (c) =>
            c.status === 'review' ||
            (c.status === 'captured' && hasMissingExamples(task.pages?.[c.key || c.url])),
        );
        for (const c of task.queue)
          if (c.status === 'failed') {
            c.status = 'pending';
            delete c.error;
            delete c.recovery;
          }
        if (
          reviews.length &&
          confirm(
            `有 ${reviews.length} 个待核对或样例缺失章节。重新采集成功后替换其已保存正文；失败时保留原文。\n\n确认重新采集这些章节？`,
          )
        )
          for (const c of reviews) {
            c.status = 'pending';
            delete c.error;
            delete c.recovery;
          }
      }
      engine = new ImportEngine(task, {
        discover: io.discover,
        capture: io.capture,
        save: saveTask,
        onChange: render,
      });
      await engine.run();
    } catch (e) {
      task.recovery = { ...classifyRecoveryError(e), scope: 'task', message: redact(e.message) };
      task.status = task.recovery.reason === 'auth' ? 'waiting_login' : 'paused';
      error(e);
    } finally {
      const again = generation === runGeneration && taskHasRetryableWork(task);
      task.autoRecovery = {
        ...(again ? scheduleRecovery(task, savedBefore) : task.autoRecovery),
        enabled: again,
        ...(!again ? { nextAttemptAt: null } : {}),
      };
      if (again && task.status !== 'waiting_login') task.status = 'retry_wait';
      if (generation !== runGeneration && task.status !== 'finished') task.status = 'paused';
      await saveTask(task);
      render();
      refreshRetryClock();
    }
  });
}

function download(text, name, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
const statusLabels = {
  ready: '准备就绪',
  paused: '已暂停',
  finished: '已处理当前发现的章节',
  waiting_login: '等待重新登录',
  retry_wait: '等待自动重试',
};
function taskState(task) {
  if (!task) return '未知';
  // A task left as running by a closed control page must not look live forever.
  // The heartbeat is written by every checkpoint; a stale one means interrupted,
  // never background execution.
  const stamp = Date.parse(task.heartbeat?.at || task.updatedAt || 0);
  const fresh = Number.isFinite(stamp) && Date.now() - stamp < 120000;
  if (task.status === 'running') return fresh ? '正在采集' : '已中断，可继续采集';
  return statusLabels[task.status] || task.status || '未知';
}
function stamp(value) {
  const time = Date.parse(value || 0);
  return Number.isFinite(time) ? new Date(time).toLocaleString() : '未知';
}
function ago(value) {
  const time = Date.parse(value || 0);
  if (!Number.isFinite(time)) return '未知';
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return minutes + ' 分钟前';
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours + ' 小时前';
  return Math.round(hours / 24) + ' 天前';
}
/** Prove the current tab really serves this task before binding: scope, login
 *  state and the saved calibration rule, never origin equality alone. */
async function checkBind(profile, task) {
  let current;
  try {
    current = await io.tab();
  } catch (error) {
    return { ok: false, reason: error.message };
  }
  const pre = classifyBind(profile, current?.url);
  if (!pre.ok) return pre;
  try {
    await io.install();
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      args: [profile],
      func: (profile) => {
        const adapters = globalThis.SecurityManualAdapters;
        if (!adapters) return { ok: false, reason: '页面脚本未加载，请刷新手册页' };
        try {
          const doc = profile.frameSelector
            ? document.querySelector(profile.frameSelector)?.contentDocument
            : document;
          if (!doc?.documentElement) return { ok: false, reason: '无法访问文档框架' };
          if (!profile.tocSelector)
            return { ok: false, reason: '已保存规则缺少目录选择器，请重新校准' };
          if (doc.querySelectorAll(profile.tocSelector).length !== 1)
            return { ok: false, reason: '已保存的目录规则在当前页面不唯一，请重新校准' };
          if (profile.contentSelector && doc.querySelectorAll(profile.contentSelector).length !== 1)
            return { ok: false, reason: '已保存的正文规则在当前页面不唯一，请重新校准' };
          const body = globalThis.ManualCapture.readState({
            entry: profile.entry,
            profile,
            selector: profile.contentSelector,
          });
          if (body?.auth) return { ok: false, reason: '当前页面需要登录，请登录后重试' };
          return { ok: true };
        } catch (error) {
          return { ok: false, reason: error?.message || '规则检查失败' };
        }
      },
    });
    const result = r[0]?.result;
    if (!result?.ok) return { ok: false, reason: result?.reason || '无法在当前标签页完成规则检查' };
  } catch (error) {
    return { ok: false, reason: '无法在当前标签页执行检查：' + error.message };
  }
  return { ok: true };
}
/** Open any saved task; a web task is bound only after checkBind passes. */
async function openTask(summary) {
  const full = await loadTask(summary.taskId);
  if (!full) throw new Error('任务已不存在，请刷新列表');
  if (task?.sourceKind === 'web') lastWebTask = task;
  task = full;
  selectedChapterKey = null;
  $('preview').textContent = '尚无已保存正文';
  $('product').value = task.product;
  $('version').value = task.version;
  if (full.sourceKind !== 'web') {
    readOnlyTask = false;
    showMode('spec');
    render();
    return;
  }
  if (!full.profile) throw new Error('该任务没有保存识别规则，请重新识别');
  const saved = validateProfile(full.profile),
    check = await checkBind(saved, full);
  profile = saved;
  populateProfile();
  readOnlyTask = !check.ok || Boolean(selectedSession?.busy);
  showMode('web');
  if (!check.ok) {
    error(new Error(check.reason));
    render();
    return;
  }
  if (selectedSession?.busy) {
    error(new Error('当前来源正在采集，此档案以只读方式查看；请先暂停来源再继续采集'));
    render();
    return;
  }
  await navigator.locks.request('task:' + full.taskId, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      readOnlyTask = true;
      error(new Error('此任务正在其他采集会话中运行，当前只读查看；请先暂停'));
      return;
    }
    if (selectedSession) await selectedSession.adopt(full, saved);
  });
  showMode('web');
  render();
}
/** A closed console leaves status 'running'; only mark it interrupted when no
 *  other console holds the task lock. This is labelling, not background work. */
async function markInterrupted() {
  for (const summary of await listTasks()) {
    if (summary.sourceKind !== 'web' || summary.status !== 'running') continue;
    const stamp = Date.parse(summary.heartbeat?.at || summary.updatedAt || 0);
    if (Number.isFinite(stamp) && Date.now() - stamp < 120000) continue;
    await navigator.locks.request('task:' + summary.taskId, { ifAvailable: true }, async (lock) => {
      if (!lock) return;
      const full = await loadTask(summary.taskId);
      if (!full || full.status !== 'running') return;
      const at = Date.parse(full.heartbeat?.at || full.updatedAt || 0);
      if (Number.isFinite(at) && Date.now() - at < 120000) return;
      full.status = 'paused';
      full.recovery = {
        ...(full.recovery || {}),
        reason: 'interrupted',
        message: '控制台已关闭，采集中断；可重新绑定标签页后继续采集',
      };
      await saveTask(full);
    });
  }
}
function renderErrorLog() {
  const log =
    Array.isArray(task?.errorLog) && task.errorLog.length ? task.errorLog.slice(0, 10) : null;
  const summary = collectionMessage(
    task,
    task?.taskId === selectedSession?.task?.taskId ? selectedSession?.getState().error : '',
  );
  const detail = log
    ? log
        .map((entry) => {
          const when = entry.at ? new Date(entry.at).toLocaleString() : '未知时间';
          const where =
            [entry.stage, entry.chapterTitle].filter(Boolean).join(' · ') || '未标注阶段';
          // Redact again on display: entries normally arrive through pushFault, but this
          // keeps the log safe even if a fault was ever written without it.
          return `${when}  ${where}\n  ${entry.name}: ${redact(String(entry.message || ''))}\n  ${redact(String(entry.stack || '')).split('\n')[0] || ''}`;
        })
        .join('\n\n')
    : (task?.queue || [])
        .filter((c) => c.error)
        .slice(-10)
        .reverse()
        .map((c) => `${c.title || '章节'}：${redact(c.error)}`)
        .join('\n\n') ||
      collectionMessage(task) ||
      '暂无记录';
  $('error-log').textContent = [summary, detail].filter(Boolean).join('\n\n');
}
async function library() {
  const libraryRows = (await listTasks()).sort(
    (a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0),
  );
  const query = $('library-search').value.trim().toLowerCase(),
    filter = $('library-filter').value;
  const matches = libraryRows.filter(
    (t) =>
      (filter === 'all' || t.sourceKind === filter) &&
      [t.product, t.version, t.entry].join(' ').toLowerCase().includes(query),
  );
  const tasks = paginate(matches, 'library', libraryPage, libraryPageSize(document));
  libraryPage = tasks.page;
  renderLibrary({
    document,
    items: tasks.items,
    taskState,
    stamp,
    ago,
    onOpen: (t) =>
      locked(
        async () => {
          await openTask(t);
        },
        { source: false },
      ),
    onExport: async (t) => {
      try {
        const full = await loadTask(t.taskId);
        if (full)
          download(
            buildExports(full).json,
            `${String(t.product || 'manual').replace(/[\\/:*?"<>|]/g, '_')}.json`,
          );
      } catch (e) {
        error(e);
      }
    },
    onDelete: (t) => {
      const captured = t.queue.filter((c) => c.status === 'captured').length,
        total = t.queue.length;
      if (
        !confirm(
          `删除任务「${t.product || '未命名'} · ${t.version || '未知'}」？\n\n已保存 ${captured}/${total} 章内容与采集进度将永久删除，已保存的识别规则会保留。\n来源：${t.entry || '未知'}\n更新：${stamp(t.updatedAt)}`,
        )
      )
        return;
      locked(
        async () => {
          await navigator.locks.request('task:' + t.taskId, { ifAvailable: true }, async (lock) => {
            if (!lock) throw new Error('任务正在采集，请先暂停后再删除');
            await deleteTask(t.taskId);
            if (lastWebTask?.taskId === t.taskId) lastWebTask = null;
            if (task?.taskId === t.taskId) {
              retryClock.dispose();
              task = null;
              profile = null;
              selectedChapterKey = null;
              $('product').value = '';
              $('version').value = '';
              $('preview').textContent = '任务已删除';
            }
            await library();
            render();
          });
        },
        { source: false },
      );
    },
  });
}
async function importSpec(text, filename, sourceURL) {
  if (text.length > 16 * 1024 * 1024) throw new Error('规范文件超过16MiB上限');
  const result = parseSpecification(text, {
    filename,
    sourceURL,
    product: $('product').value,
    version: $('version').value,
  });
  const identity = await contentHash(text),
    product = $('product').value.trim() || result.title,
    version = $('version').value.trim() || result.version || '未知';
  const candidate = {
    schemaVersion: 2,
    taskId: specificationTaskId(identity, sourceURL || 'file:' + filename, product, version),
    sourceKind: 'openapi',
    specVersion: result.specVersion,
    entry: sourceURL || '本地文件:' + filename,
    product: $('product').value.trim() || result.title,
    version: $('version').value.trim() || result.version || '未知',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'finished',
    queue: result.queue.map((c) => ({ ...c, status: 'captured' })),
    pages: result.pages,
    discoveryWarnings: result.warnings,
    scanDiagnostics: { source: 'specification' },
  };
  for (const page of Object.values(candidate.pages)) {
    page.hash = await contentHash(page.text);
    page.capturedAt = new Date().toISOString();
  }
  await navigator.locks.request('task:' + candidate.taskId, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error('这份规范正在另一个操作中使用，请稍后重试');
    const existing = await loadTask(candidate.taskId);
    if (!existing) await saveWholeTask(candidate);
    if (task?.sourceKind === 'web') lastWebTask = task;
    task = existing || candidate;
  });
  $('spec-status').textContent = `已导入 ${task.queue.length} 个接口说明；未执行接口请求`;
  render();
}
async function fetchSpec() {
  const current = await io.tab();
  const u = new URL(specificationURL($('spec-url').value, current.url));
  const r = await chrome.scripting.executeScript({
    target: { tabId },
    args: [u.href],
    func: async (raw) => {
      const url = new URL(raw);
      if (url.origin !== location.origin) throw new Error('文档地址与原页面不同源');
      const response = await fetch(url, {
        credentials: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('读取失败：HTTP ' + response.status);
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 16 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('规范文件超过16MiB');
        }
        chunks.push(value);
      }
      return new Blob(chunks).text();
    },
  });
  await importSpec(r[0].result, u.pathname.split('/').at(-1), u.href);
}
function rotationTarget() {
  return rotationSession
    ? { tabId: rotationSession.tabId, io: rotationSession.io, origin: rotationConfig?.origin }
    : { tabId, io, origin: sourceOrigin };
}
function rotationConnected() {
  return (
    !rotationSelectionPending &&
    (rotationSession
      ? !rotationSession.closed && !rotationSession.disposed
      : !chrome.runtime?.onMessage && initialized)
  );
}
function renderConnection() {
  if (!chrome.runtime?.onMessage) return;
  const session = mode === 'rotation' ? rotationSession : selectedSession;
  $('connection').textContent = session
    ? (session.closed
        ? '来源已关闭，请重新连接：'
        : mode === 'rotation'
          ? '轮换管理页：'
          : '文档来源：') + (session.address || '')
    : mode === 'rotation'
      ? '请连接用于菜单轮换的管理页'
      : '请连接用于采集的文档页';
}
function renderRotationControls() {
  sourceControls?.refresh();
  const running = rotationStates.get(rotationTarget().tabId)?.running;
  document
    .querySelectorAll('[data-panel="rotation"] button,[data-panel="rotation"] input')
    .forEach((el) => {
      el.disabled =
        !rotationConnected() ||
        (el.id !== 'rotation-stop' && rotationBusy) ||
        (running && !['rotation-stop', 'rotation-remove', 'rotation-trial'].includes(el.id));
    });
  $('rotation-remove').disabled =
    rotationBusy || rotationSelectionPending || !rotationSession || rotationSession.disposed;
  $('rotation-save').disabled =
    running || rotationBusy || !rotationConnected() || !rotationVerified;
}
function showRotationTargets() {
  const targets = rotationConfig?.targets || [];
  const page = paginate(targets, 'rotation', rotationPage, listPageSize('rotation-targets', 48, 5));
  rotationPage = page.page;
  $('rotation-targets').replaceChildren(
    ...page.items.map((t, index) => {
      const i = page.start + index;
      const li = document.createElement('li');
      li.textContent = i + 1 + '. ' + t.title;
      const b = document.createElement('button');
      b.textContent = '移除';
      b.onclick = () => {
        if (rotationBusy || busy) return;
        targets.splice(i, 1);
        invalidateRotation();
        showRotationTargets();
      };
      li.append(b);
      return li;
    }),
  );
  renderRotationControls();
}

function invalidateRotation() {
  rotationVerified = false;
  $('rotation-status').textContent = '菜单顺序已修改，请重新试运行后保存或开始轮换';
}

function rotationSettings() {
  const interval = Number($('rotation-interval').value);
  if (!Number.isInteger(interval) || interval < 30 || interval > 3600)
    throw new Error('间隔请设为30至3600秒');
  return { ...rotationConfig, intervalMs: interval * 1000 };
}
function showRotationState(targetTabId, state) {
  if (rotationTarget().tabId !== targetTabId || !state) return;
  const pendingTrial =
    !state.running && !rotationBusy && !rotationVerified && rotationConfig?.targets.length;
  $('rotation-status').textContent =
    (pendingTrial
      ? '当前菜单顺序需要重新试运行。'
      : !state.running && !rotationBusy && rotationVerified
        ? '所选导航顺序试运行通过。'
        : '') +
    `${state.message} · 最近点击：${state.lastLabel || '无'} · 累计 ${state.count || 0} 次`;
}
function rotationChanged(targetTabId, state) {
  rotationStates.set(targetTabId, state);
  showRotationState(targetTabId, state);
  renderRotationControls();
  const running = [...rotationStates.values()].filter((value) => value.running);
  const failures = [...rotationStates.values()].filter((value) => value.status === 'error');
  $('rotation-background-status').textContent = running.length
    ? `菜单轮换：${running.length} 个管理页运行中 · 累计 ${running.reduce((sum, value) => sum + value.count, 0)} 次`
    : failures.length
      ? '菜单轮换已停止，请到菜单轮换查看原因'
      : '菜单轮换未运行';
}
async function rotationCall(
  action,
  config,
  target = rotationTarget(),
  progress = null,
  guard = () => {},
) {
  const { tabId: targetTabId, origin: targetOrigin, io: targetIO } = target;
  if (rotationController && action !== 'start' && normalRotationTabs.has(targetTabId)) {
    const result = await rotationController[action](targetTabId);
    showRotationState(targetTabId, result);
    return result;
  }
  const current = await targetIO.tab();
  guard();
  if (new URL(current.url).origin !== targetOrigin) throw new Error('原页面已离开所选网站');
  if (['start', 'prepare', 'execute'].includes(action))
    await chrome.scripting.executeScript({
      target: { tabId: targetTabId },
      files: ['navigation-discovery.js', 'navigation-rotation.js'],
    });
  guard();
  const r = await chrome.scripting.executeScript({
    target: { tabId: targetTabId },
    args: [action, config ?? null, targetOrigin, progress],
    func: (action, config, origin, progress) => {
      if (location.origin !== origin) throw new Error('原页面来源已变化');
      const c = globalThis.SecurityNavigationRotation;
      if (!c) return { running: false, count: 0, message: '尚未启动' };
      if (typeof c[action] !== 'function')
        throw new Error('来源页仍使用旧版轮换器，请先停止旧轮换并刷新来源页后重试');
      if (action === 'stopManaged') return c.stopManaged(progress.runId);
      if (action === 'prepare' || action === 'execute') return c[action](config, progress);
      return action === 'start' ? c.start(config) : c[action]();
    },
  });
  const state = r[0]?.result;
  showRotationState(targetTabId, state);
  return state;
}
async function rotationAction(action, { source = true, connected = true } = {}) {
  if (rotationBusy || (connected && !rotationConnected())) return;
  rotationBusy = true;
  renderRotationControls();
  clearError();
  try {
    if (!source) await action();
    else
      await navigator.locks.request(
        'source-tab:' + rotationTarget().tabId,
        { ifAvailable: true },
        async (lock) => {
          if (!lock) throw new Error('这个标签页正在操作，请稍后再试');
          await action();
        },
      );
  } catch (e) {
    error(e);
  } finally {
    rotationBusy = false;
    renderRotationControls();
  }
}
async function pickRotation() {
  if ((await rotationCall('snapshot'))?.running) throw new Error('请先停止轮换再修改');
  const target = rotationTarget();
  const control = await chrome.tabs.getCurrent();
  await chrome.tabs.update(target.tabId, { active: true });
  let picked;
  try {
    picked = await target.io.pick('rotation', null);
  } finally {
    if (control?.id) await chrome.tabs.update(control.id, { active: true });
  }
  if (picked.frameSelector) throw new Error('首版轮换仅支持主页面导航，请在管理主页面选择');
  if (!rotationConfig)
    rotationConfig = {
      origin: target.origin,
      pathPrefix: new URL((await target.io.tab()).url).pathname,
      intervalMs: 60000,
      targets: [],
    };
  rotationConfig.targets.push({ selector: picked.selector, title: picked.title });
  invalidateRotation();
  showRotationTargets();
}
async function stopRotation() {
  rotationTrialGeneration++;
  // An active trial already owns an unverified state and checks this generation.
  // Stopping normal rotation or a pending save must preserve a completed trial.
  return rotationCall('stop');
}
async function rotationTrial() {
  const config = JSON.parse(JSON.stringify(rotationSettings()));
  if (!config.targets.length) throw new Error('请先点选导航菜单');
  const trial = ++rotationTrialGeneration;
  const target = rotationTarget();
  const assertCurrent = () => {
    if (trial !== rotationTrialGeneration) throw new Error('试运行已取消');
    if (!rotationConnected() || rotationTarget().tabId !== target.tabId)
      throw new Error('轮换来源已关闭或变化，请重新连接');
  };
  const call = (action, value, progress) =>
    rotationCall(
      action,
      value,
      target,
      progress,
      action === 'stopManaged' ? () => {} : assertCurrent,
    );
  rotationVerified = false;
  // The normal controller owns this source lock until its pending click and
  // cleanup finish. Stop it before requesting the trial's own source lock.
  if (rotationController && normalRotationTabs.has(target.tabId))
    await rotationController.stop(target.tabId);
  assertCurrent();
  rotationStates.delete(target.tabId);
  normalRotationTabs.delete(target.tabId);
  await navigator.locks.request(
    'source-tab:' + target.tabId,
    { ifAvailable: true },
    async (lock) => {
      if (!lock) throw new Error('这个标签页正在操作，请稍后再试');
      assertCurrent();
      const trialConfig = { ...config, intervalMs: 1000 };
      const progress = { runId: crypto.randomUUID(), index: 0, count: 0 };
      try {
        await call('stop');
        assertCurrent();
        const ready = await call('prepare', trialConfig, progress);
        assertCurrent();
        if (!ready?.running) throw new Error(ready?.message || '试运行无法启动');
        // Dispatch each selected menu once. A delayed browser response must
        // neither start another lap nor turn normal progress into a failure.
        for (let index = 0; index < config.targets.length; index++) {
          $('rotation-status').textContent =
            `试运行 ${index + 1}/${config.targets.length}：即将点击“${config.targets[index].title}”`;
          await sleep(1000);
          assertCurrent();
          const state = await call('execute', trialConfig, progress);
          assertCurrent();
          if (!state?.clicked || state.stopRequested || (!state.running && !state.pageHidden))
            throw new Error(
              `试运行在第 ${index + 1}/${config.targets.length} 项“${config.targets[index].title}”停止：` +
                (state?.message || '未收到点击结果'),
            );
          progress.count++;
          progress.index = (index + 1) % config.targets.length;
        }
      } finally {
        await call('stopManaged', null, progress);
      }
      assertCurrent();
    },
  );
  assertCurrent();
  rotationVerified = true;
  showRotationTargets();
  $('rotation-status').textContent = '所选导航顺序试运行通过，可保存规则或开始轮换';
}

async function preset() {
  if ((await rotationCall('snapshot'))?.running) throw new Error('请先停止轮换再重新识别');
  const target = rotationTarget();
  await chrome.scripting.executeScript({
    target: { tabId: target.tabId },
    files: ['navigation-discovery.js'],
  });
  const r = await chrome.scripting.executeScript({
    target: { tabId: target.tabId },
    func: () => globalThis.SecurityNavigationDiscovery.discover(),
  });
  const result = r[0]?.result;
  if (!result?.targets?.length)
    throw new Error(result?.warnings?.join('；') || '未识别到足够可靠的主菜单，请在原页面点选');
  if (result.origin !== target.origin) throw new Error('原页面来源已变化');
  rotationConfig = {
    origin: target.origin,
    pathPrefix: result.pathPrefix,
    intervalMs: 60000,
    targets: result.targets,
  };
  rotationVerified = false;
  showRotationTargets();
  $('rotation-status').textContent =
    `已从当前页面识别 ${result.targets.length} 个导航菜单；请核对列表并试运行。${(result.warnings || []).join('；')}`;
}
const actions = {
  detect: () => scanSelected({ detect: true }).catch(error),
  'pick-toc': () => locked(() => selectRegion('toc')),
  'pick-content': () => locked(() => selectRegion('content')),
  'sample-a': () => locked(() => sample(0)),
  'sample-b': () => locked(() => sample(1)),
  verify: () => locked(verifyAndSave),
  scan: () =>
    scanSelected({
      expand: Boolean(profile && task?.scanDiagnostics?.pendingBranches > 0),
    }).catch(error),
  start: () => startSelected().catch(error),
  retry: () => startSelected({ retry: true }).catch(error),
  'cancel-scan': () => selectedSession?.pause().catch(error),
  pause: () =>
    selectedSession ? selectedSession.pause().catch(error) : pauseImport().catch(error),
  'capture-current': () => startSelected({ currentOnly: true }).catch(error),
  'export-profile': () =>
    locked(async () => download(exportProfile(currentProfile()), 'manual-profile.json')),
  'fetch-spec': () => locked(fetchSpec),
  'refresh-library': () => library().catch(error),
  'rotation-pick': () => rotationAction(pickRotation),
  'rotation-preset': () => rotationAction(preset),
  'rotation-clear': () =>
    rotationAction(async () => {
      await rotationCall('stop');
      rotationConfig = {
        origin: rotationTarget().origin,
        pathPrefix: new URL((await rotationTarget().io.tab()).url).pathname,
        intervalMs: 60000,
        targets: [],
      };
      rotationVerified = false;
      showRotationTargets();
    }),
  'rotation-trial': () => rotationAction(rotationTrial, { source: false }),
  'rotation-save': () =>
    rotationAction(async () => {
      if (!rotationVerified) throw new Error('请先试运行');
      rotationConfig = rotationSettings();
      await setSetting('rotation:' + rotationTarget().origin, rotationConfig);
      $('rotation-status').textContent = '轮换规则已保存';
    }),
  'rotation-start': () =>
    rotationAction(
      async () => {
        if (!rotationVerified) throw new Error('请先试运行所选顺序');
        const config = rotationSettings();
        if (rotationController) normalRotationTabs.add(rotationTarget().tabId);
        const result = rotationController
          ? await rotationController.start(rotationTarget().tabId, config)
          : await rotationCall('start', rotationSettings());
        if (!result.running) throw new Error(result.message);
      },
      { source: false },
    ),
  'rotation-stop': () => stopRotation().catch(error),
  'rotation-remove': () =>
    rotationAction(
      async () => {
        const session = rotationSession;
        if (!session) return;
        if (session.closed) {
          rotationTrialGeneration++;
          await rotationController?.stop(session.tabId);
          normalRotationTabs.delete(session.tabId);
          rotationStates.delete(session.tabId);
        } else await stopRotation();
        await batch?.removeSource(session.tabId);
        renderConnection();
      },
      { source: false, connected: false },
    ),
  'rotation-export': () =>
    rotationAction(async () =>
      download(
        JSON.stringify(
          { format: 'security-navigation-profile', schemaVersion: 1, config: rotationSettings() },
          null,
          2,
        ),
        'navigation-profile.json',
      ),
    ),
};
for (const [id, action] of Object.entries(actions)) $(id).addEventListener('click', action);
document.querySelectorAll('[data-mode]').forEach(
  (b) =>
    (b.onclick = () => {
      showMode(b.dataset.mode);
      if (mode === 'library') library().catch(error);
    }),
);
$('import-profile').onchange = async () => {
  const session = selectedSession;
  let prepared = false;
  await locked(async () => {
    const file = $('import-profile').files[0];
    if (!file) return;
    if (file.size > 1024 * 1024) throw new Error('规则文件过大');
    const current = await io.tab();
    if (new URL(current.url).origin !== sourceOrigin) throw new Error('原标签页已离开当前网站');
    profile = bindProfile(JSON.parse(await file.text()), current.url);
    task = null;
    populateProfile();
    if (!session) await scan();
    prepared = true;
    $('profile-status').textContent =
      '规则已重新绑定 ' +
      profile.origin +
      ' ' +
      profile.pathPrefix +
      '；请验证当前设备的两个示例后保存';
  });
  if (prepared && session && selectedSession === session) await scanSelected().catch(error);
};
$('spec-file').onchange = () =>
  locked(
    async () => {
      const f = $('spec-file').files[0];
      if (!f) return;
      if (f.size > 16 * 1024 * 1024) throw new Error('规范文件超过16MiB');
      await importSpec(await f.text(), f.name);
    },
    { source: false },
  );
$('rotation-import').onchange = () =>
  rotationAction(async () => {
    const f = $('rotation-import').files[0];
    if (!f || f.size > 1024 * 1024) throw new Error('轮换规则文件无效');
    const value = JSON.parse(await f.text());
    if (
      value.format !== 'security-navigation-profile' ||
      value.schemaVersion !== 1 ||
      value.config?.origin !== rotationTarget().origin
    )
      throw new Error('轮换规则格式或设备来源不符');
    rotationConfig = value.config;
    invalidateRotation();
    $('rotation-interval').value = (value.config.intervalMs || 60000) / 1000;
    showRotationTargets();
  });
$('rotation-interval').onchange = () => {
  showRotationTargets();
};
const names = {
    markdown: 'manual.md',
    html: 'offline.html',
    json: 'archive.json',
    report: 'report.txt',
  },
  types = {
    markdown: 'text/markdown',
    html: 'text/html',
    json: 'application/json',
    report: 'text/plain',
  };
document.querySelectorAll('[data-export]').forEach(
  (b) =>
    (b.onclick = async () => {
      try {
        const snapshot = (await loadTask(task.taskId)) || task;
        download(
          buildExports(snapshot)[b.dataset.export],
          names[b.dataset.export],
          types[b.dataset.export],
        );
      } catch (e) {
        error(e);
      }
    }),
);
window.addEventListener('pagehide', () => {
  retryClock.dispose();
  engine?.pause();
  clearInterval(rotationPoll);
  rotationController?.dispose();
  sourceControls?.dispose();
  batch?.dispose();
  unsubscribeTasks();
});
for (const id of ['product', 'version', 'scope', 'toc-selector', 'content-selector', 'hash-mode']) {
  $(id).addEventListener('input', () => {
    if (selectedSession?.draft) render();
  });
  $(id).addEventListener('change', () => {
    if (task?.autoRecovery?.enabled && !engine?.running)
      (selectedSession ? selectedSession.pause() : pauseImport()).catch(error);
    if (selectedSession?.draft) render();
  });
}
async function savedRecovery(current) {
  const id = await getSetting('recovery-tab:' + tabId);
  if (!id) return null;
  const saved = await loadTask(id);
  if (
    !saved?.autoRecovery?.enabled ||
    saved.autoRecovery.sourceTabId !== tabId ||
    saved.sourceKind !== 'web' ||
    !saved.profile
  )
    return null;
  let candidate;
  try {
    candidate = validateProfile(saved.profile);
  } catch {
    return null;
  }
  const currentURL = current.url || '',
    browserError = /^chrome-error:\/\//i.test(currentURL);
  const address = browserError ? current.pendingUrl : currentURL;
  if (!address) return null;
  let u;
  try {
    u = new URL(address);
  } catch {
    return null;
  }
  if (u.origin !== candidate.origin) return null;
  const login = /\/(?:login|logon|signin|sign-in|sso)(?:[./_-]|$)/i.test(u.pathname);
  const proven = selectSavedProfile(address, [candidate], [saved]).status === 'selected';
  if (!proven && !login && !(browserError && normalizeDocumentURL(address, candidate))) return null;
  return { task: saved, profile: candidate, address };
}
async function restoreRetryDeadline() {
  if (!task?.autoRecovery?.enabled) return;
  const id = task.taskId;
  await navigator.locks.request('task:' + id, { ifAvailable: true }, async (lock) => {
    if (!lock) {
      task.autoRecovery = { ...task.autoRecovery, enabled: false };
      $('profile-status').textContent = '另一个控制页正在使用此任务；本页未启动自动恢复';
      return;
    }
    const saved = await loadTask(id);
    if (!saved || task?.taskId !== id) return;
    if (
      saved.autoRecovery?.enabled &&
      saved.autoRecovery.sourceTabId === tabId &&
      !Number.isFinite(saved.autoRecovery.nextAttemptAt)
    ) {
      saved.autoRecovery.nextAttemptAt = Date.now() + RETRY_INTERVAL_MS;
      await saveTask(saved);
    }
    task = saved;
  });
  refreshRetryClock();
}
async function initialize() {
  try {
    if (!Number.isInteger(tabId) || tabId <= 0)
      throw new Error('请从已登录的文档或管理标签页点击扩展');
    const current = await io.tab();
    const recovery = await savedRecovery(current);
    const u = new URL(recovery?.address || current.url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password)
      throw new Error('只支持HTTP/HTTPS页面');
    sourceOrigin = u.origin;
    sourcePath = u.pathname;
    $('connection').textContent = '来源：' + u.origin + u.pathname;
    rotationConfig = (await getSetting('rotation:' + sourceOrigin)) || {
      origin: sourceOrigin,
      pathPrefix: sourcePath,
      intervalMs: 60000,
      targets: [],
    };
    rotationVerified = rotationConfig.targets.length > 0;
    $('rotation-interval').value = rotationConfig.intervalMs / 1000;
    showRotationTargets();
    const selected = selectSavedProfile(current.url, await loadProfiles(), await listTasks());
    if (recovery) {
      task = recovery.task;
      profile = recovery.profile;
      $('product').value = task.product;
      $('version').value = task.version;
      populateProfile();
      $('profile-status').textContent = '已恢复原任务和自动重试计划；已保存章节保留';
    } else if (selected.status === 'selected') {
      profile = validateProfile(selected.profile);
      $('product').value = selected.task?.product || '';
      $('version').value = selected.task?.version || '';
      populateProfile();
      await locked(
        async () => {
          await scan();
          await previewCurrent();
        },
        { initialization: true },
      );
    } else {
      await locked(detect, { initialization: true });
    }
    rotationPoll = setInterval(() => {
      if (mode === 'rotation' && !busy && !rotationBusy)
        rotationCall('snapshot').catch((e) => {
          $('rotation-status').textContent = '状态未知：' + e.message;
        });
    }, 3000);
  } catch (e) {
    error(e);
    $('connection').textContent = redact(e.message);
  } finally {
    initialized = Boolean(sourceOrigin);
    try {
      await restoreRetryDeadline();
      await markInterrupted();
    } catch (e) {
      error(e);
    }
    render();
  }
}
installPanelNavigation();
const unsubscribeTasks = subscribeTasks(async (change) => {
  try {
    if (mode === 'library') await library();
    $('sync-status').textContent = '已同步本机任务 · ' + new Date().toLocaleTimeString();
    const viewedTaskId = task?.taskId;
    const sourceIsWriting = () =>
      selectedSession?.busy && selectedSession.task?.taskId === viewedTaskId;
    if (!busy && !selectionPending && !sourceIsWriting() && viewedTaskId === change.taskId) {
      const fresh = await loadTask(viewedTaskId);
      if (busy || selectionPending || sourceIsWriting() || task?.taskId !== viewedTaskId) return;
      if (fresh) {
        task = fresh;
      } else {
        task = null;
        selectedChapterKey = null;
        $('preview').textContent = '任务已删除';
      }
      render();
    }
  } catch (e) {
    error(e);
  }
});
if (chrome.runtime?.onMessage) {
  rotationController = createRemoteRotationController({ onChange: rotationChanged });
  mode = 'rotation';
  showMode('rotation');
  batch = setupBatch({
    createSession: createRemoteSession,
    restoreSources: listBackgroundSources,
    initialTabId: tabId,
    getDefaultPurpose: () => (mode === 'rotation' ? 'rotation' : 'document'),
    onError: (failure, session) => {
      if (!session) error(failure);
      else if (selectedSession === session) renderRecognition(task?.queue || []);
    },
    getSelected: () => selectedSession,
    onSelect: selectSession,
    onAdded: async (session) => {
      sourceControls?.refresh();
      const current = session.purpose === 'rotation' ? rotationSession : selectedSession;
      if (session.purpose === 'document' || !current || !sessionAvailable(current))
        await selectSession(session, {
          view: session.purpose === 'rotation' ? 'rotation' : 'web',
          operation: 'identify',
        });
    },
    onRemoved: (session) => {
      if (rotationSession === session) {
        rotationSession = null;
        rotationConfig = null;
        rotationVerified = false;
        showRotationTargets();
        $('rotation-status').textContent = '请选择或连接管理页';
      }
      if (selectedSession === session) {
        selectedSession = null;
        initialized = false;
        task = null;
        profile = null;
        $('connection').textContent = '请选择已连接的页面，或粘贴 URL 连接新页面';
        $('preview').textContent = '尚无已保存正文';
        render();
      }
      sourceControls?.refresh();
    },
    onChange: (session) => {
      sourceControls?.refresh();
      refreshDocumentDraft(session);
      if (rotationSession === session) {
        if (session.closed || session.disposed)
          $('rotation-status').textContent = '来源已关闭，请重新连接管理页或移除此来源';
        renderConnection();
        renderRotationControls();
      }
      if (
        selectedSession === session &&
        !selectionPending &&
        !busy &&
        !readOnlyTask &&
        (documentScans.has(session) || (task?.taskId && task.taskId === session.task?.taskId))
      ) {
        refreshProfileInputs(profile, session.profile);
        task = session.task;
        profile = session.profile;
        if (profile && documentScans.has(session)) populateProfile();
        render();
      }
    },
  });
  sourceControls = setupSourceControls({
    document,
    getController: () => batch,
    getSelected: () => (mode === 'rotation' ? rotationSession : selectedSession),
    getView: () => mode,
    onSelect: selectSession,
    onError: error,
    canSwitch: () => !busy && !rotationBusy && !selectionPending && !rotationSelectionPending,
  });
  renderConnection();
  render();
} else {
  showMode('web');
  render();
  initialize();
}

function listPageSize(id, rowHeight, fallback = 3) {
  return Math.max(1, Math.floor(($(id)?.clientHeight || rowHeight * fallback) / rowHeight));
}
function paginate(items, prefix, current, size) {
  const pages = Math.max(1, Math.ceil(items.length / size)),
    page = Math.min(Math.max(0, current), pages - 1),
    start = page * size;
  $(prefix + '-prev').disabled = page === 0;
  $(prefix + '-next').disabled = page >= pages - 1;
  $(prefix + '-page').textContent = `${items.length} 项 · ${page + 1} / ${pages} 页`;
  return { items: items.slice(start, start + size), page, start };
}
function renderChapters(queue = task?.queue || []) {
  const query = $('chapter-search').value.trim().toLowerCase(),
    filter = $('chapter-filter').value;
  const filtered = queue.filter(
    (c) =>
      c.title.toLowerCase().includes(query) &&
      (filter === 'all' ||
        (filter === 'issues'
          ? ['failed', 'review'].includes(c.status)
          : filter === 'pending'
            ? ['pending', 'processing', 'waiting_login'].includes(c.status)
            : c.status === filter)),
  );
  const page = paginate(filtered, 'chapter', chapterPage, listPageSize('chapters', 48, 5));
  chapterPage = page.page;
  $('chapters').replaceChildren(
    ...page.items.map((c) => {
      const li = document.createElement('li'),
        button = document.createElement('button');
      button.className = 'chapter-open';
      button.textContent = `${labels[c.status] || c.status} · ${c.title}`;
      button.title = [c.title, c.error].filter(Boolean).join('\n');
      button.disabled = !task?.pages?.[c.key];
      button.onclick = () => {
        selectedChapterKey = c.key;
        render();
        showView('preview');
      };
      li.append(button);
      return li;
    }),
  );
}
$('collection-message').addEventListener('click', () => {
  renderErrorLog();
  showView('errors');
});
function showView(value) {
  document
    .querySelectorAll('[data-view]')
    .forEach((el) => el.setAttribute('aria-selected', String(el.dataset.view === value)));
  document
    .querySelectorAll('[data-view-panel]')
    .forEach((el) => (el.hidden = el.dataset.viewPanel !== value));
  if (value === 'chapters') renderChapters();
}
function showOperation(value) {
  document
    .querySelectorAll('[data-operation]')
    .forEach((el) => el.setAttribute('aria-selected', String(el.dataset.operation === value)));
  document
    .querySelectorAll('[data-operation-panel]')
    .forEach((el) => (el.hidden = el.dataset.operationPanel !== value));
}
function installPanelNavigation() {
  document
    .querySelectorAll('[data-operation]')
    .forEach((button) => (button.onclick = () => showOperation(button.dataset.operation)));
  document
    .querySelectorAll('[data-view]')
    .forEach((button) => (button.onclick = () => showView(button.dataset.view)));
  $('open-calibration').onclick = () => {
    $('calibration-dialog').showModal();
  };
  document
    .querySelectorAll('[data-close-dialog]')
    .forEach((button) => (button.onclick = () => button.closest('dialog').close()));
  for (const id of ['chapter-search', 'chapter-filter'])
    $(id).addEventListener('input', () => {
      chapterPage = 0;
      renderChapters();
    });
  for (const id of ['library-search', 'library-filter'])
    $(id).addEventListener('input', () => {
      libraryPage = 0;
      library().catch(error);
    });
  $('chapter-prev').onclick = () => {
    chapterPage--;
    renderChapters();
  };
  $('chapter-next').onclick = () => {
    chapterPage++;
    renderChapters();
  };
  $('library-prev').onclick = () => {
    libraryPage--;
    library().catch(error);
  };
  $('library-next').onclick = () => {
    libraryPage++;
    library().catch(error);
  };
  $('rotation-prev').onclick = () => {
    rotationPage--;
    showRotationTargets();
  };
  $('rotation-next').onclick = () => {
    rotationPage++;
    showRotationTargets();
  };
  window.addEventListener('resize', () => {
    renderChapters();
    showRotationTargets();
    if (mode === 'library') library().catch(error);
  });
  $('import-archive').onchange = () =>
    locked(
      async () => {
        const file = $('import-archive').files[0];
        if (!file) return;
        if (file.size > 128 * 1024 * 1024) throw new Error('档案超过128MiB上限');
        const incoming = await parseArchive(await file.text());
        await navigator.locks.request(
          'task:' + incoming.taskId,
          { ifAvailable: true },
          async (lock) => {
            if (!lock) throw new Error('该任务正在采集，请暂停后再恢复');
            const existing = await loadTask(incoming.taskId),
              result = mergeArchive(existing, incoming);
            if (
              !confirm(
                `恢复「${incoming.product} · ${incoming.version}」？\n新增正文 ${result.addedPages} 章；冲突 ${result.conflicts.length} 章保留本机内容。\n恢复后不会自动采集。`,
              )
            )
              return;
            await restoreWholeTask(result.task);
            if (result.task.profile) await saveProfile(result.task.profile);
            $('sync-status').textContent =
              `已恢复 ${result.addedPages} 章；${result.conflicts.length} 个冲突保留本机内容`;
            await library();
          },
        );
        $('import-archive').value = '';
      },
      { source: false },
    );
}
function rememberRotationDraft() {
  if (!rotationSession || !rotationConfig) return;
  rotationDrafts.set(rotationSession, {
    config: JSON.parse(JSON.stringify(rotationConfig)),
    verified: rotationVerified,
    interval: $('rotation-interval').value,
    page: rotationPage,
  });
}
function rotationInScope(config, url) {
  if (!config || config.origin !== url.origin || !Array.isArray(config.targets)) return false;
  const prefix = config.pathPrefix;
  return (
    typeof prefix === 'string' &&
    (prefix === '/' ||
      url.pathname === prefix ||
      url.pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))
  );
}
function restoreRotationDraft(session, url, saved) {
  const draft = rotationDrafts.get(session);
  const reusable = draft && rotationInScope(draft.config, url);
  const savedInScope = rotationInScope(saved, url);
  rotationConfig = reusable
    ? draft.config
    : savedInScope
      ? saved
      : {
          origin: url.origin,
          pathPrefix: url.pathname,
          intervalMs: 60000,
          targets: [],
        };
  rotationVerified = reusable ? draft.verified : Boolean(savedInScope && saved.targets.length);
  rotationPage = reusable ? draft.page : 0;
  $('rotation-interval').value = reusable ? draft.interval : rotationConfig.intervalMs / 1000;
  $('rotation-status').textContent = rotationVerified
    ? '所选导航顺序已通过试运行，可保存规则或开始轮换'
    : rotationConfig.targets.length
      ? '当前页面的菜单顺序尚未试运行'
      : '请先识别或手动添加当前页面的菜单';
}

function sessionAvailable(session) {
  return (
    !session.closed && !session.disposed && (!batch || batch.getSession(session.tabId) === session)
  );
}
async function selectRotationSession(session) {
  if (rotationBusy) throw new Error('请等待轮换配置操作完成');
  rememberRotationDraft();
  const generation = ++rotationSelectionGeneration;
  rotationSelectionPending = true;
  renderRotationControls();
  try {
    // Closed management pages remain selectable so their retained menu draft can
    // be inspected and the source slot removed without contacting a dead tab.
    if (session.closed) {
      if (session.disposed || (batch && batch.getSession(session.tabId) !== session)) return;
      const draft = rotationDrafts.get(session);
      rotationSession = session;
      rotationConfig = draft?.config || null;
      rotationVerified = Boolean(draft?.verified);
      rotationPage = draft?.page || 0;
      $('rotation-interval').value = draft?.interval || '60';
      showRotationTargets();
      showMode('rotation');
      $('rotation-status').textContent =
        '来源已关闭，可查看原菜单配置或移除此来源；重新运行请连接管理页';
      return;
    }
    const current = await session.io.tab();
    const url = new URL(current.url);
    const saved =
      (await rotationController?.config?.(session.tabId)) ||
      (await getSetting('rotation:' + url.origin));
    if (generation !== rotationSelectionGeneration || !sessionAvailable(session)) return;
    rotationSession = session;
    restoreRotationDraft(session, url, saved);
    showRotationTargets();
    const running = rotationStates.get(session.tabId);
    if (running) showRotationState(session.tabId, running);
    if (!rotationPoll)
      rotationPoll = setInterval(() => {
        if (rotationSession && rotationConnected() && !rotationBusy)
          rotationCall('snapshot').catch((e) => {
            $('rotation-status').textContent = '状态未知：' + redact(e.message);
          });
      }, 3000);
    showMode('rotation');
  } finally {
    if (generation === rotationSelectionGeneration) {
      rotationSelectionPending = false;
      render();
    }
  }
}

function rememberDocumentDraft() {
  if (
    !selectedSession ||
    documentScans.has(selectedSession) ||
    readOnlyTask ||
    task?.sourceKind === 'openapi'
  )
    return;
  documentDrafts.set(selectedSession, {
    profile,
    task,
    product: $('product').value,
    version: $('version').value,
    scope: $('scope').value,
    toc: $('toc-selector').value,
    content: $('content-selector').value,
    hashMode: $('hash-mode').value,
    warnings: detectionWarnings,
    samples: [...sampleSlots],
    samplesEdited:
      JSON.stringify(sampleSlots.filter(Boolean)) !== JSON.stringify(profile?.samples || []),
  });
}
async function selectSession(session, { view = 'web', operation = null } = {}) {
  if (session.purpose === 'rotation' || (view === 'rotation' && !session.purpose))
    return selectRotationSession(session);
  if (view === 'rotation') throw new Error('文档页不能用于菜单轮换，请连接独立管理页');
  if (busy) throw new Error('请等待当前操作完成后切换文档来源');
  rememberDocumentDraft();
  const generation = ++selectionGeneration;
  const isCurrent = () => generation === selectionGeneration;
  selectionPending = true;
  render();
  try {
    if (!isCurrent() || !sessionAvailable(session)) return;
    const current = await session.io.tab();
    const url = new URL(current.url);
    if (!isCurrent() || !sessionAvailable(session)) return;
    retryClock.dispose();
    selectedSession = session;
    tabId = session.tabId;
    io = session.io;
    const draft = documentDrafts.get(session);
    const hasEditedRule =
      draft && draft.profile && (!draft.task || draft.task.taskId !== session.task?.taskId);
    task = hasEditedRule ? draft.task : session.draft?.task || session.task;
    profile = hasEditedRule ? draft.profile : session.draft?.profile || session.profile;
    pendingDocumentResults.delete(session);
    detectionWarnings = hasEditedRule
      ? draft.warnings
      : session.draft?.warnings || task?.discoveryWarnings || [];
    readOnlyTask = false;
    initialized = true;
    selectedChapterKey = null;
    $('preview').textContent = '尚无已保存正文';
    sourceOrigin = url.origin;
    sourcePath = url.pathname;
    $('connection').textContent = '当前来源：' + url.origin + url.pathname;
    $('product').value = draft?.product ?? task?.product ?? '';
    $('version').value = draft?.version ?? task?.version ?? '';
    clearError();
    if (profile) populateProfile();
    else {
      $('scope').value = url.pathname;
      $('toc-selector').value = '';
      $('content-selector').value = '';
      $('hash-mode').value = 'none';
      sampleSlots = [null, null];
      sampleProfileId = '';
      $('samples').textContent = '尚未选择示例章节；开始时会使用目录中的前两章验证';
      $('profile-status').textContent = '此来源尚未识别';
    }
    if (draft && !session.busy && !documentScans.has(session)) {
      $('scope').value = draft.scope;
      $('toc-selector').value = draft.toc;
      $('content-selector').value = draft.content;
      $('hash-mode').value = draft.hashMode;
      if (profile && draft.profile?.id === profile.id && (hasEditedRule || draft.samplesEdited)) {
        sampleSlots = [...draft.samples];
        sampleProfileId = profile.id;
        renderSamples();
      }
    }
    if (!isCurrent() || !sessionAvailable(session)) return;
    showMode(view);
    if (view === 'web' && operation === 'identify') showOperation('identify');
    render();
    if (view === 'web' && !session.busy && profile)
      await previewCurrent({
        sourceIO: session.io,
        sourceProfile: profile,
        sourceTabId: session.tabId,
        isCurrent: () => isCurrent() && sessionAvailable(session),
      });
  } catch (e) {
    if (isCurrent()) throw e;
  } finally {
    if (isCurrent()) {
      selectionPending = false;
      render();
    }
  }
}

async function captureCurrent() {
  return withTaskLock(async () => {
    const result = await io.current(profile);
    if (result.status !== 'ok' || !result.chapter)
      throw new Error(result.error || '不能确认当前章节，请核对目录选中状态');
    const chapter = result.chapter;
    if (task.pages[chapter.key] && !confirm('当前章已有保存内容，是否重新采集？')) return;
    engine = new ImportEngine(task, {
      discover: io.discover,
      capture: io.capture,
      save: saveTask,
      onChange: render,
    });
    engine.merge([chapter]);
    task.queue.find((c) => c.key === chapter.key).status = 'pending';
    await engine.run({ chapterKey: chapter.key });
    render();
  });
}

/** Apply edited identity/rules under the source and task locks before dispatch. */
async function startSelected({ retry = false, currentOnly = false } = {}) {
  if (!selectedSession) return locked(() => (currentOnly ? captureCurrent() : run(retry)));
  if (readOnlyTask || selectedSession.busy) return;
  const session = selectedSession;
  if (session.draft) {
    if (currentOnly || !canResumeSelectedDraft()) return;
    // The worker rechecks the original archive before accepting any failed scan
    // result. Do not save/adopt the displayed draft or reset its queue here.
    return session.start({ retry });
  }
  let prepared = false;
  await locked(async () => {
    await withTaskLock(async () => {
      if (!task.queue.length) {
        const result = await io.discover(profile, { expand: false });
        if (result.status === 'auth') throw new Error('登录已失效，请在来源页重新登录');
        if (result.status === 'error') throw new Error(result.error || '目录读取失败');
        const collector = new ImportEngine(task, {
          discover: io.discover,
          capture: io.capture,
          save: saveTask,
        });
        collector.merge(result.items || []);
        task.scanDiagnostics = result.diagnostics || {};
      }
      if (
        !currentOnly &&
        !profile.contentSelector &&
        task.validation?.signature !== ruleSignature(profile)
      )
        await verifyAndSave();
      if (retry) {
        const reviews = task.queue.filter(
          (c) =>
            c.status === 'review' ||
            (c.status === 'captured' && hasMissingExamples(task.pages?.[c.key || c.url])),
        );
        if (
          reviews.length &&
          confirm(
            `重新采集 ${reviews.length} 个待核对或样例缺失章节？成功后替换其已保存正文，失败保留原文。`,
          )
        )
          for (const c of reviews) c.status = 'pending';
      }
      await saveTask(task);
      await session.adopt(task, profile);
      prepared = true;
    });
  });
  if (prepared && session === selectedSession)
    await (currentOnly ? session.captureCurrent() : session.start({ retry }));
}
