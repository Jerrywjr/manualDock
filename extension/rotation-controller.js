import { redact } from './recovery.js';

// The background runtime owns timers and progress; source documents only validate and
// dispatch a single click. No selected UI source or active panel is consulted.
export function createRotationController({
  chrome,
  onChange = () => {},
  locks = globalThis.navigator?.locks,
  timers = globalThis,
  now = () => Date.now(),
}) {
  const runs = new Map();
  let disposed = false;
  const idle = () => ({
    running: false,
    count: 0,
    lastLabel: '',
    nextLabel: '',
    nextAt: null,
    intervalMs: 60000,
    message: '尚未启动导航轮换',
    status: 'stopped',
  });
  const active = (run) => !disposed && runs.get(run.tabId) === run && run.state.running;
  const view = (run) => ({ ...(run?.state || idle()) });
  function emit(run) {
    try {
      onChange(run.tabId, view(run));
    } catch {
      /* UI rendering must not own scheduling. */
    }
  }
  function release(run) {
    run.release?.();
    run.release = null;
  }
  function finish(run, message, status = 'stopped') {
    timers.clearTimeout(run.timer);
    run.timer = null;
    Object.assign(run.state, { running: false, nextAt: null, message: redact(message), status });
    if (!run.inFlight) release(run);
    emit(run);
  }
  function inScope(run, raw) {
    try {
      const url = new URL(raw),
        prefix = run.config.pathPrefix;
      return (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.origin === run.config.origin &&
        typeof prefix === 'string' &&
        (prefix === '/' ||
          url.pathname === prefix ||
          url.pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/'))
      );
    } catch {
      return false;
    }
  }
  async function source(run) {
    let tab;
    try {
      tab = await chrome.tabs.get(run.tabId);
    } catch {
      throw new Error('来源标签页已关闭，轮换停止');
    }
    if (!inScope(run, tab.pendingUrl || tab.url))
      throw new Error('来源页已离开指定站点或路径范围，轮换停止');
    return tab;
  }
  async function invoke(run, method, inject = true) {
    if (inject) {
      await chrome.scripting.executeScript({
        target: { tabId: run.tabId },
        files: ['navigation-discovery.js', 'navigation-rotation.js'],
      });
      if (!active(run)) return null;
    }
    const response = await chrome.scripting.executeScript({
      target: { tabId: run.tabId },
      args: [
        method,
        run.config,
        { runId: run.id, index: run.index, count: run.state.count, nextAt: run.state.nextAt },
      ],
      func: (method, config, progress) => {
        const runner = globalThis.SecurityNavigationRotation;
        if (!runner) return { running: false, message: '来源页的轮换器尚未加载，请重试' };
        if (typeof runner.prepare !== 'function' || typeof runner.execute !== 'function')
          return {
            running: false,
            message: '来源页仍使用旧版轮换器，请先停止旧轮换并刷新来源页后重试',
          };
        return method === 'stopManaged'
          ? runner.stopManaged(progress.runId)
          : runner[method](config, progress);
      },
    });
    return response[0]?.result;
  }
  async function cleanPage(run) {
    try {
      await invoke(run, 'stopManaged', false);
    } catch {
      /* Closed or replaced documents need no cleanup. */
    }
  }
  async function claim(run) {
    if (!locks?.request) throw new Error('浏览器无法锁定来源页，轮换未启动');
    return new Promise((resolve, reject) => {
      locks
        .request('source-tab:' + run.tabId, { ifAvailable: true }, async (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          if (!active(run)) {
            resolve(false);
            return;
          }
          await new Promise((done) => {
            run.release = done;
            resolve(true);
          });
        })
        .catch(reject);
    });
  }
  function schedule(run, delay = run.state.intervalMs) {
    if (!active(run)) return;
    timers.clearTimeout(run.timer);
    run.state.nextAt = now() + delay;
    run.timer = timers.setTimeout(() => {
      run.timer = null;
      run.operation = step(run);
      return run.operation;
    }, delay);
    emit(run);
  }
  async function step(run) {
    if (!active(run) || run.inFlight) return;
    run.inFlight = true;
    try {
      const tab = await source(run);
      if (!active(run)) return;
      if (tab.status !== 'complete') {
        run.waitingSince ??= now();
        if (now() - run.waitingSince >= 30000)
          throw new Error('等待来源页加载超时，轮换停止；页面就绪后可重新开始');
        Object.assign(run.state, {
          status: 'waiting',
          message: '来源页正在导航或刷新，等待加载完成后继续',
        });
        schedule(run, 500);
        return;
      }
      run.waitingSince = null;
      const result = await invoke(run, 'execute');
      if (!active(run)) return;
      if (!result?.clicked)
        throw new Error(result?.message || '无法确认导航点击结果，轮换停止；请检查来源页');
      run.state.count++;
      run.state.lastLabel = run.config.targets[run.index].title;
      run.index = (run.index + 1) % run.config.targets.length;
      run.state.nextLabel = run.config.targets[run.index].title;
      if (result.stopRequested) {
        finish(run, '已在来源页停止导航轮换');
        return;
      }
      if (!result.running && !result.pageHidden)
        throw new Error(result.message || '来源页已停止轮换，请重新检查导航');
      // pagehide may make the old document report running=false after its click;
      // only the workspace owns the next step. Scope is checked again before it.
      Object.assign(run.state, {
        status: 'running',
        message: `已点击“${run.state.lastLabel}”；轮换持续运行`,
      });
      schedule(run);
    } catch (error) {
      if (active(run)) {
        const message = /execution context|frame.*removed|context invalidated/i.test(
          error.message || '',
        )
          ? '页面在点击期间发生导航，无法确认点击结果；轮换停止，请检查页面后重新开始'
          : error.message || '轮换执行失败，已停止';
        finish(run, message, 'error');
        await cleanPage(run);
      }
    } finally {
      run.inFlight = false;
      if (!active(run)) release(run);
    }
  }
  async function begin(run) {
    run.inFlight = true;
    try {
      if (!(await claim(run))) {
        if (active(run)) throw new Error('该来源页正在采集或轮换，请先停止当前操作');
        return;
      }
      if (!active(run)) return;
      const tab = await source(run);
      if (tab.status !== 'complete') throw new Error('来源页尚未加载完成，请稍后开始轮换');
      if (!active(run)) return;
      const result = await invoke(run, 'prepare');
      if (!active(run)) return;
      if (!result?.running) throw new Error(result?.message || '无法确认来源页轮换器已就绪');
      run.state.intervalMs = result.intervalMs;
      run.state.nextLabel = run.config.targets[run.index].title;
      Object.assign(run.state, {
        status: 'running',
        message: '导航轮换已启动；刷新或关闭控制页不会停止',
      });
      schedule(
        run,
        run.resumeAt == null ? run.state.intervalMs : Math.max(1, run.resumeAt - now()),
      );
    } catch (error) {
      if (active(run)) {
        finish(run, error.message || '轮换启动失败', 'error');
        await cleanPage(run);
      }
    } finally {
      run.inFlight = false;
      if (!active(run)) release(run);
    }
  }
  async function start(tabId, config, resume = null) {
    if (disposed) return { ...idle(), message: '工作台已关闭，无法开始轮换' };
    const previous = runs.get(tabId);
    if (previous?.state.running) {
      await previous.operation;
      return view(previous);
    }
    if (previous?.stopOperation) await previous.stopOperation;
    else if (previous?.operation) await previous.operation;
    if (disposed) return { ...idle(), message: '工作台已关闭，无法开始轮换' };
    const current = runs.get(tabId);
    if (current !== previous && current?.state.running) {
      await current.operation;
      return view(current);
    }
    let selected;
    try {
      selected = structuredClone(config);
    } catch {
      return { ...idle(), status: 'error', message: '轮换配置必须是可序列化的数据' };
    }
    const run = {
      tabId,
      id: resume?.id || crypto.randomUUID(),
      config: selected,
      index:
        Number.isInteger(resume?.index) &&
        resume.index >= 0 &&
        resume.index < selected.targets.length
          ? resume.index
          : 0,
      resumeAt: Number.isFinite(resume?.nextAt) ? resume.nextAt : null,
      timer: null,
      state: {
        ...idle(),
        count: Number.isFinite(resume?.count) ? resume.count : 0,
        running: true,
        status: 'starting',
        message: '正在校验来源页与导航菜单',
      },
    };
    runs.set(tabId, run);
    emit(run);
    run.operation = begin(run);
    await run.operation;
    return view(run);
  }
  async function stop(tabId) {
    const run = runs.get(tabId);
    if (!run) return idle();
    if (run.stopOperation) return run.stopOperation;
    // Publish the cleanup promise before reporting stopped, so a restart from
    // either the UI or onChange cannot race the old document's managed owner.
    run.stopOperation = Promise.resolve().then(async () => {
      await run.operation;
      await cleanPage(run);
      release(run);
      return view(run);
    });
    finish(run, '已停止导航轮换');
    return run.stopOperation;
  }
  function onMessage(message, sender) {
    if (message?.type !== 'manualdock:rotation-stop' || sender?.id !== chrome.runtime.id) return;
    const run = runs.get(sender.tab?.id);
    if (run?.id !== message.runId || !active(run)) return;
    void stop(run.tabId);
  }
  function onRemoved(tabId) {
    const run = runs.get(tabId);
    if (run) finish(run, '来源标签页已关闭，轮换停止');
  }
  chrome.runtime?.onMessage?.addListener(onMessage);
  chrome.tabs?.onRemoved?.addListener(onRemoved);
  return {
    start,
    stop,
    resumeData(tabId) {
      const run = runs.get(tabId);
      return run
        ? { id: run.id, index: run.index, count: run.state.count, nextAt: run.state.nextAt }
        : null;
    },
    async snapshot(tabId) {
      return view(runs.get(tabId));
    },
    async dispose() {
      disposed = true;
      chrome.runtime?.onMessage?.removeListener(onMessage);
      chrome.tabs?.onRemoved?.removeListener(onRemoved);
      await Promise.all([...runs.keys()].map(stop));
    },
  };
}
