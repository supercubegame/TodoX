'use strict';
// 界面只做两件事：把主进程给的数据画出来，把用户意图发回去。
// 业务规则一条都不许住在这里 —— 那样规则会有两份，而只有一份是被断言过的。
(function () {
  const api = window.todox;
  const $ = (id) => document.querySelector(`[data-testid="${id}"]`);

  const ui = {
    view: { filter: 'all', query: '' },
    todos: [],
    counts: { total: 0, active: 0, completed: 0 },
    settings: null,
    editingId: null,
    pendingDeleteId: null,
    renderCount: 0,
    ready: false,
    lastError: null
  };

  // ------------------------------------------------------------ 诊断出口
  // 只读。字段可以增加，不能删改 —— 端到端闸门认这些名字。
  Object.defineProperty(window, '__DIAG__', {
    value: Object.freeze({
      get ready() { return ui.ready; },
      get counts() { return Object.assign({}, ui.counts); },
      get rendered() { return ui.todos.length; },
      get renderCount() { return ui.renderCount; },
      get settings() { return ui.settings === null ? null : Object.assign({}, ui.settings); },
      get view() { return Object.assign({}, ui.view); },
      get editingId() { return ui.editingId; },
      get lastError() { return ui.lastError === null ? null : Object.assign({}, ui.lastError); },
      get schema() { return 1; }
    }),
    writable: false,
    configurable: false,
    enumerable: true
  });

  // ------------------------------------------------------------ 与主进程通话
  async function call(fn) {
    const res = await fn();
    if (res && res.ok === true) {
      ui.lastError = null;
      $('error').hidden = true;
      apply(res.data);
      return true;
    }
    ui.lastError = res && res.error ? res.error : { code: 'UNKNOWN', message: '未知错误' };
    const el = $('error');
    el.textContent = ui.lastError.message;
    el.hidden = false;
    return false;
  }

  function apply(data) {
    ui.todos = data.todos;
    ui.counts = data.counts;
    ui.settings = data.settings;
    applySettings(data.settings);
    render();
    ui.renderCount += 1;
  }

  function refresh() { return call(() => api.view(ui.view)); }

  // ---------------------------------------------------------------- 设置
  function applySettings(s) {
    document.body.dataset.theme = s.theme;
    document.documentElement.style.fontSize = `${(16 * s.fontScale) / 100}px`;
    $('set-theme').value = s.theme;
    $('set-fontscale').value = String(s.fontScale);
    $('set-fontscale-value').textContent = String(s.fontScale);
    $('set-confirmdelete').checked = s.confirmDelete;
    $('set-priority').value = s.defaultPriority;
    $('set-sort').value = s.defaultSort;
  }

  // ---------------------------------------------------------------- 渲染
  function render() {
    const list = $('list');
    list.textContent = '';
    for (const todo of ui.todos) list.appendChild(renderItem(todo));

    $('empty').hidden = ui.counts.total !== 0;
    $('count-active').textContent = String(ui.counts.active);
    $('count-total').textContent = String(ui.counts.total);

    for (const btn of document.querySelectorAll('.filters button')) {
      btn.classList.toggle('on', btn.dataset.filter === ui.view.filter);
    }
    if (ui.editingId !== null) {
      const input = $('item-edit-input');
      if (input !== null) input.focus();
    }
  }

  function renderItem(todo) {
    const li = document.createElement('li');
    li.className = 'item';
    li.dataset.testid = 'item';
    li.dataset.id = todo.id;
    li.dataset.done = String(todo.done);
    li.dataset.priority = todo.priority;

    const probe = document.createElement('span');
    probe.className = 'probe';
    li.appendChild(probe);

    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = todo.done;
    box.dataset.testid = 'item-toggle';
    box.addEventListener('change', () => call(() => api.toggle(todo.id, ui.view)));
    li.appendChild(box);

    if (ui.editingId === todo.id) {
      const input = document.createElement('input');
      input.type = 'text';
      input.value = todo.title;
      input.dataset.testid = 'item-edit-input';
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') commitEdit(todo.id, input.value);
        else if (e.key === 'Escape') { ui.editingId = null; render(); }
      });
      li.appendChild(input);
    } else {
      const title = document.createElement('span');
      title.className = 'title';
      title.dataset.testid = 'item-title';
      title.textContent = todo.title;
      title.addEventListener('dblclick', () => { ui.editingId = todo.id; render(); });
      li.appendChild(title);
    }

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.dataset.testid = 'item-priority';
    badge.textContent = { high: '高', normal: '中', low: '低' }[todo.priority];
    li.appendChild(badge);

    const edit = document.createElement('button');
    edit.type = 'button';
    edit.dataset.testid = 'item-edit';
    edit.textContent = '改';
    edit.addEventListener('click', () => { ui.editingId = todo.id; render(); });
    li.appendChild(edit);

    const del = document.createElement('button');
    del.type = 'button';
    del.dataset.testid = 'item-delete';
    del.textContent = '删';
    del.addEventListener('click', () => requestDelete(todo.id, todo.title));
    li.appendChild(del);

    return li;
  }

  async function commitEdit(id, value) {
    const okDone = await call(() => api.update(id, { title: value }, ui.view));
    if (okDone) { ui.editingId = null; render(); }
  }

  // ---------------------------------------------------------------- 删除
  function requestDelete(id, title) {
    if (ui.settings.confirmDelete) {
      ui.pendingDeleteId = id;
      $('confirm-text').textContent = `确定删除「${title}」？`;
      $('confirm').hidden = false;
      return;
    }
    call(() => api.remove(id, ui.view));
  }

  // ---------------------------------------------------------------- 事件
  function bind() {
    $('add').addEventListener('click', async () => {
      // 这里**不做前置校验**：规则只有核心那一份，界面只负责把错误显示出来。
      const okDone = await call(() => api.add({
        title: $('new-title').value,
        priority: $('new-priority').value
      }, ui.view));
      if (okDone) $('new-title').value = '';
    });
    $('new-title').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('add').click(); });

    $('search').addEventListener('input', () => {
      ui.view.query = $('search').value;
      refresh();
    });

    for (const btn of document.querySelectorAll('.filters button')) {
      btn.addEventListener('click', () => {
        ui.view.filter = btn.dataset.filter;
        refresh();
      });
    }

    $('clear-completed').addEventListener('click', () => call(() => api.clearCompleted(ui.view)));

    $('settings-toggle').addEventListener('click', () => {
      const panel = $('settings-panel');
      panel.hidden = !panel.hidden;
    });

    $('set-theme').addEventListener('change', (e) => call(() => api.setSettings({ theme: e.target.value }, ui.view)));
    $('set-fontscale').addEventListener('input', (e) => call(() => api.setSettings({ fontScale: Number(e.target.value) }, ui.view)));
    $('set-confirmdelete').addEventListener('change', (e) => call(() => api.setSettings({ confirmDelete: e.target.checked }, ui.view)));
    $('set-priority').addEventListener('change', (e) => call(() => api.setSettings({ defaultPriority: e.target.value }, ui.view)));
    $('set-sort').addEventListener('change', (e) => call(() => api.setSettings({ defaultSort: e.target.value }, ui.view)));

    $('confirm-no').addEventListener('click', () => {
      ui.pendingDeleteId = null;
      $('confirm').hidden = true;
    });
    $('confirm-yes').addEventListener('click', async () => {
      const id = ui.pendingDeleteId;
      ui.pendingDeleteId = null;
      $('confirm').hidden = true;
      if (id !== null) await call(() => api.remove(id, ui.view));
    });
  }

  async function boot() {
    bind();
    await refresh();
    ui.ready = true;
  }

  boot();
})();
