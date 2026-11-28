pub mod backup;
pub mod commands;
pub mod document_actor;
pub mod media_protocol;
pub mod migration;
pub mod schema;
pub mod table_query;
pub mod undo;
pub mod workspace_engine;
pub mod workspace_query;
#[cfg(test)]
mod workspace_tests;

use crate::project_ownership::{
    DesktopOwnershipAcquisition, DesktopProjectOwnershipError, DesktopProjectOwnershipManager,
    ProjectOwnershipError,
};
use crate::project_runtime_bridge::ProjectRuntimeBridgeManager;
use base64::engine::general_purpose;
use base64::Engine;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State, WebviewWindow};

pub use backup::CheckpointSnapshotResult;
pub use commands::{ApplyCommandsRequest, DocCommand};
pub use document_actor::{
    DocumentActorPool, V3AttachmentMeta, V3DocumentOpenResult, V3ImportPayload, V3SyncResult,
};
pub use migration::{
    BackupResult, LegacyScanReport, MigrationSessionInfo, MigrationSessionStore,
    SingleBackupResult, V3MigrationCounts, V3MigrationMeta,
};
pub use schema::PrgFormat;
pub use table_query::{
    ColumnFilterBucketRecord, DocSearchFtsHit, DocSearchFtsQuery, TableDateRangeQuery,
    TableDateRangeResult, TableFilterBucketsQuery, TableFilterBucketsResult, TableGroupCountItem,
    TableGroupCountsQuery, TableGroupCountsResult, TablePageQuery, TablePageResult,
    TableRelationCandidatesQuery, TableRelationCandidatesResult, V3FormulaCellRecord,
    V3ImageItemRecord, V3RelationItemRecord, V3TableRowRecord,
};
pub use undo::{ChangeSource, DocChangeSet, HistoryStateInfo, RowPatchOp, V3CellKey};
pub use workspace_engine::{
    SpacedRepetitionSnapshotDto, WorkspaceAnswerSrResult, WorkspaceBacklinkRecord,
    WorkspaceCellWriteInput, WorkspaceColumnOption, WorkspaceColumnRecord,
    WorkspaceCreateRowResult, WorkspaceDocRecord, WorkspaceEngine, WorkspaceIndexUpdatedPayload,
    WorkspaceOpenResult, WorkspacePathSyncResult, WorkspaceScope, WorkspaceSyncStats,
    WorkspaceViewRecord,
};
pub use workspace_query::{
    WorkspaceSearchFtsHit, WorkspaceSearchFtsQuery, WorkspaceTableDateRangeQuery,
    WorkspaceTableFilterBucketsQuery, WorkspaceTableGroupCountsQuery, WorkspaceTablePageQuery,
};

fn emit_doc_changeset(
    app: &AppHandle,
    ownership: &DesktopProjectOwnershipManager,
    changeset: &DocChangeSet,
) {
    if changeset.canonical_path.is_empty() {
        return;
    }
    let holders = ownership.all_holders_for_path(&changeset.canonical_path);
    for holder in holders {
        let _ = app.emit_to(&holder, "pg-doc-changeset", changeset);
    }
}

fn emit_workspace_updated(
    app: &AppHandle,
    ws: &WorkspaceEngine,
    reason: &str,
    doc_ids: Vec<String>,
) {
    if let Some(root) = ws.active_root() {
        let payload = WorkspaceIndexUpdatedPayload {
            root: document_actor::canonical_display_path(&root),
            reason: reason.to_string(),
            doc_ids,
        };
        let _ = app.emit("pg-workspace-index-updated", payload);
    }
}

fn decode_b64_header(request: &tauri::ipc::Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| format!("缺少请求头 {name}"))?;
    let bytes = general_purpose::STANDARD
        .decode(raw)
        .map_err(|e| format!("无效的 base64 请求头 {name}: {e}"))?;
    String::from_utf8(bytes).map_err(|e| format!("无效的 UTF-8 请求头 {name}: {e}"))
}

fn collect_updated_section_text_uuids(cmds: &[DocCommand], out: &mut Vec<(String, String)>) {
    for cmd in cmds {
        match cmd {
            DocCommand::UpdateEntityText { uuid, text, .. } => {
                out.push((uuid.clone(), text.clone()));
            }
            DocCommand::Batch { commands } => collect_updated_section_text_uuids(commands, out),
            _ => {}
        }
    }
}

#[tauri::command]
pub fn doc_detect_format(path: String) -> Result<PrgFormat, String> {
    schema::detect_prg_format(&PathBuf::from(path))
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub(crate) enum DocOpenWithOwnershipResponse {
    AlreadyOwned {
        ownership_id: String,
        canonical_path: String,
    },
    NeedsLegacyPath {
        ownership_id: String,
        canonical_path: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        peer_window_label: Option<String>,
        format: PrgFormat,
    },
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub(crate) enum DocOpenWithOwnershipError {
    Ownership(DesktopProjectOwnershipError),
    Message(String),
}

/// 融合所有权获取、魔数探测与 SQLite v3.0.0 加载为单次 IPC 往返：
/// 将打开 `.prg` 的 5 次串行跨进程 IPC（ownership + detect + exists + detect + doc_open）压缩为 1 次，
/// 并通过紧凑流式 JSON `tauri::ipc::Response` 直出，消除大节点图的中间对象分配与双重 JSON 转义。
#[tauri::command]
pub(crate) async fn doc_open_with_ownership(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    runtime_bridge: State<'_, Arc<ProjectRuntimeBridgeManager>>,
    pool: State<'_, Arc<DocumentActorPool>>,
    path: String,
) -> Result<tauri::ipc::Response, DocOpenWithOwnershipError> {
    let ownership_for_task = Arc::clone(ownership.inner());
    let pool_for_task = Arc::clone(pool.inner());
    let endpoint = runtime_bridge.endpoint().to_owned();
    let window_label = window.label().to_owned();
    let window_label_for_task = window_label.clone();

    let (response_json, shared_canonical_path) = tauri::async_runtime::spawn_blocking(move || {
        let acquisition = ownership_for_task
            .acquire_connectable_for_window(Path::new(&path), &endpoint, &window_label_for_task)
            .map_err(|err| {
                DocOpenWithOwnershipError::Ownership(DesktopProjectOwnershipError::from(err))
            })?;

        let (ownership_id, canonical_path, peer_window_label) = match acquisition {
            DesktopOwnershipAcquisition::AlreadyOwned {
                ownership_id,
                canonical_path,
            } => {
                let json = serde_json::to_string(&DocOpenWithOwnershipResponse::AlreadyOwned {
                    ownership_id,
                    canonical_path,
                })
                .map_err(|e| DocOpenWithOwnershipError::Message(e.to_string()))?;
                return Ok((json, None));
            }
            DesktopOwnershipAcquisition::Acquired {
                ownership_id,
                canonical_path,
            } => (ownership_id, canonical_path, None),
            DesktopOwnershipAcquisition::Shared {
                ownership_id,
                canonical_path,
                peer_window_label,
            } => (ownership_id, canonical_path, Some(peer_window_label)),
        };

        let canonical_pb = PathBuf::from(&canonical_path);
        let format = schema::detect_prg_format(&canonical_pb).unwrap_or(PrgFormat::Unknown);
        if format != PrgFormat::V3Sqlite {
            let shared_path = peer_window_label.as_ref().map(|_| canonical_path.clone());
            let json = serde_json::to_string(&DocOpenWithOwnershipResponse::NeedsLegacyPath {
                ownership_id,
                canonical_path,
                peer_window_label,
                format,
            })
            .map_err(|e| DocOpenWithOwnershipError::Message(e.to_string()))?;
            return Ok((json, shared_path));
        }

        let open_result = (|| -> Result<String, String> {
            let actor = pool_for_task.open_document(&canonical_pb)?;
            let guard = actor
                .lock()
                .map_err(|_| "DocumentActor 锁中毒".to_string())?;
            guard.write_packed_open_with_ownership_json(
                &ownership_id,
                &canonical_path,
                peer_window_label.as_deref(),
            )
        })();

        match open_result {
            Ok(json) => {
                let shared_path = peer_window_label.as_ref().map(|_| canonical_path.clone());
                Ok((json, shared_path))
            }
            Err(err) => {
                let _ = ownership_for_task
                    .release_for_window(&ownership_id, &window_label_for_task);
                Err(DocOpenWithOwnershipError::Message(err))
            }
        }
    })
    .await
    .map_err(|_| {
        DocOpenWithOwnershipError::Ownership(DesktopProjectOwnershipError::from(
            ProjectOwnershipError::LoadFailed,
        ))
    })??;

    if let Some(shared_path) = shared_canonical_path {
        crate::window_manager::notify_doc_peers_changed(&app, ownership.inner(), &shared_path);
    }

    Ok(tauri::ipc::Response::new(response_json))
}

#[tauri::command]
pub async fn doc_open(
    pool: State<'_, Arc<DocumentActorPool>>,
    path: String,
) -> Result<V3DocumentOpenResult, String> {
    let pool = Arc::clone(pool.inner());
    let path_buf = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || {
        let actor = pool.open_document(&path_buf)?;
        let guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        guard.load_open_result()
    })
    .await
    .map_err(|e| format!("打开文档线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_open_temp_draft(
    pool: State<'_, Arc<DocumentActorPool>>,
) -> Result<V3DocumentOpenResult, String> {
    let pool = Arc::clone(pool.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let actor = pool.open_temp_draft()?;
        let guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        guard.load_open_result()
    })
    .await
    .map_err(|e| format!("创建临时草稿 SQLite 线程异常: {e}"))?
}

#[tauri::command]
pub(crate) async fn doc_apply_commands(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    pool: State<'_, Arc<DocumentActorPool>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    request: ApplyCommandsRequest,
) -> Result<DocChangeSet, String> {
    let pool = Arc::clone(pool.inner());
    let ws = Arc::clone(ws_engine.inner());
    let ownership_ref = Arc::clone(ownership.inner());
    let origin_window = window.label().to_owned();
    let origin_window_clone = origin_window.clone();
    let (changeset, ws_synced, section_renames) = tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&request.doc_id)?
            .ok_or_else(|| format!("文档未打开: {}", request.doc_id))?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;

        // 捕获潜在的 Section 改名以便自动更新 cross_doc_refs
        let mut text_updates = Vec::new();
        collect_updated_section_text_uuids(&request.commands, &mut text_updates);
        let mut old_section_names: Vec<(String, String, String)> = Vec::new();
        for (uuid, next_text) in text_updates {
            if let Ok(old_name) = guard.conn.query_row(
                "SELECT text FROM entities WHERE uuid = ?1 AND kind = 'section'",
                rusqlite::params![&uuid],
                |r| r.get::<_, String>(0),
            ) {
                if !old_name.is_empty() && old_name != next_text {
                    old_section_names.push((guard.doc_id.clone(), old_name, next_text));
                }
            }
        }

        let cs = guard.apply_commands(
            &request.commands,
            &request.label,
            request.record_history,
            request.now_ms,
            request.max_history_size,
            &origin_window,
        )?;
        let synced = ws.sync_from_actor(&guard).unwrap_or(false);
        Ok::<_, String>((cs, synced, old_section_names))
    })
    .await
    .map_err(|e| format!("执行文档命令线程异常: {e}"))??;

    emit_doc_changeset(&app, &ownership_ref, &changeset);

    if !section_renames.is_empty() {
        let ws_ref = Arc::clone(ws_engine.inner());
        let ownership_for_refs = Arc::clone(ownership.inner());
        let app_for_refs = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            for (target_doc_id, old_sec, new_sec) in section_renames {
                if let Ok(ref_changes) = ws_ref.repair_section_rename_references(
                    &target_doc_id,
                    &old_sec,
                    &new_sec,
                    &origin_window_clone,
                ) {
                    for rc in &ref_changes {
                        emit_doc_changeset(&app_for_refs, &ownership_for_refs, rc);
                    }
                }
            }
        });
    }

    if ws_synced {
        emit_workspace_updated(&app, ws_engine.inner(), "doc_commit", vec![changeset.doc_id.clone()]);
    }
    Ok(changeset)
}

#[tauri::command]
pub(crate) async fn doc_undo(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    pool: State<'_, Arc<DocumentActorPool>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    doc_id: String,
) -> Result<Option<DocChangeSet>, String> {
    let pool = Arc::clone(pool.inner());
    let ws = Arc::clone(ws_engine.inner());
    let ownership_ref = Arc::clone(ownership.inner());
    let origin_window = window.label().to_owned();
    let (maybe_changeset, ws_synced) = tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&doc_id)?
            .ok_or_else(|| format!("文档未打开: {doc_id}"))?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        let maybe_cs = guard.undo(&origin_window)?;
        let synced = if maybe_cs.is_some() {
            ws.sync_from_actor(&guard).unwrap_or(false)
        } else {
            false
        };
        Ok::<_, String>((maybe_cs, synced))
    })
    .await
    .map_err(|e| format!("撤销命令线程异常: {e}"))??;

    if let Some(ref changeset) = maybe_changeset {
        emit_doc_changeset(&app, &ownership_ref, changeset);
        if ws_synced {
            emit_workspace_updated(&app, ws_engine.inner(), "doc_undo", vec![changeset.doc_id.clone()]);
        }
    }
    Ok(maybe_changeset)
}

#[tauri::command]
pub(crate) async fn doc_redo(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    pool: State<'_, Arc<DocumentActorPool>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    doc_id: String,
) -> Result<Option<DocChangeSet>, String> {
    let pool = Arc::clone(pool.inner());
    let ws = Arc::clone(ws_engine.inner());
    let ownership_ref = Arc::clone(ownership.inner());
    let origin_window = window.label().to_owned();
    let (maybe_changeset, ws_synced) = tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&doc_id)?
            .ok_or_else(|| format!("文档未打开: {doc_id}"))?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        let maybe_cs = guard.redo(&origin_window)?;
        let synced = if maybe_cs.is_some() {
            ws.sync_from_actor(&guard).unwrap_or(false)
        } else {
            false
        };
        Ok::<_, String>((maybe_cs, synced))
    })
    .await
    .map_err(|e| format!("重做命令线程异常: {e}"))??;

    if let Some(ref changeset) = maybe_changeset {
        emit_doc_changeset(&app, &ownership_ref, changeset);
        if ws_synced {
            emit_workspace_updated(&app, ws_engine.inner(), "doc_redo", vec![changeset.doc_id.clone()]);
        }
    }
    Ok(maybe_changeset)
}

#[tauri::command]
pub async fn doc_clear_history(
    pool: State<'_, Arc<DocumentActorPool>>,
    doc_id: String,
) -> Result<HistoryStateInfo, String> {
    let pool = Arc::clone(pool.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&doc_id)?
            .ok_or_else(|| format!("文档未打开: {doc_id}"))?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        guard.clear_history()
    })
    .await
    .map_err(|e| format!("清空历史记录线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_get_history_state(
    pool: State<'_, Arc<DocumentActorPool>>,
    doc_id: String,
) -> Result<HistoryStateInfo, String> {
    let pool = Arc::clone(pool.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&doc_id)?
            .ok_or_else(|| format!("文档未打开: {doc_id}"))?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        guard.history_state()
    })
    .await
    .map_err(|e| format!("查询历史状态线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_sync_snapshot(
    app: AppHandle,
    pool: State<'_, Arc<DocumentActorPool>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    doc_id: String,
    snapshot: V3ImportPayload,
) -> Result<V3SyncResult, String> {
    let pool = Arc::clone(pool.inner());
    let ws = Arc::clone(ws_engine.inner());
    let (res, synced_doc_id) = tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&doc_id)?
            .ok_or_else(|| format!("文档未打开: {doc_id}"))?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        let revision = guard.sync_snapshot(&snapshot)?;
        if guard.doc_id != doc_id {
            pool.update_doc_id_index(&guard.doc_id, &guard.path_key);
        }
        let synced = ws.sync_from_actor(&guard).unwrap_or(false);
        let did = if synced {
            Some(guard.doc_id.clone())
        } else {
            None
        };
        Ok::<_, String>((V3SyncResult { revision }, did))
    })
    .await
    .map_err(|e| format!("同步快照线程异常: {e}"))??;

    if let Some(did) = synced_doc_id {
        emit_workspace_updated(&app, ws_engine.inner(), "doc_sync_snapshot", vec![did]);
    }
    Ok(res)
}

#[tauri::command]
pub async fn doc_close(
    pool: State<'_, Arc<DocumentActorPool>>,
    doc_id: String,
) -> Result<(), String> {
    let pool = Arc::clone(pool.inner());
    tauri::async_runtime::spawn_blocking(move || pool.close_document(&doc_id))
        .await
        .map_err(|e| format!("关闭文档线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_release_path(
    pool: State<'_, Arc<DocumentActorPool>>,
    path: String,
) -> Result<(), String> {
    let pool = Arc::clone(pool.inner());
    let path_buf = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || pool.release_path(&path_buf))
        .await
        .map_err(|e| format!("释放文档连接线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_release_under_prefix(
    pool: State<'_, Arc<DocumentActorPool>>,
    prefix: String,
) -> Result<(), String> {
    let pool = Arc::clone(pool.inner());
    let path_buf = PathBuf::from(prefix);
    tauri::async_runtime::spawn_blocking(move || pool.release_under_prefix(&path_buf))
        .await
        .map_err(|e| format!("批量释放目录连接线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_put_attachment(
    pool: State<'_, Arc<DocumentActorPool>>,
    request: tauri::ipc::Request<'_>,
) -> Result<V3AttachmentMeta, String> {
    let doc_id = decode_b64_header(&request, "x-doc-id-b64")?;
    let attachment_id = decode_b64_header(&request, "x-attachment-id-b64")?;
    let mime = decode_b64_header(&request, "x-mime-type-b64")?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(raw) => raw.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("doc_put_attachment 需要 raw 二进制请求体".to_string());
        }
    };
    let pool = Arc::clone(pool.inner());
    tauri::async_runtime::spawn_blocking(move || {
        media_protocol::put_attachment_into_pool(&pool, &doc_id, &attachment_id, &mime, &bytes)
    })
    .await
    .map_err(|e| format!("写入附件线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_checkpoint_and_snapshot(
    pool: State<'_, Arc<DocumentActorPool>>,
    doc_id: String,
    snapshot_path: Option<String>,
) -> Result<CheckpointSnapshotResult, String> {
    let pool = Arc::clone(pool.inner());
    let snap_buf = snapshot_path.map(PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || {
        backup::checkpoint_and_snapshot(&pool, &doc_id, snap_buf.as_deref())
    })
    .await
    .map_err(|e| format!("执行快照备份线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_scan_workspace_legacy_prg(root: String) -> Result<LegacyScanReport, String> {
    let root_buf = PathBuf::from(root);
    tauri::async_runtime::spawn_blocking(move || migration::scan_workspace_legacy_prg(&root_buf))
        .await
        .map_err(|e| format!("扫描旧版 prg 线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_backup_legacy_files(
    root: String,
    files: Vec<String>,
) -> Result<BackupResult, String> {
    let root_buf = PathBuf::from(root);
    tauri::async_runtime::spawn_blocking(move || migration::backup_legacy_files(&root_buf, &files))
        .await
        .map_err(|e| format!("批量备份旧版文件线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_backup_single_legacy_file(path: String) -> Result<SingleBackupResult, String> {
    let path_buf = PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || migration::backup_single_legacy_file(&path_buf))
        .await
        .map_err(|e| format!("备份旧版单文件线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_migration_begin(
    sessions: State<'_, Arc<MigrationSessionStore>>,
    target_path: String,
) -> Result<MigrationSessionInfo, String> {
    let sessions = Arc::clone(sessions.inner());
    let target = PathBuf::from(target_path);
    tauri::async_runtime::spawn_blocking(move || sessions.begin(&target))
        .await
        .map_err(|e| format!("创建迁移会话线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_migration_put_attachment(
    sessions: State<'_, Arc<MigrationSessionStore>>,
    request: tauri::ipc::Request<'_>,
) -> Result<V3AttachmentMeta, String> {
    let session_id = decode_b64_header(&request, "x-session-id-b64")?;
    let attachment_id = decode_b64_header(&request, "x-attachment-id-b64")?;
    let mime = decode_b64_header(&request, "x-mime-type-b64")?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(raw) => raw.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("doc_migration_put_attachment 需要 raw 二进制请求体".to_string());
        }
    };
    let sessions = Arc::clone(sessions.inner());
    tauri::async_runtime::spawn_blocking(move || {
        sessions.put_attachment(&session_id, &attachment_id, &mime, &bytes)
    })
    .await
    .map_err(|e| format!("迁移写入附件线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_migration_copy_attachments(
    pool: State<'_, Arc<DocumentActorPool>>,
    sessions: State<'_, Arc<MigrationSessionStore>>,
    session_id: String,
    source_doc_id: String,
) -> Result<usize, String> {
    let pool = Arc::clone(pool.inner());
    let sessions = Arc::clone(sessions.inner());
    tauri::async_runtime::spawn_blocking(move || {
        sessions.copy_attachments_from_actor(&session_id, &pool, &source_doc_id)
    })
    .await
    .map_err(|e| format!("迁移拷贝附件线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_migration_commit(
    pool: State<'_, Arc<DocumentActorPool>>,
    sessions: State<'_, Arc<MigrationSessionStore>>,
    session_id: String,
    snapshot: V3ImportPayload,
    expected_counts: V3MigrationCounts,
) -> Result<V3MigrationMeta, String> {
    let pool = Arc::clone(pool.inner());
    let sessions = Arc::clone(sessions.inner());
    tauri::async_runtime::spawn_blocking(move || {
        sessions.commit(&pool, &session_id, &snapshot, &expected_counts)
    })
    .await
    .map_err(|e| format!("提交迁移线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_migration_abort(
    sessions: State<'_, Arc<MigrationSessionStore>>,
    session_id: String,
) -> Result<(), String> {
    let sessions = Arc::clone(sessions.inner());
    tauri::async_runtime::spawn_blocking(move || {
        sessions.abort(&session_id);
    })
    .await
    .map_err(|e| format!("取消迁移线程异常: {e}"))?;
    Ok(())
}

#[tauri::command]
pub async fn table_query_page(
    pool: State<'_, Arc<DocumentActorPool>>,
    query: TablePageQuery,
) -> Result<TablePageResult, String> {
    let pool = Arc::clone(pool.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&query.doc_id)?
            .ok_or_else(|| format!("文档未打开: {}", query.doc_id))?;
        let guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        table_query::query_table_page(&guard.conn, &query)
    })
    .await
    .map_err(|e| format!("分页查询表格线程异常: {e}"))?
}

#[tauri::command]
pub async fn table_query_filter_buckets(
    pool: State<'_, Arc<DocumentActorPool>>,
    query: TableFilterBucketsQuery,
) -> Result<TableFilterBucketsResult, String> {
    let pool = Arc::clone(pool.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&query.doc_id)?
            .ok_or_else(|| format!("文档未打开: {}", query.doc_id))?;
        let guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        table_query::query_filter_buckets(&guard.conn, &query)
    })
    .await
    .map_err(|e| format!("列筛选分桶查询线程异常: {e}"))?
}

#[tauri::command]
pub async fn table_query_relation_candidates(
    pool: State<'_, Arc<DocumentActorPool>>,
    query: TableRelationCandidatesQuery,
) -> Result<TableRelationCandidatesResult, String> {
    let pool = Arc::clone(pool.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&query.doc_id)?
            .ok_or_else(|| format!("文档未打开: {}", query.doc_id))?;
        let guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        table_query::query_relation_candidates(&guard.conn, &query)
    })
    .await
    .map_err(|e| format!("关系候选查询线程异常: {e}"))?
}

#[tauri::command]
pub async fn table_query_group_counts(
    pool: State<'_, Arc<DocumentActorPool>>,
    query: TableGroupCountsQuery,
) -> Result<TableGroupCountsResult, String> {
    let pool = Arc::clone(pool.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&query.doc_id)?
            .ok_or_else(|| format!("文档未打开: {}", query.doc_id))?;
        let guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        table_query::query_group_counts(&guard.conn, &query)
    })
    .await
    .map_err(|e| format!("分组计数查询线程异常: {e}"))?
}

#[tauri::command]
pub async fn table_query_date_range(
    pool: State<'_, Arc<DocumentActorPool>>,
    query: TableDateRangeQuery,
) -> Result<TableDateRangeResult, String> {
    let pool = Arc::clone(pool.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&query.doc_id)?
            .ok_or_else(|| format!("文档未打开: {}", query.doc_id))?;
        let guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        table_query::query_date_range(&guard.conn, &query)
    })
    .await
    .map_err(|e| format!("日期区间查询线程异常: {e}"))?
}

#[tauri::command]
pub async fn doc_search_fts(
    pool: State<'_, Arc<DocumentActorPool>>,
    query: DocSearchFtsQuery,
) -> Result<Vec<DocSearchFtsHit>, String> {
    let pool = Arc::clone(pool.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let actor = pool
            .get_by_doc_id(&query.doc_id)?
            .ok_or_else(|| format!("文档未打开: {}", query.doc_id))?;
        let guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        table_query::search_doc_fts(&guard.conn, &query)
    })
    .await
    .map_err(|e| format!("文档 FTS 搜索线程异常: {e}"))?
}

// ============================================================================
// M4 工作空间双层 SQLite & 跨文件多维表格 Tauri Commands
// ============================================================================

#[tauri::command]
pub async fn ws_open(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    root: String,
) -> Result<WorkspaceOpenResult, String> {
    let ws = Arc::clone(ws_engine.inner());
    let ws_for_watch = Arc::clone(ws_engine.inner());
    let app_for_watch = app.clone();
    let root_buf = PathBuf::from(root);

    let res = tauri::async_runtime::spawn_blocking(move || {
        let opened = ws.open_workspace(&root_buf)?;
        let _ = ws.start_watcher(move |mut payload| {
            if let Ok(stats) = ws_for_watch.sync_incremental(0) {
                if stats.indexed_docs > 0 || stats.removed_docs > 0 {
                    payload.reason = "fs_watch_synced".to_string();
                    let _ = app_for_watch.emit("pg-workspace-index-updated", payload);
                }
            }
        });
        Ok::<_, String>(opened)
    })
    .await
    .map_err(|e| format!("打开工作空间索引线程异常: {e}"))??;

    emit_workspace_updated(&app, ws_engine.inner(), "ws_open", Vec::new());
    Ok(res)
}

#[tauri::command]
pub async fn ws_close(ws_engine: State<'_, Arc<WorkspaceEngine>>) -> Result<(), String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || ws.close_workspace())
        .await
        .map_err(|e| format!("关闭工作空间索引线程异常: {e}"))?
}

#[tauri::command]
pub async fn ws_sync_incremental(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
) -> Result<WorkspaceSyncStats, String> {
    let ws = Arc::clone(ws_engine.inner());
    let stats = tauri::async_runtime::spawn_blocking(move || ws.sync_incremental(0))
        .await
        .map_err(|e| format!("增量同步工作空间线程异常: {e}"))??;
    if stats.indexed_docs > 0 || stats.removed_docs > 0 {
        emit_workspace_updated(&app, ws_engine.inner(), "ws_sync_incremental", Vec::new());
    }
    Ok(stats)
}

#[tauri::command]
pub async fn ws_sync_file(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    path: String,
) -> Result<Option<String>, String> {
    let ws = Arc::clone(ws_engine.inner());
    let path_buf = PathBuf::from(path);
    let doc_id = tauri::async_runtime::spawn_blocking(move || ws.sync_file_by_path(&path_buf))
        .await
        .map_err(|e| format!("同步单文件索引线程异常: {e}"))??;
    if let Some(ref did) = doc_id {
        emit_workspace_updated(&app, ws_engine.inner(), "ws_sync_file", vec![did.clone()]);
    }
    Ok(doc_id)
}

#[tauri::command]
pub async fn ws_list_docs(
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
) -> Result<Vec<WorkspaceDocRecord>, String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || ws.list_docs())
        .await
        .map_err(|e| format!("查询工作空间文档列表线程异常: {e}"))?
}

#[tauri::command]
pub async fn ws_list_columns(
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
) -> Result<Vec<WorkspaceColumnRecord>, String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || ws.list_columns())
        .await
        .map_err(|e| format!("查询工作空间列列表线程异常: {e}"))?
}

#[tauri::command]
pub async fn ws_ensure_sr_columns(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
) -> Result<Vec<WorkspaceColumnRecord>, String> {
    let ws = Arc::clone(ws_engine.inner());
    let cols = tauri::async_runtime::spawn_blocking(move || ws.ensure_workspace_sr_columns())
        .await
        .map_err(|e| format!("初始化全局间隔重复列线程异常: {e}"))??;
    emit_workspace_updated(&app, ws_engine.inner(), "ws_ensure_sr_columns", Vec::new());
    Ok(cols)
}

#[tauri::command]
pub async fn ws_create_shared_column(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    name: String,
    col_type: String,
    config_json: Option<String>,
) -> Result<WorkspaceColumnRecord, String> {
    let ws = Arc::clone(ws_engine.inner());
    let col = tauri::async_runtime::spawn_blocking(move || {
        ws.create_shared_column(&name, &col_type, config_json.as_deref())
    })
    .await
    .map_err(|e| format!("创建共享字段线程异常: {e}"))??;
    emit_workspace_updated(&app, ws_engine.inner(), "ws_create_shared_column", Vec::new());
    Ok(col)
}

#[tauri::command]
pub async fn ws_create_or_get_option(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    canonical_key: String,
    option_name: String,
) -> Result<WorkspaceColumnOption, String> {
    let ws = Arc::clone(ws_engine.inner());
    let opt = tauri::async_runtime::spawn_blocking(move || {
        ws.create_or_get_workspace_option(&canonical_key, &option_name)
    })
    .await
    .map_err(|e| format!("创建工作空间选项线程异常: {e}"))??;
    emit_workspace_updated(&app, ws_engine.inner(), "ws_create_option", Vec::new());
    Ok(opt)
}

#[tauri::command]
pub(crate) async fn ws_promote_column_to_shared(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    source_canonical_key: String,
    target_name: Option<String>,
) -> Result<WorkspaceColumnRecord, String> {
    let ws = Arc::clone(ws_engine.inner());
    let origin = window.label().to_owned();
    let (col, changesets) = tauri::async_runtime::spawn_blocking(move || {
        ws.promote_column_to_shared(&source_canonical_key, target_name.as_deref(), &origin)
    })
    .await
    .map_err(|e| format!("提升共享字段线程异常: {e}"))??;

    for cs in &changesets {
        emit_doc_changeset(&app, ownership.inner(), cs);
    }
    emit_workspace_updated(&app, ws_engine.inner(), "ws_promote_column", Vec::new());
    Ok(col)
}

#[tauri::command]
pub(crate) async fn ws_merge_columns(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    source_canonical_keys: Vec<String>,
    target_canonical_key: String,
) -> Result<WorkspaceColumnRecord, String> {
    let ws = Arc::clone(ws_engine.inner());
    let origin = window.label().to_owned();
    let (col, changesets) = tauri::async_runtime::spawn_blocking(move || {
        ws.merge_columns(&source_canonical_keys, &target_canonical_key, &origin)
    })
    .await
    .map_err(|e| format!("合并工作空间字段线程异常: {e}"))??;

    for cs in &changesets {
        emit_doc_changeset(&app, ownership.inner(), cs);
    }
    emit_workspace_updated(&app, ws_engine.inner(), "ws_merge_columns", Vec::new());
    Ok(col)
}

#[tauri::command]
pub async fn ws_list_views(
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
) -> Result<Vec<WorkspaceViewRecord>, String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || ws.list_views())
        .await
        .map_err(|e| format!("查询工作空间视图列表线程异常: {e}"))?
}

#[tauri::command]
pub async fn ws_upsert_view(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    view: WorkspaceViewRecord,
) -> Result<(), String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || ws.upsert_view(&view))
        .await
        .map_err(|e| format!("保存工作空间视图线程异常: {e}"))??;
    emit_workspace_updated(&app, ws_engine.inner(), "ws_upsert_view", Vec::new());
    Ok(())
}

#[tauri::command]
pub async fn ws_delete_view(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    view_id: String,
) -> Result<(), String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || ws.delete_view(&view_id))
        .await
        .map_err(|e| format!("删除工作空间视图线程异常: {e}"))??;
    emit_workspace_updated(&app, ws_engine.inner(), "ws_delete_view", Vec::new());
    Ok(())
}

#[tauri::command]
pub async fn ws_reorder_views(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    ordered_ids: Vec<String>,
) -> Result<(), String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || ws.reorder_views(&ordered_ids))
        .await
        .map_err(|e| format!("重排工作空间视图线程异常: {e}"))??;
    emit_workspace_updated(&app, ws_engine.inner(), "ws_reorder_views", Vec::new());
    Ok(())
}

#[tauri::command]
pub async fn ws_get_table_meta(
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
) -> Result<String, String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || ws.get_table_meta())
        .await
        .map_err(|e| format!("查询工作空间表元数据线程异常: {e}"))?
}

#[tauri::command]
pub async fn ws_update_table_meta(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    meta_json: String,
) -> Result<(), String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || ws.update_table_meta(&meta_json))
        .await
        .map_err(|e| format!("保存工作空间表元数据线程异常: {e}"))??;
    emit_workspace_updated(&app, ws_engine.inner(), "ws_update_table_meta", Vec::new());
    Ok(())
}

#[tauri::command]
pub async fn ws_table_query_page(
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    query: WorkspaceTablePageQuery,
) -> Result<TablePageResult, String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || {
        ws.with_index_conn(|conn, _root| workspace_query::query_workspace_table_page(conn, &query))
    })
    .await
    .map_err(|e| format!("跨文件分页查询线程异常: {e}"))?
}

#[tauri::command]
pub async fn ws_table_query_filter_buckets(
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    query: WorkspaceTableFilterBucketsQuery,
) -> Result<TableFilterBucketsResult, String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || {
        ws.with_index_conn(|conn, _root| {
            workspace_query::query_workspace_filter_buckets(conn, &query)
        })
    })
    .await
    .map_err(|e| format!("跨文件筛选分桶查询线程异常: {e}"))?
}

#[tauri::command]
pub async fn ws_table_query_group_counts(
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    query: WorkspaceTableGroupCountsQuery,
) -> Result<TableGroupCountsResult, String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || {
        ws.with_index_conn(|conn, _root| {
            workspace_query::query_workspace_group_counts(conn, &query)
        })
    })
    .await
    .map_err(|e| format!("跨文件分组计数查询线程异常: {e}"))?
}

#[tauri::command]
pub async fn ws_table_query_date_range(
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    query: WorkspaceTableDateRangeQuery,
) -> Result<TableDateRangeResult, String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || {
        ws.with_index_conn(|conn, _root| workspace_query::query_workspace_date_range(conn, &query))
    })
    .await
    .map_err(|e| format!("跨文件日期区间查询线程异常: {e}"))?
}

#[tauri::command]
pub async fn ws_table_query_relation_candidates(
    pool: State<'_, Arc<DocumentActorPool>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    query: TableRelationCandidatesQuery,
) -> Result<TableRelationCandidatesResult, String> {
    let pool = Arc::clone(pool.inner());
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let actor = if let Some(a) = pool.get_by_doc_id(&query.doc_id)? {
            a
        } else if let Some(path) = ws.resolve_doc_path(&query.doc_id)? {
            pool.open_for_background(&path)?
        } else {
            return Err(format!("找不到文档 docId={}", query.doc_id));
        };
        let guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        table_query::query_relation_candidates(&guard.conn, &query)
    })
    .await
    .map_err(|e| format!("跨文件关系候选查询线程异常: {e}"))?
}

#[tauri::command]
pub async fn ws_search_fts(
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    query: WorkspaceSearchFtsQuery,
) -> Result<Vec<WorkspaceSearchFtsHit>, String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || {
        ws.with_index_conn(|conn, _root| workspace_query::search_workspace_fts(conn, &query))
    })
    .await
    .map_err(|e| format!("工作空间 FTS 全文搜索线程异常: {e}"))?
}

#[tauri::command]
pub(crate) async fn ws_update_row_text(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    doc_id: String,
    row_uuid: String,
    text: String,
) -> Result<DocChangeSet, String> {
    let ws = Arc::clone(ws_engine.inner());
    let origin = window.label().to_owned();
    let cs = tauri::async_runtime::spawn_blocking(move || {
        ws.update_row_text(&doc_id, &row_uuid, &text, &origin)
    })
    .await
    .map_err(|e| format!("跨文件更新标题线程异常: {e}"))??;
    emit_doc_changeset(&app, ownership.inner(), &cs);
    emit_workspace_updated(&app, ws_engine.inner(), "ws_update_row_text", vec![cs.doc_id.clone()]);
    Ok(cs)
}

#[tauri::command]
pub(crate) async fn ws_update_row_cells(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    doc_id: String,
    row_uuid: String,
    updates: Vec<WorkspaceCellWriteInput>,
    touch_updated_at: bool,
    today_key: Option<String>,
) -> Result<DocChangeSet, String> {
    let ws = Arc::clone(ws_engine.inner());
    let origin = window.label().to_owned();
    let cs = tauri::async_runtime::spawn_blocking(move || {
        ws.update_row_cells(
            &doc_id,
            &row_uuid,
            &updates,
            touch_updated_at,
            today_key.as_deref(),
            &origin,
        )
    })
    .await
    .map_err(|e| format!("跨文件更新单元格线程异常: {e}"))??;
    emit_doc_changeset(&app, ownership.inner(), &cs);
    emit_workspace_updated(&app, ws_engine.inner(), "ws_update_row_cells", vec![cs.doc_id.clone()]);
    Ok(cs)
}

#[tauri::command]
pub(crate) async fn ws_answer_spaced_repetition(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    doc_id: String,
    row_uuid: String,
    choice: String,
    today_key: Option<String>,
    baseline: Option<SpacedRepetitionSnapshotDto>,
) -> Result<WorkspaceAnswerSrResult, String> {
    let ws = Arc::clone(ws_engine.inner());
    let origin = window.label().to_owned();
    let res = tauri::async_runtime::spawn_blocking(move || {
        ws.answer_spaced_repetition(
            &doc_id,
            &row_uuid,
            &choice,
            today_key.as_deref(),
            baseline.as_ref(),
            &origin,
        )
    })
    .await
    .map_err(|e| format!("跨文件间隔重复作答线程异常: {e}"))??;
    emit_doc_changeset(&app, ownership.inner(), &res.changeset);
    emit_workspace_updated(
        &app,
        ws_engine.inner(),
        "ws_answer_spaced_repetition",
        vec![res.changeset.doc_id.clone()],
    );
    Ok(res)
}

#[tauri::command]
pub(crate) async fn ws_restore_spaced_repetition(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    doc_id: String,
    row_uuid: String,
    snapshot: SpacedRepetitionSnapshotDto,
    today_key: Option<String>,
) -> Result<DocChangeSet, String> {
    let ws = Arc::clone(ws_engine.inner());
    let origin = window.label().to_owned();
    let cs = tauri::async_runtime::spawn_blocking(move || {
        ws.restore_spaced_repetition(&doc_id, &row_uuid, &snapshot, today_key.as_deref(), &origin)
    })
    .await
    .map_err(|e| format!("跨文件恢复间隔重复快照线程异常: {e}"))??;
    emit_doc_changeset(&app, ownership.inner(), &cs);
    emit_workspace_updated(
        &app,
        ws_engine.inner(),
        "ws_restore_spaced_repetition",
        vec![cs.doc_id.clone()],
    );
    Ok(cs)
}

#[tauri::command]
pub(crate) async fn ws_add_row_image(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    request: tauri::ipc::Request<'_>,
) -> Result<DocChangeSet, String> {
    let doc_id = decode_b64_header(&request, "x-doc-id-b64")?;
    let row_uuid = decode_b64_header(&request, "x-row-uuid-b64")?;
    let attachment_id = decode_b64_header(&request, "x-attachment-id-b64")?;
    let mime = decode_b64_header(&request, "x-mime-type-b64")?;
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(raw) => raw.clone(),
        tauri::ipc::InvokeBody::Json(_) => {
            return Err("ws_add_row_image 需要 raw 二进制请求体".to_string());
        }
    };
    let ws = Arc::clone(ws_engine.inner());
    let origin = window.label().to_owned();
    let cs = tauri::async_runtime::spawn_blocking(move || {
        ws.add_row_image(&doc_id, &row_uuid, &attachment_id, &mime, &bytes, &origin)
    })
    .await
    .map_err(|e| format!("跨文件添加行图片线程异常: {e}"))??;
    emit_doc_changeset(&app, ownership.inner(), &cs);
    emit_workspace_updated(&app, ws_engine.inner(), "ws_add_row_image", vec![cs.doc_id.clone()]);
    Ok(cs)
}

#[tauri::command]
pub(crate) async fn ws_remove_row_image(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    doc_id: String,
    row_uuid: String,
    image_node_uuid: String,
) -> Result<DocChangeSet, String> {
    let ws = Arc::clone(ws_engine.inner());
    let origin = window.label().to_owned();
    let cs = tauri::async_runtime::spawn_blocking(move || {
        ws.remove_row_image(&doc_id, &row_uuid, &image_node_uuid, &origin)
    })
    .await
    .map_err(|e| format!("跨文件移除行图片线程异常: {e}"))??;
    emit_doc_changeset(&app, ownership.inner(), &cs);
    emit_workspace_updated(&app, ws_engine.inner(), "ws_remove_row_image", vec![cs.doc_id.clone()]);
    Ok(cs)
}

#[tauri::command]
pub(crate) async fn ws_set_row_relations(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    doc_id: String,
    row_uuid: String,
    relation_kind: String,
    target_uuids: Vec<String>,
) -> Result<DocChangeSet, String> {
    let ws = Arc::clone(ws_engine.inner());
    let origin = window.label().to_owned();
    let cs = tauri::async_runtime::spawn_blocking(move || {
        ws.set_row_relations(&doc_id, &row_uuid, &relation_kind, &target_uuids, &origin)
    })
    .await
    .map_err(|e| format!("跨文件修改关系线程异常: {e}"))??;
    emit_doc_changeset(&app, ownership.inner(), &cs);
    emit_workspace_updated(&app, ws_engine.inner(), "ws_set_row_relations", vec![cs.doc_id.clone()]);
    Ok(cs)
}

#[tauri::command]
pub(crate) async fn ws_create_row(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    doc_id: String,
    text: String,
    initial_cells: Option<Vec<WorkspaceCellWriteInput>>,
) -> Result<WorkspaceCreateRowResult, String> {
    let ws = Arc::clone(ws_engine.inner());
    let origin = window.label().to_owned();
    let cells = initial_cells.unwrap_or_default();
    let res = tauri::async_runtime::spawn_blocking(move || {
        ws.create_row(&doc_id, &text, &cells, &origin)
    })
    .await
    .map_err(|e| format!("跨文件新建行线程异常: {e}"))??;
    emit_doc_changeset(&app, ownership.inner(), &res.changeset);
    emit_workspace_updated(&app, ws_engine.inner(), "ws_create_row", vec![res.doc_id.clone()]);
    Ok(res)
}

#[tauri::command]
pub(crate) async fn ws_notify_path_renamed(
    app: AppHandle,
    window: WebviewWindow,
    ownership: State<'_, Arc<DesktopProjectOwnershipManager>>,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    old_path: String,
    new_path: String,
    is_dir: bool,
) -> Result<WorkspacePathSyncResult, String> {
    let ws = Arc::clone(ws_engine.inner());
    let origin = window.label().to_owned();
    let old_buf = PathBuf::from(old_path);
    let new_buf = PathBuf::from(new_path);
    let res = tauri::async_runtime::spawn_blocking(move || {
        ws.notify_path_renamed(&old_buf, &new_buf, is_dir, &origin)
    })
    .await
    .map_err(|e| format!("路径重命名索引联动线程异常: {e}"))??;
    for cs in &res.updated_ref_docs {
        emit_doc_changeset(&app, ownership.inner(), cs);
    }
    emit_workspace_updated(&app, ws_engine.inner(), "ws_path_renamed", Vec::new());
    Ok(res)
}

#[tauri::command]
pub async fn ws_notify_path_deleted(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    path: String,
    is_dir: bool,
) -> Result<usize, String> {
    let ws = Arc::clone(ws_engine.inner());
    let path_buf = PathBuf::from(path);
    let removed = tauri::async_runtime::spawn_blocking(move || {
        ws.notify_path_deleted(&path_buf, is_dir)
    })
    .await
    .map_err(|e| format!("路径删除索引联动线程异常: {e}"))??;
    if removed > 0 {
        emit_workspace_updated(&app, ws_engine.inner(), "ws_path_deleted", Vec::new());
    }
    Ok(removed)
}

#[tauri::command]
pub async fn ws_reissue_copied_doc_ids(
    app: AppHandle,
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    copied_path: String,
    is_dir: bool,
) -> Result<Vec<String>, String> {
    let ws = Arc::clone(ws_engine.inner());
    let path_buf = PathBuf::from(copied_path);
    let new_ids = tauri::async_runtime::spawn_blocking(move || {
        ws.reissue_copied_doc_ids(&path_buf, is_dir)
    })
    .await
    .map_err(|e| format!("副本重签发 docId 线程异常: {e}"))??;
    if !new_ids.is_empty() {
        emit_workspace_updated(&app, ws_engine.inner(), "ws_reissue_doc_id", new_ids.clone());
    }
    Ok(new_ids)
}

#[tauri::command]
pub async fn ws_list_backlinks(
    ws_engine: State<'_, Arc<WorkspaceEngine>>,
    target_doc_id: String,
) -> Result<Vec<WorkspaceBacklinkRecord>, String> {
    let ws = Arc::clone(ws_engine.inner());
    tauri::async_runtime::spawn_blocking(move || ws.list_backlinks(&target_doc_id))
        .await
        .map_err(|e| format!("查询跨文件反向引用线程异常: {e}"))?
}
