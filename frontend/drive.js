import { initializeEffects, icon, fileIcon, disposeRows, syncEffectTheme, setProgress, mountDeletion, followFlight, hideFlight, launchFlight } from './effects.jsx';
'use strict';
// Run from the external head script before first paint; production CSP allows self-hosted scripts.
try {
  const theme = localStorage.getItem('clouddrive-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.motion = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'off' : 'on';
} catch {}
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id), api = '/api/clouddrive';
  const KEY = 'clouddrive-pending-upload', TIME = 'clouddrive-upload-seconds';
  const root = document.documentElement;
  const compactLayout = matchMedia('(max-width: 650px)');
  let path = new URLSearchParams(location.search).get('path') || '';
  let pending = null, running = false, stopped = false, cancelling = false, ready = false;
  let phase = 'paused', lastFile = null, uploadJob = null, toastTimer;
  let queue = [], activeJob = null, queueSignature = '';
  let elapsed = 0, transferred = 0, speed = 0, sampleBytes = 0, timer, listSequence = 0;
  let entries = [], openDelete = null, seenRows = new Set();
  let sortKey = null, sortDirection = 0, refreshJob = null;
  let uploadIconName = '';
  const active = new Set();

  function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }
  function store(key, value) {
    try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, String(value)); } catch {}
  }
  function error(e = '') { $('error').textContent = e.message || String(e); }
  function bytes(n) {
    const units = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
    while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
    return `${n.toFixed(i ? 2 : 0)} ${units[i]}`;
  }
  function duration(n) {
    n = Math.max(0, Math.floor(n));
    return `${Math.floor(n / 3600)}:${String(Math.floor(n % 3600 / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
  }
  async function request(url, init) {
    const response = await fetch(url, init);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.message || `请求失败 (${response.status})`);
    return data;
  }
  function button(label, action, className = '') {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.className = className;
    b.addEventListener('click', () => Promise.resolve().then(action).catch(error));
    return b;
  }
  function toast(message) {
    clearTimeout(toastTimer);
    const check = document.createElement('span'); check.className = 'toast-check'; check.textContent = '✓'; check.setAttribute('aria-hidden', 'true');
    $('toast').replaceChildren(check, document.createTextNode(message)); $('toast').hidden = false;
    toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3600);
  }
  function animate(element, frames, options) {
    if (root.dataset.motion === 'off' || !element.animate) return Promise.resolve();
    return element.animate(frames, options).finished.catch(() => {});
  }

  // Explicit theme mode is stored independently from its resolved color scheme.
  const colorPreference = matchMedia('(prefers-color-scheme: dark)');
  let themeMode = ['light', 'dark'].includes(stored('clouddrive-theme')) ? stored('clouddrive-theme') : 'system';
  function softenControl(element) {
    if (root.dataset.motion === 'off') return;
    element.getAnimations().filter(animation => !animation.transitionProperty).forEach(animation => animation.cancel());
    animate(element, [{filter:'blur(0)'},{filter:'blur(1.5px)',offset:.3},{filter:'blur(0)'}], {duration:680,easing:'cubic-bezier(.22,.12,.18,1)'});
  }
  function positionThemeIcon() {
    const target = $('theme-' + themeMode).querySelector('span').getBoundingClientRect();
    const control = $('theme-switch').getBoundingClientRect(), size = $('theme-toggle').offsetWidth;
    $('theme-switch').style.setProperty('--theme-icon-left', `${target.left - control.left + (target.width - size) / 2}px`);
  }
  function closeTheme(focus = false) {
    const wasOpen = $('theme-switch').classList.contains('expanded');
    $('theme-switch').classList.remove('expanded'); $('theme-toggle').setAttribute('aria-expanded', 'false');
    $('theme-options').inert = true;
    if (wasOpen) softenControl($('theme-icon'));
    if (focus && wasOpen) $('theme-toggle').focus();
  }
  function syncTheme() {
    const dark = themeMode === 'dark' || (themeMode === 'system' && colorPreference.matches);
    root.dataset.theme = dark ? 'dark' : 'light'; root.dataset.resolvedTheme = root.dataset.theme;
    root.dataset.themeMode = themeMode;
    for (const mode of ['light','dark','system']) $('theme-' + mode).setAttribute('aria-checked', String(themeMode === mode));
    icon($('theme-icon'), themeMode === 'system' ? 'SunMoon' : dark ? 'Moon' : 'Sun', 17);
    positionThemeIcon();
    $('theme-toggle').title = `页面配色：${{light:'浅色',dark:'深色',system:'跟随系统'}[themeMode]}`;
    syncEffectTheme();
  }
  function setTheme(theme, event) {
    const apply = () => { themeMode = theme; store('clouddrive-theme', theme); syncTheme(); closeTheme(true); };
    if (!document.startViewTransition || root.dataset.motion === 'off') { apply(); return; }
    const transition = document.startViewTransition(apply);
    transition.ready.then(() => {
      root.animate([{opacity:1,filter:'blur(0)'},{opacity:0,filter:'blur(5px)'}], {duration:420,easing:'cubic-bezier(.22,.12,.18,1)',pseudoElement:'::view-transition-old(root)'});
      root.animate([{opacity:0,filter:'blur(5px)'},{opacity:1,filter:'blur(0)'}], {duration:480,easing:'cubic-bezier(.22,.12,.18,1)',pseudoElement:'::view-transition-new(root)'});
    }).catch(() => {});
  }
  initializeEffects(() => { if (ready && !running && !cancelling) $('file').click(); });
  for (const [id, name] of [['theme-light-icon','Sun'],['theme-dark-icon','Moon'],['theme-system-icon','SunMoon'],['refresh-symbol','RotateCw'],['new-folder-symbol','Plus'],['mkdir-submit','Check'],['mkdir-cancel','X'],['pause-upload','Pause'],['resume','Play'],['cancel-upload','X']]) icon($(id), name);
  $('theme-toggle').onclick = () => {
    const open = $('theme-switch').classList.toggle('expanded');
    if (open) positionThemeIcon();
    softenControl($('theme-icon'));
    $('theme-toggle').setAttribute('aria-expanded', String(open)); $('theme-options').inert = !open;
  };
  for (const mode of ['light','dark','system']) $('theme-' + mode).onclick = event => setTheme(mode,event);
  $('theme-options').addEventListener('keydown', event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...$('theme-options').querySelectorAll('button')], current = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (current + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    buttons[next].focus();
  });
  document.addEventListener('pointerdown', event => {
    if (!$('theme-switch').contains(event.target)) closeTheme();
    if (!$('mkdir-control').contains(event.target)) showMkdir(false, false);
  });
  addEventListener('resize', positionThemeIcon);
  colorPreference.addEventListener('change', syncTheme);
  matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
    root.dataset.motion = event.matches ? 'off' : 'on';
    if (event.matches) { hideFlight(); clearDepthBlurs(); resetDepth(); }
    syncEffectTheme();
  });
  compactLayout.addEventListener('change', () => {
    $('entries').querySelectorAll('[colspan]').forEach(cell => { cell.colSpan = compactLayout.matches ? 3 : 4; });
  });

  function join(name) { return path ? `${path}/${name}` : name; }
  function closeDelete(restoreFocus = false) {
    if (!openDelete || openDelete.busy) return;
    const control = openDelete; openDelete = null; control.close(restoreFocus);
  }
  function deletion(item, full, row) {
    const host = document.createElement('span'); host.className = 'delete-shell';
    let state, directory;
    mountDeletion(host, {
      item,
      register: control => { state = control; state.element = host; },
      onOpen: control => { closeDelete(); openDelete = control; },
      onConfirm: async () => {
        directory = path;
        await request(`${api}/remove?path=${encodeURIComponent(full)}`, { method: 'DELETE' }); error();
      },
      onDone: async () => {
        row.classList.add('deleting-row');
        await animate(row, [{ opacity: 1, transform: getComputedStyle(row).transform }, { opacity: 0, transform: 'translate(-24px,-10px) scale(.98)' }], { duration: 220, easing: 'ease-in', fill: 'forwards' });
        if (openDelete === state) openDelete = null;
        if (path === directory) await list();
        toast(`已删除“${item.name}”`);
      },
      onError: error
    });
    return host;
  }
  document.addEventListener('pointerdown', e => { if (openDelete && !openDelete.element.contains(e.target)) closeDelete(); });

  function renderEntries({ reveal = false } = {}) {
    closeDelete(); resetDepth(); clearDepthBlurs();
    const nameOrder = (a, b) => a.name.localeCompare(b.name, 'zh-CN');
    const visible = [...entries].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (!sortKey) return new Date(b.modified) - new Date(a.modified) || nameOrder(a, b);
      const delta = sortKey === 'name' ? nameOrder(a, b) : sortKey === 'size' ? (a.size || 0) - (b.size || 0) : new Date(a.modified) - new Date(b.modified);
      return delta * sortDirection || nameOrder(a, b);
    });
    for (const th of document.querySelectorAll('th[data-sort]')) {
      const selected = th.dataset.sort === sortKey;
      th.setAttribute('aria-sort', selected ? sortDirection === 1 ? 'ascending' : 'descending' : 'none');
      icon(th.querySelector('.sort-icon'), selected ? sortDirection === 1 ? 'ArrowUp' : 'ArrowDown' : 'ArrowUpDown', 12);
    }
    disposeRows();
    const rows = [], nextSeen = new Set();
    if (path) {
      const tr = document.createElement('tr'), td = document.createElement('td');
      tr.className = 'parent-row'; td.colSpan = compactLayout.matches ? 3 : 4;
      td.append(button('返回上级目录', () => list(path.split('/').slice(0, -1).join('/')), 'parent-button')); tr.append(td); rows.push(tr);
    }
    visible.forEach(item => {
      const tr = document.createElement('tr'), name = document.createElement('td'), size = document.createElement('td');
      const modified = document.createElement('td'), actions = document.createElement('td'), full = join(item.name);
      nextSeen.add(full);
      if (!seenRows.has(full)) tr.className = 'new-row';
      const entryIcon = document.createElement('span'), label = document.createElement('span');
      entryIcon.className = 'entry-icon'; entryIcon.setAttribute('aria-hidden', 'true');
      label.className = 'file-name'; label.textContent = item.name;
      if (item.isDir) {
        const open = button('', () => openFolder(full, tr), 'folder-button file-entry'), tag = document.createElement('span');
        tag.className = 'sr-only'; tag.textContent = '[目录] '; open.append(tag, entryIcon, label); name.append(open);
      } else {
        const entry = document.createElement('span'); entry.className = 'file-entry'; entry.append(entryIcon, label); name.append(entry);
      }
      fileIcon(entryIcon, item.name, item.isDir);
      size.textContent = item.isDir ? '—' : bytes(item.size);
      modified.className = 'modified';
      const date = new Date(item.modified);
      modified.textContent = date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
      modified.title = date.toLocaleString();
      if (!item.isDir) {
        const a = document.createElement('a'); a.className = 'download icon-button'; a.setAttribute('aria-label', '下载'); a.title = `下载“${item.name}”`; icon(a, 'Download');
        a.href = `${api}/download?path=${encodeURIComponent(full)}`; a.download = item.name; actions.append(a);
      }
      actions.append(deletion(item, full, tr)); tr.append(name, size, modified, actions); rows.push(tr);
    });
    if (!visible.length) {
      const tr = document.createElement('tr'), td = document.createElement('td'), caption = document.createElement('div');
      td.colSpan = compactLayout.matches ? 3 : 4; td.className = 'empty-cell';
      const title = document.createElement('span'); title.textContent = '空目录';
      caption.className = 'empty-caption'; caption.textContent = '把第一个文件拖进来，让这里有些内容。';
      td.append(title, caption); tr.append(td); rows.push(tr);
    }
    // A bounded cascade stays top-to-bottom without making large directories wait seconds.
    const stagger = Math.min(64, 520 / Math.max(1, rows.length - 1));
    rows.forEach((row, i) => {
      if (root.dataset.motion === 'off') { row.classList.remove('new-row'); return; }
      if (!reveal && !row.classList.contains('new-row')) return;
      row.classList.add('new-row'); row.style.setProperty('--row-delay', `${Math.round(i * stagger)}ms`);
      const finish = event => {
        if (event.target !== row || event.animationName !== 'row-arrive') return;
        row.classList.remove('new-row'); row.style.removeProperty('--row-delay');
        row.removeEventListener('animationend', finish); row.removeEventListener('animationcancel', finish);
      };
      row.addEventListener('animationend', finish); row.addEventListener('animationcancel', finish);
    });
    $('entries').replaceChildren(...rows); seenRows = nextSeen;
    const folders = entries.filter(e => e.isDir).length;
    $('entry-count').textContent = `${entries.length} 项 · ${folders} 个文件夹 · ${entries.length - folders} 个文件`;
  }
  async function openFolder(full, row) {
    if (row.getAttribute('aria-busy') === 'true') return;
    resetDepth(); row.classList.add('opening-folder'); row.setAttribute('aria-busy', 'true');
    try { await list(full); }
    finally { row.classList.remove('opening-folder'); row.removeAttribute('aria-busy'); }
  }
  async function list(dir = path) {
    const seq = ++listSequence, refreshStart = performance.now(); $('loading').textContent = '正在读取目录…';
    closeDelete(); resetDepth(); clearDepthBlurs();
    showMkdir(false, false);
    $('entries').closest('table').setAttribute('aria-busy', 'true');
    $('refresh').classList.add('busy'); $('refresh').setAttribute('aria-busy', 'true');
    try {
      const data = await request(`${api}/list?path=${encodeURIComponent(dir)}`);
      if (seq !== listSequence) return;
      if (path !== data.sub) { sortKey = null; sortDirection = 0; seenRows.clear(); }
      path = data.sub; entries = data.entries;
      history.replaceState(null, '', path ? `/?path=${encodeURIComponent(path)}` : '/');
      const percent = data.maxSize ? Math.min(100, data.totalSize / data.maxSize * 100) : 0;
      $('capacity').textContent = `已用 ${bytes(data.totalSize)} / ${bytes(data.maxSize)} (${percent.toFixed(1)}%)`;
      $('capacity-note').textContent = `总容量 ${bytes(data.maxSize)}，单文件最多 ${bytes(5 * 1024 ** 3)}。公开云盘，所有访客均可管理文件。`;
      $('drop-capacity-fill').style.width = `${percent}%`; $('capacity-meter').setAttribute('aria-valuenow', percent.toFixed(1));
      $('breadcrumbs').replaceChildren(button('根目录', () => list('')));
      const parts = path.split('/').filter(Boolean);
      parts.forEach((part, i) => {
        const separator = document.createElement('span'); separator.className = 'crumb-separator'; separator.textContent = '/'; separator.setAttribute('aria-hidden', 'true');
        $('breadcrumbs').append(separator, button(part, () => list(parts.slice(0, i + 1).join('/'))));
      });
      $('breadcrumbs').lastElementChild.setAttribute('aria-current', 'page'); renderEntries({ reveal: true }); error();
    } catch (e) { if (seq === listSequence) error(e); }
    finally {
      if (seq === listSequence) { $('loading').textContent = ''; $('entries').closest('table').setAttribute('aria-busy', 'false'); }
      const elapsed = performance.now() - refreshStart;
      if (root.dataset.motion !== 'off') await new Promise(resolve => setTimeout(resolve, Math.ceil(Math.max(elapsed, 650) / 650) * 650 - elapsed));
      if (seq === listSequence) { $('refresh').classList.remove('busy'); $('refresh').setAttribute('aria-busy', 'false'); }
    }
  }

  function completedBytes(session) { return session.completed.reduce((n, i) => n + Math.min(session.chunkSize, session.size - i * session.chunkSize), 0); }
  function sameFile(a, b) { return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified; }
  function queueTotal() { return queue.reduce((n, job) => n + job.file.size, 0); }
  function queueDone() { return queue.reduce((n, job) => n + (job.status === 'done' ? job.file.size : 0), 0); }
  function renderQueue(percent) {
    if (queue.length < 2) {
      queueSignature = ''; $('upload-queue-head').hidden = true; $('upload-queue-list').hidden = true;
      return;
    }
    const activeIndex = queue.indexOf(activeJob);
    const done = queue.filter(job => job.status === 'done').length;
    $('upload-queue-head').hidden = false; $('upload-queue-list').hidden = false;
    $('upload-queue-count').textContent = activeIndex >= 0 ? `第 ${activeIndex + 1} / ${queue.length} 个` : `准备 ${queue.length} 个文件`;
    $('upload-queue-size').textContent = `共 ${bytes(queueTotal())} · 已完成 ${done} 个`;
    const signature = queue.map(job => `${job.file.name}:${job.status}:${job === activeJob ? Math.floor(percent / 5) : ''}`).join('|');
    if (signature === queueSignature) return;
    queueSignature = signature;
    const rows = queue.map(job => {
      const item = document.createElement('li'), file = document.createElement('span');
      const iconHost = document.createElement('span'), name = document.createElement('span');
      const size = document.createElement('span'), state = document.createElement('span');
      item.dataset.status = job === activeJob && job.status === 'active' ? 'active' : job.status;
      iconHost.className = 'entry-icon'; iconHost.setAttribute('aria-hidden', 'true');
      fileIcon(iconHost, job.file.name);
      name.className = 'queue-name'; name.textContent = job.file.name; name.title = job.file.name;
      size.className = 'queue-size'; size.textContent = bytes(job.file.size);
      state.className = 'queue-state';
      const current = pending && job === activeJob ? Math.min(100, transferred / job.file.size * 100) : 0;
      state.textContent = job.status === 'done' ? '已完成' : job.status === 'failed' ? '等待继续' : job === activeJob ? phase === 'finishing' ? '整理中' : `${current.toFixed(0)}%` : '等待';
      if (job === activeJob) item.setAttribute('aria-current', 'step');
      file.append(iconHost, name); item.append(file, size, state); return item;
    });
    $('upload-queue-list').replaceChildren(...rows);
  }
  function render() {
    const visible = Boolean(pending || queue.length);
    $('upload').hidden = !visible; $('upload').dataset.state = running ? phase : 'paused';
    $('pause-upload').hidden = !running || phase !== 'uploading';
    $('resume').hidden = running || cancelling;
    const resumeLabel = queue.length ? '继续上传' : '选择原文件续传';
    $('resume').setAttribute('aria-label', resumeLabel); $('resume').title = resumeLabel;
    $('cancel-upload').disabled = cancelling || (running && phase !== 'uploading');
    const cancelLabel = queue.length > 1 ? '取消全部上传' : '取消上传';
    $('cancel-upload').setAttribute('aria-label', cancelLabel); $('cancel-upload').title = cancelLabel;
    if (!visible) { renderQueue(0); return; }
    const total = queue.length ? queueTotal() : pending ? pending.size : 0;
    const current = pending ? Math.min(transferred, pending.size) : 0;
    const overall = Math.min(total, queueDone() + current);
    const percent = total ? overall / total * 100 : 0;
    const activeIndex = queue.indexOf(activeJob);
    const state = cancelling ? '正在取消' : running ? ({ preparing: '准备传输', uploading: '正在上传', pausing: '正在暂停', finishing: '正在整理' }[phase]) : '等待续传';
    const name = pending ? pending.name : activeJob ? activeJob.file.name : queue.length === 1 ? queue[0].file.name : `${queue.length} 个文件`;
    $('upload-name').textContent = name; $('upload-name').title = name;
    if (uploadIconName !== name) { fileIcon($('upload-file-icon'), name); uploadIconName = name; }
    $('upload-percent').textContent = `${percent.toFixed(1)}%`; setProgress(percent);
    $('upload-meter').setAttribute('aria-valuenow', percent.toFixed(1));
    $('upload-bytes').textContent = `${bytes(overall)} / ${bytes(total)}`;
    $('upload-speed').textContent = running ? `${bytes(speed)}/s` : '已暂停';
    $('upload-elapsed').textContent = duration(elapsed);
    $('upload-eta').textContent = phase === 'finishing' && running ? '即将完成' : running && speed > 0 ? duration((total - overall) / speed) : running ? '计算中' : '等待继续';
    // Announce whole percentage changes only, rather than every network progress event.
    const progressText = queue.length > 1 && activeIndex >= 0 ? `${state}第 ${activeIndex + 1} / ${queue.length} 个文件：${name}` : `${state}：${name}`;
    const announcement = `${progressText}；${Math.floor(percent)}%`;
    if ($('progress').textContent !== announcement) $('progress').textContent = announcement;
    renderQueue(percent);
  }
  function startUpload(files) {
    if (running || cancelling || !ready) return;
    let list = Array.from(files || []);
    if (!list.length) return;
    if (pending) {
      const match = list.find(file => sameFile(file, pending));
      if (!match) { error('请选择原文件继续上传，或先取消未完成的上传'); $('file').value = ''; return; }
      list = [match, ...list.filter(file => file !== match)];
    }
    if (list.length > 100) { error('一次最多选择 100 个文件'); $('file').value = ''; return; }
    const names = new Set();
    for (const file of list) {
      if (!file.size) { error(`“${file.name}”是空文件，无法上传`); $('file').value = ''; return; }
      if (names.has(file.name)) { error('同一批次中不能包含重名文件'); $('file').value = ''; return; }
      names.add(file.name);
    }
    queue = list.map(file => ({ file, status: 'waiting', dir: path }));
    activeJob = null; stopped = false; running = true; phase = 'preparing'; error(); queueSignature = '';
    if (!pending) elapsed = 0;
    render();
    const check = pending ? list.slice(1) : list;
    uploadJob = (async () => {
      try {
        if (check.length) await request(`${api}/upload-batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, files: check.map(file => ({ name: file.name, size: file.size, lastModified: file.lastModified })) }) });
      } catch (e) {
        if (!stopped) { queue = []; activeJob = null; running = false; phase = 'paused'; error(e); render(); }
        return;
      }
      await runQueue();
    })();
  }
  async function runQueue() {
    const completed = [];
    try {
      while (!stopped) {
        const job = queue.find(item => item.status === 'waiting');
        if (!job) break;
        activeJob = job; job.status = 'active'; lastFile = job.file; phase = 'preparing';
        if (!pending) transferred = 0;
        error(); render();
        const session = await upload(job.file, job.dir);
        if (stopped || !session) break;
        job.status = 'done'; completed.push(job); transferred = 0;
        phase = 'preparing'; render();
      }
      if (stopped) return;
      const doneCount = queue.filter(job => job.status === 'done').length;
      const names = queue.filter(job => job.status === 'done').map(job => job.file.name);
      queue = []; activeJob = null; lastFile = null; pending = null; store(KEY, null); store(TIME, null);
      if (doneCount) {
        list().catch(error);
        toast(doneCount === 1 ? `“${names[0]}”上传完成` : `${doneCount} 个文件上传完成`);
      }
    } catch (e) {
      if (activeJob && activeJob.status === 'active') activeJob.status = 'failed';
      if (!stopped) error(e);
    } finally {
      clearInterval(timer); active.forEach(xhr => xhr.abort());
      if (activeJob && activeJob.status === 'active') activeJob.status = 'waiting';
      running = false; phase = 'paused'; speed = 0; $('file').value = ''; render();
    }
  }
  async function upload(file, directory) {
    try {
      if (pending) pending = await request(`${api}/upload-session/${encodeURIComponent(pending.id)}`);
      else pending = await request(`${api}/upload-session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: directory, name: file.name, size: file.size, lastModified: file.lastModified }) });
      store(KEY, pending.id); const session = pending; phase = 'uploading';
      transferred = completedBytes(session); speed = 0; sampleBytes = 0;
      let completed = transferred, next = 0, failure = null;
      const done = new Set(session.completed), inflight = new Map();
      const update = () => { transferred = Math.min(file.size, completed + [...inflight.values()].reduce((a, b) => a + b, 0)); render(); };
      let last = performance.now();
      timer = setInterval(() => {
        const now = performance.now(); speed = sampleBytes * 1000 / (now - last); elapsed += (now - last) / 1000;
        last = now; sampleBytes = 0; store(TIME, elapsed); render();
      }, 1000);
      render();
      const send = index => new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest(), start = index * session.chunkSize;
        const part = file.slice(start, Math.min(file.size, start + session.chunkSize)); let previous = 0, idleTimer, timedOut = false;
        active.add(xhr); render();
        xhr.open('PUT', `${api}/upload-session/${session.id}/chunk/${index}`);
        xhr.setRequestHeader('Content-Type', 'application/octet-stream');
        // Slow connections can take over five minutes per chunk. Time out only
        // after five minutes without progress, including the final server ack.
        xhr.timeout = 0;
        const armTimeout = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { timedOut = true; xhr.abort(); }, 300000); };
        xhr.upload.onprogress = event => {
          armTimeout();
          const n = Math.min(event.loaded, part.size); sampleBytes += Math.max(0, n - previous); previous = n; inflight.set(index, n); update();
        };
        xhr.upload.onload = armTimeout;
        const cleanup = failed => { clearTimeout(idleTimer); active.delete(xhr); if (failed) inflight.delete(index); update(); };
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) { cleanup(false); resolve(); }
          else {
            cleanup(true); let message = `分片 ${index + 1} 上传失败 (${xhr.status})`;
            try { message = JSON.parse(xhr.responseText).message || message; } catch {}
            const failure = new Error(message); failure.retryable = xhr.status === 408 || xhr.status === 429 || (xhr.status >= 500 && xhr.status !== 507);
            reject(failure);
          }
        };
        xhr.onerror = xhr.ontimeout = () => { cleanup(true); reject(new Error('网络中断或请求超时，请继续上传或重选原文件续传')); };
        xhr.onabort = () => { cleanup(true); reject(new Error(timedOut ? '上传长时间无进展，请继续上传或检查网络' : '上传已中断')); };
        armTimeout(); xhr.send(part);
      });
      const worker = async () => {
        try {
          while (!stopped && !failure) {
            const index = next++; if (index >= Math.ceil(file.size / session.chunkSize)) return; if (done.has(index)) continue;
            for (let attempt = 0; attempt < 3; attempt++) {
              if (stopped || failure) return;
              try { await send(index); break; }
              catch (e) { if (attempt === 2 || stopped || e.retryable === false) throw e; await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); }
            }
            if (stopped || failure) return;
            done.add(index); completed += Math.min(session.chunkSize, file.size - index * session.chunkSize);
            inflight.delete(index); session.completed = [...done]; update();
          }
        } catch (e) { if (!failure) failure = e; active.forEach(xhr => xhr.abort()); }
      };
      await Promise.all(Array.from({ length: Math.min(3, Math.ceil(file.size / session.chunkSize)) }, worker));
      if (stopped) return null; if (failure) throw failure;
      phase = 'finishing'; transferred = file.size; render();
      await request(`${api}/upload-session/${session.id}/complete`, { method: 'POST' });
      pending = null; lastFile = null; store(KEY, null); store(TIME, null);
      return session;
    } catch (e) { if (stopped) return null; throw e; }
    finally {
      clearInterval(timer); active.forEach(xhr => xhr.abort());
      if (pending) {
        // The server is authoritative after pause or a failed request: a chunk may already be saved.
        try { pending = await request(`${api}/upload-session/${encodeURIComponent(pending.id)}`); transferred = completedBytes(pending); }
        catch (e) { error(e); }
      }
      speed = 0; $('file').value = '';
    }
  }
  function resumeQueue() {
    if (running || cancelling || !ready) return;
    if (queue.length) {
      for (const job of queue) if (job.status === 'failed') job.status = 'waiting';
      stopped = false; running = true; phase = 'preparing'; error(); render();
      uploadJob = runQueue();
    } else if (lastFile) startUpload([lastFile]);
    else $('file').click();
  }
  async function pause() {
    if (!running || phase !== 'uploading') return;
    stopped = true; phase = 'pausing'; active.forEach(xhr => xhr.abort()); render();
    await uploadJob;
  }
  async function cancel() {
    if ((!pending && !queue.length) || cancelling || (running && phase !== 'uploading')) return;
    const pendingCount = queue.filter(job => job.status !== 'done').length;
    if (!confirm(queue.length > 1 ? `取消剩余的 ${pendingCount} 个文件？已完成文件不会删除。` : '取消上传并删除该上传任务的临时数据？')) return;
    cancelling = true; stopped = true; active.forEach(xhr => xhr.abort()); render();
    try {
      await uploadJob;
      if (pending) await request(`${api}/upload-session/${encodeURIComponent(pending.id)}`, { method: 'DELETE' });
      pending = null; lastFile = null; queue = []; activeJob = null; store(KEY, null); store(TIME, null); error(); toast('上传任务已取消');
    } catch (e) { error(e); }
    finally { cancelling = false; queueSignature = ''; render(); }
  }

  function showMkdir(show, focus = true) {
    const wasOpen = $('mkdir-control').classList.contains('expanded');
    if (show === wasOpen) return;
    $('mkdir-control').classList.toggle('expanded', show);
    $('mkdir').inert = !show; $('mkdir').setAttribute('aria-hidden', String(!show));
    $('new-folder').setAttribute('aria-expanded', String(show));
    softenControl($('new-folder-symbol'));
    if (focus) (show ? $('folder-name') : $('new-folder')).focus({preventScroll:true});
  }
  $('refresh').onclick = () => {
    if (refreshJob) return;
    refreshJob = list().finally(() => { refreshJob = null; });
  };
  $('new-folder').onclick = () => showMkdir($('new-folder').getAttribute('aria-expanded') !== 'true');
  $('mkdir-cancel').onclick = () => showMkdir(false);
  $('mkdir').onsubmit = async e => {
    e.preventDefault(); const name = $('folder-name').value.trim(); if (!name || $('mkdir-submit').disabled) return;
    $('mkdir-submit').disabled = true;
    try {
      await request(`${api}/mkdir?path=${encodeURIComponent(path)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      $('folder-name').value = ''; showMkdir(false); error(); await list(); toast(`已创建“${name}”`);
    } catch (e) { error(e); }
    finally { $('mkdir-submit').disabled = false; }
  };
  $('resume').onclick = resumeQueue;
  $('file').onchange = e => { startUpload(e.target.files); e.target.value = ''; };
  $('pause-upload').onclick = pause; $('cancel-upload').onclick = cancel;
  document.querySelectorAll('th[data-sort] button').forEach(button => button.onclick = () => {
    const key = button.closest('th').dataset.sort;
    if (sortKey !== key) { sortKey = key; sortDirection = 1; }
    else if (sortDirection === 1) sortDirection = -1;
    else { sortKey = null; sortDirection = 0; }
    renderEntries();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') { closeDelete(true); closeTheme(true); showMkdir(false); hideFlight(); }
  });
  const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
  let hoverRow = null, hoverRect = null, hoverFrame = 0, hoverX = 0, hoverY = 0, grabbedRow = null;
  const depthBlurs = new Map();
  function clearDepthBlurs() { for (const animation of depthBlurs.values()) animation.cancel(); depthBlurs.clear(); }
  function softenDepth(row, lifting) {
    depthBlurs.get(row)?.cancel();
    if (root.dataset.motion === 'off' || !row.animate) return;
    const animation = row.animate([
      { filter:'blur(0)' },
      { filter:`blur(${lifting ? .75 : .45}px)`, offset:.28 },
      { filter:'blur(0)' }
    ], { duration:lifting ? 840 : 680, easing:'cubic-bezier(.22,.12,.18,1)' });
    depthBlurs.set(row, animation);
    animation.finished.catch(() => {}).finally(() => { if (depthBlurs.get(row) === animation) depthBlurs.delete(row); });
  }
  function releaseDeletePlane() {
    if (!grabbedRow) return;
    grabbedRow.style.removeProperty('transform'); grabbedRow = null;
  }
  function resetDepth() {
    cancelAnimationFrame(hoverFrame); hoverFrame = 0;
    if (hoverRow) {
      hoverRow.classList.remove('hovered');
      hoverRow.style.removeProperty('--row-rx'); hoverRow.style.removeProperty('--row-ry');
      softenDepth(hoverRow, false);
    }
    hoverRow = null; hoverRect = null;
  }
  document.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || !finePointer.matches || root.dataset.motion === 'off') return resetDepth();
    // The existing card keeps its hover physics; freeze its plane while grabbing the trash.
    if (grabbedRow || openDelete?.element.querySelector('[data-held]')) return;
    // Keep the original hit area while the card lifts away from the pointer.
    const insideCurrent = hoverRect && event.clientX >= hoverRect.left && event.clientX <= hoverRect.right && event.clientY >= hoverRect.top && event.clientY <= hoverRect.bottom;
    const row = insideCurrent ? hoverRow : event.target.closest('#entries tr');
    if (!row || row.classList.contains('parent-row') || row.querySelector('.empty-cell')) return resetDepth();
    if (openDelete && !row.classList.contains('delete-active')) return resetDepth();
    if (hoverRow !== row) { resetDepth(); hoverRow = row; hoverRect = row.getBoundingClientRect(); row.classList.add('hovered'); softenDepth(row, true); }
    hoverX = event.clientX; hoverY = event.clientY;
    if (!hoverFrame) hoverFrame = requestAnimationFrame(() => {
      hoverFrame = 0; if (!hoverRow) return;
      const rect = hoverRect;
      const ry = Math.max(-1, Math.min(1, (hoverX - rect.left) / rect.width * 2 - 1));
      const rx = Math.max(-1, Math.min(1, -((hoverY - rect.top) / rect.height * 2 - 1)));
      const emphasis = hoverRow.classList.contains('delete-active') ? 1.6 : 1;
      hoverRow.style.setProperty('--row-rx', `${rx * 3 * emphasis}deg`); hoverRow.style.setProperty('--row-ry', `${ry * 1.4 * emphasis}deg`);
    });
  });
  document.addEventListener('mouseleave', resetDepth);
  $('entries').addEventListener('pointerdown', event => {
    const row = event.target.closest('.delete-active');
    if (!row) { resetDepth(); return; }
    if (!event.target.closest('.slide-commit__capsule')) return;
    cancelAnimationFrame(hoverFrame); hoverFrame = 0;
    grabbedRow = row; row.style.transform = getComputedStyle(row).transform;
  }, true);
  addEventListener('pointerup', releaseDeletePlane); addEventListener('pointercancel', releaseDeletePlane);
  finePointer.addEventListener('change', resetDepth);
  addEventListener('resize', resetDepth); addEventListener('scroll', resetDepth); addEventListener('blur', () => { releaseDeletePlane(); resetDepth(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { hideFlight(); resetDepth(); } });

  // Real file drags drive the original FlyingButton controller through its external API.
  let dragTimeout;
  function filesDrag(event) { return event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files'); }
  document.addEventListener('dragenter', e => { if (filesDrag(e)) { e.preventDefault(); followFlight(e); } });
  document.addEventListener('dragover', e => {
    if (!filesDrag(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = running || !ready || cancelling ? 'none' : 'copy';
    followFlight(e); clearTimeout(dragTimeout); dragTimeout = setTimeout(hideFlight, 900);
  });
  document.addEventListener('dragleave', e => { if (!e.relatedTarget && (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight)) hideFlight(); });
  document.addEventListener('dragend', hideFlight); addEventListener('blur', hideFlight);
  document.addEventListener('drop', e => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) { hideFlight(); return; }
    e.preventDefault();
    if (running || cancelling || !ready) { hideFlight(); toast('请先完成当前上传任务'); return; }
    const files = Array.from(e.dataTransfer.files);
    if (pending && !files.some(file => sameFile(file, pending))) { hideFlight(); startUpload(files); return; }
    clearTimeout(dragTimeout); launchFlight(e, files[0]); startUpload(files);
  });

  syncTheme(); render(); list();
  (async () => {
    const id = stored(KEY);
    if (id) {
      elapsed = Number(stored(TIME)) || 0;
      try { pending = await request(`${api}/upload-session/${encodeURIComponent(id)}`); transferred = completedBytes(pending); }
      catch (e) { store(KEY, null); store(TIME, null); error(e); }
    }
    ready = true; render();
  })();
}, { once: true });
