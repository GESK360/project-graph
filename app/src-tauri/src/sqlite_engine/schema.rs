use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::Read;
use std::path::Path;

pub const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
pub const ZIP_MAGIC: &[u8; 4] = b"PK\x03\x04";
pub const SCHEMA_VERSION: &str = "3";
pub const SCHEMA_USER_VERSION: i32 = 3;
pub const FORMAT_VERSION: &str = "3.0.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrgFormat {
    V2Zip,
    V3Sqlite,
    Unknown,
}

/// 仅读取文件前 16 字节判断 `.prg` 格式（SQLite v3.0.0 或旧版 ZIP）。
pub fn detect_prg_format(path: &Path) -> Result<PrgFormat, String> {
    let mut file = File::open(path).map_err(|e| format!("无法打开文件 {:?}: {e}", path))?;
    let mut header = [0u8; 16];
    let n = file
        .read(&mut header)
        .map_err(|e| format!("无法读取文件头 {:?}: {e}", path))?;
    if n >= 16 && &header == SQLITE_MAGIC {
        return Ok(PrgFormat::V3Sqlite);
    }
    if n >= 4 && &header[..4] == ZIP_MAGIC {
        return Ok(PrgFormat::V2Zip);
    }
    Ok(PrgFormat::Unknown)
}

/// 初始化单文件 `.prg v3.0.0` 连接的运行时 PRAGMA 与自定义 `NATURAL` 排序规则。
pub fn apply_connection_pragmas(conn: &Connection) -> Result<(), String> {
    conn.busy_timeout(std::time::Duration::from_millis(5000))
        .map_err(|e| format!("设置 SQLite busy_timeout 失败: {e}"))?;
    crate::sqlite_engine::table_query::register_natural_collation(conn)?;
    let journal_mode: String = conn
        .query_row("PRAGMA journal_mode", [], |r| r.get(0))
        .unwrap_or_default();
    if !journal_mode.eq_ignore_ascii_case("wal") {
        conn.execute_batch("PRAGMA journal_mode = WAL;")
            .map_err(|e| format!("启用 SQLite WAL 模式失败: {e}"))?;
    }
    conn.execute_batch(
        "
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        PRAGMA temp_store = MEMORY;
        PRAGMA cache_size = -32000;
        PRAGMA mmap_size = 268435456;
        ",
    )
    .map_err(|e| format!("应用 SQLite PRAGMA 失败: {e}"))
}

/// 快速路径：若数据库页头 `PRAGMA user_version >= 3` 则直接跳过 25 条 `CREATE IF NOT EXISTS` DDL 解析，
/// 仅应用轻量运行时 PRAGMA；首次打开旧 v3 文件或新库时自动补建表并写入 `user_version = 3`。
pub fn initialize_v3_schema_if_needed(conn: &Connection) -> Result<(), String> {
    apply_connection_pragmas(conn)?;
    let user_version: i32 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if user_version >= SCHEMA_USER_VERSION {
        return Ok(());
    }
    create_v3_tables_and_stamp(conn)
}

/// 建立 `.prg v3.0.0` 完整表结构、R-Tree 空间索引与 FTS5 全文索引。
pub fn initialize_v3_schema(conn: &Connection) -> Result<(), String> {
    apply_connection_pragmas(conn)?;
    create_v3_tables_and_stamp(conn)
}

fn create_v3_tables_and_stamp(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS metadata (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS entities (
          uuid                TEXT PRIMARY KEY,
          kind                TEXT NOT NULL,
          parent_section_uuid TEXT,
          text                TEXT NOT NULL DEFAULT '',
          details_json        TEXT NOT NULL DEFAULT '[]',
          details_plain       TEXT NOT NULL DEFAULT '',
          x                   REAL NOT NULL DEFAULT 0,
          y                   REAL NOT NULL DEFAULT 0,
          w                   REAL NOT NULL DEFAULT 100,
          h                   REAL NOT NULL DEFAULT 50,
          props_json          TEXT NOT NULL DEFAULT '{}',
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL,
          is_row              INTEGER NOT NULL DEFAULT 1,
          sort_order          INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_entities_parent     ON entities(parent_section_uuid);
        CREATE INDEX IF NOT EXISTS idx_entities_row_order  ON entities(is_row, sort_order);
        CREATE INDEX IF NOT EXISTS idx_entities_updated    ON entities(is_row, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_entities_created    ON entities(is_row, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_entities_kind       ON entities(kind);

        CREATE TABLE IF NOT EXISTS entity_rtree_map (
          rtree_id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid     TEXT UNIQUE NOT NULL REFERENCES entities(uuid) ON DELETE CASCADE
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS entities_rtree USING rtree(
          id, min_x, max_x, min_y, max_y
        );

        CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
          uuid UNINDEXED,
          text,
          details_plain,
          tokenize='unicode61'
        );

        CREATE TABLE IF NOT EXISTS edges (
          uuid        TEXT PRIMARY KEY,
          kind        TEXT NOT NULL,
          source_uuid TEXT NOT NULL,
          target_uuid TEXT NOT NULL,
          text        TEXT NOT NULL DEFAULT '',
          props_json  TEXT NOT NULL DEFAULT '{}',
          sort_order  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_uuid);
        CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_uuid);

        CREATE TABLE IF NOT EXISTS associations (
          uuid              TEXT PRIMARY KEY,
          kind              TEXT NOT NULL,
          member_uuids_json TEXT NOT NULL,
          props_json        TEXT NOT NULL DEFAULT '{}',
          sort_order        INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS table_columns (
          id            TEXT PRIMARY KEY,
          canonical_key TEXT NOT NULL,
          name          TEXT NOT NULL,
          type          TEXT NOT NULL,
          position      INTEGER NOT NULL,
          config_json   TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_table_columns_canonical ON table_columns(canonical_key);

        CREATE TABLE IF NOT EXISTS table_views (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          type        TEXT NOT NULL,
          deletable   INTEGER NOT NULL DEFAULT 1,
          position    INTEGER NOT NULL,
          config_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cell_values (
          entity_uuid   TEXT NOT NULL REFERENCES entities(uuid) ON DELETE CASCADE,
          col_id        TEXT NOT NULL REFERENCES table_columns(id) ON DELETE CASCADE,
          canonical_key TEXT NOT NULL,
          val_type      TEXT NOT NULL,
          val_text      TEXT,
          val_num       REAL,
          val_date      TEXT,
          val_json      TEXT,
          PRIMARY KEY (entity_uuid, col_id)
        );
        CREATE INDEX IF NOT EXISTS idx_cells_col_num  ON cell_values(col_id, val_num);
        CREATE INDEX IF NOT EXISTS idx_cells_col_text ON cell_values(col_id, val_text);
        CREATE INDEX IF NOT EXISTS idx_cells_col_date ON cell_values(col_id, val_date);

        CREATE TABLE IF NOT EXISTS cell_multi_options (
          entity_uuid TEXT NOT NULL REFERENCES entities(uuid) ON DELETE CASCADE,
          col_id      TEXT NOT NULL REFERENCES table_columns(id) ON DELETE CASCADE,
          option_id   TEXT NOT NULL,
          option_name TEXT NOT NULL,
          PRIMARY KEY (entity_uuid, col_id, option_id)
        );
        CREATE INDEX IF NOT EXISTS idx_multi_opt ON cell_multi_options(col_id, option_id, entity_uuid);

        CREATE TABLE IF NOT EXISTS formula_cache (
          entity_uuid   TEXT NOT NULL REFERENCES entities(uuid) ON DELETE CASCADE,
          col_id        TEXT NOT NULL REFERENCES table_columns(id) ON DELETE CASCADE,
          canonical_key TEXT NOT NULL,
          kind          TEXT NOT NULL,
          display_text  TEXT NOT NULL DEFAULT '',
          val_num       REAL,
          val_date_ms   INTEGER,
          val_json      TEXT,
          is_volatile   INTEGER NOT NULL DEFAULT 0,
          computed_day  TEXT,
          PRIMARY KEY (entity_uuid, col_id)
        );
        CREATE INDEX IF NOT EXISTS idx_formula_col_num  ON formula_cache(col_id, val_num);
        CREATE INDEX IF NOT EXISTS idx_formula_col_text ON formula_cache(col_id, display_text);
        CREATE INDEX IF NOT EXISTS idx_formula_col_date ON formula_cache(col_id, val_date_ms);

        CREATE TABLE IF NOT EXISTS attachments (
          id         TEXT PRIMARY KEY,
          mime       TEXT NOT NULL,
          width      INTEGER,
          height     INTEGER,
          size_bytes INTEGER NOT NULL,
          thumb_blob BLOB,
          data_blob  BLOB NOT NULL
        );

        CREATE TABLE IF NOT EXISTS history_ops (
          seq           INTEGER PRIMARY KEY AUTOINCREMENT,
          tx_id         TEXT NOT NULL,
          label         TEXT NOT NULL DEFAULT '',
          undo_ops_json TEXT NOT NULL,
          redo_ops_json TEXT NOT NULL,
          created_at    INTEGER NOT NULL
        );

        PRAGMA user_version = 3;
        ",
    )
    .map_err(|e| format!("初始化 SQLite v3.0.0 Schema 失败: {e}"))
}

/// 执行 `PRAGMA wal_checkpoint(TRUNCATE)`，将 WAL 合并回主文件并截断边车文件。
pub fn wal_checkpoint_truncate(conn: &Connection) -> Result<(i64, i64, i64), String> {
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
    })
    .map_err(|e| format!("执行 WAL checkpoint 失败: {e}"))
}

/// 以只读模式打开 SQLite `.prg`（用于 `read_prg_metadata` 等轻量读取）。
pub fn open_readonly(path: &Path) -> Result<Connection, String> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("只读打开 SQLite 文件失败: {e}"))?;
    let _ = conn.busy_timeout(std::time::Duration::from_millis(2000));
    Ok(conn)
}

/// 将 `serde_json::Value` 编码为标准 MessagePack 字节，供 `read_prg_metadata` 兼容旧版调用方解码。
pub fn encode_json_value_as_msgpack(val: &serde_json::Value, out: &mut Vec<u8>) {
    match val {
        serde_json::Value::Null => out.push(0xc0),
        serde_json::Value::Bool(false) => out.push(0xc2),
        serde_json::Value::Bool(true) => out.push(0xc3),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                if (0..=127).contains(&i) {
                    out.push(i as u8);
                } else if (-32..0).contains(&i) {
                    out.push(i as i8 as u8);
                } else {
                    out.push(0xd3);
                    out.extend_from_slice(&i.to_be_bytes());
                }
            } else if let Some(u) = n.as_u64() {
                out.push(0xcf);
                out.extend_from_slice(&u.to_be_bytes());
            } else if let Some(f) = n.as_f64() {
                out.push(0xcb);
                out.extend_from_slice(&f.to_be_bytes());
            } else {
                out.push(0xc0);
            }
        }
        serde_json::Value::String(s) => encode_msgpack_str(s, out),
        serde_json::Value::Array(arr) => {
            let len = arr.len();
            if len <= 15 {
                out.push(0x90 | (len as u8));
            } else if len <= u16::MAX as usize {
                out.push(0xdc);
                out.extend_from_slice(&(len as u16).to_be_bytes());
            } else {
                out.push(0xdd);
                out.extend_from_slice(&(len as u32).to_be_bytes());
            }
            for item in arr {
                encode_json_value_as_msgpack(item, out);
            }
        }
        serde_json::Value::Object(map) => {
            let len = map.len();
            if len <= 15 {
                out.push(0x80 | (len as u8));
            } else if len <= u16::MAX as usize {
                out.push(0xde);
                out.extend_from_slice(&(len as u16).to_be_bytes());
            } else {
                out.push(0xdf);
                out.extend_from_slice(&(len as u32).to_be_bytes());
            }
            for (k, v) in map {
                encode_msgpack_str(k, out);
                encode_json_value_as_msgpack(v, out);
            }
        }
    }
}

fn encode_msgpack_str(s: &str, out: &mut Vec<u8>) {
    let bytes = s.as_bytes();
    let len = bytes.len();
    if len <= 31 {
        out.push(0xa0 | (len as u8));
    } else if len <= u8::MAX as usize {
        out.push(0xd9);
        out.push(len as u8);
    } else if len <= u16::MAX as usize {
        out.push(0xda);
        out.extend_from_slice(&(len as u16).to_be_bytes());
    } else {
        out.push(0xdb);
        out.extend_from_slice(&(len as u32).to_be_bytes());
    }
    out.extend_from_slice(bytes);
}

/// 从 SQLite `.prg` 中快速读取元数据并序列化为 MessagePack 字节（与旧版 `metadata.msgpack` 契约一致）。
pub fn read_v3_metadata_msgpack(path: &Path) -> Result<Vec<u8>, String> {
    let conn = open_readonly(path)?;
    let mut stmt = conn
        .prepare("SELECT key, value FROM metadata WHERE key IN ('format_version', 'docId', 'extension_json')")
        .map_err(|e| format!("查询 SQLite metadata 失败: {e}"))?;

    let mut version = FORMAT_VERSION.to_string();
    let mut doc_id: Option<String> = None;
    let mut extension_val: Option<serde_json::Value> = None;

    let rows = stmt
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|e| format!("读取 SQLite metadata 失败: {e}"))?;

    for row in rows {
        let (k, v) = row.map_err(|e| format!("解析 metadata 行失败: {e}"))?;
        match k.as_str() {
            "format_version" if !v.is_empty() => version = v,
            "docId" if !v.is_empty() => doc_id = Some(v),
            "extension_json" if !v.is_empty() => {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&v) {
                    extension_val = Some(parsed);
                }
            }
            _ => {}
        }
    }

    let mut map = serde_json::Map::new();
    map.insert("version".to_string(), serde_json::Value::String(version));
    if let Some(id) = doc_id {
        map.insert("docId".to_string(), serde_json::Value::String(id));
    }
    if let Some(ext) = extension_val {
        map.insert("extension".to_string(), ext);
    }

    let mut out = Vec::with_capacity(128);
    encode_json_value_as_msgpack(&serde_json::Value::Object(map), &mut out);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(1);

    fn temp_prg(tag: &str) -> std::path::PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "flux-sqlite-schema-{}-{}-{}.prg",
            std::process::id(),
            tag,
            n
        ))
    }

    #[test]
    fn initializes_wal_rtree_fts5_and_detects_format() {
        let path = temp_prg("init");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            initialize_v3_schema(&conn).unwrap();

            let journal_mode: String = conn
                .query_row("PRAGMA journal_mode", [], |r| r.get(0))
                .unwrap();
            assert_eq!(journal_mode.to_lowercase(), "wal");

            // 验证 R-Tree 和 FTS5 虚拟表均可写入与查询
            conn.execute(
                "INSERT INTO entities (uuid, kind, text, details_plain, x, y, w, h, created_at, updated_at, is_row, sort_order)
                 VALUES ('e1', 'text', '量子力学笔记', '薛定谔方程', 10.0, 20.0, 120.0, 60.0, 1000, 2000, 1, 0)",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO entity_rtree_map (uuid) VALUES ('e1')", [])
                .unwrap();
            let rid = conn.last_insert_rowid();
            conn.execute(
                "INSERT INTO entities_rtree (id, min_x, max_x, min_y, max_y) VALUES (?1, 10.0, 130.0, 20.0, 80.0)",
                [rid],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO entities_fts (uuid, text, details_plain) VALUES ('e1', '量子力学笔记', '薛定谔方程')",
                [],
            )
            .unwrap();

            let rtree_hits: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM entities_rtree WHERE max_x >= 50 AND min_x <= 100 AND max_y >= 40 AND min_y <= 60",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(rtree_hits, 1);

            let fts_hits: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM entities_fts WHERE entities_fts MATCH '薛定谔方程'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(fts_hits, 1);

            wal_checkpoint_truncate(&conn).unwrap();
        }

        assert_eq!(detect_prg_format(&path).unwrap(), PrgFormat::V3Sqlite);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn detects_zip_and_unknown_headers() {
        let zip_path = temp_prg("zip");
        std::fs::write(&zip_path, b"PK\x03\x04dummy-zip-body").unwrap();
        assert_eq!(detect_prg_format(&zip_path).unwrap(), PrgFormat::V2Zip);
        let _ = std::fs::remove_file(&zip_path);

        let unknown_path = temp_prg("unknown");
        std::fs::write(&unknown_path, b"plain-text-content").unwrap();
        assert_eq!(detect_prg_format(&unknown_path).unwrap(), PrgFormat::Unknown);
        let _ = std::fs::remove_file(&unknown_path);
    }

    #[test]
    fn reads_v3_metadata_as_valid_msgpack() {
        let path = temp_prg("meta");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            initialize_v3_schema(&conn).unwrap();
            conn.execute(
                "INSERT INTO metadata (key, value) VALUES ('format_version', '3.0.0'), ('docId', 'doc-v3-123')",
                [],
            )
            .unwrap();
            wal_checkpoint_truncate(&conn).unwrap();
        }

        let bytes = read_v3_metadata_msgpack(&path).unwrap();
        // 最小检查：包含 fixmap 头及 version/3.0.0/docId/doc-v3-123 字符串片段
        assert!(!bytes.is_empty());
        assert_eq!(bytes[0] & 0xf0, 0x80);
        let as_lossy = String::from_utf8_lossy(&bytes);
        assert!(as_lossy.contains("version"));
        assert!(as_lossy.contains("3.0.0"));
        assert!(as_lossy.contains("docId"));
        assert!(as_lossy.contains("doc-v3-123"));

        let _ = std::fs::remove_file(&path);
    }
}
