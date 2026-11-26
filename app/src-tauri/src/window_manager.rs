use crate::project_ownership::DesktopProjectOwnershipManager;
use base64::engine::general_purpose;
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Runtime, State, WebviewWindow, WebviewWindowBuilder};
use tokio::sync::oneshot;

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);
const WORKSPACE_ACK_TIMEOUT: Duration = Duration::from_secs(8);

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowInitPayload {
    pub file_path: Option<String>,
    pub deep_link_url: Option<String>,
    pub workspace_root: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingWindowEvents {
    pub file_paths: Vec<String>,
    pub deep_link_urls: Vec<String>,
}

#[derive(Default)]
struct WindowRoutingState {
    ready: bool,
    pending_events: PendingWindowEvents,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowRoleInfo {
    pub label: String,
    pub is_primary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentPeersChangedEvent {
    canonical_path: String,
    peer_count: usize,
}

pub fn notify_doc_peers_changed<R: Runtime>(
    app: &AppHandle<R>,
    ownership: &DesktopProjectOwnershipManager,
    canonical_path: &str,
) {
    let holders = ownership.all_holders_for_path(canonical_path);
    let peer_count = holders.len().saturating_sub(1);
    let event = DocumentPeersChangedEvent {
        canonical_path: canonical_path.to_owned(),
        peer_count,
    };
    for holder in holders {
        let _ = app.emit_to(&holder, "pg-doc-peers-changed", event.clone());
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentPatchEvent {
    canonical_path: String,
    source_window: String,
    revision: u64,
    patch: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentSavedEvent {
    canonical_path: String,
    source_window: String,
    revision: u64,
    doc_id: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotRequestEvent {
    request_id: String,
    canonical_path: String,
    requester_window: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceCoordRequestEvent {
    request_id: String,
    action: String,
    source_path: String,
    target_path: Option<String>,
    source_window: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceSyncEvent {
    source_window: String,
    payload: Value,
}

fn normalize_path_key(path: &str) -> String {
    #[cfg(windows)]
    {
        path.replace('/', "\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        path.to_owned()
    }
}

pub fn is_deep_link_arg(arg: &str) -> bool {
    let lower = arg.to_ascii_lowercase();
    lower.starts_with("prg:") || lower.starts_with("flux:")
}

pub struct WindowManagerState {
    last_focused_label: Mutex<String>,
    primary_window_label: Mutex<String>,
    next_window_id: AtomicU64,
    next_request_id: AtomicU64,
    window_routes: Mutex<HashMap<String, WindowRoutingState>>,
    pending_init_payloads: Mutex<HashMap<String, WindowInitPayload>>,
    doc_revisions: Mutex<HashMap<String, u64>>,
    pending_snapshots: Mutex<HashMap<String, oneshot::Sender<Option<Value>>>>,
    pending_workspace_acks: Mutex<HashMap<String, oneshot::Sender<bool>>>,
    save_locks: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl Default for WindowManagerState {
    fn default() -> Self {
        Self {
            last_focused_label: Mutex::new("main".to_owned()),
            primary_window_label: Mutex::new("main".to_owned()),
            next_window_id: AtomicU64::new(2),
            next_request_id: AtomicU64::new(1),
            window_routes: Mutex::new(HashMap::new()),
            pending_init_payloads: Mutex::new(HashMap::new()),
            doc_revisions: Mutex::new(HashMap::new()),
            pending_snapshots: Mutex::new(HashMap::new()),
            pending_workspace_acks: Mutex::new(HashMap::new()),
            save_locks: tokio::sync::Mutex::new(HashMap::new()),
        }
    }
}

impl WindowManagerState {
    pub fn record_focus(&self, label: &str) {
        if let Ok(mut guard) = self.last_focused_label.lock() {
            *guard = label.to_owned();
        }
    }

    pub fn last_focused_label(&self) -> String {
        self.last_focused_label
            .lock()
            .map(|guard| guard.clone())
            .unwrap_or_else(|_| "main".to_owned())
    }

    pub fn is_primary(&self, label: &str) -> bool {
        self.primary_window_label
            .lock()
            .map(|guard| guard.as_str() == label)
            .unwrap_or(label == "main")
    }

    pub fn next_revision(&self, canonical_path: &str) -> u64 {
        let key = normalize_path_key(canonical_path);
        let mut guard = self.doc_revisions.lock().unwrap();
        let entry = guard.entry(key).or_insert(0);
        *entry += 1;
        *entry
    }

    pub fn current_revision(&self, canonical_path: &str) -> u64 {
        let key = normalize_path_key(canonical_path);
        self.doc_revisions
            .lock()
            .ok()
            .and_then(|guard| guard.get(&key).copied())
            .unwrap_or(0)
    }

    fn allocate_window_label(&self) -> String {
        let id = self.next_window_id.fetch_add(1, Ordering::Relaxed);
        format!("window-{id}")
    }

    fn allocate_request_id(&self, prefix: &str) -> String {
        let id = self.next_request_id.fetch_add(1, Ordering::Relaxed);
        format!("{prefix}-{id}")
    }

    pub fn store_init_payload(&self, label: &str, payload: WindowInitPayload) {
        if let Ok(mut guard) = self.pending_init_payloads.lock() {
            guard.insert(label.to_owned(), payload);
        }
    }

    pub fn take_init_payload(&self, label: &str) -> Option<WindowInitPayload> {
        self.pending_init_payloads
            .lock()
            .ok()
            .and_then(|mut guard| guard.remove(label))
    }

    pub fn queue_routed_events(
        &self,
        label: &str,
        file_paths: &[String],
        deep_link_urls: &[String],
    ) -> bool {
        let Ok(mut routes) = self.window_routes.lock() else {
            return true;
        };
        let route = routes.entry(label.to_owned()).or_default();
        if route.ready {
            return true;
        }
        route
            .pending_events
            .file_paths
            .extend_from_slice(file_paths);
        route
            .pending_events
            .deep_link_urls
            .extend_from_slice(deep_link_urls);
        false
    }

    pub fn activate_window_routing(&self, label: &str) -> Result<PendingWindowEvents, String> {
        let mut routes = self
            .window_routes
            .lock()
            .map_err(|_| "Window routing state lock poisoned".to_owned())?;
        let route = routes.entry(label.to_owned()).or_default();
        route.ready = true;
        Ok(std::mem::take(&mut route.pending_events))
    }

    pub fn resolve_target_window<R: Runtime>(
        &self,
        app: &AppHandle<R>,
    ) -> Option<WebviewWindow<R>> {
        let preferred = self.last_focused_label();
        if let Some(win) = app.get_webview_window(&preferred) {
            return Some(win);
        }
        if let Some(main) = app.get_webview_window("main") {
            return Some(main);
        }
        app.webview_windows().into_values().next()
    }

    pub fn on_window_destroyed<R: Runtime>(
        &self,
        app: &AppHandle<R>,
        ownership: &DesktopProjectOwnershipManager,
        label: &str,
    ) {
        if let Ok(mut guard) = self.pending_init_payloads.lock() {
            guard.remove(label);
        }
        if let Ok(mut routes) = self.window_routes.lock() {
            routes.remove(label);
        }
        let affected_paths = ownership.release_all_for_window(label);
        for path in affected_paths {
            notify_doc_peers_changed(app, ownership, &path);
        }

        let remaining_labels: Vec<String> = app
            .webview_windows()
            .keys()
            .filter(|candidate| candidate.as_str() != label)
            .cloned()
            .collect();
        let fallback = remaining_labels
            .iter()
            .find(|candidate| candidate.as_str() == "main")
            .or_else(|| remaining_labels.first())
            .cloned();

        if let Ok(mut focused) = self.last_focused_label.lock() {
            if focused.as_str() == label {
                if let Some(next) = &fallback {
                    *focused = next.clone();
                }
            }
        }

        let promoted = if let Ok(mut primary) = self.primary_window_label.lock() {
            if primary.as_str() == label {
                if let Some(next) = fallback {
                    *primary = next.clone();
                    Some(next)
                } else {
                    None
                }
            } else {
                None
            }
        } else {
            None
        };

        if let Some(new_primary) = promoted {
            let _ = app.emit_to(&new_primary, "pg-window-role-primary", true);
        }
    }

    async fn save_lock_for(&self, path: &str) -> Arc<tokio::sync::Mutex<()>> {
        let key = normalize_path_key(path);
        let mut locks = self.save_locks.lock().await;
        locks
            .entry(key)
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }
}

pub fn focus_window<R: Runtime>(window: &WebviewWindow<R>) {
    let _ = window.show();
    let _ = window.unminimize();
    let _ = window.set_focus();
}

#[cfg(desktop)]
pub fn route_single_instance_args(app: &AppHandle, args: &[String]) {
    let state = app.state::<Arc<WindowManagerState>>();

    if args.iter().skip(1).any(|arg| arg == "--new-window") {
        let app_clone = app.clone();
        let state_clone = Arc::clone(state.inner());
        tauri::async_runtime::spawn(async move {
            let _ = create_new_window_inner(&app_clone, &state_clone, None, None, None).await;
        });
        return;
    }

    let Some(target) = state.resolve_target_window(app) else {
        return;
    };
    let target_label = target.label().to_owned();
    focus_window(&target);

    let mut file_paths = Vec::new();
    let mut deep_links = Vec::new();
    for arg in args.iter().skip(1) {
        if is_deep_link_arg(arg) {
            deep_links.push(arg.clone());
            continue;
        }
        if arg.to_lowercase().ends_with(".prg") && Path::new(arg).exists() {
            file_paths.push(arg.clone());
        }
    }

    if !state.queue_routed_events(&target_label, &file_paths, &deep_links) {
        return;
    }
    for path in file_paths {
        let _ = app.emit_to(&target_label, "open-file-from-os", path);
    }
    if !deep_links.is_empty() {
        let _ = app.emit_to(&target_label, "targeted-deep-link", deep_links);
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
pub fn route_opened_urls(app: &AppHandle, urls: Vec<String>) {
    let state = app.state::<Arc<WindowManagerState>>();
    let Some(target) = state.resolve_target_window(app) else {
        return;
    };
    let target_label = target.label().to_owned();
    focus_window(&target);
    let mut deep_links = Vec::new();
    for url in urls {
        if is_deep_link_arg(&url) {
            deep_links.push(url);
        }
    }
    if !state.queue_routed_events(&target_label, &[], &deep_links) {
        return;
    }
    if !deep_links.is_empty() {
        let _ = app.emit_to(&target_label, "targeted-deep-link", deep_links);
    }
}

async fn create_new_window_inner(
    app: &AppHandle,
    state: &Arc<WindowManagerState>,
    file_path: Option<String>,
    deep_link_url: Option<String>,
    workspace_root: Option<String>,
) -> Result<String, String> {
    let base_config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .ok_or_else(|| "Missing base window config".to_owned())?;

    let label = state.allocate_window_label();
    let mut conf = base_config;
    conf.label = label.clone();
    conf.visible = false;

    // 相对当前焦点窗口做轻微偏移，避免两个窗口完全重叠让用户以为没打开
    let cascade_offset = state.resolve_target_window(app).and_then(|focused| {
        let pos = focused.outer_position().ok()?;
        let scale = focused.scale_factor().ok().unwrap_or(1.0);
        let logical_x = pos.x as f64 / scale + 36.0;
        let logical_y = pos.y as f64 / scale + 36.0;
        Some((logical_x, logical_y))
    });

    if file_path.is_some() || deep_link_url.is_some() || workspace_root.is_some() {
        state.store_init_payload(
            &label,
            WindowInitPayload {
                file_path,
                deep_link_url,
                workspace_root,
            },
        );
    }

    let mut builder = WebviewWindowBuilder::from_config(app, &conf).map_err(|e| e.to_string())?;
    if let Some((x, y)) = cascade_offset {
        builder = builder.position(x, y);
    }

    let window = builder.build().map_err(|e| {
        let _ = state.take_init_payload(&label);
        e.to_string()
    })?;

    #[cfg(target_os = "macos")]
    {
        let _ = crate::macos_resize_cursor::install(&window);
    }
    #[cfg(target_os = "windows")]
    {
        let app_for_drop = app.clone();
        let label_for_drop = label.clone();
        let _ = app.run_on_main_thread(move || {
            if let Some(win) = app_for_drop.get_webview_window(&label_for_drop) {
                crate::custom_drag_drop::install_for_window(app_for_drop.clone(), &win);
            }
        });
    }
    let _ = window;

    state.record_focus(&label);
    Ok(label)
}

#[tauri::command]
pub async fn create_new_window(
    app: AppHandle,
    state: State<'_, Arc<WindowManagerState>>,
    file_path: Option<String>,
    deep_link_url: Option<String>,
    workspace_root: Option<String>,
) -> Result<String, String> {
    create_new_window_inner(
        &app,
        state.inner(),
        file_path,
        deep_link_url,
        workspace_root,
    )
    .await
}

#[tauri::command]
pub fn take_window_init_payload(
    window: WebviewWindow,
    state: State<'_, Arc<WindowManagerState>>,
) -> Option<WindowInitPayload> {
    state.take_init_payload(window.label())
}

#[tauri::command]
pub fn activate_window_routing(
    window: WebviewWindow,
    state: State<'_, Arc<WindowManagerState>>,
) -> Result<PendingWindowEvents, String> {
    state.activate_window_routing(window.label())
}

#[tauri::command]
pub fn get_window_role(
    window: WebviewWindow,
    state: State<'_, Arc<WindowManagerState>>,
) -> WindowRoleInfo {
    let label = window.label().to_owned();
    WindowRoleInfo {
        is_primary: state.is_primary(&label),
        label,
    }
}

#[tauri::command]
pub fn focus_last_active_window(
    app: AppHandle,
    state: State<'_, Arc<WindowManagerState>>,
) -> Result<(), String> {
    if let Some(win) = state.resolve_target_window(&app) {
        focus_window(&win);
    }
    Ok(())
}

#[tauri::command]
pub fn focus_window_by_label(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(win) = app.get_webview_window(&label) {
        focus_window(&win);
    }
    Ok(())
}

#[tauri::command]
pub fn list_open_windows(app: AppHandle) -> Vec<String> {
    app.webview_windows().keys().cloned().collect()
}

#[tauri::command]
pub fn broadcast_document_patch(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    state: State<'_, Arc<WindowManagerState>>,
    canonical_path: String,
    patch: Value,
) -> Result<u64, String> {
    let revision = state.next_revision(&canonical_path);
    let source_window = window.label().to_owned();
    let peers = ownership.peer_windows_for_path(&canonical_path, &source_window);
    let event = DocumentPatchEvent {
        canonical_path,
        source_window,
        revision,
        patch,
    };
    for peer in peers {
        let _ = app.emit_to(&peer, "pg-doc-patch", event.clone());
    }
    Ok(revision)
}

#[tauri::command]
pub fn broadcast_document_saved(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    state: State<'_, Arc<WindowManagerState>>,
    canonical_path: String,
    doc_id: Option<String>,
) -> Result<u64, String> {
    let revision = state.current_revision(&canonical_path);
    let source_window = window.label().to_owned();
    let peers = ownership.peer_windows_for_path(&canonical_path, &source_window);
    let event = DocumentSavedEvent {
        canonical_path,
        source_window,
        revision,
        doc_id,
    };
    for peer in peers {
        let _ = app.emit_to(&peer, "pg-doc-saved", event.clone());
    }
    Ok(revision)
}

#[tauri::command]
pub async fn request_peer_document_snapshot(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<WindowManagerState>>,
    canonical_path: String,
    peer_window_label: String,
) -> Result<Option<Value>, String> {
    if app.get_webview_window(&peer_window_label).is_none() {
        return Ok(None);
    }
    let request_id = state.allocate_request_id("snap");
    let (tx, rx) = oneshot::channel();
    {
        let mut pending = state
            .pending_snapshots
            .lock()
            .map_err(|_| "Snapshot state lock poisoned".to_owned())?;
        pending.insert(request_id.clone(), tx);
    }

    let event = SnapshotRequestEvent {
        request_id: request_id.clone(),
        canonical_path,
        requester_window: window.label().to_owned(),
    };
    if app
        .emit_to(&peer_window_label, "pg-doc-snapshot-request", event)
        .is_err()
    {
        if let Ok(mut pending) = state.pending_snapshots.lock() {
            pending.remove(&request_id);
        }
        return Ok(None);
    }

    let result = tokio::time::timeout(SNAPSHOT_TIMEOUT, rx).await;
    if let Ok(mut pending) = state.pending_snapshots.lock() {
        pending.remove(&request_id);
    }
    match result {
        Ok(Ok(snapshot)) => Ok(snapshot),
        _ => Ok(None),
    }
}

#[tauri::command]
pub fn respond_peer_document_snapshot(
    state: State<'_, Arc<WindowManagerState>>,
    request_id: String,
    snapshot: Option<Value>,
) -> bool {
    let sender = state
        .pending_snapshots
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&request_id));
    sender.is_some_and(|tx| tx.send(snapshot).is_ok())
}

#[tauri::command]
pub async fn coordinate_workspace_action(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, Arc<WindowManagerState>>,
    action: String,
    source_path: String,
    target_path: Option<String>,
) -> Result<(), String> {
    let source_window = window.label().to_owned();
    let peers: Vec<String> = app
        .webview_windows()
        .keys()
        .filter(|label| label.as_str() != source_window.as_str())
        .cloned()
        .collect();
    if peers.is_empty() {
        return Ok(());
    }

    let mut receivers = Vec::with_capacity(peers.len());
    let mut failed_windows = Vec::new();
    for peer in peers {
        let request_id = state.allocate_request_id("ws");
        let (tx, rx) = oneshot::channel();
        state
            .pending_workspace_acks
            .lock()
            .map_err(|_| "Workspace coordination state lock poisoned".to_owned())?
            .insert(request_id.clone(), tx);
        let event = WorkspaceCoordRequestEvent {
            request_id: request_id.clone(),
            action: action.clone(),
            source_path: source_path.clone(),
            target_path: target_path.clone(),
            source_window: source_window.clone(),
        };
        if app
            .emit_to(&peer, "pg-workspace-coord-request", event)
            .is_ok()
        {
            receivers.push((peer, request_id, rx));
        } else {
            failed_windows.push(peer);
            if let Ok(mut pending) = state.pending_workspace_acks.lock() {
                pending.remove(&request_id);
            }
        }
    }

    for (peer, request_id, rx) in receivers {
        let acknowledged = matches!(
            tokio::time::timeout(WORKSPACE_ACK_TIMEOUT, rx).await,
            Ok(Ok(true))
        );
        if let Ok(mut pending) = state.pending_workspace_acks.lock() {
            pending.remove(&request_id);
        }
        if !acknowledged {
            failed_windows.push(peer);
        }
    }

    if !failed_windows.is_empty() {
        return Err(format!(
            "未能安全协调所有窗口的工作空间操作：{}",
            failed_windows.join(", ")
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn respond_workspace_action(
    state: State<'_, Arc<WindowManagerState>>,
    request_id: String,
    ok: bool,
) -> bool {
    let sender = state
        .pending_workspace_acks
        .lock()
        .ok()
        .and_then(|mut pending| pending.remove(&request_id));
    sender.is_some_and(|tx| tx.send(ok).is_ok())
}

#[tauri::command]
pub fn broadcast_workspace_event(
    app: AppHandle,
    window: WebviewWindow,
    payload: Value,
) -> Result<(), String> {
    let source_window = window.label().to_owned();
    let event = WorkspaceSyncEvent {
        source_window: source_window.clone(),
        payload,
    };
    for label in app.webview_windows().keys() {
        if label.as_str() != source_window.as_str() {
            let _ = app.emit_to(label, "pg-workspace-sync", event.clone());
        }
    }
    Ok(())
}

fn write_bytes_atomically(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| format!("无法创建目录: {e}"))?;

    static NEXT_TMP_ID: AtomicU64 = AtomicU64::new(1);
    let tmp_seq = NEXT_TMP_ID.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("project.prg");
    let tmp_path: PathBuf =
        parent.join(format!(".{file_name}.{}.{tmp_seq}.tmp", std::process::id()));

    let write_res = (|| -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&tmp_path)?;
        file.write_all(bytes)?;
        let _ = file.sync_data();
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("写入临时文件失败: {err}"));
    }

    let mut last_err = None;
    for attempt in 0..4 {
        match fs::rename(&tmp_path, path) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = Some(err);
                if attempt < 3 {
                    std::thread::sleep(Duration::from_millis(30));
                }
            }
        }
    }

    let _ = fs::remove_file(&tmp_path);
    Err(format!(
        "原子替换文件失败: {}",
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

#[tauri::command]
pub async fn write_project_file_atomic(
    state: State<'_, Arc<WindowManagerState>>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let path_b64 = request
        .headers()
        .get("x-file-path-b64")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Missing x-file-path-b64 header".to_owned())?;
    let path_bytes = general_purpose::STANDARD
        .decode(path_b64)
        .map_err(|e| format!("Invalid x-file-path-b64 header: {e}"))?;
    let path_str =
        String::from_utf8(path_bytes).map_err(|e| format!("Invalid UTF-8 file path: {e}"))?;

    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(raw) => raw.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("Expected raw binary body for write_project_file_atomic".to_owned());
        }
    };

    let lock = state.save_lock_for(&path_str).await;
    let _guard = lock.lock().await;
    let path_buf = PathBuf::from(&path_str);
    tauri::async_runtime::spawn_blocking(move || write_bytes_atomically(&path_buf, &bytes))
        .await
        .map_err(|e| format!("写文件线程异常: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    static TEST_DIR_SEQ: AtomicU64 = AtomicU64::new(1);

    fn make_temp_dir() -> PathBuf {
        let seq = TEST_DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "flux-window-manager-test-{}-{seq}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn focus_tracking_updates_last_focused_window() {
        let state = WindowManagerState::default();
        assert_eq!(state.last_focused_label(), "main");
        state.record_focus("window-2");
        assert_eq!(state.last_focused_label(), "window-2");
        state.record_focus("window-3");
        assert_eq!(state.last_focused_label(), "window-3");
    }

    #[test]
    fn routes_received_before_window_ready_are_queued_then_drained_once() {
        let state = WindowManagerState::default();
        let first_files = vec!["C:\\notes\\first.prg".to_owned()];
        let first_links = vec!["prg://open?docId=first".to_owned()];
        assert!(!state.queue_routed_events("window-2", &first_files, &first_links));

        let queued = state.activate_window_routing("window-2").unwrap();
        assert_eq!(queued.file_paths, first_files);
        assert_eq!(queued.deep_link_urls, first_links);

        let later_files = vec!["C:\\notes\\later.prg".to_owned()];
        assert!(state.queue_routed_events("window-2", &later_files, &[]));
        assert!(state
            .activate_window_routing("window-2")
            .unwrap()
            .file_paths
            .is_empty());
    }

    #[test]
    fn revision_counter_is_monotonic_per_document() {
        let state = WindowManagerState::default();
        assert_eq!(state.next_revision("D:\\notes\\a.prg"), 1);
        assert_eq!(state.next_revision("d:/notes/a.prg"), 2);
        assert_eq!(state.next_revision("D:\\notes\\b.prg"), 1);
        assert_eq!(state.current_revision("D:\\notes\\a.prg"), 2);
    }

    #[test]
    fn detects_deep_link_schemes_case_insensitively() {
        assert!(is_deep_link_arg("prg://open?path=a.prg"));
        assert!(is_deep_link_arg("FLUX://open?path=a.prg"));
        assert!(!is_deep_link_arg("D:\\a.prg"));
        assert!(!is_deep_link_arg("--new-window"));
    }

    #[test]
    fn atomic_write_replaces_existing_file_cleanly() {
        let dir = make_temp_dir();
        let target = dir.join("中文工程.prg");
        write_bytes_atomically(&target, b"version-1").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"version-1");
        write_bytes_atomically(&target, b"version-2-longer").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"version-2-longer");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp file must be cleaned up");
        let _ = fs::remove_dir_all(&dir);
    }
}
