(async () => {
  'use strict';
  const $ = id => document.getElementById(id);
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    $('theme-light').setAttribute('aria-pressed', String(theme === 'light'));
    $('theme-black').setAttribute('aria-pressed', String(theme === 'black'));
    try { localStorage.setItem('memo-theme', theme); } catch {}
  }
  $('theme-light').addEventListener('click', () => setTheme('light'));
  $('theme-black').addEventListener('click', () => setTheme('black'));
  setTheme(document.documentElement.dataset.theme === 'black' ? 'black' : 'light');
  const title = $('title'), body = $('body'), list = $('notes');
  let dialogResolve = null, dialogValue = null, dialogOpener = null;
  const dialog = M.Modal.init($('action-dialog'), {
    onOpenEnd() { ($('dialog-field').hidden ? $('dialog-cancel') : $('dialog-input')).focus(); },
    onCloseEnd() {
      const resolve = dialogResolve; dialogResolve = null;
      if (dialogOpener?.isConnected) dialogOpener.focus();
      resolve?.(dialogValue);
    }
  });
  function askDialog(heading, message, inputValue = null) {
    if (dialogResolve) return Promise.resolve(null);
    dialogOpener = document.activeElement; dialogValue = null;
    $('dialog-title').textContent = heading; $('dialog-message').textContent = message;
    $('dialog-field').hidden = inputValue === null;
    $('dialog-input').disabled = inputValue === null;
    $('dialog-input').required = inputValue !== null;
    $('dialog-input').value = inputValue || '';
    const result = new Promise(resolve => { dialogResolve = resolve; });
    dialog.open(); return result;
  }
  $('dialog-form').addEventListener('submit', event => {
    event.preventDefault(); if (event.isComposing) return;
    dialogValue = $('dialog-field').hidden ? true : $('dialog-input').value; dialog.close();
  });
  $('dialog-cancel').addEventListener('click', () => { dialogValue = null; dialog.close(); });
  let notes = [], trash = [], activeId = null, trashId = null, revision = 0;
  let groups = [], selectedGroup = '';
  const collapsedGroups = new Set();
  const NOTE_DRAG_TYPE = 'application/x-memo-id';
  let draggedNoteId = null;
  const canMoveNote = () => ready && !busy && !blocked && !saving && !dirty && !trashView;
  function clearNoteDrag() {
    draggedNoteId = null;
    document.querySelectorAll('.group-drop-target, .note-dragging').forEach(element => { element.classList.remove('group-drop-target', 'note-dragging'); });
  }
  let layoutMode = 'list';
  let editorOpen = false;
  function updateEditorVisibility() {
    $('app').classList.toggle('editor-open', editorOpen);
  }
  try { if (localStorage.getItem('memo-layout') === 'sticky') layoutMode = 'sticky'; } catch {}
  function setLayout(mode) {
    if (layoutMode !== mode) editorOpen = false;
    layoutMode = mode;
    $('app').classList.toggle('sticky-mode', mode === 'sticky');
    $('layout-list').setAttribute('aria-pressed', String(mode === 'list'));
    $('layout-sticky').setAttribute('aria-pressed', String(mode === 'sticky'));
    updateEditorVisibility();
    try { localStorage.setItem('memo-layout', mode); } catch {}
  }
  $('layout-list').addEventListener('click', () => { setLayout('list'); renderList(); });
  $('layout-sticky').addEventListener('click', () => { setLayout('sticky'); renderList(); });
  setLayout(layoutMode);
  $('close-editor').addEventListener('click', () => {
    editorOpen = false; updateEditorVisibility();
    list.querySelector('.note[aria-current="true"]')?.focus();
  });
  let trashView = false, ready = false, blocked = false, busy = false, dirty = false, saving = false, pending = Promise.resolve();
  const current = () => (trashView ? trash : notes).find(n => n.id === (trashView ? trashId : activeId));
  const dateLabel = value => new Intl.DateTimeFormat('ja-JP', {year:'numeric', month:'2-digit', day:'2-digit'}).format(new Date(value));
  function createNoteId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  const newNote = (text = '', noteTitle = '') => ({id:createNoteId(), created:new Date().toISOString(), title:noteTitle, body:text, group:selectedGroup});
  function status(text, error = false) {
    for (const id of ['status', 'board-status']) { $(id).textContent = text; $(id).dataset.error = String(error); }
  }
  function controls() {
    title.disabled = body.disabled = !ready || busy || trashView || !current();
    $('add').disabled = !ready || busy || blocked;
    list.querySelectorAll('.note-delete, .note-restore').forEach(button => { button.disabled = !ready || busy || blocked || saving || dirty; });
    $('show-notes').disabled = $('show-trash').disabled = !ready || busy;
    $('add-group').disabled = !ready || busy || blocked || saving || dirty;
    $('note-group').disabled = !ready || busy || blocked || saving || dirty || trashView || !current();
    document.querySelectorAll('.group-rename').forEach(button => { button.disabled = !ready || busy || blocked || saving || dirty; });
    list.querySelectorAll('.note').forEach(button => { button.draggable = canMoveNote(); });
  }
  function accept(data) { notes = data.notes; trash = data.trash || []; groups = data.groups || []; activeId = data.activeId; revision = data.revision; if (selectedGroup && !groups.includes(selectedGroup)) selectedGroup = ''; }
  function groupButton(group, accordion = false) {
    const row = document.createElement('div'); row.className = 'group-heading';
    const button = document.createElement('button'); button.className = 'group-select waves-effect';
    const count = notes.filter(n => (n.group || '') === group).length;
    button.textContent = `${accordion ? (collapsedGroups.has(group) ? '▸ ' : '▾ ') : ''}${group || '未分類'} (${count})`;
    button.setAttribute(accordion ? 'aria-expanded' : 'aria-pressed', String(accordion ? !collapsedGroups.has(group) : selectedGroup === group));
    button.addEventListener('click', () => {
      if (busy) return;
      selectedGroup = group; editorOpen = false;
      if (accordion) { if (collapsedGroups.has(group)) collapsedGroups.delete(group); else collapsedGroups.add(group); }
      render();
    });
    row.append(button);
    row.title = 'メモをここにドロップして移動';
    const acceptsNote = event => canMoveNote() && draggedNoteId && Array.from(event.dataTransfer?.types || []).includes(NOTE_DRAG_TYPE);
    row.addEventListener('dragover', event => {
      if (!acceptsNote(event)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; row.classList.add('group-drop-target');
    });
    row.addEventListener('dragleave', event => { if (!row.contains(event.relatedTarget)) row.classList.remove('group-drop-target'); });
    row.addEventListener('drop', async event => {
      if (!acceptsNote(event)) return;
      event.preventDefault(); event.stopPropagation();
      const id = event.dataTransfer.getData(NOTE_DRAG_TYPE);
      if (id !== draggedNoteId) { clearNoteDrag(); return; }
      clearNoteDrag(); await moveNote(id, group);
    });
    if (group) {
      const rename = document.createElement('button'); rename.className = 'group-rename waves-effect'; rename.textContent = '✎'; rename.title = 'グループ名を変更';
      rename.setAttribute('aria-label', `${group}の名前を変更`); rename.addEventListener('click', () => editGroup(group)); row.append(rename);
    }
    return row;
  }
  function renderList() {
    list.replaceChildren();
    $('group-list').replaceChildren();
    for (const group of ['', ...groups]) $('group-list').append(groupButton(group));
    $('app').classList.toggle('trash-view', trashView);
    const visible = trashView ? trash : (layoutMode === 'sticky' ? notes.filter(n => (n.group || '') === selectedGroup) : notes);
    $('total').textContent = visible.length;
    $('list-label').textContent = trashView ? 'ゴミ箱' : (layoutMode === 'sticky' ? selectedGroup || '未分類' : 'すべてのメモ');
    const targets = new Map();
    if (!trashView && layoutMode === 'list') {
      for (const group of ['', ...groups]) {
        const section = document.createElement('section'); section.className = 'group-section';
        section.append(groupButton(group, true));
        const contents = document.createElement('div'); contents.hidden = collapsedGroups.has(group); section.append(contents); targets.set(group, contents); list.append(section);
      }
    }
    if (!visible.length) {
      const empty = document.createElement('p'); empty.className = 'empty';
      empty.textContent = trashView ? 'ゴミ箱は空です。' : '新規追加、または .txt ファイルをドロップしてください。';
      list.append(empty);
    }
    for (const note of visible) {
      const row = document.createElement('div'); row.className = layoutMode === 'sticky' ? 'note-row card z-depth-1' : 'note-row';
      const button = document.createElement('button'); button.className = 'note';
      button.addEventListener('dragstart', event => {
        if (!canMoveNote()) { event.preventDefault(); return; }
        draggedNoteId = note.id; event.dataTransfer.setData(NOTE_DRAG_TYPE, note.id); event.dataTransfer.effectAllowed = 'move';
        button.classList.add('note-dragging');
      });
      button.addEventListener('dragend', clearNoteDrag);
      button.setAttribute('aria-current', String(note.id === current()?.id));
      const date = document.createElement('time'); date.dateTime = note.created; date.textContent = dateLabel(note.created);
      const label = document.createElement('span'); label.className = 'note-title'; label.textContent = note.title.trim() || '無題のメモ';
      button.append(date, label);
      const preview = document.createElement('span'); preview.className = 'note-preview';
      preview.textContent = note.body.slice(0, 500) || '（本文なし）'; button.append(preview);
      button.addEventListener('click', () => { if (busy) return; if (trashView) trashId = note.id; else { activeId = note.id; selectedGroup = note.group || ''; } editorOpen = true; render(); });
      const remove = document.createElement('button'); remove.className = 'note-delete waves-effect'; remove.type = 'button';
      const action = trashView ? '完全に削除' : 'ゴミ箱に移動';
      remove.title = action;
      remove.setAttribute('aria-label', `${note.title.trim() || '無題のメモ'}を${action}`);
      remove.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>';
      const permanent = trashView;
      remove.addEventListener('click', () => deleteNote(note, permanent));
      row.append(button);
      if (trashView) {
        const restore = document.createElement('button'); restore.className = 'note-restore waves-effect'; restore.type = 'button';
        restore.title = '復元'; restore.setAttribute('aria-label', `${note.title.trim() || '無題のメモ'}を復元`);
        restore.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3M7 8l5-5 5 5M4 14v6a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-6"/></svg>';
        restore.addEventListener('click', () => restoreNote(note)); row.append(restore);
      }
      row.append(remove); (targets.get(note.group || '') || list).append(row);
    }
    controls();
  }
  function count() { $('characters').textContent = `${Array.from(body.value).length.toLocaleString('ja-JP')} 文字`; }
  function render() {
    if (!current()) editorOpen = false;
    updateEditorVisibility();
    const note = current(); title.value = note?.title || ''; body.value = note?.body || '';
    $('note-group').replaceChildren();
    for (const group of ['', ...groups]) { const option = document.createElement('option'); option.value = group; option.textContent = group || '未分類'; $('note-group').append(option); }
    $('note-group').value = note?.group || '';
    body.placeholder = trashView ? 'ゴミ箱のメモは編集できません。' : (note ? 'ここから、書きはじめる。' : 'メモを選択するか、新規追加してください。');
    $('created').textContent = note ? dateLabel(note.created) : ''; $('created').dateTime = note?.created || '';
    $('list-label').textContent = trashView ? 'ゴミ箱' : 'すべてのメモ';
    $('show-notes').setAttribute('aria-pressed', String(!trashView)); $('show-trash').setAttribute('aria-pressed', String(trashView));
    renderList(); count(); controls();
  }
  function save() {
    dirty = true;
    if (saving || blocked) return pending;
    saving = true; controls();
    pending = (async () => {
      while (dirty && !blocked) {
        dirty = false; status('保存中…');
        try {
          const response = await fetch('/api/notes', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({notes, activeId, revision})});
          const result = await response.json();
          if (!response.ok) throw new Error(result.error);
          revision = result.revision; status('保存済み');
        } catch (error) { dirty = true; blocked = true; status(`${error.message} 入力内容をコピーして保管してください。`, true); }
      }
      saving = false; controls();
    })();
    return pending;
  }
  $('add').addEventListener('click', () => { if (busy || blocked || !ready) return; const note = newNote(); notes.unshift(note); activeId = note.id; collapsedGroups.delete(selectedGroup); trashView = false; editorOpen = true; render(); save(); title.focus(); });
  $('add-group').addEventListener('click', () => editGroup());
  $('note-group').addEventListener('change', async () => {
    if (!current()) return;
    await moveNote(current().id, $('note-group').value);
  });
  async function moveNote(id, group) {
    if (!canMoveNote() || (group && !groups.includes(group))) return;
    const note = notes.find(item => item.id === id);
    if (!note || (note.group || '') === group) return;
    busy = true;
    note.group = group; selectedGroup = group; activeId = note.id; collapsedGroups.delete(group);
    render();
    try {
      await save();
      if (!blocked) status(`「${note.title.trim() || '無題のメモ'}」を「${group || '未分類'}」へ移動しました`);
    } finally { busy = false; render(); }
  }
  async function editGroup(oldName) {
    if (!ready || busy || saving || dirty || blocked) return;
    const name = await askDialog(oldName ? 'グループ名を変更' : 'グループを作成', 'グループ名が保存フォルダーの名前になります。', oldName || '');
    if (name === null || name === oldName) return;
    busy = true; controls();
    try {
      const response = await fetch('/api/group', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({name, oldName, revision})});
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      accept(result); selectedGroup = name; collapsedGroups.delete(name); editorOpen = false; status(oldName ? 'グループ名を変更しました' : 'グループを作成しました');
    } catch (error) { status(error.message, true); }
    finally { busy = false; render(); }
  }
  title.addEventListener('input', () => { current().title = title.value; renderList(); save(); });
  body.addEventListener('input', () => { current().body = body.value; count(); renderList(); save(); });
  $('show-notes').addEventListener('click', () => { trashView = false; editorOpen = false; render(); });
  $('show-trash').addEventListener('click', () => { trashView = true; trashId = trash[0]?.id || null; editorOpen = false; render(); });
  async function deleteNote(note, permanent) {
    if (!ready || !note || saving || dirty || blocked || busy) return;
    const name = note.title.trim() || '無題のメモ';
    const message = permanent
      ? `「${name}」を完全に削除します。元に戻せません。削除しますか？`
      : `「${name}」を削除してゴミ箱に移動しますか？`;
    if (!await askDialog(permanent ? 'メモを完全に削除' : 'メモを削除', message)) return;
    busy = true; controls();
    try {
      const response = await fetch(permanent ? '/api/delete' : '/api/trash', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:note.id, revision})});
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      accept(result); trashId = trash[0]?.id || null; status(permanent ? 'ファイルを完全に削除しました' : 'ゴミ箱に移動しました');
    } catch (error) { blocked = true; status(`${error.message} 再読み込みしてください。`, true); }
    finally { busy = false; render(); }
  }
  async function restoreNote(note) {
    if (!ready || !note || saving || dirty || blocked || busy) return;
    busy = true; controls();
    try {
      const response = await fetch('/api/restore', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({id:note.id, revision})});
      const result = await response.json(); if (!response.ok) throw new Error(result.error);
      accept(result); trashId = trash[0]?.id || null; trashView = false; selectedGroup = current()?.group || ''; collapsedGroups.delete(selectedGroup); editorOpen = true; status('メモを復元しました');
    } catch (error) { blocked = true; status(`${error.message} 再読み込みしてください。`, true); }
    finally { busy = false; render(); }
  }
  function decode(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', {fatal:true}).decode(bytes);
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', {fatal:true}).decode(bytes);
    try { return new TextDecoder('utf-8', {fatal:true}).decode(bytes); }
    catch { return new TextDecoder('shift_jis', {fatal:true}).decode(bytes); }
  }
  let dragDepth = 0;
  const fileDrag = event => Array.from(event.dataTransfer?.types || []).includes('Files');
  window.addEventListener('dragenter', event => { if (!fileDrag(event)) return; event.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; });
  window.addEventListener('dragover', event => { if (!fileDrag(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = ready && !busy && !blocked ? 'copy' : 'none'; });
  window.addEventListener('dragleave', event => { if (dragDepth > 0) dragDepth--; if (!dragDepth) $('drop-overlay').hidden = true; });
  window.addEventListener('dragend', () => { dragDepth = 0; $('drop-overlay').hidden = true; });
  window.addEventListener('drop', async event => {
    if (!fileDrag(event)) return;
    event.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true;
    if (!ready || busy || blocked) { status('現在取り込めません。処理完了または再読み込み後にお試しください。', true); return; }
    const files = Array.from(event.dataTransfer.files), textFiles = files.filter(file => /\.txt$/i.test(file.name));
    if (!textFiles.length) { status('.txt ファイルをドロップしてください。', true); return; }
    busy = true; controls(); status('ファイルを読み込み中…');
    try {
      await pending;
      if (blocked) return;
      if (textFiles.reduce((sum, file) => sum + file.size, 0) > 8_000_000) throw new Error('取り込むファイルの合計は8MB以下にしてください。');
      const imported = [];
      for (const file of textFiles) {
        try { imported.push(newNote(decode(await file.arrayBuffer()), file.name.replace(/\.txt$/i, ''))); }
        catch { throw new Error(`「${file.name}」を読み込めませんでした。取り込みは行っていません。`); }
      }
      const combined = [...imported, ...notes];
      if (new TextEncoder().encode(JSON.stringify({notes:combined, activeId:imported[0].id, revision})).length > 10_000_000) throw new Error('メモ全体の保存容量（10MB）を超えるため取り込めません。');
      notes = combined; activeId = imported[0].id; collapsedGroups.delete(selectedGroup); trashView = false; editorOpen = true; render();
      await save();
      if (!blocked) status(`${imported.length}件のメモを追加しました${files.length > textFiles.length ? '（.txt 以外は対象外）' : ''}`);
    } catch (error) { status(error.message, true); }
    finally { busy = false; render(); }
  });
  window.addEventListener('beforeunload', event => { if (dirty || saving || busy) { event.preventDefault(); event.returnValue = ''; } });
  try {
    const response = await fetch('/api/notes'); const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    accept(data); ready = true; render(); status('保存済み');
  } catch (error) { status(`${error.message} Pythonから起動して再読み込みしてください。`, true); }
})();
