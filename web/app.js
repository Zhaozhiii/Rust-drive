'use strict';
(() => {
const $ = id => document.getElementById(id), api = '/api/clouddrive';
const KEY = 'clouddrive-pending-upload', TIME = 'clouddrive-upload-seconds';
let path = new URLSearchParams(location.search).get('path') || '', pending = null, running = false, stopped = false;
let elapsed = 0, transferred = 0, speed = 0, sampleBytes = 0, active = new Set(), timer, listSequence = 0;
function stored(key) { try { return localStorage.getItem(key); } catch { return null; } }
function store(key, value) { try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, String(value)); } catch {} }
function error(e = '') { $('error').textContent = e.message || String(e); }
function bytes(n) { const units = ['B','KiB','MiB','GiB']; let i = 0; while (n >= 1024 && i < 3) { n /= 1024; i++; } return `${n.toFixed(i ? 2 : 0)} ${units[i]}`; }
function duration(n) { n = Math.max(0, Math.floor(n)); return `${Math.floor(n/3600)}:${String(Math.floor(n%3600/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
async function request(url, init) { const response = await fetch(url, init); const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.message || `请求失败 (${response.status})`); return data; }
function button(label, action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', () => Promise.resolve().then(action).catch(error)); return b; }
function join(name) { return path ? `${path}/${name}` : name; }
async function list(dir = path) {
 const seq = ++listSequence; $('loading').textContent = '正在读取目录…';
 try { const data = await request(`${api}/list?path=${encodeURIComponent(dir)}`); if(seq !== listSequence) return; path = data.sub;
 history.replaceState(null, '', path ? `/?path=${encodeURIComponent(path)}` : '/');
 $('capacity').textContent = `已用 ${bytes(data.totalSize)} / ${bytes(data.maxSize)} (${(data.totalSize/data.maxSize*100).toFixed(1)}%)`;
 $('breadcrumbs').replaceChildren(button('根目录', () => list('')));
 const parts = path.split('/').filter(Boolean); parts.forEach((part,i) => { $('breadcrumbs').append(' / ', button(part, () => list(parts.slice(0,i+1).join('/')))); });
 const rows = []; if (path) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 4; td.append(button('返回上级目录', () => list(parts.slice(0,-1).join('/')))); tr.append(td); rows.push(tr); }
 for (const item of data.entries) { const tr = document.createElement('tr'), name = document.createElement('td'), size = document.createElement('td'), modified = document.createElement('td'), actions = document.createElement('td');
 const full = join(item.name); if (item.isDir) name.append(button(`[目录] ${item.name}`, () => list(full))); else name.textContent = item.name;
 size.textContent = item.isDir ? '—' : bytes(item.size); modified.className = 'modified'; modified.textContent = new Date(item.modified).toLocaleString();
 if(!item.isDir) { const a = document.createElement('a'); a.textContent = '下载'; a.href = `${api}/download?path=${encodeURIComponent(full)}`; a.download = item.name; actions.append(a,' '); }
 actions.append(button('删除', async () => { if (!confirm(`确认删除${item.isDir ? '目录及全部内容' : '文件'}“${item.name}”？`)) return; await request(`${api}/remove?path=${encodeURIComponent(full)}`, {method:'DELETE'}); error(); await list(); }));
 tr.append(name,size,modified,actions); rows.push(tr); }
 if(!data.entries.length) { const tr = document.createElement('tr'), td = document.createElement('td'); td.colSpan = 4; td.textContent = '空目录'; tr.append(td); rows.push(tr); }
 $('entries').replaceChildren(...rows);
 } catch(e) { error(e); } finally { if(seq === listSequence) $('loading').textContent = ''; }
}
function render() {
 $('upload').hidden = !pending; $('choose').disabled = running; $('choose').textContent = pending ? '选择原文件续传' : '上传文件'; $('resume').hidden = running;
 if(!pending) return; const percent = Math.min(100,transferred/pending.size*100);
 $('progress').textContent = `${running ? '正在上传' : '等待续传'}：${pending.name}；${percent.toFixed(1)}%；${bytes(transferred)} / ${bytes(pending.size)}；速度 ${bytes(speed)}/s；已用 ${duration(elapsed)}；预计剩余 ${running && speed > 0 ? duration((pending.size-transferred)/speed) : '暂停或计算中'}`;
}
function completedBytes(session) { return session.completed.reduce((n,i) => n + Math.min(session.chunkSize,session.size-i*session.chunkSize),0); }
async function upload(file) {
 if(!file || running) return; error(); stopped = false;
 try {
 if(pending) { if(file.name!==pending.name || file.size!==pending.size || file.lastModified!==pending.lastModified) throw new Error('请选择原文件继续上传，或先取消未完成的上传'); pending = await request(`${api}/upload-session/${pending.id}`); }
 else { pending = await request(`${api}/upload-session`, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({path,name:file.name,size:file.size,lastModified:file.lastModified})}); elapsed = 0; store(TIME,0); }
 store(KEY,pending.id); const session = pending; running = true; transferred = completedBytes(session); speed = 0; sampleBytes = 0;
 let completed = transferred, next = 0, failure = null; const done = new Set(session.completed), inflight = new Map();
 const update = () => { transferred = Math.min(file.size,completed + [...inflight.values()].reduce((a,b) => a+b,0)); render(); };
 let last = performance.now(); timer = setInterval(() => { const now = performance.now(); speed = sampleBytes*1000/(now-last); elapsed += (now-last)/1000; last = now; sampleBytes = 0; store(TIME,elapsed); render(); },1000); render();
 const send = index => new Promise((resolve,reject) => {
 const xhr = new XMLHttpRequest(), start = index*session.chunkSize, part = file.slice(start,Math.min(file.size,start+session.chunkSize)); let previous = 0;
 active.add(xhr); xhr.open('PUT',`${api}/upload-session/${session.id}/chunk/${index}`); xhr.setRequestHeader('Content-Type','application/octet-stream'); xhr.timeout = 300000;
 xhr.upload.onprogress = event => { const n = Math.min(event.loaded,part.size); sampleBytes += Math.max(0,n-previous); previous=n; inflight.set(index,n); update(); };
 const cleanup = () => { active.delete(xhr); inflight.delete(index); update(); };
 xhr.onload = () => { cleanup(); if(xhr.status>=200 && xhr.status<300) resolve(); else { let message = `分片 ${index+1} 上传失败 (${xhr.status})`; try {message=JSON.parse(xhr.responseText).message || message;}catch{} reject(new Error(message)); } };
 xhr.onerror = xhr.ontimeout = () => {cleanup();reject(new Error('网络中断或请求超时，请重选原文件续传'));}; xhr.onabort = () => {cleanup();reject(new Error('上传已中断'));}; xhr.send(part);
 });
 const worker = async () => { try { while(!stopped && !failure) { const index=next++; if(index>=Math.ceil(file.size/session.chunkSize)) return; if(done.has(index)) continue;
 for(let attempt=0;attempt<3;attempt++) { if(stopped || failure) return; try {await send(index);break;} catch(e) {if(attempt===2 || stopped) throw e; await new Promise(r=>setTimeout(r,500*(attempt+1)));} }
 if(stopped || failure) return; done.add(index); completed+=Math.min(session.chunkSize,file.size-index*session.chunkSize); session.completed=[...done]; update();
 } } catch(e) { if(!failure) failure=e; active.forEach(xhr=>xhr.abort()); } };
 await Promise.all(Array.from({length:Math.min(3,Math.ceil(file.size/session.chunkSize))},worker));
 if(stopped) return; if(failure) throw failure;
 await request(`${api}/upload-session/${session.id}/complete`,{method:'POST'}); pending=null; store(KEY,null); store(TIME,null); await list(session.path);
 } catch(e) { if(!stopped) {error(e);if(pending) {try {pending=await request(`${api}/upload-session/${pending.id}`);transferred=completedBytes(pending);} catch {}}} }
 finally {clearInterval(timer);active.forEach(xhr=>xhr.abort());running=false;speed=0;$('file').value='';render();}
}
async function cancel() { if(!pending || !confirm('取消上传并删除该上传任务的临时数据？')) return; stopped=true;active.forEach(xhr=>xhr.abort());try {await request(`${api}/upload-session/${pending.id}`,{method:'DELETE'}); pending=null;store(KEY,null);store(TIME,null);error();} catch(e) {error(e);}render(); }
$('refresh').onclick = () => list(); $('new-folder').onclick = () => {$('mkdir').hidden = !$('mkdir').hidden;if(!$('mkdir').hidden)$('folder-name').focus();}; $('mkdir-cancel').onclick = () => {$('mkdir').hidden=true;};
$('mkdir').onsubmit = async e => {e.preventDefault();try {const name=$('folder-name').value.trim();if(!name)return;await request(`${api}/mkdir?path=${encodeURIComponent(path)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});$('folder-name').value='';$('mkdir').hidden=true;error();await list();}catch(e){error(e);}};
$('choose').onclick = $('resume').onclick = () => $('file').click(); $('file').onchange = e => upload(e.target.files[0]); $('cancel-upload').onclick=cancel;
document.body.addEventListener('dragover',e=>{e.preventDefault();$('drop').classList.add('drag');});document.body.addEventListener('dragleave',e=>{if(!e.relatedTarget)$('drop').classList.remove('drag');});document.body.addEventListener('drop',e=>{e.preventDefault();$('drop').classList.remove('drag');if(e.dataTransfer.files.length>1){error('每次请选择一个文件上传');return;}upload(e.dataTransfer.files[0]);});
list(); const id=stored(KEY);if(id) {elapsed=Number(stored(TIME))||0;request(`${api}/upload-session/${encodeURIComponent(id)}`).then(s=>{pending=s;transferred=completedBytes(s);render();}).catch(e=>{store(KEY,null);store(TIME,null);error(e);});}
})();
