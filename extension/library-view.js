/** Saved-library presentation only. The panel owns persistence, locks and confirmations. */
export function renderLibrary({
  document,
  items,
  taskState,
  stamp,
  ago,
  onOpen,
  onExport,
  onDelete,
}) {
  const $ = (id) => document.getElementById(id);
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty-hint';
    li.textContent = '还没有保存的任务。';
    $('task-list').replaceChildren(li);
    return;
  }
  $('task-list').replaceChildren(
    ...items.map((t) => {
      const captured = t.queue.filter((c) => c.status === 'captured').length,
        total = t.queue.length;
      const li = document.createElement('li');
      li.className = 'task-item';
      const open = document.createElement('button');
      open.className = 'task-open';
      for (const text of [
        `${t.product || '未命名'} · ${t.version || '未知'}`,
        `${t.sourceKind === 'openapi' ? '规范文件' : '在线手册'} · 已保存 ${captured}/${total} 章 · ${taskState(t)}${t.errorLog?.length ? ` · 错误 ${t.errorLog.length} 条` : ''}`,
        `来源 ${t.entry || '未知'}`,
        `更新 ${stamp(t.updatedAt)}（${ago(t.updatedAt)}） · 创建 ${stamp(t.createdAt)}`,
      ]) {
        const span = document.createElement('span');
        span.textContent = text;
        open.append(span);
      }
      // A specification task is local, so it can always be opened; a web task needs
      // the control page that is bound to the same manual tab.
      // Every saved task is listed and selectable; binding is decided by checkBind
      // at click time, not by comparing origins in the list.
      open.disabled = false;
      open.title =
        t.sourceKind === 'web'
          ? '打开这个任务；若当前标签页不是该手册，会先检查来源、手册范围、登录状态与采集规则'
          : '在控制页打开这个规范任务';
      open.onclick = () => onOpen(t);
      const save = document.createElement('button');
      save.textContent = '导出 JSON';
      save.className = 'quiet';
      save.onclick = () => onExport(t);
      const drop = document.createElement('button');
      drop.textContent = '删除';
      drop.className = 'quiet danger';
      drop.onclick = () => onDelete(t);
      const actions = document.createElement('div');
      actions.className = 'task-actions';
      actions.append(save, drop);
      li.append(open, actions);
      return li;
    }),
  );
}

export function libraryPageSize(document) {
  const window = document.defaultView;
  const list = document.getElementById('task-list');
  const style = window.getComputedStyle(list);
  const rowHeight =
    Number.parseFloat(style.getPropertyValue('--task-row-height')) ||
    (window.innerWidth <= 700 ? 128 : 96);
  const columns =
    Number.parseInt(style.getPropertyValue('--task-columns'), 10) ||
    (window.innerWidth <= 999 ? 1 : 2);
  return Math.max(1, Math.floor((list.clientHeight || rowHeight * 3) / rowHeight)) * columns;
}
