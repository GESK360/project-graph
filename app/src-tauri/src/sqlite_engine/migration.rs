use crate::sqlite_engine::document_actor::{
    write_snapshot_in_tx, DocumentActorPool, V3AttachmentMeta, V3ImportPayload,
};
use crate::sqlite_engine::media_protocol::inspect_and_make_thumbnail;
use crate::sqlite_engine::schema::{
    detect_prg_format, initialize_v3_schema, wal_checkpoint_truncate, PrgFormat,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const IGNORED_DIRS: &[&str] = &["node_modules", "dist", "__pycache__", "target"];
static TMP_SEQ: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyPrgEntry {
    pub path: String,
    pub rel_path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyScanReport {
    pub root: String,
    pub files: Vec<LegacyPrgEntry>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupResult {
    pub backup_dir: String,
    pub backed_up_count: usize,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SingleBackupResult {
    pub backup_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationSessionInfo {
    pub session_id: String,
    pub tmp_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3MigrationCounts {
    pub entities: usize,
    pub edges: usize,
    pub associations: usize,
    pub attachments: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3MigrationMeta {
    pub doc_id: String,
    pub format_version: String,
    pub entity_count: usize,
    pub edge_count: usize,
    pub association_count: usize,
    pub attachment_count: usize,
}

struct StagingSession {
    target_path: PathBuf,
    tmp_path: PathBuf,
    conn: Connection,
}

/// 管理流式升级临时会话（允许附件逐个以 raw binary 写入 `.prg.v3.tmp`，无需经过巨型 JSON）。
#[derive(Default)]
pub struct MigrationSessionStore {
    sessions: Mutex<HashMap<String, StagingSession>>,
}

impl MigrationSessionStore {
    pub fn begin(&self, target_path: &Path) -> Result<MigrationSessionInfo, String> {
        if let Some(parent) = target_path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建目标目录失败: {e}"))?;
        }
        let session_id = uuid::Uuid::new_v4().to_string();
        let seq = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
        let file_name = target_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("project.prg");
        let tmp_name = format!(".{file_name}.v3.tmp-{}-{seq}", std::process::id());
        let tmp_path = target_path
            .parent()
            .map(|p| p.join(&tmp_name))
            .unwrap_or_else(|| PathBuf::from(&tmp_name));

        remove_sqlite_with_sidecars(&tmp_path);

        let conn = Connection::open(&tmp_path)
            .map_err(|e| format!("创建临时 SQLite 迁移库失败: {e}"))?;
        initialize_v3_schema(&conn)?;

        let info = MigrationSessionInfo {
            session_id: session_id.clone(),
            tmp_path: tmp_path.to_string_lossy().to_string(),
        };
        let mut guard = self
            .sessions
            .lock()
            .map_err(|_| "MigrationSessionStore 锁中毒".to_string())?;
        guard.insert(
            session_id,
            StagingSession {
                target_path: target_path.to_path_buf(),
                tmp_path,
                conn,
            },
        );
        Ok(info)
    }

    pub fn put_attachment(
        &self,
        session_id: &str,
        attachment_id: &str,
        mime: &str,
        bytes: &[u8],
    ) -> Result<V3AttachmentMeta, String> {
        let (width, height, thumb) = inspect_and_make_thumbnail(mime, bytes);
        let size_bytes = bytes.len() as i64;
        let guard = self
            .sessions
            .lock()
            .map_err(|_| "MigrationSessionStore 锁中毒".to_string())?;
        let session = guard
            .get(session_id)
            .ok_or_else(|| format!("迁移会话不存在或已结束: {session_id}"))?;
        session
            .conn
            .execute(
                "INSERT OR REPLACE INTO attachments (id, mime, width, height, size_bytes, thumb_blob, data_blob)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    attachment_id,
                    mime,
                    width,
                    height,
                    size_bytes,
                    thumb.as_deref(),
                    bytes
                ],
            )
            .map_err(|e| format!("迁移写入附件 {attachment_id} 失败: {e}"))?;

        Ok(V3AttachmentMeta {
            id: attachment_id.to_string(),
            mime: mime.to_string(),
            width,
            height,
            size_bytes,
            has_thumb: thumb.is_some(),
        })
    }

    /// 从一个已打开的 v3 文档直接拷贝全部附件到当前迁移会话（用于 `saveAs` 零 JS 内存拷贝）。
    pub fn copy_attachments_from_actor(
        &self,
        session_id: &str,
        pool: &Arc<DocumentActorPool>,
        source_doc_id: &str,
    ) -> Result<usize, String> {
        let source_actor = pool
            .get_by_doc_id(source_doc_id)?
            .ok_or_else(|| format!("源文档未打开: {source_doc_id}"))?;

        // 逐条搬运，避免额外编码转换
        let rows: Vec<(String, String, Option<i64>, Option<i64>, i64, Option<Vec<u8>>, Vec<u8>)> = {
            let src = source_actor
                .lock()
                .map_err(|_| "DocumentActor 锁中毒".to_string())?;
            let mut stmt = src
                .conn
                .prepare("SELECT id, mime, width, height, size_bytes, thumb_blob, data_blob FROM attachments")
                .map_err(|e| format!("读取源文档附件失败: {e}"))?;
            let iter = stmt
                .query_map([], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                    ))
                })
                .map_err(|e| format!("迭代源文档附件失败: {e}"))?;
            iter.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("收集源文档附件失败: {e}"))?
        };

        let guard = self
            .sessions
            .lock()
            .map_err(|_| "MigrationSessionStore 锁中毒".to_string())?;
        let session = guard
            .get(session_id)
            .ok_or_else(|| format!("迁移会话不存在或已结束: {session_id}"))?;
        let mut insert = session
            .conn
            .prepare(
                "INSERT OR REPLACE INTO attachments (id, mime, width, height, size_bytes, thumb_blob, data_blob)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| format!("准备目标附件写入失败: {e}"))?;
        for (id, mime, width, height, size_bytes, thumb_blob, data_blob) in &rows {
            insert
                .execute(params![id, mime, width, height, size_bytes, thumb_blob, data_blob])
                .map_err(|e| format!("拷贝附件 {id} 失败: {e}"))?;
        }
        Ok(rows.len())
    }

    pub fn commit(
        &self,
        pool: &Arc<DocumentActorPool>,
        session_id: &str,
        snapshot: &V3ImportPayload,
        expected: &V3MigrationCounts,
    ) -> Result<V3MigrationMeta, String> {
        let mut session = {
            let mut guard = self
                .sessions
                .lock()
                .map_err(|_| "MigrationSessionStore 锁中毒".to_string())?;
            guard
                .remove(session_id)
                .ok_or_else(|| format!("迁移会话不存在或已结束: {session_id}"))?
        };

        let result = (|| -> Result<V3MigrationMeta, String> {
            let tx = session
                .conn
                .transaction()
                .map_err(|e| format!("开启迁移提交事务失败: {e}"))?;
            write_snapshot_in_tx(&tx, snapshot, 1)?;
            tx.commit()
                .map_err(|e| format!("提交迁移事务失败: {e}"))?;

            let entity_count: usize = session
                .conn
                .query_row("SELECT COUNT(*) FROM entities", [], |r| r.get::<_, i64>(0))
                .map_err(|e| format!("校验 entities 计数失败: {e}"))? as usize;
            let edge_count: usize = session
                .conn
                .query_row("SELECT COUNT(*) FROM edges", [], |r| r.get::<_, i64>(0))
                .map_err(|e| format!("校验 edges 计数失败: {e}"))? as usize;
            let association_count: usize = session
                .conn
                .query_row("SELECT COUNT(*) FROM associations", [], |r| r.get::<_, i64>(0))
                .map_err(|e| format!("校验 associations 计数失败: {e}"))? as usize;
            let attachment_count: usize = session
                .conn
                .query_row("SELECT COUNT(*) FROM attachments", [], |r| r.get::<_, i64>(0))
                .map_err(|e| format!("校验 attachments 计数失败: {e}"))? as usize;

            let unique_entities = snapshot
                .entities
                .iter()
                .map(|e| e.uuid.as_str())
                .collect::<HashSet<_>>()
                .len();
            let unique_edges = snapshot
                .edges
                .iter()
                .map(|e| e.uuid.as_str())
                .collect::<HashSet<_>>()
                .len();
            let unique_assocs = snapshot
                .associations
                .iter()
                .map(|a| a.uuid.as_str())
                .collect::<HashSet<_>>()
                .len();

            if entity_count != expected.entities.min(unique_entities)
                || edge_count != expected.edges.min(unique_edges)
                || association_count != expected.associations.min(unique_assocs)
                || attachment_count != expected.attachments
            {
                return Err(format!(
                    "迁移完整性校验失败: 期望(实体={},边={},关联={},附件={}) 实际(实体={},边={},关联={},附件={})",
                    expected.entities,
                    expected.edges,
                    expected.associations,
                    expected.attachments,
                    entity_count,
                    edge_count,
                    association_count,
                    attachment_count
                ));
            }

            let doc_id: String = session
                .conn
                .query_row("SELECT value FROM metadata WHERE key = 'docId'", [], |r| {
                    r.get(0)
                })
                .map_err(|e| format!("校验 docId 失败: {e}"))?;
            let format_version: String = session
                .conn
                .query_row(
                    "SELECT value FROM metadata WHERE key = 'format_version'",
                    [],
                    |r| r.get(0),
                )
                .map_err(|e| format!("校验 format_version 失败: {e}"))?;

            wal_checkpoint_truncate(&session.conn)?;
            Ok(V3MigrationMeta {
                doc_id,
                format_version,
                entity_count,
                edge_count,
                association_count,
                attachment_count,
            })
        })();

        // 先彻底关闭临时数据库连接，再做文件替换或清理
        let target_path = session.target_path.clone();
        let tmp_path = session.tmp_path.clone();
        drop(session.conn);
        let _ = std::fs::remove_file(sidecar_path(&tmp_path, "-wal"));
        let _ = std::fs::remove_file(sidecar_path(&tmp_path, "-shm"));

        match result {
            Ok(meta) => {
                // 替换目标文件前释放目标路径上可能残留的 SQLite 连接与旧 WAL/SHM
                pool.release_path(&target_path)?;
                let _ = std::fs::remove_file(sidecar_path(&target_path, "-wal"));
                let _ = std::fs::remove_file(sidecar_path(&target_path, "-shm"));
                atomic_replace_file(&tmp_path, &target_path)?;
                Ok(meta)
            }
            Err(err) => {
                remove_sqlite_with_sidecars(&tmp_path);
                Err(err)
            }
        }
    }

    pub fn abort(&self, session_id: &str) {
        let removed = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut g| g.remove(session_id));
        if let Some(session) = removed {
            let tmp = session.tmp_path.clone();
            drop(session.conn);
            remove_sqlite_with_sidecars(&tmp);
        }
    }
}

fn sidecar_path(base: &Path, suffix: &str) -> PathBuf {
    let mut os = base.as_os_str().to_os_string();
    os.push(suffix);
    PathBuf::from(os)
}

pub fn remove_sqlite_with_sidecars(base: &Path) {
    let _ = std::fs::remove_file(base);
    let _ = std::fs::remove_file(sidecar_path(base, "-wal"));
    let _ = std::fs::remove_file(sidecar_path(base, "-shm"));
}

fn atomic_replace_file(tmp_path: &Path, target_path: &Path) -> Result<(), String> {
    let mut last_err: Option<std::io::Error> = None;
    for attempt in 0..8 {
        match std::fs::rename(tmp_path, target_path) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last_err = Some(err);
                if attempt < 7 {
                    std::thread::sleep(Duration::from_millis(30 * (attempt as u64 + 1)));
                }
            }
        }
    }
    remove_sqlite_with_sidecars(tmp_path);
    Err(format!(
        "原子替换目标文件 {:?} 失败: {}",
        target_path,
        last_err.map(|e| e.to_string()).unwrap_or_default()
    ))
}

/// 扫描工作空间目录下全部旧版 ZIP `.prg` 文件（跳过隐藏目录如 `.flux-graph` 与常见构建目录）。
pub fn scan_workspace_legacy_prg(root: &Path) -> Result<LegacyScanReport, String> {
    if !root.exists() {
        return Err(format!("工作空间目录不存在: {}", root.display()));
    }
    let mut files = Vec::new();
    let mut total_bytes = 0u64;
    scan_dir_recursive(root, root, &mut files, &mut total_bytes);
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(LegacyScanReport {
        root: root.to_string_lossy().to_string(),
        files,
        total_bytes,
    })
}

fn scan_dir_recursive(
    root: &Path,
    dir: &Path,
    out: &mut Vec<LegacyPrgEntry>,
    total_bytes: &mut u64,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || IGNORED_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
            scan_dir_recursive(root, &path, out, total_bytes);
        } else if ft.is_file() && name.to_ascii_lowercase().ends_with(".prg") {
            if matches!(detect_prg_format(&path), Ok(PrgFormat::V2Zip)) {
                let size_bytes = entry.metadata().map(|m| m.len()).unwrap_or(0);
                let rel_path = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                *total_bytes = total_bytes.saturating_add(size_bytes);
                out.push(LegacyPrgEntry {
                    path: path.to_string_lossy().to_string(),
                    rel_path,
                    size_bytes,
                });
            }
        }
    }
}

fn format_backup_timestamp() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // 使用紧凑 UTC/Unix 时间戳避免引入额外日期库，确保唯一且可读
    format!("ts-{secs}")
}

/// 将工作空间内待升级旧版 `.prg` 保留完整相对目录结构备份至 `<root>/.flux-graph/backup-v2/<timestamp>/`。
pub fn backup_legacy_files(root: &Path, files: &[String]) -> Result<BackupResult, String> {
    let backup_root = root
        .join(".flux-graph")
        .join("backup-v2")
        .join(format_backup_timestamp());
    std::fs::create_dir_all(&backup_root)
        .map_err(|e| format!("创建备份目录失败: {e}"))?;

    let canonical_root = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
    let mut backed_up_count = 0usize;
    let mut total_bytes = 0u64;

    for raw in files {
        let src = PathBuf::from(raw);
        if !src.exists() {
            continue;
        }
        let canonical_src = std::fs::canonicalize(&src).unwrap_or_else(|_| src.clone());
        let rel = canonical_src
            .strip_prefix(&canonical_root)
            .or_else(|_| src.strip_prefix(root))
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|_| {
                src.file_name()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| PathBuf::from("unknown.prg"))
            });
        let dst = backup_root.join(rel);
        if let Some(parent) = dst.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("创建备份子目录失败: {e}"))?;
        }
        let copied = std::fs::copy(&src, &dst)
            .map_err(|e| format!("备份文件 {} 失败: {e}", src.display()))?;
        backed_up_count += 1;
        total_bytes = total_bytes.saturating_add(copied);
    }

    Ok(BackupResult {
        backup_dir: backup_root.to_string_lossy().to_string(),
        backed_up_count,
        total_bytes,
    })
}

/// 工作空间外的单个旧版 `.prg` 同级自动留存 `.v2.bak`（若已存在则加序号后缀避免覆盖更早原件）。
pub fn backup_single_legacy_file(path: &Path) -> Result<SingleBackupResult, String> {
    if !path.exists() {
        return Err(format!("待备份文件不存在: {}", path.display()));
    }
    let mut candidate = sidecar_path(path, ".v2.bak");
    let mut idx = 1u32;
    while candidate.exists() {
        candidate = sidecar_path(path, &format!(".v2.{idx}.bak"));
        idx += 1;
    }
    std::fs::copy(path, &candidate)
        .map_err(|e| format!("备份旧版文件失败: {e}"))?;
    Ok(SingleBackupResult {
        backup_path: candidate.to_string_lossy().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite_engine::document_actor::V3EntityRecord;
    use std::sync::atomic::{AtomicU64, Ordering};

    static DIR_SEQ: AtomicU64 = AtomicU64::new(1);

    fn make_temp_dir(tag: &str) -> PathBuf {
        let n = DIR_SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "flux-mig-test-{}-{}-{n}",
            std::process::id(),
            tag
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn scans_and_backups_only_legacy_zip_prg_preserving_tree() {
        let root = make_temp_dir("scan");
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::create_dir_all(root.join(".flux-graph/history")).unwrap();

        std::fs::write(root.join("a.prg"), b"PK\x03\x04legacy-a").unwrap();
        std::fs::write(root.join("sub/b.prg"), b"PK\x03\x04legacy-b-longer").unwrap();
        std::fs::write(root.join(".flux-graph/history/ignored.prg"), b"PK\x03\x04skip").unwrap();
        std::fs::write(root.join("v3.prg"), b"SQLite format 3\0already-v3").unwrap();

        let report = scan_workspace_legacy_prg(&root).unwrap();
        assert_eq!(report.files.len(), 2);
        assert_eq!(report.files[0].rel_path, "a.prg");
        assert_eq!(report.files[1].rel_path, "sub/b.prg");

        let paths: Vec<String> = report.files.iter().map(|f| f.path.clone()).collect();
        let backup = backup_legacy_files(&root, &paths).unwrap();
        assert_eq!(backup.backed_up_count, 2);
        let backup_root = PathBuf::from(&backup.backup_dir);
        assert!(backup_root.join("a.prg").exists());
        assert!(backup_root.join("sub/b.prg").exists());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn streams_attachments_and_commits_atomically() {
        let root = make_temp_dir("commit");
        let target = root.join("board.prg");
        std::fs::write(&target, b"PK\x03\x04old-zip-placeholder").unwrap();

        let bak = backup_single_legacy_file(&target).unwrap();
        assert!(PathBuf::from(&bak.backup_path).exists());

        let pool = Arc::new(DocumentActorPool::default());
        let store = MigrationSessionStore::default();
        let session = store.begin(&target).unwrap();

        store
            .put_attachment(&session.session_id, "att-svg", "image/svg+xml", b"<svg/>")
            .unwrap();

        let payload = V3ImportPayload {
            doc_id: "doc-mig-1".to_string(),
            format_version: "3.0.0".to_string(),
            readme: None,
            tags: vec![],
            references: serde_json::json!({ "sections": {}, "files": [] }),
            extension_json: None,
            table_meta_json: "{}".to_string(),
            entities: vec![V3EntityRecord {
                uuid: "e-1".to_string(),
                kind: "text".to_string(),
                parent_section_uuid: None,
                text: "迁移节点".to_string(),
                details_json: "[]".to_string(),
                details_plain: "".to_string(),
                x: 0.0,
                y: 0.0,
                w: 100.0,
                h: 50.0,
                props_json: "{}".to_string(),
                created_at: 100,
                updated_at: 200,
                is_row: true,
                sort_order: 0,
            }],
            edges: vec![],
            associations: vec![],
            table_columns: vec![],
            table_views: vec![],
            cell_values: vec![],
        };

        let meta = store
            .commit(
                &pool,
                &session.session_id,
                &payload,
                &V3MigrationCounts {
                    entities: 1,
                    edges: 0,
                    associations: 0,
                    attachments: 1,
                },
            )
            .unwrap();

        assert_eq!(meta.doc_id, "doc-mig-1");
        assert_eq!(meta.entity_count, 1);
        assert_eq!(meta.attachment_count, 1);
        assert_eq!(detect_prg_format(&target).unwrap(), PrgFormat::V3Sqlite);

        let _ = std::fs::remove_dir_all(&root);
    }
}
