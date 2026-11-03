import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { Download, Trash2, Sun, Moon, SunMoon, X, RotateCw, ArrowUp, ArrowDown, ArrowUpDown, Plus, Check, Play, Pause } from 'lucide-react';
import FlyingButton from './vendor/react-bits/FlyingButton.jsx';
import FolderFloat from './vendor/react-bits/FolderFloat.jsx';
import SlideCommit from './vendor/react-bits/SlideCommit.jsx';
import './surface.css';
import { FileTypeIcon } from './file-icons.jsx';

const icons = { Download, Trash2, Sun, Moon, SunMoon, X, RotateCw, ArrowUp, ArrowDown, ArrowUpDown, Plus, Check, Play, Pause };
const roots = new Map();
let folderRoot, flightRoot, flightEngine, chooseFile;
let folderState = { open: false, label: '上传文件', sub: '点击或拖入', items: [] };
let flightState = null, flightRun = 0, folderTimer;
let folderHovered = false, folderFocused = false;
const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const dark = () => document.documentElement.dataset.resolvedTheme === 'dark';

function mount(host, content, synchronous = false) {
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  if (synchronous) flushSync(() => root.render(content)); else root.render(content);
  return root;
}
export function disposeRows() {
  for (const [host, root] of roots) {
    if (host.closest('#entries')) { root.unmount(); roots.delete(host); }
  }
}
export function icon(host, name, size = 16) {
  const Icon = icons[name];
  mount(host, <Icon size={size} strokeWidth={1.7} aria-hidden="true" />, true);
}
export function fileIcon(host, name, isDir = false) {
  host.dataset.fileKind = isDir ? 'folder' : 'file';
  mount(host, <FileTypeIcon name={name} isDir={isDir} />, true);
  // Upstream gives every SVG an unused id="file", which collides with our file input.
  host.querySelector('[id="file"]')?.removeAttribute('id');
}

function renderFolder() {
  if (!folderRoot) return;
  const isDark = dark();
  folderRoot.render(<FolderFloat
    open={folderState.open || folderHovered || folderFocused} onTrigger={chooseFile} trigger="controlled"
    label={folderState.label} sublabel={folderState.sub} items={folderState.items}
    width={110} height={80} radius={12} spread={110} lift={23} tilt={8}
    folderColor={isDark ? '#666662' : '#343433'} frontColor={isDark ? '#85857d' : '#555553'}
    paperColor={isDark ? '#f1f1e9' : '#fafaf7'} labelColor="#ffffff"
    itemColor={isDark ? '#333331' : '#ffffff'} itemTextColor={isDark ? '#eeeee9' : '#20201f'}
    physics={!reduce()} drift={0.35} />);
}
function renderFlight() {
  if (!flightRoot) return;
  const host = document.getElementById('flight');
  host.hidden = !flightState || reduce();
  host.dataset.phase = flightState?.phase || 'idle';
  if (!flightState || reduce()) { flightRoot.render(null); flightEngine = null; return; }
  flightRoot.render(<FlyingButton
    size="small" radius={12} theme={dark() ? 'dark' : 'light'} trigger="external"
    carryCursor={false} ramp={false} jets={2} smoke={0.65} wobble={0.7}
    thrustColor={dark() ? '#eeeeea' : '#767673'} smokeColor={dark() ? '#b8b8b3' : '#a3a39c'}
    buttonColor={dark() ? '#deded6' : '#292928'} textColor={dark() ? '#242423' : '#fafaf8'}
    externalPoint={flightState.point} onEngine={engine => { flightEngine = engine; }}
  >{flightState.name || '准备上传'}</FlyingButton>);
}

export function initializeEffects(onChoose) {
  chooseFile = onChoose;
  const folder = document.getElementById('folder-island');
  folderRoot = mount(folder, null);
  folder.addEventListener('pointerover', event => {
    if (event.pointerType !== 'mouse' || !event.target.closest('.folder-float')) return;
    if (!folderHovered) { folderHovered = true; renderFolder(); }
  });
  folder.addEventListener('pointerout', event => {
    if (event.relatedTarget?.closest?.('.folder-float')) return;
    folderHovered = false; renderFolder();
  });
  folder.addEventListener('focusin', () => { folderFocused = true; renderFolder(); });
  folder.addEventListener('focusout', event => {
    if (folder.contains(event.relatedTarget)) return;
    folderFocused = false; renderFolder();
  });
  for (const id of ['upload-particles', 'upload-card-particles']) {
    const particles = document.getElementById(id);
    particles.replaceChildren(...Array.from({ length: 18 }, (_, i) => {
      const dot = document.createElement('i');
      dot.style.cssText = `--x:${(i * 37 + 11) % 100}%;--y:${(i * 23 + 17) % 86 + 7}%;--size:${i % 3 === 0 ? 2 : 1}px;--delay:${-i * .31}s;--duration:${1.4 + i % 5 * .3}s`;
      return dot;
    }));
  }
  flightRoot = mount(document.getElementById('flight'), null);
  renderFolder(); setProgress(0);
  const fitIntro = () => {
    const viewHeight = Math.min(innerHeight, visualViewport?.height || innerHeight);
    document.documentElement.style.setProperty('--view-height', `${viewHeight}px`);
    const scale = Math.max(0, Math.min(1, (document.getElementById('drop').clientHeight - 8) / 102));
    folder.style.setProperty('--folder-scale', String(scale));
  };
  fitIntro();
  new ResizeObserver(fitIntro).observe(document.getElementById('drop'));
  addEventListener('resize', fitIntro); visualViewport?.addEventListener('resize', fitIntro);
}
export function syncEffectTheme() { renderFolder(); if (flightState) renderFlight(); }
export function setProgress(value) {
  const upload = document.getElementById('upload');
  const progress = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
  upload.style.setProperty('--upload-progress', `${progress}%`);
  upload.dataset.empty = String(progress === 0);
  upload.dataset.complete = String(progress === 100);
}
export function followFlight(event) {
  clearTimeout(folderTimer);
  const drop = document.getElementById('drop');
  drop.classList.add('drag');
  const name = event.dataTransfer?.items?.[0]?.getAsFile()?.name || '文件已就位';
  folderState = { open: true, label: '松手上传', sub: '准备接收', items: [{ label: name, value: 'incoming' }] };
  renderFolder();
  flightState = {
    phase: 'following', name: name === '文件已就位' ? '准备上传' : shorten(name),
    point: { x: Math.max(65, Math.min(innerWidth - 65, event.clientX - 40)), y: Math.max(26, event.clientY - 42) }
  };
  renderFlight();
}
function shorten(name) { return name.length > 18 ? `${name.slice(0, 15)}…` : name; }
export function hideFlight() {
  flightRun++; clearTimeout(folderTimer);
  document.getElementById('drop').classList.remove('drag');
  flightState = null; renderFlight();
  folderState = { open: false, label: '上传文件', sub: '点击或拖入', items: [] }; renderFolder();
}
export function launchFlight(event, file) {
  followFlight(event);
  const run = ++flightRun;
  const host = document.getElementById('flight');
  document.getElementById('drop').classList.remove('drag');
  folderState = { ...folderState, label: '正在接收', items: [{ label: shorten(file.name), value: 'incoming' }] };
  renderFolder();
  if (reduce()) { hideFlight(); return; }
  const start = { ...flightState.point };
  const folder = document.querySelector('.folder-float__folder').getBoundingClientRect();
  const target = { x: folder.left + folder.width / 2, y: folder.top + folder.height * 0.4 };
  const control = { x: (start.x + target.x) / 2, y: Math.max(30, Math.min(start.y, target.y) - 75) };
  const startTime = performance.now(), duration = 720;
  flightState.phase = 'docking'; host.dataset.phase = 'docking';
  const tick = now => {
    if (run !== flightRun) return;
    const t = Math.min(1, (now - startTime) / duration), u = t * t * (3 - 2 * t);
    const x = (1-u)**2 * start.x + 2*(1-u)*u*control.x + u*u*target.x;
    const y = (1-u)**2 * start.y + 2*(1-u)*u*control.y + u*u*target.y;
    flightEngine?.externalAt(x, y);
    const craft = host.querySelector('.flying-button__craft');
    if (craft) { craft.style.scale = String(1 - 0.86 * u); craft.style.opacity = String(1 - u ** 3); }
    if (t < 1) requestAnimationFrame(tick);
    else {
      flightState = null; renderFlight();
      folderTimer = setTimeout(hideFlight, 180);
    }
  };
  requestAnimationFrame(tick);
}

function DeleteControl({ item, onOpen, onConfirm, onDone, onError, register }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [geometry, setGeometry] = useState(null);
  const trigger = useRef(null), box = useRef(null), doneTimer = useRef();
  const state = useRef({ busy: false });
  state.current.close = (focus = false) => {
    if (state.current.busy) return;
    state.current.restoreFocus = focus; setOpen(false);
  };
  useEffect(() => { register(state.current); return () => clearTimeout(doneTimer.current); }, []);
  useLayoutEffect(() => {
    if (!open) {
      if (state.current.restoreFocus) { trigger.current?.focus({ preventScroll: true }); state.current.restoreFocus = false; }
      return;
    }
    const row = box.current.closest('tr'), shell = box.current.closest('.delete-shell');
    row.classList.add('delete-active'); shell.classList.add('expanded');
    const measure = () => setGeometry({ width: row.offsetWidth - 16, height: Math.min(56, row.offsetHeight - 16) });
    measure();
    const observer = new ResizeObserver(measure); observer.observe(row);
    return () => { observer.disconnect(); row.classList.remove('delete-active'); shell.classList.remove('expanded'); };
  }, [open]);
  useEffect(() => { if (open && geometry) box.current?.querySelector('[role="slider"]')?.focus({ preventScroll: true }); }, [open, !!geometry]);
  return <span ref={box} className={`delete-control${open ? ' open' : ''}${busy ? ' deleting' : ''}`}>
    <button type="button" className="delete-trigger icon-button" ref={trigger}
      aria-label="删除" title={`删除${item.isDir ? '目录' : '文件'}“${item.name}”`} aria-expanded={open}
      onClick={() => { if (open) { state.current.close(true); return; } onOpen(state.current); setOpen(true); }}>
      <Trash2 size={16} strokeWidth={1.7} aria-hidden="true" />
    </button>
    {open && geometry && <span className="delete-confirm">
      <SlideCommit label={item.isDir ? '← 左滑至最左侧删除目录及内容' : '← 左滑至最左侧删除'} doneLabel="已删除" errorLabel="删除失败，左滑重试"
        confirmationLabel={item.isDir ? '文件夹类型：将删除其中所有文件，再次左滑确认' : undefined}
        width={geometry.width} height={geometry.height} radius={12} holdMs={0} successColor="#cf3b3b" dangerColor="#cf3b3b"
        reverse handleOnly icon={<Trash2 size={20} strokeWidth={1.7} />} trackColor="transparent" handleColor="#262626"
        onConfirm={async () => {
          state.current.busy = true; setBusy(true);
          try { await onConfirm(); } catch (error) { state.current.busy = false; setBusy(false); throw error; }
        }}
        onDone={() => { doneTimer.current = setTimeout(onDone, reduce() ? 100 : 650); }}
        onError={onError} onCancel={() => state.current.close(true)} />
      <button type="button" className="delete-dismiss" aria-label="取消删除" disabled={busy}
        onClick={() => state.current.close(true)}><X size={15} aria-hidden="true" /></button>
    </span>}
  </span>;
}
export function mountDeletion(host, props) {
  mount(host, <DeleteControl {...props} />, true);
}
