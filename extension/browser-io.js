// 后台与来源页的操作桥梁：注入脚本、打开章节、核对选中项、展开正文并读取。
// createBrowserIO 为一个来源标签页建立操作集合；不负责数据库保存或整本队列推进。
import { normalizeDocumentURL, cleanChapter, ruleSignature, validateProfile } from './profiles.js';
import { classifyRecoveryError, recoveryError } from './recovery.js';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const navigationInterrupted = (error) =>
  /execution context (?:was )?(?:destroyed|removed)|frame (?:was )?removed|context invalidated|unload/i.test(
    error?.message || '',
  );
// Only explicit structural failures can end a navigation wait early. A missing
// tree or chapter can be transient while the next document replaces its DOM.
const legacyDirectoryErrors = new Set([
  '目录定位规则无效，请重新校准',
  '目录定位匹配多个普通区域，请重新校准',
  '目录必须限定为独立导航区域，请重新校准',
  '目录必须限定为独立导航区域，不能选择整页或正文',
  '目录与正文区域重叠，请重新校准',
  '目录与正文不能选择同一区域',
]);
function directoryFailureReason(proof) {
  if (!proof || proof.verified) return null;
  const reason = proof.reason || proof.fault?.message;
  if (proof.errorCode === 'DIRECTORY_INVALID') return reason || '目录结构无效，请重新校准';
  if (legacyDirectoryErrors.has(reason)) return reason;
  const matches = /^页面定位规则失效或不唯一：目录选择器 .* 匹配 (\d+) 个元素，请重新校准$/.exec(
    reason || '',
  );
  return matches && Number(matches[1]) > 1 ? reason : null;
}
const loginURL = (url) =>
  /\/(?:login|logon|signin|sign-in|sso)(?:[./_-]|$)/i.test(new URL(url).pathname);
function embeddedImageSources(page) {
  if (!(page.diagnostics?.images?.embedded > 0)) return [];
  return [...String(page.html || '').matchAll(/<img\b[^>]*>/gi)]
    .map(([tag]) =>
      tag
        .match(/(?:^|\s)src\s*=\s*(["'])(data:image\/[\w.+-]+;base64,[a-z0-9+/=\s]+)\1/i)?.[2]
        ?.replace(/\s/g, ''),
    )
    .filter(Boolean);
}
function checkSource(current, profile) {
  if (/^chrome-error:\/\//i.test(current.url || '')) {
    if (!current.pendingUrl || !normalizeDocumentURL(current.pendingUrl, profile))
      throw new Error('无法确认错误标签页仍属于手册范围，请重新连接原手册');
    throw recoveryError('手册页面处于网络错误状态', 'NETWORK_ERROR');
  }
  if (!current.url || new URL(current.url).origin !== profile.origin)
    throw new Error('原标签页已离开手册网站');
}
export function createBrowserIO(tabId) {
  async function tab() {
    try {
      return await chrome.tabs.get(tabId);
    } catch {
      throw new Error('原标签页已关闭，请从已登录的页面重新点击扩展');
    }
  }
  async function install() {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['tree.js', 'manual-adapters.js', 'capture.js'],
    });
    // File injection can finish without propagating page-side errors. Read the
    // adapter's explicit result before allowing detection, navigation or picking.
    const result = await chrome.scripting.executeScript({
      target: { tabId },
      args: [],
      func: () => globalThis.SecurityManualAdapterInstallError ?? null,
    });
    const message = result[0]?.result;
    if (typeof message !== 'string')
      throw new Error('无法确认文档读取器已加载，请刷新来源页后重试');
    if (message) throw new Error(message);
  }
  async function isRotating() {
    await install();
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      func: () =>
        Boolean(
          globalThis.SecurityNavigationRotation?.snapshot().running ||
          globalThis.SangforMenuRotation?.snapshot().running,
        ),
    });
    return r[0]?.result === true;
  }
  async function adapter(method, options) {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      args: [method, options],
      func: (name, args) => globalThis.SecurityManualAdapters[name](args),
    });
    return r[0]?.result;
  }
  async function state(profile, chapter) {
    const r = await chrome.scripting.executeScript({
      target: { tabId },
      args: [profile, chapter ?? null],
      func: (profile, chapter) => {
        const doc = profile.frameSelector
          ? document.querySelector(profile.frameSelector)?.contentDocument
          : document;
        const identities =
          globalThis.SecurityManualDocumentIdentities ||
          (globalThis.SecurityManualDocumentIdentities = new WeakMap());
        if (doc && !identities.has(doc)) identities.set(doc, crypto.randomUUID());
        const documentURL = doc
          ? globalThis.SecurityManualAdapters.normalizeURL(doc.URL, profile, doc.URL)
          : null;
        const proof =
          profile.frameSelector && chapter && !chapter.locator
            ? {
                verified: Boolean(
                  documentURL &&
                  documentURL ===
                    globalThis.SecurityManualAdapters.normalizeURL(chapter.url, profile),
                ),
                kind: 'frame-url',
              }
            : chapter
              ? globalThis.SecurityManualAdapters.verify({ profile, chapter })
              : null;
        return {
          documentId: doc ? identities.get(doc) : null,
          documentURL,
          body: globalThis.ManualCapture.readState({
            entry: profile.entry,
            profile,
            selector: profile.contentSelector,
          }),
          proof,
        };
      },
    });
    return r[0]?.result;
  }
  async function detect() {
    const current = await tab();
    if (!current.url || !/^https?:/.test(current.url))
      throw new Error('请在已登录的HTTP/HTTPS文档页点击扩展');
    await install();
    return adapter('detect', { entry: current.url });
  }
  async function discover(profile, { expand = true } = {}) {
    const current = await tab();
    checkSource(current, profile);
    if (loginURL(current.url)) return { status: 'auth' };
    await install();
    if ((await state(profile))?.body.auth) return { status: 'auth' };
    return adapter('discover', { profile, expand });
  }
  async function current(profile) {
    const selected = await tab();
    checkSource(selected, profile);
    if (loginURL(selected.url)) return { status: 'auth' };
    if (!normalizeDocumentURL(selected.url, profile))
      throw new Error('已离开手册范围，请检查登录或重新校准');
    await install();
    if ((await state(profile))?.body.auth) return { status: 'auth' };
    return adapter('current', { profile });
  }
  async function recover(profile) {
    let current = await tab();
    const browserError = /^chrome-error:\/\//i.test(current.url || '');
    const sameOrigin = current.url && new URL(current.url).origin === profile.origin;
    if (sameOrigin && loginURL(current.url)) return { status: 'auth' };
    if (browserError) {
      if (!current.pendingUrl || !normalizeDocumentURL(current.pendingUrl, profile))
        throw new Error('无法确认错误标签页仍属于手册范围，请在手册页重新点击扩展');
    } else {
      if (!sameOrigin) throw new Error('原标签页已离开手册网站');
      if (!normalizeDocumentURL(current.url, profile))
        throw new Error('已离开手册范围，请检查登录或重新校准');
      // Inline login forms must be left available for the user to finish signing in.
      try {
        await install();
        if ((await state(profile))?.body.auth) return { status: 'auth' };
      } catch (error) {
        if (!classifyRecoveryError(error).retryable) throw error;
      }
    }
    const entry = normalizeDocumentURL(profile.entry, profile);
    if (!entry) throw new Error('手册入口不在已保存的范围内，请重新校准');
    await chrome.tabs.update(tabId, { url: entry });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      await delay(180);
      current = await tab();
      if (/^chrome-error:\/\//i.test(current.url || ''))
        throw recoveryError('手册页面仍处于网络错误状态', 'NETWORK_ERROR');
      if (!current.url || new URL(current.url).origin !== profile.origin)
        throw new Error('页面跳转到其他来源，已停止');
      if (loginURL(current.url)) return { status: 'auth' };
      if (current.status !== 'complete') continue;
      if (!normalizeDocumentURL(current.url, profile))
        throw new Error('已离开手册范围，请检查登录或重新校准');
      try {
        await install();
        if ((await state(profile))?.body.auth) return { status: 'auth' };
        return { status: 'ok' };
      } catch (error) {
        if (navigationInterrupted(error)) continue;
        throw error;
      }
    }
    throw recoveryError('等待手册重新连接超时，将在下一轮恢复时重试', 'LOAD_TIMEOUT');
  }
  const bindingFailure = (result) =>
    Object.assign(new Error(result.error || '页面定位规则失效，请重新校准'), {
      fault: result.fault,
      stage: 'check-regions',
    });
  async function bindingCandidate(profile) {
    const original = await adapter('bindings', { profile });
    if (!original) throw new Error('未收到页面定位检查结果，请重新连接');
    let candidate = original.profile || profile;
    if (original.status !== 'ok') {
      // Ambiguity and inaccessible frames require explicit calibration. Missing
      // regions may be rediscovered, but only against the existing chapter set.
      if (
        !original.issues?.length ||
        original.issues.some((issue) => issue.count !== 0 || issue.region === 'frame')
      )
        throw bindingFailure(original);
      const detected = await adapter('detect', { entry: profile.entry });
      if (
        !detected?.profile ||
        detected.profile.adapterId !== profile.adapterId ||
        (detected.profile.frameSelector || '') !== (profile.frameSelector || '')
      )
        throw bindingFailure(original);
      candidate = { ...profile };
      for (const issue of original.issues)
        candidate[issue.region + 'Selector'] = detected.profile[issue.region + 'Selector'];
      if (!candidate.tocSelector || (profile.contentSelector && !candidate.contentSelector))
        throw bindingFailure(original);
    }
    candidate = validateProfile(candidate);
    const checked = await adapter('bindings', { profile: candidate });
    if (checked?.status !== 'ok') throw bindingFailure(checked || {});
    return { profile: validateProfile(checked.profile), multiRoot: checked.directoryRoots > 1 };
  }
  // Reopening a click-driven manual may need to prove a known selected chapter
  // before its stale bindings can be repaired. This never navigates or persists.
  async function boundCurrent(profile) {
    const selected = await current(profile);
    if (selected?.status !== 'error') return selected;
    const { profile: candidate } = await bindingCandidate(profile);
    return adapter('current', { profile: candidate });
  }
  /** Rebind only missing regions, inside the old scope, after proving the old queue. */
  async function prepare(profile, chapters, { shouldContinue = () => true } = {}) {
    const check = () => {
      if (!shouldContinue()) throw recoveryError('采集已暂停', 'CANCELLED');
    };
    const current = await tab();
    checkSource(current, profile);
    if (loginURL(current.url)) return { status: 'auth' };
    await install();
    if ((await state(profile))?.body.auth) return { status: 'auth' };
    check();
    let { profile: candidate, multiRoot } = await bindingCandidate(profile);
    if (
      candidate.adapterId !== 'sangfor' &&
      !multiRoot &&
      ruleSignature(candidate) === ruleSignature(profile)
    )
      return { status: 'ok', changed: false, profile };
    check();
    const known = (chapters || []).map((chapter) => cleanChapter(chapter, profile));
    const scopeChanged = candidate.tocSelector !== profile.tocSelector;
    const proveDirectory = async () => {
      check();
      const found = await adapter('discover', { profile: candidate, expand: false });
      check();
      const diagnostics = found?.diagnostics || {};
      if (
        !found ||
        found.status === 'error' ||
        diagnostics.truncated ||
        diagnostics.ambiguousPaths ||
        diagnostics.pendingBranches ||
        diagnostics.incompleteNodes
      )
        throw new Error('重新识别的目录不完整或有歧义，未更新原任务，请重新校准');
      const observed = (found.items || []).map((chapter) => cleanChapter(chapter, candidate));
      const byKey = new Map(observed.map((chapter) => [chapter?.key, chapter]));
      if (
        known.length < 2 ||
        observed.some((chapter) => !chapter) ||
        byKey.size !== observed.length ||
        known.some((chapter) => !chapter || byKey.get(chapter.key)?.title !== chapter.title) ||
        (scopeChanged && byKey.size !== new Set(known.map((chapter) => chapter?.key)).size)
      )
        throw new Error('重新识别的目录与原任务章节不一致，未更新原任务，请重新校准');
    };
    await proveDirectory();
    // Legacy Ext readers ignored the configured scope, even for a single root.
    // Re-prove the saved queue; multi-root directories also exercise both ends.
    const samples = multiRoot ? [known[0], known.at(-1)] : known.slice(0, 2);
    candidate = { ...candidate, samples };
    await verifySamples(candidate, { shouldContinue });
    check();
    // Sample navigation can recreate containers. Do not accept a selector that
    // only worked on the initial page, even when both sample bodies were read.
    const final = await adapter('bindings', { profile: candidate });
    if (final?.status !== 'ok' || ruleSignature(final.profile) !== ruleSignature(candidate))
      throw bindingFailure(final || {});
    await proveDirectory();
    return { status: 'ok', changed: true, verified: true, profile: candidate };
  }
  async function pick(kind, profile) {
    await install();
    return adapter('pick', { kind, profile });
  }
  // 单章流程：打开章节 → 证明已切换并稳定 → 准备正文 → 重新稳定 → 提取与复核。
  // 目录选中只是其中一个条件，不能把上一章尚未替换的正文保存为当前章。
  async function capture(chapter, profile) {
    const captureStarted = Date.now();
    let current = await tab();
    checkSource(current, profile);
    if (loginURL(current.url)) return { status: 'auth' };
    await install();
    const before = await state(profile, chapter);
    if (before?.body.auth) return { status: 'auth' };
    // A page-side failure arrives as a reason string; keep the structured fault
    // that the adapter captured so the real cause survives the script boundary.
    if (chapter.locator) {
      try {
        const result = await adapter('open', { profile, chapter });
        if (!result?.clicked)
          throw Object.assign(new Error(result?.reason || '无法唯一打开所选章节'), {
            fault: result?.fault,
            stage: 'open-directory',
            chapterKey: chapter.key,
          });
      } catch (error) {
        if (!navigationInterrupted(error))
          throw Object.assign(error, {
            stage: error.stage || 'open-directory',
            chapterKey: error.chapterKey ?? chapter.key,
          });
      }
    } else {
      const target = normalizeDocumentURL(chapter.url, profile);
      if (!target) throw new Error('章节不在手册范围内');
      if (profile.frameSelector) {
        await chrome.scripting.executeScript({
          target: { tabId },
          args: [profile.frameSelector, target, profile.origin],
          func: (selector, target, origin) => {
            const frames = document.querySelectorAll(selector);
            if (frames.length !== 1 || !frames[0].matches('iframe,frame'))
              throw new Error('无法唯一定位文档框架');
            const frame = frames[0],
              doc = frame.contentDocument;
            if (!doc || new URL(target).origin !== origin || location.origin !== origin)
              throw new Error('文档框架或目标不同源');
            if (doc.URL !== 'about:blank' && new URL(doc.URL).origin !== origin)
              throw new Error('文档框架不同源');
            frame.contentWindow.location.assign(target);
            return { navigated: true };
          },
        });
      } else await chrome.tabs.update(tabId, { url: target });
    }
    const start = Date.now();
    // 换章等待与正文展开分开计时，避免一分钟的展开预算被45秒换章期限抵消。
    let deadline = start + 45000;
    let signature = '',
      stableSince = 0,
      installed = false,
      lastBlockers = [],
      lastFault = null,
      directoryError = null,
      preparedDocument = null,
      preparation = null;
    await delay(180);
    while (Date.now() < deadline) {
      current = await tab();
      if (/^chrome-error:\/\//i.test(current.url || ''))
        throw recoveryError('手册页面处于网络错误状态', 'NETWORK_ERROR');
      if (!current.url || new URL(current.url).origin !== profile.origin)
        throw new Error('页面跳转到其他来源，已停止');
      if (loginURL(current.url)) return { status: 'auth' };
      if (current.status !== 'complete') {
        directoryError = null;
        installed = false;
        await delay(160);
        continue;
      }
      if (!normalizeDocumentURL(current.url, profile))
        throw new Error('已离开手册范围，请检查登录或重新校准');
      if (
        !chapter.locator &&
        !profile.frameSelector &&
        normalizeDocumentURL(current.url, profile) !== chapter.url
      ) {
        directoryError = null;
        await delay(160);
        continue;
      }
      let observed;
      try {
        if (!installed) {
          await install();
          installed = true;
        }
        observed = await state(profile, chapter);
      } catch (error) {
        if (navigationInterrupted(error)) {
          directoryError = null;
          installed = false;
          await delay(160);
          continue;
        }
        throw Object.assign(error, {
          stage: error.stage || 'read-state',
          chapterKey: error.chapterKey ?? chapter.key,
        });
      }
      if (observed?.body.auth) return { status: 'auth' };
      if (
        preparedDocument &&
        (observed?.documentId !== preparedDocument || !observed?.proof?.verified)
      )
        throw new Error('展开正文后页面或章节已变化，未保存该页');
      const observedFault = observed?.proof?.fault || observed?.body?.fault || null;
      if (observedFault) lastFault = observedFault;
      const directoryReason = directoryFailureReason(observed?.proof);
      if (
        directoryReason &&
        observed.documentId &&
        observed.body.nonEmpty &&
        !observed.body.loading &&
        !observed.body.fault
      ) {
        const key = JSON.stringify([
          directoryReason,
          observed.documentId,
          observed.documentURL || current.url,
          observed.body.signature,
        ]);
        if (directoryError?.key !== key) directoryError = { key, since: Date.now() };
        // DOM replacement can briefly overlap old/new trees. Require the same
        // failure and body in one document for a full stability interval.
        if (Date.now() - directoryError.since >= 1200)
          throw Object.assign(new Error(directoryReason), {
            code: 'DIRECTORY_INVALID',
            stage: 'verify-directory',
            chapterKey: chapter.key,
            fault: observed.proof.fault,
          });
      } else directoryError = null;
      const changed = observed?.body.signature !== before?.body.signature;
      const newDocument = Boolean(
        before?.documentId && observed?.documentId && before.documentId !== observed.documentId,
      );
      const switched = newDocument || before?.proof?.verified || changed;
      const blockers = [
        !observed?.proof?.verified && '目录选中未确认',
        !observed.body.nonEmpty && '正文为空',
        observed.body.loading && '仍在加载',
        !switched && '正文未变化',
      ].filter(Boolean);
      lastBlockers = blockers;
      const ready =
        observed?.proof?.verified && observed.body.nonEmpty && !observed.body.loading && switched;
      if (!ready) {
        signature = '';
        stableSince = 0;
        await delay(160);
        continue;
      }
      if (signature !== observed.body.signature) {
        signature = observed.body.signature;
        stableSince = Date.now();
      }
      if (Date.now() - stableSince >= 600 && Date.now() - start >= 1200) {
        if (!preparation) {
          const preparationStarted = Date.now();
          const reply = await chrome.scripting.executeScript({
            target: { tabId },
            args: [
              {
                entry: profile.entry,
                profile,
                selector: profile.contentSelector,
                chapter,
                ...(chapter.locator ? { locator: chapter.locator } : {}),
              },
            ],
            func: (options) => globalThis.ManualCapture.prepareContent(options),
          });
          // prepareContent 自身执行60秒总预算及单项等待限制；其耗时不占用换章预算。
          deadline += Date.now() - preparationStarted;
          preparation = reply[0]?.result;
          if (preparation?.status === 'auth') return preparation;
          if (preparation?.status !== 'ok')
            throw Object.assign(new Error(preparation?.error || '未收到正文展开结果'), {
              stage: 'expand-content',
              chapterKey: chapter.key,
              fault: preparation?.diagnostics?.fault,
            });
          const afterPreparation = await state(profile, chapter);
          if (
            afterPreparation?.documentId !== observed.documentId ||
            !afterPreparation?.proof?.verified
          )
            throw new Error('展开正文时页面或章节已变化，未保存该页');
          preparedDocument = observed.documentId;
          // Disclosure changes are not evidence of navigation. The target body
          // was proven above; now establish a fresh stable extraction baseline.
          if (
            preparation.clicked ||
            afterPreparation.body.signature !== signature ||
            afterPreparation.body.loading
          ) {
            signature = '';
            stableSince = 0;
            continue;
          }
        }
        const navigationFinished = Date.now();
        const r = await chrome.scripting.executeScript({
          target: { tabId },
          args: [
            {
              entry: profile.entry,
              profile,
              selector: profile.contentSelector,
              chapter,
              ...(chapter.locator ? { locator: chapter.locator } : {}),
              expectedURL: current.url,
              chapterTitle: chapter.title,
              requireExpanded: true,
            },
          ],
          func: (options) => globalThis.ManualCapture.capture(options),
        });
        const result = r[0]?.result;
        if (!result) throw new Error('页面未返回正文');
        if (result.status === 'ok') {
          const final = await state(profile, chapter);
          if (!final?.proof?.verified) throw new Error('正文读取后目录选中状态已变化');
          if (
            final.body.loading ||
            !final.body.nonEmpty ||
            final.body.signature !== signature ||
            final.documentId !== observed.documentId
          ) {
            signature = '';
            stableSince = 0;
            continue;
          }
          result.navigationProof = final.proof;
          if (profile.frameSelector && !chapter.locator) result.url = final.documentURL;
          result.title = chapter.title || result.title;
        }
        result.diagnostics = {
          ...result.diagnostics,
          disclosures: {
            ...result.diagnostics?.disclosures,
            clicked: (preparation.clicked || 0) + (result.diagnostics?.disclosures?.clicked || 0),
          },
          timing: {
            ...result.diagnostics?.timing,
            navigationMs: navigationFinished - captureStarted,
            totalMs: Date.now() - captureStarted,
          },
        };
        if (lastFault && !result.diagnostics?.fault)
          result.diagnostics = { ...result.diagnostics, fault: lastFault };
        return result;
      }
      await delay(160);
    }
    // A bare timeout tells the user nothing about which proof never arrived.
    throw recoveryError(
      `45秒内未确认章节和正文完成切换，未保存旧正文${lastBlockers.length ? `（最后未满足：${lastBlockers.join('、')}）` : ''}`,
      'LOAD_TIMEOUT',
    );
  }
  async function verifySamples(profile, { shouldContinue = () => true } = {}) {
    if (profile.samples?.length !== 2 || profile.samples[0].key === profile.samples[1].key)
      throw new Error('请选取两个不同的示例章节');
    async function sample(chapter) {
      if (!shouldContinue()) throw recoveryError('采集已暂停', 'CANCELLED');
      const page = await capture(chapter, profile);
      if (!shouldContinue()) throw recoveryError('采集已暂停', 'CANCELLED');
      if (page.status === 'auth')
        throw recoveryError('登录已失效，等待用户登录后恢复', 'AUTH_REQUIRED');
      if (page.status !== 'ok')
        throw recoveryError(
          page.error || page.diagnostics?.reason || '示例章节读取失败，请检查登录或重新点选',
          page.code,
        );
      return page;
    }
    const first = await sample(profile.samples[0]),
      second = await sample(profile.samples[1]);
    if (String(first.text || '').trim() === String(second.text || '').trim()) {
      const firstImages = embeddedImageSources(first),
        secondImages = embeddedImageSources(second);
      const realImageChange = JSON.stringify(firstImages) !== JSON.stringify(secondImages);
      const imageOnly = !String(first.text || '').trim();
      if (!realImageChange || (imageOnly && (!firstImages.length || !secondImages.length)))
        throw new Error('两个示例正文相同，尚不能确认文字或已保存图片发生切换；请选择不同章节');
    }
    return { verified: true, previews: [first, second] };
  }
  return {
    tab,
    install,
    isRotating,
    adapter,
    state,
    detect,
    discover,
    current,
    boundCurrent,
    recover,
    prepare,
    pick,
    capture,
    verifySamples,
  };
}
