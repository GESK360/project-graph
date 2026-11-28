use crate::sqlite_engine::document_actor::DocumentActorPool;
use crate::sqlite_engine::schema::wal_checkpoint_truncate;
use rusqlite::{backup::Backup, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointSnapshotResult {
    pub checkpointed: bool,
    pub snapshot_path: Option<String>,
}

/// 对已打开的 v3 文档执行 `PRAGMA wal_checkpoint(TRUNCATE)`，并可选使用 SQLite Online Backup API
/// 写出一个干净、自包含的 `.prg` 历史里程碑快照文件。
pub fn checkpoint_and_snapshot(
    pool: &Arc<DocumentActorPool>,
    doc_id: &str,
    snapshot_path: Option<&Path>,
) -> Result<CheckpointSnapshotResult, String> {
    let actor = pool
        .get_by_doc_id(doc_id)?
        .ok_or_else(|| format!("未找到已打开的文档 docId={doc_id}"))?;

    let guard = actor
        .lock()
        .map_err(|_| "DocumentActor 锁中毒".to_string())?;

    guard.checkpoint_truncate()?;

    let Some(dst_path) = snapshot_path else {
        return Ok(CheckpointSnapshotResult {
            checkpointed: true,
            snapshot_path: None,
        });
    };

    if let Some(parent) = dst_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建快照目录失败: {e}"))?;
    }

    let tmp_snapshot = {
        let mut os = dst_path.as_os_str().to_os_string();
        os.push(".bak.tmp");
        std::path::PathBuf::from(os)
    };
    let _ = std::fs::remove_file(&tmp_snapshot);

    {
        let mut dst_conn = Connection::open(&tmp_snapshot)
            .map_err(|e| format!("创建快照目标库失败: {e}"))?;
        let backup = Backup::new(&guard.conn, &mut dst_conn)
            .map_err(|e| format!("初始化 SQLite Online Backup 失败: {e}"))?;
        backup
            .run_to_completion(200, Duration::from_millis(5), None)
            .map_err(|e| format!("执行 SQLite Online Backup 失败: {e}"))?;
        drop(backup);
        let _ = wal_checkpoint_truncate(&dst_conn);
    }

    let _ = std::fs::remove_file(format!("{}-wal", tmp_snapshot.display()));
    let _ = std::fs::remove_file(format!("{}-shm", tmp_snapshot.display()));
    std::fs::rename(&tmp_snapshot, dst_path)
        .map_err(|e| format!("落盘快照文件失败: {e}"))?;

    Ok(CheckpointSnapshotResult {
        checkpointed: true,
        snapshot_path: Some(dst_path.to_string_lossy().to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite_engine::schema::{detect_prg_format, PrgFormat};
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(1);

    #[test]
    fn online_backup_creates_standalone_v3_snapshot() {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("flux-backup-test-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let src = dir.join("live.prg");
        let snap = dir.join(".flux-graph/history/live/20261127-235959.prg");

        let pool = Arc::new(DocumentActorPool::default());
        let actor = pool.open_document(&src).unwrap();
        let doc_id = {
            let mut g = actor.lock().unwrap();
            g.put_attachment("a1", "text/plain", None, None, None, b"hello-snap")
                .unwrap();
            g.doc_id.clone()
        };

        let res = checkpoint_and_snapshot(&pool, &doc_id, Some(&snap)).unwrap();
        assert!(res.checkpointed);
        assert!(snap.exists());
        assert_eq!(detect_prg_format(&snap).unwrap(), PrgFormat::V3Sqlite);

        // 验证快照内附件可读且完整
        let verify_conn = Connection::open(&snap).unwrap();
        let blob: Vec<u8> = verify_conn
            .query_row("SELECT data_blob FROM attachments WHERE id = 'a1'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(blob, b"hello-snap");
        drop(verify_conn);

        pool.release_path(&src).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
    }
}
