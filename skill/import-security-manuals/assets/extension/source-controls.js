import { connectSourceURL, resolveSourcePurpose } from './source-connector.js';
import { redact } from './recovery.js';

/** URL entry and source selection only; collection is an explicit separate action. */
export function setupSourceControls({
  document,
  getController,
  getSelected,
  getView,
  onSelect,
  onError = () => {},
  canSwitch = () => true,
  connectURL = connectSourceURL,
}) {
  const $ = (id) => document.getElementById(id);
  const form = $('source-connect-form'),
    field = $('source-url'),
    button = $('source-connect'),
    select = $('source-select'),
    status = $('source-connect-status');
  let pending = false,
    disposed = false,
    previousView = null;
  const viewPurpose = () => (getView() === 'rotation' ? 'rotation' : 'document');
  function refresh() {
    if (disposed) return;
    const purpose = viewPurpose();
    if (previousView !== getView()) {
      previousView = getView();
      status.textContent =
        purpose === 'rotation'
          ? '在此栏目连接管理页；文档请在“识别与校准”连接，已知文档地址会自动跳转。'
          : '文档页用于识别与采集，菜单轮换在后台独立运行。';
    }
    field.placeholder = purpose === 'rotation' ? '粘贴管理页面 URL' : '粘贴文档页面 URL';
    updateButton();
    const sessions = (getController()?.listSessions() || []).filter(
      (session) => (session.purpose || 'document') === purpose,
    );
    const label = $('source-select-label');
    if (label) label.textContent = purpose === 'rotation' ? '轮换管理页' : '文档来源';
    const selected = getSelected()?.tabId;
    select.replaceChildren(
      new document.defaultView.Option('请选择已连接的页面', ''),
      ...sessions.map((session) => {
        const state = session.getState();
        const unavailable = session.disposed ? '已移除 · ' : session.closed ? '已关闭 · ' : '';
        const option = new document.defaultView.Option(
          redact(`${unavailable}${state.product || '页面'} · ${state.address}`),
          String(session.tabId),
        );
        option.disabled = session.disposed || (session.closed && session.purpose !== 'rotation');
        return option;
      }),
    );
    select.value = sessions.some((session) => session.tabId === selected) ? String(selected) : '';
    select.disabled = pending || !sessions.length || !canSwitch();
    button.disabled = pending || !canSwitch();
    field.disabled = pending;
  }
  function updateButton() {
    const purpose = resolveSourcePurpose(field.value, viewPurpose());
    button.textContent = pending
      ? '正在连接…'
      : purpose === 'rotation'
        ? '连接管理页'
        : '连接文档页';
  }
  function purposeHint() {
    if (disposed || pending) return;
    updateButton();
    const known = resolveSourcePurpose(field.value, null);
    status.textContent =
      known === 'document'
        ? '已识别为文档地址，连接后进入识别与校准；不会自动采集。'
        : known === 'rotation'
          ? '已识别为管理页地址，连接后进入菜单轮换。'
          : `此页面按当前栏目连接：${viewPurpose() === 'rotation' ? '菜单轮换' : '文档采集'}。`;
  }
  async function submit(event) {
    event.preventDefault();
    if (pending || !canSwitch()) return;
    const controller = getController();
    if (!controller) return;
    const raw = field.value;
    const requestedPurpose = resolveSourcePurpose(raw, viewPurpose());
    pending = true;
    refresh();
    status.textContent = '正在请求该网站的访问权限并连接页面…';
    try {
      // Call directly in the submit gesture: do not await UI or storage first.
      const connection = connectURL(raw, {
        preferredTabIds: controller
          .listSessions()
          .filter((s) => !s.closed && !s.disposed)
          .map((s) => s.tabId),
        canCreate: () => controller.canAddSource(),
      });
      const tab = await connection;
      if (disposed) return;
      const purpose = resolveSourcePurpose(tab.url, requestedPurpose);
      const session = await controller.addSource(tab.id, { purpose });
      if (!session) throw new Error('来源未能加入工作台，请先移除一个已暂停的来源');
      await onSelect(session, {
        view: session.purpose === 'rotation' ? 'rotation' : 'web',
        operation: 'identify',
      });
      status.textContent =
        session.purpose === 'rotation'
          ? '管理页已连接，仅用于菜单轮换。'
          : '文档已连接，请先快速识别目录或手动校准，再开始采集。';
    } catch (error) {
      status.textContent = redact(error.message || String(error));
      onError(error);
    } finally {
      pending = false;
      refresh();
    }
  }
  async function change() {
    if (pending || !canSwitch()) {
      refresh();
      return;
    }
    const session = getController()
      ?.listSessions()
      .find((item) => item.tabId === Number(select.value));
    if (!session) return;
    try {
      await onSelect(session, { view: getView() });
    } catch (error) {
      onError(error);
    } finally {
      refresh();
    }
  }
  form.addEventListener('submit', submit);
  select.addEventListener('change', change);
  field.addEventListener('input', purposeHint);
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      form.removeEventListener('submit', submit);
      select.removeEventListener('change', change);
      field.removeEventListener('input', purposeHint);
    },
  };
}
