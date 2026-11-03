mod storage;
use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, Multipart, Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use futures_util::StreamExt;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use storage::{Root, allocated, scan_size};
use tokio::{
    io::{AsyncSeekExt, AsyncWriteExt},
    sync::{Mutex, RwLock, Semaphore},
};

const CHUNK: u64 = 16 * 1024 * 1024;
const WRITE_BUFFER: usize = 256 * 1024;
const MAX_BATCH: usize = 100;
const GIB: u64 = 1024 * 1024 * 1024;
type Result<T> = std::result::Result<T, Error>;
#[derive(Debug)]
struct Error(StatusCode, String);
impl IntoResponse for Error {
    fn into_response(self) -> Response {
        (self.0, Json(json!({"message": self.1}))).into_response()
    }
}
impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        let code = match e.raw_os_error() {
            Some(libc::ENOSPC) => StatusCode::INSUFFICIENT_STORAGE,
            Some(libc::EEXIST) => StatusCode::CONFLICT,
            Some(libc::ENOENT) => StatusCode::NOT_FOUND,
            Some(libc::ELOOP) | Some(libc::EXDEV) | Some(libc::EINVAL) | Some(libc::ENOTDIR) => {
                StatusCode::BAD_REQUEST
            }
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        Self(
            code,
            match code {
                StatusCode::NOT_FOUND => "文件或目录不存在".into(),
                StatusCode::CONFLICT => "文件或目录已存在".into(),
                StatusCode::BAD_REQUEST => "无效的路径".into(),
                StatusCode::INSUFFICIENT_STORAGE => "磁盘空间不足".into(),
                _ => {
                    eprintln!("storage: {e}");
                    "文件操作失败".into()
                }
            },
        )
    }
}
fn bad(s: &str) -> Error {
    Error(StatusCode::BAD_REQUEST, s.into())
}
fn missing() -> Error {
    Error(StatusCode::NOT_FOUND, "上传任务不存在".into())
}
fn conflict(s: &str) -> Error {
    Error(StatusCode::CONFLICT, s.into())
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}
#[derive(Clone)]
struct App {
    root: Arc<Root>,
    used: Arc<Mutex<Budget>>,
    tree: Arc<Mutex<()>>,
    sessions: Arc<Mutex<HashMap<String, Arc<Session>>>>,
    streams: Arc<Semaphore>,
    disk: Arc<std::sync::Mutex<u64>>,
    max: u64,
    max_file: u64,
    floor: u64,
}
struct Budget {
    used: u64,
    reserved: HashMap<String, u64>,
}
// Reserve in-flight writes separately from the logical file quota. The guard
// lives inside the blocking write task, including if its HTTP request is aborted.
struct DiskWrite {
    pending: Arc<std::sync::Mutex<u64>>,
    bytes: u64,
}
impl DiskWrite {
    fn claim(pending: &mut u64, available: u64, bytes: u64) -> Result<()> {
        if available.saturating_sub(*pending) < bytes {
            return Err(Error(
                StatusCode::INSUFFICIENT_STORAGE,
                "磁盘空间不足".into(),
            ));
        }
        *pending += bytes;
        Ok(())
    }
    fn acquire(
        root: &Root,
        disk: &Arc<std::sync::Mutex<u64>>,
        floor: u64,
        bytes: u64,
    ) -> Result<Self> {
        let mut pending = disk.lock().unwrap();
        Self::claim(&mut pending, root.free()?.saturating_sub(floor), bytes)?;
        Ok(Self {
            pending: disk.clone(),
            bytes,
        })
    }
}
impl Drop for DiskWrite {
    fn drop(&mut self) {
        *self.pending.lock().unwrap() -= self.bytes;
    }
}
fn task_error(e: tokio::task::JoinError) -> Error {
    std::io::Error::other(e).into()
}
// Coalesce small HTTP frames without buffering a whole chunk or file.
struct UploadWriter {
    file: Arc<std::fs::File>,
    buffer: Vec<u8>,
}
impl UploadWriter {
    fn new(file: std::fs::File) -> Self {
        Self {
            file: Arc::new(file),
            buffer: Vec::with_capacity(WRITE_BUFFER),
        }
    }
    async fn write(&mut self, a: &App, mut data: &[u8]) -> Result<()> {
        while !data.is_empty() {
            let n = data.len().min(WRITE_BUFFER - self.buffer.len());
            self.buffer.extend_from_slice(&data[..n]);
            data = &data[n..];
            if self.buffer.len() == WRITE_BUFFER {
                self.flush(a).await?;
            }
        }
        Ok(())
    }
    async fn flush(&mut self, a: &App) -> Result<()> {
        if self.buffer.is_empty() {
            return Ok(());
        }
        let file = self.file.clone();
        let root = a.root.clone();
        let disk = a.disk.clone();
        let floor = a.floor;
        let mut buffer = std::mem::take(&mut self.buffer);
        self.buffer = tokio::task::spawn_blocking(move || -> Result<Vec<u8>> {
            use std::io::Write;
            let _space = DiskWrite::acquire(&root, &disk, floor, buffer.len() as u64)?;
            (&*file).write_all(&buffer)?;
            buffer.clear();
            Ok(buffer)
        })
        .await
        .map_err(task_error)??;
        Ok(())
    }
    async fn sync(&self, data_only: bool) -> Result<()> {
        let file = self.file.clone();
        tokio::task::spawn_blocking(move || {
            if data_only {
                file.sync_data()
            } else {
                file.sync_all()
            }
        })
        .await
        .map_err(task_error)??;
        Ok(())
    }
}
#[derive(Serialize, Deserialize, Clone)]
struct Meta {
    id: String,
    dir: String,
    name: String,
    size: u64,
    #[serde(rename = "lastModified")]
    last_modified: u64,
    done: Vec<bool>,
    #[serde(rename = "createdAt")]
    created_at: u64,
}
struct Session {
    meta: Mutex<Meta>,
    ops: RwLock<()>,
    chunks: Vec<Mutex<()>>,
    folder: PathBuf,
}
impl Session {
    fn new(meta: Meta, folder: PathBuf) -> Self {
        let chunks = (0..meta.done.len()).map(|_| Mutex::new(())).collect();
        Self {
            meta: Mutex::new(meta),
            ops: RwLock::new(()),
            chunks,
            folder,
        }
    }
}
fn status(m: &Meta) -> Value {
    json!({"id":m.id,"path":m.dir,"name":m.name,"size":m.size,"lastModified":m.last_modified,"chunkSize":CHUNK,"completed":m.done.iter().enumerate().filter_map(|(i,d)|d.then_some(i)).collect::<Vec<_>>()})
}
async fn save(s: &Session, m: &Meta) -> Result<()> {
    let tmp = s.folder.join("session.json.tmp");
    let mut f = tokio::fs::File::create(&tmp).await?;
    f.write_all(&serde_json::to_vec(m).unwrap()).await?;
    f.sync_all().await?;
    tokio::fs::rename(tmp, s.folder.join("session.json")).await?;
    tokio::fs::File::open(&s.folder).await?.sync_all().await?;
    Ok(())
}

#[cfg(test)]
mod transfer_tests {
    use super::*;

    #[test]
    fn concurrent_writes_cannot_spend_the_same_free_space() {
        let mut pending = 0;
        DiskWrite::claim(&mut pending, 1024, 768).unwrap();
        assert_eq!(
            DiskWrite::claim(&mut pending, 1024, 257).unwrap_err().0,
            StatusCode::INSUFFICIENT_STORAGE
        );
        assert_eq!(pending, 768);
        DiskWrite::claim(&mut pending, 1024, 256).unwrap();
        assert_eq!(pending, 1024);
        assert!(DiskWrite::claim(&mut pending, 512, 1).is_err());
    }

    #[tokio::test]
    async fn cancelled_waiter_keeps_space_reserved_until_disk_task_finishes() {
        let pending = Arc::new(std::sync::Mutex::new(256));
        let guard = DiskWrite {
            pending: pending.clone(),
            bytes: 256,
        };
        let (started, ready) = tokio::sync::oneshot::channel();
        let (release, wait) = std::sync::mpsc::channel();
        let (finished, done) = tokio::sync::oneshot::channel();
        let task = tokio::task::spawn_blocking(move || {
            let _ = started.send(());
            wait.recv().unwrap();
            drop(guard);
            let _ = finished.send(());
        });
        ready.await.unwrap();
        task.abort();
        assert_eq!(*pending.lock().unwrap(), 256);
        release.send(()).unwrap();
        done.await.unwrap();
        assert_eq!(*pending.lock().unwrap(), 0);
    }
}
async fn session(a: &App, id: &str) -> Result<Arc<Session>> {
    a.sessions.lock().await.get(id).cloned().ok_or_else(missing)
}
fn valid_name(n: &str) -> Result<()> {
    if n.is_empty()
        || n == "."
        || n == ".."
        || n == ".uploads"
        || n == ".tmp"
        || n.contains(['/', '\\', '\0'])
    {
        return Err(bad("无效的文件或目录名称"));
    }
    Ok(())
}
fn valid_upload(a: &App, name: &str, size: u64, last_modified: u64) -> Result<()> {
    valid_name(name)?;
    if size == 0 || size > a.max_file || last_modified > 9007199254740991 {
        return Err(bad(&format!(
            "文件信息无效或超过 {} 单文件上限",
            display(a.max_file)
        )));
    }
    Ok(())
}
#[derive(Deserialize)]
struct Location {
    #[serde(default)]
    path: String,
}
#[derive(Deserialize)]
struct Name {
    name: String,
}
#[derive(Deserialize)]
struct Create {
    path: String,
    name: String,
    size: u64,
    #[serde(rename = "lastModified")]
    last_modified: u64,
}
#[derive(Deserialize)]
struct BatchFile {
    name: String,
    size: u64,
    #[serde(rename = "lastModified")]
    last_modified: u64,
}
#[derive(Deserialize)]
struct Batch {
    path: String,
    files: Vec<BatchFile>,
}
fn display(n: u64) -> String {
    if n < GIB {
        if n < 1024 {
            format!("{n} B")
        } else if n < 1024 * 1024 {
            format!("{:.1} KB", n as f64 / 1024.)
        } else {
            format!("{:.1} MB", n as f64 / (1024. * 1024.))
        }
    } else {
        format!("{:.2} GB", n as f64 / GIB as f64)
    }
}
async fn list(State(a): State<App>, Query(q): Query<Location>) -> Result<Json<Value>> {
    let _tree = a.tree.lock().await;
    let dir = a.root.dir(&q.path)?;
    let mut entries = Vec::new();
    for ent in std::fs::read_dir(dir.proc())? {
        let e = ent?;
        let name = e.file_name().to_string_lossy().into_owned();
        if q.path.is_empty() && [".tmp", ".uploads"].contains(&name.as_str()) {
            continue;
        }
        let ft = e.file_type()?;
        if ft.is_symlink() || !(ft.is_file() || ft.is_dir()) {
            continue;
        }
        let m = e.metadata()?;
        let modified: chrono::DateTime<chrono::Utc> = m.modified()?.into();
        entries.push(json!({"name":name,"isDir":ft.is_dir(),"size":if ft.is_dir(){None}else{Some(m.len())},"sizeDisplay":if ft.is_dir(){"-".into()}else{display(m.len())},"modified":modified.to_rfc3339_opts(chrono::SecondsFormat::Millis,true)}));
    }
    entries.sort_by(|x, y| {
        y["isDir"]
            .as_bool()
            .cmp(&x["isDir"].as_bool())
            .then_with(|| x["name"].as_str().cmp(&y["name"].as_str()))
    });
    let b = a.used.lock().await;
    Ok(Json(
        json!({"entries":entries,"totalSize":b.used,"maxSize":a.max,"sub":q.path}),
    ))
}
async fn mkdir(
    State(a): State<App>,
    Query(q): Query<Location>,
    Json(n): Json<Name>,
) -> Result<Json<Value>> {
    valid_name(&n.name)?;
    let _tree = a.tree.lock().await;
    let d = a.root.dir(&q.path)?;
    std::fs::create_dir(d.proc().join(n.name))?;
    Ok(Json(json!({"message":"创建成功"})))
}
async fn remove(State(a): State<App>, Query(q): Query<Location>) -> Result<Json<Value>> {
    tokio::spawn(remove_entry(a, q)).await.map_err(task_error)?
}
async fn remove_entry(a: App, q: Location) -> Result<Json<Value>> {
    if q.path.is_empty() {
        return Err(bad("不能删除根目录"));
    }
    let _tree = a.tree.lock().await;
    let root = a.root.clone();
    let size = tokio::task::spawn_blocking(move || -> Result<u64> {
        let (p, n) = root.parent(&q.path)?;
        let f = root.open(&q.path, false)?;
        let md = f.file.metadata()?;
        let size = if md.is_dir() {
            scan_size(&f.proc(), false)?
        } else {
            md.len()
        };
        if md.is_dir() {
            std::fs::remove_dir_all(p.proc().join(n))?
        } else {
            std::fs::remove_file(p.proc().join(n))?
        }
        Ok(size)
    })
    .await
    .map_err(task_error)??;
    let mut b = a.used.lock().await;
    b.used = b.used.saturating_sub(size);
    Ok(Json(json!({"message":"删除成功"})))
}
async fn download(State(a): State<App>, Query(q): Query<Location>) -> Result<Response> {
    // openat2 constrains this lookup; atomic replacement needs no tree lock.
    // Downloads should not queue behind recursive deletion or commit fsync.
    let f = a.root.open(&q.path, false)?;
    if !f.file.metadata()?.is_file() {
        return Err(bad("请选择文件"));
    }
    let mut h = HeaderMap::new();
    let uri = format!(
        "/_drive_internal/{}",
        q.path
            .split('/')
            .map(|x| utf8_percent_encode(x, NON_ALPHANUMERIC).to_string())
            .collect::<Vec<_>>()
            .join("/")
    );
    h.insert(
        "X-Accel-Redirect",
        HeaderValue::from_str(&uri).map_err(|_| bad("无效的路径"))?,
    );
    let filename = q.path.rsplit('/').next().unwrap_or("download");
    h.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_str(&format!(
            "attachment; filename=\"download\"; filename*=UTF-8''{}",
            utf8_percent_encode(filename, NON_ALPHANUMERIC)
        ))
        .unwrap(),
    );
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(
        "X-Content-Type-Options",
        HeaderValue::from_static("nosniff"),
    );
    Ok((h, "").into_response())
}
fn check_space(a: &App, b: &Budget, exclude: Option<&str>, requested: u64) -> Result<()> {
    let reserved: u64 = b
        .reserved
        .iter()
        .filter(|(key, _)| exclude != Some(key.as_str()))
        .map(|(_, size)| size)
        .sum();
    if b.used.saturating_add(reserved).saturating_add(requested) > a.max {
        return Err(Error(
            StatusCode::INSUFFICIENT_STORAGE,
            format!("超过 {} 总容量限制（含未完成上传）", display(a.max)),
        ));
    }
    let mut future = requested.saturating_sub(exclude.map_or(0, |id| {
        allocated(&a.root.path.join(".uploads").join(id).join("data.part"))
    }));
    for (key, n) in &b.reserved {
        if exclude != Some(key.as_str()) {
            future = future.saturating_add(n.saturating_sub(allocated(
                &a.root.path.join(".uploads").join(key).join("data.part"),
            )));
        }
    }
    if a.root.free()?.saturating_sub(a.floor) < future {
        return Err(Error(
            StatusCode::INSUFFICIENT_STORAGE,
            "磁盘可用空间不足，需保留系统空间".into(),
        ));
    }
    Ok(())
}
async fn reserve(a: &App, id: &str, size: u64) -> Result<()> {
    let mut b = a.used.lock().await;
    check_space(a, &b, Some(id), size)?;
    b.reserved.insert(id.to_owned(), size);
    Ok(())
}
async fn create(State(a): State<App>, Json(q): Json<Create>) -> Result<(StatusCode, Json<Value>)> {
    valid_upload(&a, &q.name, q.size, q.last_modified)?;
    {
        // Only validate the destination before creating the hidden session.
        // The final commit repeats this lookup, so a directory cannot be
        // removed underneath us without producing a clear error later.
        let _tree = a.tree.lock().await;
        a.root.dir(&q.path)?;
    }
    let id = uuid::Uuid::new_v4().to_string();
    reserve(&a, &id, q.size).await?;
    let folder = a.root.path.join(".uploads").join(&id);
    let meta = Meta {
        id: id.clone(),
        dir: q.path,
        name: q.name,
        size: q.size,
        last_modified: q.last_modified,
        done: vec![false; q.size.div_ceil(CHUNK) as usize],
        created_at: now(),
    };
    let s = Arc::new(Session::new(meta.clone(), folder));
    let result: Result<()> = async {
        tokio::fs::create_dir(&s.folder).await?;
        tokio::fs::File::create(s.folder.join("data.part")).await?;
        save(&s, &meta).await?;
        Ok(())
    }
    .await;
    if let Err(e) = result {
        a.used.lock().await.reserved.remove(&id);
        let _ = tokio::fs::remove_dir_all(&s.folder).await;
        return Err(e);
    }
    a.sessions.lock().await.insert(id, s);
    Ok((StatusCode::CREATED, Json(status(&meta))))
}
async fn batch(State(a): State<App>, Json(q): Json<Batch>) -> Result<Json<Value>> {
    if q.files.is_empty() {
        return Err(bad("请选择文件"));
    }
    if q.files.len() > MAX_BATCH {
        return Err(bad(&format!("一次最多选择 {MAX_BATCH} 个文件")));
    }
    a.root.dir(&q.path)?;
    let mut names = HashSet::with_capacity(q.files.len());
    let mut total = 0u64;
    for file in &q.files {
        valid_upload(&a, &file.name, file.size, file.last_modified)?;
        if !names.insert(file.name.as_str()) {
            return Err(bad("同一批次中不能包含重名文件"));
        }
        total = total.saturating_add(file.size);
    }
    let remaining = {
        let b = a.used.lock().await;
        check_space(&a, &b, None, total)?;
        let committed = b
            .used
            .saturating_add(b.reserved.values().copied().sum::<u64>())
            .saturating_add(total);
        a.max.saturating_sub(committed)
    };
    Ok(Json(json!({
        "count":q.files.len(),
        "totalSize":total,
        "maxSize":a.max,
        "remaining":remaining
    })))
}
async fn get_session(State(a): State<App>, Path(id): Path<String>) -> Result<Json<Value>> {
    let s = session(&a, &id).await?;
    let _op = s.ops.read().await;
    let m = s.meta.lock().await;
    if !s.folder.exists() {
        return Err(missing());
    }
    Ok(Json(status(&m)))
}
async fn chunk(
    State(a): State<App>,
    Path((id, index)): Path<(String, usize)>,
    body: axum::body::Body,
) -> Result<Json<Value>> {
    // A disconnected handler must not release its chunk lock while a detached
    // blocking disk write can still be running. Let this task finish that write.
    tokio::spawn(write_chunk(a, id, index, body))
        .await
        .map_err(task_error)?
}
async fn write_chunk(
    a: App,
    id: String,
    index: usize,
    body: axum::body::Body,
) -> Result<Json<Value>> {
    let _permit = a.streams.acquire().await.unwrap();
    let s = session(&a, &id).await?;
    let _op = s.ops.read().await;
    let lock = s.chunks.get(index).ok_or_else(|| bad("分片序号无效"))?;
    let _chunk = lock.lock().await;
    let m = s.meta.lock().await.clone();
    if !s.folder.exists() {
        return Err(missing());
    }
    if m.done[index] {
        let expected = CHUNK.min(m.size - index as u64 * CHUNK);
        let mut n = 0u64;
        let mut stream = body.into_data_stream();
        while let Some(part) = stream.next().await {
            let part = part.map_err(|_| bad("上传已中断"))?;
            n += part.len() as u64;
            if n > expected {
                return Err(bad("分片大小超过预期"));
            }
        }
        if n != expected {
            return Err(bad("分片不完整，请重试"));
        }
        return Ok(Json(json!({"index":index,"completed":true})));
    }
    let expected = CHUNK.min(m.size - index as u64 * CHUNK);
    let mut received = 0;
    let mut f = tokio::fs::OpenOptions::new()
        .write(true)
        .open(s.folder.join("data.part"))
        .await?;
    f.seek(std::io::SeekFrom::Start(index as u64 * CHUNK))
        .await?;
    let mut writer = UploadWriter::new(f.into_std().await);
    let mut stream = body.into_data_stream();
    while let Some(part) = stream.next().await {
        let part = part.map_err(|_| bad("上传已中断"))?;
        if received + part.len() as u64 > expected {
            return Err(bad("分片大小超过预期"));
        }
        writer.write(&a, &part).await?;
        received += part.len() as u64;
    }
    if received != expected {
        return Err(bad("分片不完整，请重试"));
    }
    writer.flush(&a).await?;
    writer.sync(true).await?;
    let mut current = s.meta.lock().await;
    let mut next = current.clone();
    next.done[index] = true;
    save(&s, &next).await?;
    *current = next;
    Ok(Json(json!({"index":index,"completed":true})))
}
async fn complete(State(a): State<App>, Path(id): Path<String>) -> Result<Json<Value>> {
    let s = session(&a, &id).await?;
    let _op = s.ops.write().await;
    let _tree = a.tree.lock().await;
    let m = s.meta.lock().await.clone();
    if m.done.iter().any(|d| !d) {
        return Err(conflict("仍有分片未上传"));
    }
    let part = s.folder.join("data.part");
    if std::fs::metadata(&part)?.len() != m.size {
        return Err(conflict("文件大小不一致"));
    }
    let d = a.root.dir(&m.dir)?;
    let target = d.proc().join(&m.name);
    let old = match std::fs::symlink_metadata(&target) {
        Ok(v) => {
            if !v.is_file() {
                return Err(conflict("目标不是普通文件"));
            }
            v.len()
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
        Err(e) => return Err(e.into()),
    };
    // Persist an intent before rename. Startup recognizes a completed rename after a crash.
    let mut marker = tokio::fs::File::create(s.folder.join("committing")).await?;
    marker.write_all(b"1").await?;
    marker.sync_all().await?;
    tokio::fs::File::open(&s.folder).await?.sync_all().await?;
    tokio::fs::rename(part, &target).await?;
    tokio::fs::File::from_std(d.file).sync_all().await?;
    {
        let mut b = a.used.lock().await;
        b.used = b.used.saturating_sub(old).saturating_add(m.size);
        b.reserved.remove(&id);
    }
    a.sessions.lock().await.remove(&id);
    if let Err(e) = tokio::fs::remove_dir_all(&s.folder).await {
        eprintln!("completed session cleanup: {e}")
    }
    Ok(Json(json!({"message":"上传成功","name":m.name})))
}
async fn cancel(State(a): State<App>, Path(id): Path<String>) -> Result<Json<Value>> {
    let s = session(&a, &id).await?;
    let _op = s.ops.write().await;
    let _tree = a.tree.lock().await;
    if s.folder.exists() {
        tokio::fs::remove_dir_all(&s.folder).await?
    }
    a.sessions.lock().await.remove(&id);
    a.used.lock().await.reserved.remove(&id);
    Ok(Json(json!({"message":"已取消上传"})))
}
async fn multipart(
    State(a): State<App>,
    Query(q): Query<Location>,
    mut upload: Multipart,
) -> Result<Json<Value>> {
    let _permit = a.streams.acquire().await.unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let folder = a.root.path.join(".uploads").join(&id);
    // Legacy uploads reserve incrementally, including bodies without Content-Length.
    {
        let _tree = a.tree.lock().await;
        a.root.dir(&q.path)?;
        reserve(&a, &id, 0).await?;
    }
    let result: Result<Json<Value>> = async {
        tokio::fs::create_dir(&folder).await?;
        let mut field = upload
            .next_field()
            .await
            .map_err(|_| bad("无效的上传表单"))?
            .ok_or_else(|| bad("请选择文件"))?;
        if field.name() != Some("file") {
            return Err(bad("请选择文件"));
        }
        let name = field
            .file_name()
            .ok_or_else(|| bad("缺少文件名"))?
            .to_owned();
        valid_name(&name)?;
        let mut writer = UploadWriter::new(
            tokio::fs::File::create(folder.join("data.part"))
                .await?
                .into_std()
                .await,
        );
        let mut size = 0;
        while let Some(data) = field.chunk().await.map_err(|_| bad("上传已中断"))? {
            size += data.len() as u64;
            if size > a.max_file {
                return Err(bad("文件超过 5 GiB"));
            }
            reserve(&a, &id, size).await?;
            writer.write(&a, &data).await?;
        }
        writer.flush(&a).await?;
        writer.sync(false).await?;
        drop(writer);
        drop(field);
        if upload
            .next_field()
            .await
            .map_err(|_| bad("无效的上传表单"))?
            .is_some()
        {
            return Err(bad("一次只能上传一个文件"));
        }
        let _tree = a.tree.lock().await;
        let d = a.root.dir(&q.path)?;
        let target = d.proc().join(&name);
        let old = match std::fs::symlink_metadata(&target) {
            Ok(v) => {
                if !v.is_file() {
                    return Err(conflict("目标不是普通文件"));
                }
                v.len()
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => 0,
            Err(e) => return Err(e.into()),
        };
        tokio::fs::rename(folder.join("data.part"), target).await?;
        tokio::fs::File::from_std(d.file).sync_all().await?;
        let mut b = a.used.lock().await;
        b.used = b.used.saturating_sub(old).saturating_add(size);
        Ok(Json(json!({"message":"上传成功","name":name})))
    }
    .await;
    if let Err(e) = tokio::fs::remove_dir_all(&folder).await
        && e.kind() != std::io::ErrorKind::NotFound
    {
        eprintln!("multipart cleanup: {e}")
    }
    a.used.lock().await.reserved.remove(&id);
    result
}
fn env_size(k: &str, default: u64) -> u64 {
    std::env::var(k)
        .ok()
        .map(|s| s.parse().expect("invalid size environment variable"))
        .unwrap_or(default)
}
#[tokio::main(flavor = "multi_thread", worker_threads = 2)]
async fn main() -> std::result::Result<(), Box<dyn std::error::Error>> {
    if std::env::args().any(|s| s == "--healthcheck") {
        use std::io::{Read, Write};
        let addr = std::env::var("DRIVE_HEALTH_ADDRESS").unwrap_or("127.0.0.1:3104".into());
        let mut s = std::net::TcpStream::connect_timeout(
            &addr.parse()?,
            std::time::Duration::from_secs(2),
        )?;
        s.set_read_timeout(Some(std::time::Duration::from_secs(2)))?;
        s.write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
        let mut b = [0; 64];
        let n = s.read(&mut b)?;
        if !String::from_utf8_lossy(&b[..n]).starts_with("HTTP/1.0 200") {
            return Err("healthcheck failed".into());
        }
        return Ok(());
    }
    let root = Arc::new(Root::new(
        std::env::var("CLOUDDRIVE_ROOT").unwrap_or("./test-data".into()),
    )?);
    let max = env_size("DRIVE_MAX_BYTES", 10 * GIB);
    let max_file = env_size("DRIVE_MAX_FILE_BYTES", 5 * GIB);
    let mut sessions = HashMap::new();
    let mut reserved = HashMap::new();
    for entry in std::fs::read_dir(root.path.join(".uploads"))? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let folder = entry.path();
        let id = entry.file_name().to_string_lossy().into_owned();
        if uuid::Uuid::parse_str(&id).is_err() {
            continue;
        }
        if let Ok(bytes) = std::fs::read(folder.join("session.json"))
            && let Ok(m) = serde_json::from_slice::<Meta>(&bytes)
        {
            if m.id != id
                || valid_name(&m.name).is_err()
                || Root::validate(&m.dir).is_err()
                || m.size == 0
                || m.size > max_file
                || m.done.len() != m.size.div_ceil(CHUNK) as usize
            {
                eprintln!("invalid session {id}, retained");
                continue;
            }
            if folder.join("committing").exists() && !folder.join("data.part").exists() {
                std::fs::remove_dir_all(&folder)?;
                continue;
            }
            if folder.join("data.part").is_file() {
                reserved.insert(id.clone(), m.size);
                sessions.insert(id, Arc::new(Session::new(m, folder)));
            }
        }
    }
    let used = scan_size(&root.path, true)?;
    let a = App {
        root,
        used: Arc::new(Mutex::new(Budget { used, reserved })),
        tree: Arc::new(Mutex::new(())),
        sessions: Arc::new(Mutex::new(sessions)),
        streams: Arc::new(Semaphore::new(6)),
        disk: Arc::new(std::sync::Mutex::new(0)),
        max,
        max_file,
        floor: env_size("DRIVE_DISK_RESERVE_BYTES", 2 * GIB),
    };
    let hourly = a.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            let _tree = hourly.tree.lock().await;
            let p = hourly.root.path.clone();
            if let Ok(Ok(n)) = tokio::task::spawn_blocking(move || scan_size(&p, true)).await {
                hourly.used.lock().await.used = n
            }
        }
    });
    let router = Router::new()
        .route("/healthz", get(|| async { Json(json!({"status":"ok"})) }))
        .route(
            "/",
            get(|| async {
                (
                    [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
                    include_str!("../web/index.html"),
                )
            }),
        )
        .route(
            "/app.js",
            get(|| async {
                (
                    [(
                        header::CONTENT_TYPE,
                        "application/javascript; charset=utf-8",
                    )],
                    include_str!("../web/app.js"),
                )
            }),
        )
        .route("/api/clouddrive/list", get(list))
        .route("/api/clouddrive/mkdir", post(mkdir))
        .route("/api/clouddrive/remove", axum::routing::delete(remove))
        .route("/api/clouddrive/download", get(download))
        .route(
            "/api/clouddrive/upload",
            post(multipart).layer(DefaultBodyLimit::disable()),
        )
        .route("/api/clouddrive/upload-session", post(create))
        .route("/api/clouddrive/upload-batch", post(batch))
        .route(
            "/api/clouddrive/upload-session/{id}",
            get(get_session).delete(cancel),
        )
        .route(
            "/api/clouddrive/upload-session/{id}/chunk/{index}",
            put(chunk).layer(DefaultBodyLimit::disable()),
        )
        .route(
            "/api/clouddrive/upload-session/{id}/complete",
            post(complete),
        )
        .layer(DefaultBodyLimit::max(64 * 1024))
        .with_state(a);
    let address = std::env::var("DRIVE_LISTEN").unwrap_or("127.0.0.1:3104".into());
    let listener = tokio::net::TcpListener::bind(&address).await?;
    println!("drive-service listening on {address}; used={used}");
    axum::serve(listener, router)
        .with_graceful_shutdown(async {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).unwrap();
            tokio::select! {_=tokio::signal::ctrl_c()=>{},_=term.recv()=>{}}
        })
        .await?;
    Ok(())
}
