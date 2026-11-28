use crate::sqlite_engine::commands::{
    CellMutationItem, DocCommand, EntityBoundsItem, FormulaCacheEntry, ReparentItem,
    SectionChildOrderPatch,
};
use crate::sqlite_engine::document_actor::{
    canonical_display_path, normalize_path_key, DocumentActor, DocumentActorPool, V3CellValueRecord,
    V3EdgeRecord, V3EntityRecord, V3MultiOptionEntry, V3TableColumnRecord,
};
use crate::sqlite_engine::media_protocol::inspect_and_make_thumbnail;
use crate::sqlite_engine::migration::{scan_workspace_legacy_prg, LegacyScanReport};
use crate::sqlite_engine::schema::{
    apply_connection_pragmas, detect_prg_format, open_readonly, wal_checkpoint_truncate, PrgFormat,
};
use crate::sqlite_engine::table_query::{
    add_days_to_date_key, days_from_civil, format_js_number, parse_date_key,
    resolve_primary_text_from_row, resolve_today_key, V3ImageItemRecord, V3RelationItemRecord,
};
use crate::sqlite_engine::undo::DocChangeSet;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const IGNORED_DIRS: &[&str] = &["node_modules", "dist", "__pycache__", "target"];
const OPTION_COLORS: &[&str] = &[
    "gray", "purple", "blue", "green", "amber", "rose", "cyan", "orange",
];

// ============================================================================
// 公共数据结构（与前端 WorkspaceClient.ts 契约一致）
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceScope {
    /// `"all"` | `"folders"` | `"docs"`
    pub kind: String,
    #[serde(default)]
    pub paths: Vec<String>,
}

impl Default for WorkspaceScope {
    fn default() -> Self {
        Self {
            kind: "all".to_string(),
            paths: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDocRecord {
    pub doc_id: String,
    pub rel_path: String,
    pub folder_path: String,
    pub title: String,
    pub mtime_ms: i64,
    pub file_size: i64,
    pub revision: i64,
    pub format_version: String,
    pub abs_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceColumnOption {
    pub id: String,
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceColumnRecord {
    pub canonical_key: String,
    pub name: String,
    pub r#type: String,
    pub is_shared: bool,
    pub config_json: String,
    pub doc_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceViewRecord {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub deletable: bool,
    pub position: i64,
    pub scope: WorkspaceScope,
    pub config_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSyncStats {
    pub total_docs: usize,
    pub indexed_docs: usize,
    pub skipped_docs: usize,
    pub removed_docs: usize,
    pub legacy_v2_docs: usize,
    pub elapsed_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceOpenResult {
    pub root: String,
    pub index_path: String,
    pub legacy_report: LegacyScanReport,
    pub sync_stats: WorkspaceSyncStats,
    pub docs: Vec<WorkspaceDocRecord>,
    pub columns: Vec<WorkspaceColumnRecord>,
    pub views: Vec<WorkspaceViewRecord>,
    pub meta_json: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceIndexUpdatedPayload {
    pub root: String,
    pub reason: String,
    #[serde(default)]
    pub doc_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCellWriteInput {
    pub canonical_key: String,
    /// `None` 表示清空单元格；`Some(json)` 支持 string / number / string[]（单选/多选可传 ws optionId 或 optionName）。
    pub value: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpacedRepetitionSnapshotDto {
    pub mastery: Option<f64>,
    pub correct_count: Option<f64>,
    pub delay: Option<f64>,
    pub answer_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceAnswerSrResult {
    pub changeset: DocChangeSet,
    pub snapshot: SpacedRepetitionSnapshotDto,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCreateRowResult {
    pub doc_id: String,
    pub uuid: String,
    pub changeset: DocChangeSet,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceBacklinkRecord {
    pub source_doc_id: String,
    pub source_rel_path: String,
    pub source_title: String,
    pub source_uuid: String,
    pub target_doc_id: String,
    pub target_section_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacePathSyncResult {
    pub updated_docs: usize,
    pub updated_ref_docs: Vec<DocChangeSet>,
}

// ============================================================================
// index.sqlite DDL 初始化
// ============================================================================

pub fn initialize_workspace_index_schema(conn: &Connection) -> Result<(), String> {
    apply_connection_pragmas(conn)?;
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS workspace_meta (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS docs (
          doc_id         TEXT PRIMARY KEY,
          rel_path       TEXT UNIQUE NOT NULL,
          folder_path    TEXT NOT NULL,
          title          TEXT NOT NULL,
          mtime_ms       INTEGER NOT NULL,
          file_size      INTEGER NOT NULL,
          revision       INTEGER NOT NULL DEFAULT 1,
          format_version TEXT NOT NULL DEFAULT '3.0.0'
        );
        CREATE INDEX IF NOT EXISTS idx_docs_folder ON docs(folder_path);

        CREATE TABLE IF NOT EXISTS workspace_columns (
          canonical_key TEXT PRIMARY KEY,
          name          TEXT NOT NULL,
          type          TEXT NOT NULL,
          is_shared     INTEGER NOT NULL DEFAULT 0,
          config_json   TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE IF NOT EXISTS workspace_views (
          id          TEXT PRIMARY KEY,
          name        TEXT NOT NULL,
          type        TEXT NOT NULL,
          position    INTEGER NOT NULL,
          scope_json  TEXT NOT NULL,
          config_json TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS entities (
          doc_id              TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
          uuid                TEXT NOT NULL,
          kind                TEXT NOT NULL,
          parent_section_uuid TEXT,
          outer_label         TEXT,
          text                TEXT NOT NULL DEFAULT '',
          details_plain       TEXT NOT NULL DEFAULT '',
          images_json         TEXT NOT NULL DEFAULT '[]',
          image_count         INTEGER NOT NULL DEFAULT 0,
          parents_json        TEXT NOT NULL DEFAULT '[]',
          children_json       TEXT NOT NULL DEFAULT '[]',
          inner_json          TEXT NOT NULL DEFAULT '[]',
          created_at          INTEGER NOT NULL,
          updated_at          INTEGER NOT NULL,
          is_row              INTEGER NOT NULL DEFAULT 1,
          sort_order          INTEGER NOT NULL DEFAULT 0,
          sr_due_status       TEXT NOT NULL DEFAULT '待复习',
          PRIMARY KEY (doc_id, uuid)
        );
        CREATE INDEX IF NOT EXISTS idx_ws_ent_doc     ON entities(doc_id, is_row, sort_order);
        CREATE INDEX IF NOT EXISTS idx_ws_ent_doc_sr  ON entities(doc_id, is_row, sr_due_status, sort_order);
        CREATE INDEX IF NOT EXISTS idx_ws_ent_updated ON entities(is_row, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ws_ent_created ON entities(is_row, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_ws_ent_sr_due  ON entities(is_row, sr_due_status, updated_at DESC);

        CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
          doc_id UNINDEXED,
          uuid UNINDEXED,
          text,
          details_plain,
          tokenize='unicode61'
        );

        CREATE TABLE IF NOT EXISTS cell_values (
          doc_id        TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
          entity_uuid   TEXT NOT NULL,
          canonical_key TEXT NOT NULL,
          val_type      TEXT NOT NULL,
          val_text      TEXT,
          val_num       REAL,
          val_date      TEXT,
          val_json      TEXT,
          PRIMARY KEY (doc_id, entity_uuid, canonical_key)
        );
        CREATE INDEX IF NOT EXISTS idx_ws_cells_key_num  ON cell_values(canonical_key, val_num);
        CREATE INDEX IF NOT EXISTS idx_ws_cells_key_text ON cell_values(canonical_key, val_text);
        CREATE INDEX IF NOT EXISTS idx_ws_cells_key_date ON cell_values(canonical_key, val_date);
        CREATE INDEX IF NOT EXISTS idx_ws_cells_entity   ON cell_values(entity_uuid, doc_id);
        CREATE INDEX IF NOT EXISTS idx_ws_cells_ck_text  ON cell_values(canonical_key, val_text, doc_id, entity_uuid);
        CREATE INDEX IF NOT EXISTS idx_ws_cells_ck_date  ON cell_values(canonical_key, val_date, doc_id, entity_uuid);

        CREATE TABLE IF NOT EXISTS cell_multi_options (
          doc_id        TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
          entity_uuid   TEXT NOT NULL,
          canonical_key TEXT NOT NULL,
          option_name   TEXT NOT NULL,
          PRIMARY KEY (doc_id, entity_uuid, canonical_key, option_name)
        );
        CREATE INDEX IF NOT EXISTS idx_ws_multi_opt ON cell_multi_options(canonical_key, option_name, doc_id, entity_uuid);

        CREATE TABLE IF NOT EXISTS formula_cache (
          doc_id        TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
          entity_uuid   TEXT NOT NULL,
          canonical_key TEXT NOT NULL,
          kind          TEXT NOT NULL,
          display_text  TEXT NOT NULL DEFAULT '',
          val_num       REAL,
          val_date_ms   INTEGER,
          val_json      TEXT,
          is_volatile   INTEGER NOT NULL DEFAULT 0,
          computed_day  TEXT,
          PRIMARY KEY (doc_id, entity_uuid, canonical_key)
        );
        CREATE INDEX IF NOT EXISTS idx_ws_formula_key_text ON formula_cache(canonical_key, display_text);
        CREATE INDEX IF NOT EXISTS idx_ws_formula_key_num  ON formula_cache(canonical_key, val_num);
        CREATE INDEX IF NOT EXISTS idx_ws_formula_key_date ON formula_cache(canonical_key, val_date_ms);
        CREATE INDEX IF NOT EXISTS idx_ws_formula_entity   ON formula_cache(entity_uuid, doc_id);
        CREATE INDEX IF NOT EXISTS idx_ws_formula_ck_text  ON formula_cache(canonical_key, display_text, doc_id, entity_uuid);
        CREATE INDEX IF NOT EXISTS idx_ws_docs_folder      ON docs(folder_path, doc_id);
        CREATE INDEX IF NOT EXISTS idx_ws_docs_folder_nc   ON docs(folder_path COLLATE NOCASE, doc_id);
        CREATE INDEX IF NOT EXISTS idx_ws_docs_rel_nat     ON docs(rel_path COLLATE \"NATURAL\", doc_id);

        CREATE TABLE IF NOT EXISTS cross_doc_refs (
          source_doc_id       TEXT NOT NULL REFERENCES docs(doc_id) ON DELETE CASCADE,
          source_uuid         TEXT NOT NULL,
          target_doc_id       TEXT NOT NULL,
          target_section_name TEXT NOT NULL DEFAULT '',
          PRIMARY KEY (source_doc_id, source_uuid, target_doc_id, target_section_name)
        );
        CREATE INDEX IF NOT EXISTS idx_ws_refs_target ON cross_doc_refs(target_doc_id);
        ",
    )
    .map_err(|e| format!("初始化工作空间 index.sqlite Schema 失败: {e}"))?;

    // 兼容既有 index.sqlite 平滑补齐 sr_due_status 列及覆盖索引
    let has_sr_due_col: bool = conn
        .prepare("PRAGMA table_info(entities)")
        .and_then(|mut stmt| {
            let mut rows = stmt.query([])?;
            while let Some(r) = rows.next()? {
                let name: String = r.get(1)?;
                if name == "sr_due_status" {
                    return Ok(true);
                }
            }
            Ok(false)
        })
        .unwrap_or(true);
    if !has_sr_due_col {
        let _ = conn.execute(
            "ALTER TABLE entities ADD COLUMN sr_due_status TEXT NOT NULL DEFAULT '待复习'",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_ws_ent_sr_due ON entities(is_row, sr_due_status, updated_at DESC)",
            [],
        );
    }

    // 确保至少存在一个默认跨文件视图
    let view_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM workspace_views", [], |r| r.get(0))
        .unwrap_or(0);
    if view_count == 0 {
        let default_scope = serde_json::to_string(&WorkspaceScope::default()).unwrap();
        let default_config = serde_json::json!({
            "deletable": false,
            "visibleColumnIds": ["name", "sourceFile", "updatedAt"],
            "columnWidths": {}
        })
        .to_string();
        conn.execute(
            "INSERT INTO workspace_views (id, name, type, position, scope_json, config_json)
             VALUES ('default-ws-table-view', '工作空间总表', 'table', 0, ?1, ?2)",
            params![default_scope, default_config],
        )
        .map_err(|e| format!("初始化默认工作空间视图失败: {e}"))?;
        conn.execute(
            "INSERT OR IGNORE INTO workspace_meta (key, value) VALUES ('table_meta_json', ?1)",
            params![serde_json::json!({ "activeViewId": "default-ws-table-view" }).to_string()],
        )
        .map_err(|e| format!("初始化默认工作空间表元数据失败: {e}"))?;
    }
    Ok(())
}

// ============================================================================
// 路径与工具函数
// ============================================================================

fn normalize_rel_path(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let s = rel
        .to_string_lossy()
        .replace('\\', "/")
        .trim_start_matches('/')
        .to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// 跨大小写（Windows）计算 `path` 相对 `root` 的规范化正斜杠路径。
pub(crate) fn compute_rel_path_insensitive(root: &Path, path: &Path) -> Option<String> {
    if let Some(direct) = normalize_rel_path(root, path) {
        return Some(direct);
    }
    let root_norm = normalize_path_key(root);
    let root_trimmed = root_norm.trim_end_matches('/');
    let path_disp = canonical_display_path(path).replace('\\', "/");
    let path_key = normalize_path_key(path);
    let prefix = format!("{root_trimmed}/");
    if path_key.starts_with(&prefix) {
        let byte_start = prefix.len();
        if path_disp.len() >= byte_start && path_disp.is_char_boundary(byte_start) {
            return Some(path_disp[byte_start..].to_string());
        }
    }
    None
}

pub(crate) fn split_rel_path_meta(rel_path: &str) -> (String, String) {
    let clean = rel_path.replace('\\', "/");
    let (folder, file) = match clean.rsplit_once('/') {
        Some((dir, name)) => (dir.to_string(), name),
        None => (String::new(), clean.as_str()),
    };
    let bytes = file.as_bytes();
    let title = if bytes.len() >= 4 && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".prg") {
        file.get(..file.len() - 4).unwrap_or(file).to_string()
    } else {
        file.to_string()
    };
    (folder, title)
}

fn strip_prefix_case_insensitive<'a>(s: &'a str, prefix: &str) -> Option<&'a str> {
    if let Some(rest) = s.strip_prefix(prefix) {
        return Some(rest);
    }
    if s.len() >= prefix.len()
        && s.is_char_boundary(prefix.len())
        && s[..prefix.len()].eq_ignore_ascii_case(prefix)
    {
        return Some(&s[prefix.len()..]);
    }
    let mut s_chars = s.char_indices();
    for p_ch in prefix.chars() {
        let (_, s_ch) = s_chars.next()?;
        if s_ch.to_lowercase().ne(p_ch.to_lowercase()) {
            return None;
        }
    }
    match s_chars.next() {
        Some((idx, _)) => s.get(idx..),
        None => Some(""),
    }
}

fn is_ignored_workspace_entry(name: &str) -> bool {
    name.starts_with('.') || IGNORED_DIRS.contains(&name)
}

pub(crate) fn is_prg_file_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    bytes.len() > 4 && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".prg")
}

fn file_mtime_and_size(meta: &fs::Metadata) -> (i64, i64) {
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    (mtime_ms, meta.len() as i64)
}

fn current_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn pick_next_option_color(existing: &[WorkspaceColumnOption]) -> String {
    let mut counts: HashMap<&str, usize> = OPTION_COLORS.iter().map(|c| (*c, 0)).collect();
    for opt in existing {
        if let Some(cnt) = counts.get_mut(opt.color.as_str()) {
            *cnt += 1;
        }
    }
    let mut best = OPTION_COLORS[0];
    let mut best_count = usize::MAX;
    for &c in OPTION_COLORS {
        let cnt = *counts.get(c).unwrap_or(&0);
        if cnt < best_count {
            best = c;
            best_count = cnt;
        }
    }
    best.to_string()
}

#[derive(Debug, Clone)]
struct DiskPrgEntry {
    abs_path: PathBuf,
    rel_path: String,
    folder_path: String,
    title: String,
    mtime_ms: i64,
    file_size: i64,
}

fn collect_disk_prg_entries(root: &Path, dir: &Path, out: &mut Vec<DiskPrgEntry>) {
    let Ok(read_dir) = fs::read_dir(dir) else {
        return;
    };
    for entry in read_dir.flatten() {
        let file_name = entry.file_name();
        let name = file_name.to_string_lossy();
        if is_ignored_workspace_entry(&name) {
            continue;
        }
        let path = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_dir() {
            collect_disk_prg_entries(root, &path, out);
        } else if ft.is_file() && is_prg_file_name(&name) {
            if let Ok(meta) = entry.metadata() {
                if let Some(rel_path) = normalize_rel_path(root, &path) {
                    let (folder_path, title) = split_rel_path_meta(&rel_path);
                    let (mtime_ms, file_size) = file_mtime_and_size(&meta);
                    out.push(DiskPrgEntry {
                        abs_path: path,
                        rel_path,
                        folder_path,
                        title,
                        mtime_ms,
                        file_size,
                    });
                }
            }
        }
    }
}

// ============================================================================
// 间隔重复受保护列规格与 Rust 侧确定性求值（与 StageTableService.tsx 100% 一致）
// ============================================================================

struct SrSpec {
    role: &'static str,
    name: &'static str,
    col_type: &'static str,
    format: Option<&'static str>,
}

const SR_SPECS: &[SrSpec] = &[
    SrSpec { role: "source", name: "出处", col_type: "select", format: None },
    SrSpec { role: "notes", name: "备注", col_type: "text", format: None },
    SrSpec { role: "knowledge", name: "知识点", col_type: "multi_select", format: None },
    SrSpec { role: "mastery", name: "掌握程度", col_type: "number", format: None },
    SrSpec { role: "correctCount", name: "答对次数", col_type: "number", format: None },
    SrSpec { role: "nextInterval", name: "下次作答", col_type: "formula", format: Some("0") },
    SrSpec { role: "delay", name: "延期", col_type: "number", format: None },
    SrSpec { role: "answerDate", name: "作答日期", col_type: "date", format: None },
    SrSpec { role: "nextDueDate", name: "下次要求作答时间", col_type: "formula", format: Some("YYYY-MM-DD") },
    SrSpec { role: "dueStatus", name: "是否到期", col_type: "formula", format: None },
    SrSpec { role: "archiveStatus", name: "归档状态", col_type: "select", format: None },
];

fn build_sr_formula_text(role: &str, role_ids: &HashMap<String, String>) -> Option<String> {
    match role {
        "nextInterval" => Some(format!(
            "POWER(2, IFBLANK({{{{{}}}}}, 0)) - 1 + IFBLANK({{{{{}}}}}, 0)",
            role_ids.get("correctCount")?,
            role_ids.get("delay")?,
        )),
        "nextDueDate" => Some(format!(
            "IF(ISBLANK({{{{{}}}}}), \"\", TODATE({{{{{}}}}}) + {{{{{}}}}})",
            role_ids.get("answerDate")?,
            role_ids.get("answerDate")?,
            role_ids.get("nextInterval")?,
        )),
        "dueStatus" => Some(format!(
            "IF({{{{{}}}}} = \"已归档\", \"已归档\", IF(ISBLANK({{{{{}}}}}), \"待复习\", IF(TODATE({{{{{}}}}}) <= TODAY(), \"待复习\", \"未到期\")))",
            role_ids.get("archiveStatus")?,
            role_ids.get("answerDate")?,
            role_ids.get("nextDueDate")?,
        )),
        _ => None,
    }
}

struct ComputedSrFormulas {
    next_interval: f64,
    next_due_date: Option<String>,
    next_due_date_ms: Option<i64>,
    due_status: &'static str,
}

fn evaluate_sr_formulas(
    correct_count: Option<f64>,
    delay: Option<f64>,
    answer_date: Option<&str>,
    archive_status_name: Option<&str>,
    today_key: &str,
) -> ComputedSrFormulas {
    let cc = correct_count.filter(|n| n.is_finite()).unwrap_or(0.0);
    let dl = delay.filter(|n| n.is_finite()).unwrap_or(0.0);
    let next_interval = 2.0_f64.powf(cc) - 1.0 + dl;

    let clean_answer = answer_date.map(|s| s.trim()).filter(|s| !s.is_empty());
    let (next_due_date, next_due_date_ms) = if let Some(ans) = clean_answer {
        if parse_date_key(ans).is_some() {
            let due_str = add_days_to_date_key(ans, next_interval.round() as i64);
            let ms = parse_date_key(&due_str)
                .map(|(y, m, d)| days_from_civil(y, m, d) * 86_400_000);
            (Some(due_str), ms)
        } else {
            (None, None)
        }
    } else {
        (None, None)
    };

    let due_status = if archive_status_name == Some("已归档") {
        "已归档"
    } else if clean_answer.is_none() {
        "待复习"
    } else if let Some(ref due) = next_due_date {
        if due.as_str() <= today_key {
            "待复习"
        } else {
            "未到期"
        }
    } else {
        "待复习"
    };

    ComputedSrFormulas {
        next_interval,
        next_due_date,
        next_due_date_ms,
        due_status,
    }
}

// ============================================================================
// 单文档 -> index.sqlite 投影逻辑
// ============================================================================

#[derive(Debug, Clone)]
struct SourceColInfo {
    canonical_key: String,
    name: String,
    col_type: String,
    config_json: String,
    opt_name_by_id: HashMap<String, String>,
    options: Vec<WorkspaceColumnOption>,
}

fn parse_options_from_config(config_json: &str) -> Vec<WorkspaceColumnOption> {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(config_json) else {
        return Vec::new();
    };
    let Some(arr) = val.get("options").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
        let name = item.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        let color = item
            .get("color")
            .and_then(|v| v.as_str())
            .unwrap_or("gray")
            .trim();
        if !id.is_empty() && !name.is_empty() {
            out.push(WorkspaceColumnOption {
                id: id.to_string(),
                name: name.to_string(),
                color: color.to_string(),
            });
        }
    }
    out
}

fn merge_column_into_workspace_columns(
    tx: &Transaction<'_>,
    col: &SourceColInfo,
) -> Result<(), String> {
    let existing: Option<(String, String, i64, String)> = tx
        .query_row(
            "SELECT name, type, is_shared, config_json FROM workspace_columns WHERE canonical_key = ?1",
            params![&col.canonical_key],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()
        .map_err(|e| format!("查询 workspace_columns 失败: {e}"))?;

    let is_shared_flag = if col.canonical_key.starts_with("ws:") || col.canonical_key.starts_with("role:sr:") {
        1i64
    } else {
        0i64
    };

    if let Some((ex_name, _ex_type, ex_shared, ex_cfg_json)) = existing {
        // 合并 select / multi_select 选项（按 option.name 归一，保留稳定 ws option id）
        if col.col_type == "select" || col.col_type == "multi_select" {
            let mut ex_cfg: serde_json::Value =
                serde_json::from_str(&ex_cfg_json).unwrap_or_else(|_| serde_json::json!({}));
            let mut merged_opts = parse_options_from_config(&ex_cfg_json);
            let mut seen_names: HashSet<String> = merged_opts
                .iter()
                .map(|o| o.name.trim().to_lowercase())
                .collect();
            let mut changed = false;
            for incoming in &col.options {
                let norm = incoming.name.trim().to_lowercase();
                if norm.is_empty() || !seen_names.insert(norm) {
                    continue;
                }
                merged_opts.push(WorkspaceColumnOption {
                    id: format!("opt_{}", uuid::Uuid::new_v4()),
                    name: incoming.name.clone(),
                    color: if incoming.color.is_empty() {
                        pick_next_option_color(&merged_opts)
                    } else {
                        incoming.color.clone()
                    },
                });
                changed = true;
            }
            if changed {
                if let Some(obj) = ex_cfg.as_object_mut() {
                    obj.insert(
                        "options".to_string(),
                        serde_json::to_value(&merged_opts).unwrap_or_else(|_| serde_json::json!([])),
                    );
                }
                let next_cfg_str = serde_json::to_string(&ex_cfg).unwrap_or(ex_cfg_json);
                tx.execute(
                    "UPDATE workspace_columns SET config_json = ?1, is_shared = ?2, name = ?3 WHERE canonical_key = ?4",
                    params![next_cfg_str, ex_shared.max(is_shared_flag), ex_name, &col.canonical_key],
                )
                .map_err(|e| format!("更新 workspace_columns 选项失败: {e}"))?;
            }
        }
        return Ok(());
    }

    // 首次发现该 canonical_key：构造规范化 config_json（为选项签发工作空间级 opt_<uuid>）
    let mut cfg: serde_json::Value =
        serde_json::from_str(&col.config_json).unwrap_or_else(|_| serde_json::json!({}));
    if col.col_type == "select" || col.col_type == "multi_select" {
        let mut ws_opts: Vec<WorkspaceColumnOption> = Vec::new();
        let mut seen = HashSet::new();
        for o in &col.options {
            let norm = o.name.trim().to_lowercase();
            if norm.is_empty() || !seen.insert(norm) {
                continue;
            }
            ws_opts.push(WorkspaceColumnOption {
                id: format!("opt_{}", uuid::Uuid::new_v4()),
                name: o.name.clone(),
                color: if o.color.is_empty() {
                    pick_next_option_color(&ws_opts)
                } else {
                    o.color.clone()
                },
            });
        }
        if let Some(obj) = cfg.as_object_mut() {
            obj.insert(
                "options".to_string(),
                serde_json::to_value(&ws_opts).unwrap_or_else(|_| serde_json::json!([])),
            );
        }
    }
    let cfg_str = serde_json::to_string(&cfg).unwrap_or_else(|_| "{}".to_string());
    tx.execute(
        "INSERT INTO workspace_columns (canonical_key, name, type, is_shared, config_json)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            &col.canonical_key,
            &col.name,
            &col.col_type,
            is_shared_flag,
            cfg_str,
        ],
    )
    .map_err(|e| format!("写入 workspace_columns 失败: {e}"))?;
    Ok(())
}

/// 将单个源 `.prg` SQLite 连接的数据投影到工作空间 `index.sqlite` 事务内。
/// 返回该文档的 `doc_id`。
fn project_doc_conn_into_index_tx(
    idx_tx: &Transaction<'_>,
    doc_conn: &Connection,
    rel_path: &str,
    folder_path: &str,
    title: &str,
    mtime_ms: i64,
    file_size: i64,
    today_key: &str,
) -> Result<String, String> {
    // 1. 读取源文档 metadata
    let mut doc_id = String::new();
    let mut revision: i64 = 1;
    let mut format_version = "3.0.0".to_string();
    {
        let mut stmt = doc_conn
            .prepare("SELECT key, value FROM metadata WHERE key IN ('docId', 'revision', 'format_version')")
            .map_err(|e| format!("读取源文档 metadata 失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("遍历源文档 metadata 失败: {e}"))?;
        for row in rows.flatten() {
            match row.0.as_str() {
                "docId" if !row.1.trim().is_empty() => doc_id = row.1,
                "revision" => revision = row.1.parse::<i64>().unwrap_or(1),
                "format_version" if !row.1.trim().is_empty() => format_version = row.1,
                _ => {}
            }
        }
    }
    if doc_id.is_empty() {
        doc_id = format!("path:{}", rel_path.to_lowercase());
    }

    // 处理可能存在的旧路径或旧 doc_id 记录（先清理 FTS 与 docs，ON DELETE CASCADE 清理关联表）
    let stale_doc_id_by_path: Option<String> = idx_tx
        .query_row(
            "SELECT doc_id FROM docs WHERE rel_path = ?1",
            params![rel_path],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| format!("查询旧 rel_path 失败: {e}"))?;
    if let Some(old_id) = stale_doc_id_by_path {
        idx_tx
            .execute("DELETE FROM entities_fts WHERE doc_id = ?1", params![&old_id])
            .map_err(|e| format!("清理旧 FTS 失败: {e}"))?;
        idx_tx
            .execute("DELETE FROM docs WHERE doc_id = ?1", params![&old_id])
            .map_err(|e| format!("清理旧 docs 行失败: {e}"))?;
    }
    // 防止同 doc_id 冲突
    idx_tx
        .execute("DELETE FROM entities_fts WHERE doc_id = ?1", params![&doc_id])
        .map_err(|e| format!("清理同 doc_id FTS 失败: {e}"))?;
    idx_tx
        .execute("DELETE FROM docs WHERE doc_id = ?1", params![&doc_id])
        .map_err(|e| format!("清理同 doc_id docs 行失败: {e}"))?;

    idx_tx
        .execute(
            "INSERT INTO docs (doc_id, rel_path, folder_path, title, mtime_ms, file_size, revision, format_version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                &doc_id,
                rel_path,
                folder_path,
                title,
                mtime_ms,
                file_size,
                revision,
                &format_version,
            ],
        )
        .map_err(|e| format!("写入 docs 行失败: {e}"))?;

    // 2. 读取源文档 table_columns 并合并到 workspace_columns
    let mut col_by_id: HashMap<String, SourceColInfo> = HashMap::new();
    let mut sr_col_id_by_role: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = doc_conn
            .prepare("SELECT id, canonical_key, name, type, config_json FROM table_columns ORDER BY position ASC, rowid ASC")
            .map_err(|e| format!("读取源文档 table_columns 失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| format!("遍历源文档 table_columns 失败: {e}"))?;
        for row in rows {
            let (id, canonical_key, name, col_type, config_json) =
                row.map_err(|e| format!("解析源文档列失败: {e}"))?;
            let options = parse_options_from_config(&config_json);
            let opt_name_by_id: HashMap<String, String> = options
                .iter()
                .map(|o| (o.id.clone(), o.name.clone()))
                .collect();
            if let Some(role) = canonical_key.strip_prefix("role:sr:") {
                sr_col_id_by_role.insert(role.to_string(), id.clone());
            }
            let info = SourceColInfo {
                canonical_key,
                name,
                col_type,
                config_json,
                opt_name_by_id,
                options,
            };
            merge_column_into_workspace_columns(idx_tx, &info)?;
            col_by_id.insert(id, info);
        }
    }

    // 3. 读取源文档 entities（含图片与行实体）
    struct SrcEntity {
        uuid: String,
        kind: String,
        parent_section_uuid: Option<String>,
        text: String,
        details_plain: String,
        props_json: String,
        created_at: i64,
        updated_at: i64,
        is_row: bool,
        sort_order: i64,
    }
    let mut all_entities: Vec<SrcEntity> = Vec::new();
    let mut row_entity_map: HashMap<String, (String, String)> = HashMap::new(); // uuid -> (label, kind)
    let mut images_by_parent: HashMap<String, Vec<V3ImageItemRecord>> = HashMap::new();
    let mut inner_by_parent: HashMap<String, Vec<V3RelationItemRecord>> = HashMap::new();
    let mut raw_refs: Vec<(String, String, String)> = Vec::new(); // (source_uuid, file_name, section_name)

    {
        let mut stmt = doc_conn
            .prepare(
                "SELECT uuid, kind, parent_section_uuid, text, details_plain, props_json,
                        created_at, updated_at, is_row, sort_order
                 FROM entities
                 ORDER BY sort_order ASC, rowid ASC",
            )
            .map_err(|e| format!("读取源文档 entities 失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok(SrcEntity {
                    uuid: r.get(0)?,
                    kind: r.get(1)?,
                    parent_section_uuid: r.get(2)?,
                    text: r.get(3)?,
                    details_plain: r.get(4)?,
                    props_json: r.get(5)?,
                    created_at: r.get(6)?,
                    updated_at: r.get(7)?,
                    is_row: r.get::<_, i64>(8)? != 0,
                    sort_order: r.get(9)?,
                })
            })
            .map_err(|e| format!("遍历源文档 entities 失败: {e}"))?;
        for r in rows {
            let ent = r.map_err(|e| format!("解析源文档实体失败: {e}"))?;
            if ent.kind == "image" {
                if let Some(ref pid) = ent.parent_section_uuid {
                    let parsed_props: serde_json::Value =
                        serde_json::from_str(&ent.props_json).unwrap_or_default();
                    let is_bg = parsed_props
                        .get("isBackground")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    if !is_bg {
                        let att_id = parsed_props
                            .get("attachmentId")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string();
                        images_by_parent
                            .entry(pid.clone())
                            .or_default()
                            .push(V3ImageItemRecord {
                                uuid: ent.uuid.clone(),
                                attachment_id: att_id,
                            });
                    }
                }
            } else if ent.is_row {
                let label = resolve_primary_text_from_row(&ent.kind, &ent.text, &ent.props_json);
                row_entity_map.insert(ent.uuid.clone(), (label.clone(), ent.kind.clone()));
                if let Some(ref pid) = ent.parent_section_uuid {
                    inner_by_parent
                        .entry(pid.clone())
                        .or_default()
                        .push(V3RelationItemRecord {
                            uuid: ent.uuid.clone(),
                            label,
                            kind: ent.kind.clone(),
                        });
                }
                if ent.kind == "reference" {
                    if let Ok(props) = serde_json::from_str::<serde_json::Value>(&ent.props_json) {
                        let file_name = props
                            .get("fileName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        let section_name = props
                            .get("sectionName")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .trim()
                            .to_string();
                        if !file_name.is_empty() {
                            raw_refs.push((ent.uuid.clone(), file_name, section_name));
                        }
                    }
                }
            }
            all_entities.push(ent);
        }
    }

    // 4. 读取 edges 并构建 1-hop parents / children 摘要
    let mut parents_by_uuid: HashMap<String, Vec<V3RelationItemRecord>> = HashMap::new();
    let mut children_by_uuid: HashMap<String, Vec<V3RelationItemRecord>> = HashMap::new();
    let mut parents_seen: HashMap<String, HashSet<String>> = HashMap::new();
    let mut children_seen: HashMap<String, HashSet<String>> = HashMap::new();
    {
        let mut stmt = doc_conn
            .prepare("SELECT source_uuid, target_uuid FROM edges ORDER BY sort_order ASC, rowid ASC")
            .map_err(|e| format!("读取源文档 edges 失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| format!("遍历源文档 edges 失败: {e}"))?;
        for r in rows.flatten() {
            let (src, dst) = r;
            if src == dst {
                continue;
            }
            let Some((src_lbl, src_kind)) = row_entity_map.get(&src) else {
                continue;
            };
            let Some((dst_lbl, dst_kind)) = row_entity_map.get(&dst) else {
                continue;
            };
            if parents_seen
                .entry(dst.clone())
                .or_default()
                .insert(src.clone())
            {
                parents_by_uuid
                    .entry(dst.clone())
                    .or_default()
                    .push(V3RelationItemRecord {
                        uuid: src.clone(),
                        label: src_lbl.clone(),
                        kind: src_kind.clone(),
                    });
            }
            if children_seen
                .entry(src.clone())
                .or_default()
                .insert(dst.clone())
            {
                children_by_uuid
                    .entry(src)
                    .or_default()
                    .push(V3RelationItemRecord {
                        uuid: dst,
                        label: dst_lbl.clone(),
                        kind: dst_kind.clone(),
                    });
            }
        }
    }

    // 5. 写入 index.sqlite 的 entities 与 entities_fts
    let mut row_uuids: HashSet<String> = HashSet::new();
    {
        let mut ent_stmt = idx_tx
            .prepare(
                "INSERT INTO entities (
                    doc_id, uuid, kind, parent_section_uuid, outer_label, text, details_plain,
                    images_json, image_count, parents_json, children_json, inner_json,
                    created_at, updated_at, is_row, sort_order
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            )
            .map_err(|e| format!("准备写入 index.entities 失败: {e}"))?;
        let mut fts_stmt = idx_tx
            .prepare("INSERT INTO entities_fts (doc_id, uuid, text, details_plain) VALUES (?1, ?2, ?3, ?4)")
            .map_err(|e| format!("准备写入 index.entities_fts 失败: {e}"))?;

        for ent in &all_entities {
            if !ent.is_row {
                continue;
            }
            row_uuids.insert(ent.uuid.clone());
            let primary_text = resolve_primary_text_from_row(&ent.kind, &ent.text, &ent.props_json);
            let outer_label = ent
                .parent_section_uuid
                .as_ref()
                .and_then(|pid| row_entity_map.get(pid))
                .map(|(lbl, _)| lbl.clone());
            let imgs = if ent.kind == "section" {
                images_by_parent.remove(&ent.uuid).unwrap_or_default()
            } else {
                Vec::new()
            };
            let image_count = imgs.len() as i64;
            let images_json = serde_json::to_string(&imgs).unwrap_or_else(|_| "[]".to_string());
            let parents = parents_by_uuid.remove(&ent.uuid).unwrap_or_default();
            let parents_json = serde_json::to_string(&parents).unwrap_or_else(|_| "[]".to_string());
            let children = children_by_uuid.remove(&ent.uuid).unwrap_or_default();
            let children_json =
                serde_json::to_string(&children).unwrap_or_else(|_| "[]".to_string());
            let inner = if ent.kind == "section" {
                inner_by_parent.remove(&ent.uuid).unwrap_or_default()
            } else {
                Vec::new()
            };
            let inner_json = serde_json::to_string(&inner).unwrap_or_else(|_| "[]".to_string());

            ent_stmt
                .execute(params![
                    &doc_id,
                    &ent.uuid,
                    &ent.kind,
                    &ent.parent_section_uuid,
                    &outer_label,
                    &primary_text,
                    &ent.details_plain,
                    &images_json,
                    image_count,
                    &parents_json,
                    &children_json,
                    &inner_json,
                    ent.created_at,
                    ent.updated_at,
                    1i64,
                    ent.sort_order,
                ])
                .map_err(|e| format!("写入 index.entities {} 失败: {e}", ent.uuid))?;

            fts_stmt
                .execute(params![&doc_id, &ent.uuid, &primary_text, &ent.details_plain])
                .map_err(|e| format!("写入 index.entities_fts {} 失败: {e}", ent.uuid))?;
        }
    }

    // 6. 投影 cell_values 与 cell_multi_options（select/multi_select 统一归一化为 option_name）
    // 同时记录每行 SR 输入字段，便于校验/刷新易变 SR 公式缓存
    let mut sr_correct_by_row: HashMap<String, f64> = HashMap::new();
    let mut sr_delay_by_row: HashMap<String, f64> = HashMap::new();
    let mut sr_answer_by_row: HashMap<String, String> = HashMap::new();
    let mut sr_archive_by_row: HashMap<String, String> = HashMap::new();

    {
        // 读取源 multi_options 以便无损获取 option_name
        let mut src_multi: HashMap<(String, String), Vec<String>> = HashMap::new();
        {
            let mut mstmt = doc_conn
                .prepare("SELECT entity_uuid, col_id, option_name FROM cell_multi_options")
                .map_err(|e| format!("读取源 cell_multi_options 失败: {e}"))?;
            let mrows = mstmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| format!("遍历源 cell_multi_options 失败: {e}"))?;
            for r in mrows.flatten() {
                src_multi.entry((r.0, r.1)).or_default().push(r.2);
            }
        }

        let mut cstmt = doc_conn
            .prepare(
                "SELECT entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json
                 FROM cell_values",
            )
            .map_err(|e| format!("读取源 cell_values 失败: {e}"))?;
        let crows = cstmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<f64>>(5)?,
                    r.get::<_, Option<String>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                ))
            })
            .map_err(|e| format!("遍历源 cell_values 失败: {e}"))?;

        let mut ins_cell = idx_tx
            .prepare(
                "INSERT OR REPLACE INTO cell_values (
                    doc_id, entity_uuid, canonical_key, val_type, val_text, val_num, val_date, val_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| format!("准备写入 index.cell_values 失败: {e}"))?;
        let mut ins_multi = idx_tx
            .prepare(
                "INSERT OR IGNORE INTO cell_multi_options (doc_id, entity_uuid, canonical_key, option_name)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| format!("准备写入 index.cell_multi_options 失败: {e}"))?;

        for row in crows {
            let (entity_uuid, col_id, raw_ck, val_type, val_text, val_num, val_date, val_json) =
                row.map_err(|e| format!("解析源 cell_values 失败: {e}"))?;
            if !row_uuids.contains(&entity_uuid) {
                continue;
            }
            let col_info = col_by_id.get(&col_id);
            let canonical_key = col_info
                .map(|c| c.canonical_key.clone())
                .unwrap_or(raw_ck);

            // 归一化 select 与 multi_select 到 option_name
            let (norm_text, norm_json, multi_names) = match val_type.as_str() {
                "select" => {
                    let opt_name = val_text.as_deref().and_then(|raw_opt_id| {
                        col_info
                            .and_then(|c| c.opt_name_by_id.get(raw_opt_id).cloned())
                            .or_else(|| {
                                let t = raw_opt_id.trim();
                                if t.is_empty() { None } else { Some(t.to_string()) }
                            })
                    });
                    (opt_name, None, Vec::new())
                }
                "multi_select" => {
                    let mut names = src_multi
                        .remove(&(entity_uuid.clone(), col_id.clone()))
                        .unwrap_or_default();
                    if names.is_empty() {
                        if let Some(ref vj) = val_json {
                            if let Ok(ids) = serde_json::from_str::<Vec<String>>(vj) {
                                for oid in ids {
                                    let resolved = col_info
                                        .and_then(|c| c.opt_name_by_id.get(&oid).cloned())
                                        .unwrap_or(oid);
                                    if !resolved.trim().is_empty() {
                                        names.push(resolved);
                                    }
                                }
                            }
                        }
                    }
                    let mut deduped = Vec::new();
                    let mut seen = HashSet::new();
                    for n in names {
                        if seen.insert(n.clone()) {
                            deduped.push(n);
                        }
                    }
                    let joined = if deduped.is_empty() {
                        None
                    } else {
                        Some(deduped.join(","))
                    };
                    let json_arr = if deduped.is_empty() {
                        None
                    } else {
                        serde_json::to_string(&deduped).ok()
                    };
                    (joined, json_arr, deduped)
                }
                _ => (val_text, val_json, Vec::new()),
            };

            // 记录 SR 输入
            match canonical_key.as_str() {
                "role:sr:correctCount" => {
                    if let Some(n) = val_num {
                        sr_correct_by_row.insert(entity_uuid.clone(), n);
                    }
                }
                "role:sr:delay" => {
                    if let Some(n) = val_num {
                        sr_delay_by_row.insert(entity_uuid.clone(), n);
                    }
                }
                "role:sr:answerDate" => {
                    if let Some(d) = val_date.as_deref().or(norm_text.as_deref()) {
                        if !d.trim().is_empty() {
                            sr_answer_by_row.insert(entity_uuid.clone(), d.trim().to_string());
                        }
                    }
                }
                "role:sr:archiveStatus" => {
                    if let Some(ref s) = norm_text {
                        sr_archive_by_row.insert(entity_uuid.clone(), s.clone());
                    }
                }
                _ => {}
            }

            ins_cell
                .execute(params![
                    &doc_id,
                    &entity_uuid,
                    &canonical_key,
                    &val_type,
                    &norm_text,
                    val_num,
                    &val_date,
                    &norm_json,
                ])
                .map_err(|e| format!("写入 index.cell_values 失败: {e}"))?;

            for opt_name in multi_names {
                ins_multi
                    .execute(params![&doc_id, &entity_uuid, &canonical_key, &opt_name])
                    .map_err(|e| format!("写入 index.cell_multi_options 失败: {e}"))?;
            }
        }
    }

    // 7. 投影 formula_cache（并校验/刷新易变 SR 公式以保证跨午夜与缺失缓存 100% 准确）
    let mut synced_sr_formulas: HashSet<(String, String)> = HashSet::new();
    {
        let mut fstmt = doc_conn
            .prepare(
                "SELECT entity_uuid, col_id, canonical_key, kind, display_text, val_num, val_date_ms, val_json, is_volatile, computed_day
                 FROM formula_cache",
            )
            .map_err(|e| format!("读取源 formula_cache 失败: {e}"))?;
        let frows = fstmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<f64>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                    r.get::<_, i64>(8)?,
                    r.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(|e| format!("遍历源 formula_cache 失败: {e}"))?;

        let mut ins_fc = idx_tx
            .prepare(
                "INSERT OR REPLACE INTO formula_cache (
                    doc_id, entity_uuid, canonical_key, kind, display_text, val_num, val_date_ms, val_json, is_volatile, computed_day
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            )
            .map_err(|e| format!("准备写入 index.formula_cache 失败: {e}"))?;

        for row in frows {
            let (
                entity_uuid,
                col_id,
                raw_ck,
                kind,
                display_text,
                val_num,
                val_date_ms,
                val_json,
                is_volatile,
                computed_day,
            ) = row.map_err(|e| format!("解析源 formula_cache 失败: {e}"))?;
            if !row_uuids.contains(&entity_uuid) {
                continue;
            }
            let canonical_key = col_by_id
                .get(&col_id)
                .map(|c| c.canonical_key.clone())
                .unwrap_or(raw_ck);

            // 若是易变 SR 公式且 computed_day 已过期，交由下方确定性重算覆盖
            let is_sr_formula = matches!(
                canonical_key.as_str(),
                "role:sr:nextInterval" | "role:sr:nextDueDate" | "role:sr:dueStatus"
            );
            if is_sr_formula && computed_day.as_deref() != Some(today_key) {
                continue;
            }
            if is_sr_formula {
                synced_sr_formulas.insert((entity_uuid.clone(), canonical_key.clone()));
                if canonical_key == "role:sr:dueStatus" {
                    let eff_status = if display_text.trim().is_empty() {
                        "待复习"
                    } else {
                        display_text.trim()
                    };
                    if eff_status != "待复习" {
                        idx_tx
                            .execute(
                                "UPDATE entities SET sr_due_status = ?1 WHERE doc_id = ?2 AND uuid = ?3",
                                params![eff_status, &doc_id, &entity_uuid],
                            )
                            .map_err(|e| format!("更新 entities.sr_due_status 失败: {e}"))?;
                    }
                }
            }

            ins_fc
                .execute(params![
                    &doc_id,
                    &entity_uuid,
                    &canonical_key,
                    &kind,
                    &display_text,
                    val_num,
                    val_date_ms,
                    &val_json,
                    is_volatile,
                    &computed_day,
                ])
                .map_err(|e| format!("写入 index.formula_cache 失败: {e}"))?;
        }

        // 若该文档启用了 SR 列，为缺失或跨日过期的行补全最新 SR 公式投影
        if !sr_col_id_by_role.is_empty() {
            for entity_uuid in &row_uuids {
                let need_interval = sr_col_id_by_role.contains_key("nextInterval")
                    && !synced_sr_formulas
                        .contains(&(entity_uuid.clone(), "role:sr:nextInterval".to_string()));
                let need_due_date = sr_col_id_by_role.contains_key("nextDueDate")
                    && !synced_sr_formulas
                        .contains(&(entity_uuid.clone(), "role:sr:nextDueDate".to_string()));
                let need_due_status = sr_col_id_by_role.contains_key("dueStatus")
                    && !synced_sr_formulas
                        .contains(&(entity_uuid.clone(), "role:sr:dueStatus".to_string()));
                if !need_interval && !need_due_date && !need_due_status {
                    continue;
                }
                let eval = evaluate_sr_formulas(
                    sr_correct_by_row.get(entity_uuid).copied(),
                    sr_delay_by_row.get(entity_uuid).copied(),
                    sr_answer_by_row.get(entity_uuid).map(|s| s.as_str()),
                    sr_archive_by_row.get(entity_uuid).map(|s| s.as_str()),
                    today_key,
                );
                if need_interval {
                    ins_fc
                        .execute(params![
                            &doc_id,
                            entity_uuid,
                            "role:sr:nextInterval",
                            "number",
                            format_js_number(eval.next_interval.round()),
                            Some(eval.next_interval),
                            Option::<i64>::None,
                            Option::<String>::None,
                            0i64,
                            today_key,
                        ])
                        .map_err(|e| format!("补全 SR nextInterval 缓存失败: {e}"))?;
                }
                if need_due_date {
                    let (kind, disp, ms) = match (&eval.next_due_date, eval.next_due_date_ms) {
                        (Some(d), Some(m)) => ("date", d.as_str(), Some(m)),
                        _ => ("empty", "", None),
                    };
                    ins_fc
                        .execute(params![
                            &doc_id,
                            entity_uuid,
                            "role:sr:nextDueDate",
                            kind,
                            disp,
                            Option::<f64>::None,
                            ms,
                            Option::<String>::None,
                            0i64,
                            today_key,
                        ])
                        .map_err(|e| format!("补全 SR nextDueDate 缓存失败: {e}"))?;
                }
                if need_due_status {
                    ins_fc
                        .execute(params![
                            &doc_id,
                            entity_uuid,
                            "role:sr:dueStatus",
                            "string",
                            eval.due_status,
                            Option::<f64>::None,
                            Option::<i64>::None,
                            Option::<String>::None,
                            1i64,
                            today_key,
                        ])
                        .map_err(|e| format!("补全 SR dueStatus 缓存失败: {e}"))?;
                    if eval.due_status != "待复习" {
                        idx_tx
                            .execute(
                                "UPDATE entities SET sr_due_status = ?1 WHERE doc_id = ?2 AND uuid = ?3",
                                params![eval.due_status, &doc_id, entity_uuid],
                            )
                            .map_err(|e| format!("更新补全 entities.sr_due_status 失败: {e}"))?;
                    }
                }
            }
        }
    }

    // 8. 写入 cross_doc_refs（先按已有 docs.title 解析，未命中时暂存 title:<name> 供全量后解析）
    if !raw_refs.is_empty() {
        let mut ref_stmt = idx_tx
            .prepare(
                "INSERT OR IGNORE INTO cross_doc_refs (source_doc_id, source_uuid, target_doc_id, target_section_name)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| format!("准备写入 cross_doc_refs 失败: {e}"))?;
        for (src_uuid, file_name, sec_name) in raw_refs {
            let target_id: Option<String> = idx_tx
                .query_row(
                    "SELECT doc_id FROM docs WHERE lower(title) = lower(?1) LIMIT 1",
                    params![&file_name],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| format!("解析 cross_doc_refs 目标失败: {e}"))?;
            let resolved_target = target_id.unwrap_or_else(|| format!("title:{file_name}"));
            ref_stmt
                .execute(params![&doc_id, &src_uuid, &resolved_target, &sec_name])
                .map_err(|e| format!("写入 cross_doc_refs 失败: {e}"))?;
        }
    }

    Ok(doc_id)
}

/// 将暂存的 `title:<fileName>` 跨文件引用解析为真实的 `docs.doc_id`。
fn resolve_pending_cross_doc_refs_tx(tx: &Transaction<'_>) -> Result<(), String> {
    let pending: Vec<(String, String, String, String)> = {
        let mut stmt = tx
            .prepare(
                "SELECT source_doc_id, source_uuid, target_doc_id, target_section_name
                 FROM cross_doc_refs
                 WHERE target_doc_id LIKE 'title:%'",
            )
            .map_err(|e| format!("查询待解析 cross_doc_refs 失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| format!("遍历待解析 cross_doc_refs 失败: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("收集待解析 cross_doc_refs 失败: {e}"))?
    };

    for (src_doc, src_uuid, raw_target, sec_name) in pending {
        let Some(title_name) = raw_target.strip_prefix("title:") else {
            continue;
        };
        let found: Option<String> = tx
            .query_row(
                "SELECT doc_id FROM docs WHERE lower(title) = lower(?1) LIMIT 1",
                params![title_name],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("解析标题引用失败: {e}"))?;
        if let Some(real_id) = found {
            tx.execute(
                "DELETE FROM cross_doc_refs
                 WHERE source_doc_id = ?1 AND source_uuid = ?2 AND target_doc_id = ?3 AND target_section_name = ?4",
                params![&src_doc, &src_uuid, &raw_target, &sec_name],
            )
            .map_err(|e| format!("清理占位 cross_doc_refs 失败: {e}"))?;
            tx.execute(
                "INSERT OR IGNORE INTO cross_doc_refs (source_doc_id, source_uuid, target_doc_id, target_section_name)
                 VALUES (?1, ?2, ?3, ?4)",
                params![&src_doc, &src_uuid, &real_id, &sec_name],
            )
            .map_err(|e| format!("写入解析后的 cross_doc_refs 失败: {e}"))?;
        }
    }
    Ok(())
}

// ============================================================================
// WorkspaceEngine 主状态
// ============================================================================

struct ActiveWorkspace {
    root: PathBuf,
    conn: Connection,
}

struct WatcherHandle {
    _watcher: RecommendedWatcher,
    stop_flag: Arc<AtomicBool>,
}

pub struct WorkspaceEngine {
    pool: Arc<DocumentActorPool>,
    active: Mutex<Option<ActiveWorkspace>>,
    watcher: Mutex<Option<WatcherHandle>>,
}

impl WorkspaceEngine {
    pub fn new(pool: Arc<DocumentActorPool>) -> Self {
        Self {
            pool,
            active: Mutex::new(None),
            watcher: Mutex::new(None),
        }
    }

    pub fn active_root(&self) -> Option<PathBuf> {
        self.active
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|w| w.root.clone()))
    }

    /// 打开或切换工作空间：初始化 `.flux-graph/index.sqlite`、扫描旧版 v2.x 并执行增量索引同步。
    pub fn open_workspace(&self, root: &Path) -> Result<WorkspaceOpenResult, String> {
        if !root.exists() || !root.is_dir() {
            return Err(format!("工作空间目录不存在: {}", root.display()));
        }
        let canonical_root = fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
        let flux_dir = canonical_root.join(".flux-graph");
        fs::create_dir_all(&flux_dir)
            .map_err(|e| format!("创建 .flux-graph 目录失败: {e}"))?;
        let index_path = flux_dir.join("index.sqlite");

        // 停止旧 watcher
        self.stop_watcher();

        let conn = Connection::open(&index_path)
            .map_err(|e| format!("打开工作空间 index.sqlite 失败: {e}"))?;
        initialize_workspace_index_schema(&conn)?;

        let legacy_report = scan_workspace_legacy_prg(&canonical_root)?;

        {
            let mut guard = self
                .active
                .lock()
                .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
            *guard = Some(ActiveWorkspace {
                root: canonical_root.clone(),
                conn,
            });
        }

        let sync_stats = self.sync_incremental(legacy_report.files.len())?;
        let docs = self.list_docs()?;
        let columns = self.list_columns()?;
        let views = self.list_views()?;
        let meta_json = self.get_table_meta()?;

        Ok(WorkspaceOpenResult {
            root: canonical_display_path(&canonical_root),
            index_path: canonical_display_path(&index_path),
            legacy_report,
            sync_stats,
            docs,
            columns,
            views,
            meta_json,
        })
    }

    /// 启动基于 `notify = "6"` 的文件系统监听，自动增量刷新外部增删改名的 `.prg` 文件。
    pub fn start_watcher<F>(&self, on_updated: F) -> Result<(), String>
    where
        F: Fn(WorkspaceIndexUpdatedPayload) + Send + Sync + 'static,
    {
        self.stop_watcher();
        let Some(root) = self.active_root() else {
            return Ok(());
        };
        let root_for_thread = root.clone();
        let stop_flag = Arc::new(AtomicBool::new(false));
        let stop_for_cb = Arc::clone(&stop_flag);
        let pending_dirty = Arc::new(Mutex::new(HashSet::<PathBuf>::new()));
        let pending_for_cb = Arc::clone(&pending_dirty);

        let mut watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
            // 严禁任何 panic 跨越 Windows ReadDirectoryChangesW FFI 回调边界导致进程 abort (0xc0000409)
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                if stop_for_cb.load(Ordering::Relaxed) {
                    return;
                }
                let Ok(event) = res else {
                    return;
                };
                if matches!(event.kind, EventKind::Access(_)) {
                    return;
                }
                let mut dirty_paths = Vec::new();
                for p in event.paths {
                    let s = p.to_string_lossy().replace('\\', "/");
                    if s.contains("/.flux-graph/") || s.ends_with("-wal") || s.ends_with("-shm") {
                        continue;
                    }
                    if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                        if is_prg_file_name(name) {
                            dirty_paths.push(p);
                        }
                    }
                }
                if !dirty_paths.is_empty() {
                    if let Ok(mut guard) = pending_for_cb.lock() {
                        for p in dirty_paths {
                            guard.insert(p);
                        }
                    }
                }
            }));
        })
        .map_err(|e| format!("初始化 notify 文件监听失败: {e}"))?;

        watcher
            .watch(&root, RecursiveMode::Recursive)
            .map_err(|e| format!("启动工作空间目录监听失败: {e}"))?;

        // 防抖轮询线程（250ms 合并高频保存/批处理事件）
        let stop_for_worker = Arc::clone(&stop_flag);
        let root_str = canonical_display_path(&root_for_thread);
        std::thread::spawn(move || {
            while !stop_for_worker.load(Ordering::Relaxed) {
                std::thread::sleep(Duration::from_millis(250));
                if stop_for_worker.load(Ordering::Relaxed) {
                    break;
                }
                let batch: Vec<PathBuf> = {
                    let Ok(mut guard) = pending_dirty.lock() else {
                        break;
                    };
                    if guard.is_empty() {
                        continue;
                    }
                    guard.drain().collect()
                };
                if !batch.is_empty() {
                    on_updated(WorkspaceIndexUpdatedPayload {
                        root: root_str.clone(),
                        reason: "fs_watch".to_string(),
                        doc_ids: Vec::new(),
                    });
                }
            }
        });

        let mut wg = self
            .watcher
            .lock()
            .map_err(|_| "WorkspaceEngine watcher 锁中毒".to_string())?;
        *wg = Some(WatcherHandle {
            _watcher: watcher,
            stop_flag,
        });
        Ok(())
    }

    pub fn stop_watcher(&self) {
        if let Ok(mut wg) = self.watcher.lock() {
            if let Some(handle) = wg.take() {
                handle.stop_flag.store(true, Ordering::Relaxed);
            }
        }
    }

    pub fn close_workspace(&self) -> Result<(), String> {
        self.stop_watcher();
        let mut guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        if let Some(ws) = guard.take() {
            let _ = wal_checkpoint_truncate(&ws.conn);
        }
        Ok(())
    }

    /// 增量同步工作空间全部 `.prg v3.0.0` 文件：按 `(rel_path, mtime_ms, file_size)` 跳过未变文件。
    pub fn sync_incremental(&self, known_legacy_count: usize) -> Result<WorkspaceSyncStats, String> {
        let t0 = Instant::now();
        let root = self
            .active_root()
            .ok_or_else(|| "尚未打开工作空间".to_string())?;

        let mut disk_entries = Vec::new();
        collect_disk_prg_entries(&root, &root, &mut disk_entries);

        let mut guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let ws = guard
            .as_mut()
            .ok_or_else(|| "尚未打开工作空间".to_string())?;

        // 1. 加载现有索引中的 (rel_path -> (doc_id, mtime_ms, file_size))
        let existing_docs: HashMap<String, (String, i64, i64)> = {
            let mut stmt = ws
                .conn
                .prepare("SELECT rel_path, doc_id, mtime_ms, file_size FROM docs")
                .map_err(|e| format!("查询 docs 快照失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)?,
                        r.get::<_, i64>(3)?,
                    ))
                })
                .map_err(|e| format!("遍历 docs 快照失败: {e}"))?;
            let mut map = HashMap::new();
            for r in rows.flatten() {
                map.insert(r.0, (r.1, r.2, r.3));
            }
            map
        };

        let mut disk_rel_set: HashSet<String> = HashSet::with_capacity(disk_entries.len());
        let mut to_index: Vec<DiskPrgEntry> = Vec::new();
        let mut skipped_docs = 0usize;

        for entry in disk_entries {
            disk_rel_set.insert(entry.rel_path.clone());
            if let Some((_, old_mtime, old_size)) = existing_docs.get(&entry.rel_path) {
                if *old_mtime == entry.mtime_ms && *old_size == entry.file_size {
                    skipped_docs += 1;
                    continue;
                }
            }
            to_index.push(entry);
        }

        let removed_rels: Vec<(String, String)> = existing_docs
            .into_iter()
            .filter(|(rel, _)| !disk_rel_set.contains(rel))
            .map(|(rel, (doc_id, _, _))| (rel, doc_id))
            .collect();

        if to_index.is_empty() && removed_rels.is_empty() {
            let total_docs: usize = ws
                .conn
                .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get::<_, i64>(0))
                .unwrap_or(0) as usize;
            return Ok(WorkspaceSyncStats {
                total_docs,
                indexed_docs: 0,
                skipped_docs,
                removed_docs: 0,
                legacy_v2_docs: known_legacy_count,
                elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0,
            });
        }

        let today_key = resolve_today_key(&ws.conn, None);
        let mut indexed_docs = 0usize;
        let mut legacy_v2_docs = 0usize;
        let removed_docs = removed_rels.len();

        let tx = ws
            .conn
            .transaction()
            .map_err(|e| format!("开启工作空间同步事务失败: {e}"))?;

        for (_rel, old_doc_id) in &removed_rels {
            tx.execute("DELETE FROM entities_fts WHERE doc_id = ?1", params![old_doc_id])
                .map_err(|e| format!("删除已移除文档 FTS 失败: {e}"))?;
            tx.execute("DELETE FROM docs WHERE doc_id = ?1", params![old_doc_id])
                .map_err(|e| format!("删除已移除文档 docs 行失败: {e}"))?;
        }

        for entry in to_index {
            match detect_prg_format(&entry.abs_path) {
                Ok(PrgFormat::V3Sqlite) => {}
                Ok(PrgFormat::V2Zip) => {
                    legacy_v2_docs += 1;
                    continue;
                }
                _ => continue,
            }
            // 若该文档已在 DocumentActorPool 中打开，优先直接复用内存连接（看到最新 WAL 提交）
            let projected = if let Ok(Some(actor)) = self.pool.get_cached_by_path(&entry.abs_path) {
                if let Ok(actor_guard) = actor.lock() {
                    project_doc_conn_into_index_tx(
                        &tx,
                        &actor_guard.conn,
                        &entry.rel_path,
                        &entry.folder_path,
                        &entry.title,
                        entry.mtime_ms,
                        entry.file_size,
                        &today_key,
                    )
                } else {
                    continue;
                }
            } else {
                match open_readonly(&entry.abs_path) {
                    Ok(doc_conn) => project_doc_conn_into_index_tx(
                        &tx,
                        &doc_conn,
                        &entry.rel_path,
                        &entry.folder_path,
                        &entry.title,
                        entry.mtime_ms,
                        entry.file_size,
                        &today_key,
                    ),
                    Err(_) => continue,
                }
            };
            if projected.is_ok() {
                indexed_docs += 1;
            }
        }

        resolve_pending_cross_doc_refs_tx(&tx)?;
        tx.commit()
            .map_err(|e| format!("提交工作空间增量同步事务失败: {e}"))?;

        let total_docs: usize = ws
            .conn
            .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get::<_, i64>(0))
            .unwrap_or(0) as usize;

        Ok(WorkspaceSyncStats {
            total_docs,
            indexed_docs,
            skipped_docs,
            removed_docs,
            legacy_v2_docs: legacy_v2_docs.max(known_legacy_count),
            elapsed_ms: t0.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// 当单个活跃 `DocumentActor` 完成写事务提交后，实时（< 1ms）同步其最新数据进 `index.sqlite`。
    pub fn sync_from_actor(&self, actor: &DocumentActor) -> Result<bool, String> {
        if actor.is_temp_draft {
            return Ok(false);
        }
        let mut guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let Some(ws) = guard.as_mut() else {
            return Ok(false);
        };
        let Some(rel_path) = compute_rel_path_insensitive(&ws.root, &actor.path) else {
            return Ok(false);
        };
        let (folder_path, title) = split_rel_path_meta(&rel_path);
        let (mtime_ms, file_size) = fs::metadata(&actor.path)
            .map(|m| file_mtime_and_size(&m))
            .unwrap_or_else(|_| (current_unix_ms(), 0));
        let today_key = resolve_today_key(&ws.conn, None);

        let tx = ws
            .conn
            .transaction()
            .map_err(|e| format!("开启单文档索引同步事务失败: {e}"))?;
        project_doc_conn_into_index_tx(
            &tx,
            &actor.conn,
            &rel_path,
            &folder_path,
            &title,
            mtime_ms,
            file_size,
            &today_key,
        )?;
        resolve_pending_cross_doc_refs_tx(&tx)?;
        tx.commit()
            .map_err(|e| format!("提交单文档索引同步事务失败: {e}"))?;
        Ok(true)
    }

    /// 按路径同步单个 `.prg` 文件（新建页面、恢复历史版本或外部写入后调用）。
    pub fn sync_file_by_path(&self, path: &Path) -> Result<Option<String>, String> {
        if !path.exists() {
            return Ok(None);
        }
        if detect_prg_format(path)? != PrgFormat::V3Sqlite {
            return Ok(None);
        }
        if let Ok(Some(actor)) = self.pool.get_cached_by_path(path) {
            let guard = actor
                .lock()
                .map_err(|_| "DocumentActor 锁中毒".to_string())?;
            let synced = self.sync_from_actor(&guard)?;
            return Ok(if synced {
                Some(guard.doc_id.clone())
            } else {
                None
            });
        }
        let mut guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let Some(ws) = guard.as_mut() else {
            return Ok(None);
        };
        let Some(rel_path) = compute_rel_path_insensitive(&ws.root, path) else {
            return Ok(None);
        };
        let (folder_path, title) = split_rel_path_meta(&rel_path);
        let (mtime_ms, file_size) = fs::metadata(path)
            .map(|m| file_mtime_and_size(&m))
            .unwrap_or_else(|_| (current_unix_ms(), 0));
        let today_key = resolve_today_key(&ws.conn, None);
        let doc_conn = open_readonly(path)?;
        let tx = ws
            .conn
            .transaction()
            .map_err(|e| format!("开启单文件索引事务失败: {e}"))?;
        let doc_id = project_doc_conn_into_index_tx(
            &tx,
            &doc_conn,
            &rel_path,
            &folder_path,
            &title,
            mtime_ms,
            file_size,
            &today_key,
        )?;
        resolve_pending_cross_doc_refs_tx(&tx)?;
        tx.commit()
            .map_err(|e| format!("提交单文件索引事务失败: {e}"))?;
        Ok(Some(doc_id))
    }

    /// 供 `flux-media://` 或跨文件路由根据 `doc_id` 解析磁盘绝对路径。
    pub fn resolve_doc_path(&self, doc_id: &str) -> Result<Option<PathBuf>, String> {
        let guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let Some(ws) = guard.as_ref() else {
            return Ok(None);
        };
        let rel: Option<String> = ws
            .conn
            .query_row(
                "SELECT rel_path FROM docs WHERE doc_id = ?1",
                params![doc_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| format!("查询 doc_id 路径失败: {e}"))?;
        Ok(rel.map(|r| ws.root.join(r)))
    }

    /// 检查 `index.sqlite` 的只读借用执行入口（供 `workspace_query.rs` 使用）。
    pub fn with_index_conn<T, F>(&self, f: F) -> Result<T, String>
    where
        F: FnOnce(&Connection, &Path) -> Result<T, String>,
    {
        let guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let ws = guard
            .as_ref()
            .ok_or_else(|| "尚未打开工作空间".to_string())?;
        f(&ws.conn, &ws.root)
    }

    // ========================================================================
    // 文档列表、列管理与视图管理
    // ========================================================================

    pub fn list_docs(&self) -> Result<Vec<WorkspaceDocRecord>, String> {
        self.with_index_conn(|conn, root| {
            let mut stmt = conn
                .prepare(
                    "SELECT doc_id, rel_path, folder_path, title, mtime_ms, file_size, revision, format_version
                     FROM docs ORDER BY rel_path COLLATE \"NATURAL\" ASC",
                )
                .map_err(|e| format!("查询 docs 列表失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    let rel: String = r.get(1)?;
                    let abs_path = canonical_display_path(&root.join(&rel));
                    Ok(WorkspaceDocRecord {
                        doc_id: r.get(0)?,
                        rel_path: rel,
                        folder_path: r.get(2)?,
                        title: r.get(3)?,
                        mtime_ms: r.get(4)?,
                        file_size: r.get(5)?,
                        revision: r.get(6)?,
                        format_version: r.get(7)?,
                        abs_path,
                    })
                })
                .map_err(|e| format!("遍历 docs 列表失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析 docs 列表失败: {e}"))
        })
    }

    pub fn list_columns(&self) -> Result<Vec<WorkspaceColumnRecord>, String> {
        self.with_index_conn(|conn, _root| {
            let mut stmt = conn
                .prepare(
                    "SELECT wc.canonical_key, wc.name, wc.type, wc.is_shared, wc.config_json,
                            COALESCE((
                              SELECT COUNT(DISTINCT cv.doc_id)
                              FROM cell_values cv
                              WHERE cv.canonical_key = wc.canonical_key
                            ), 0) AS cell_docs,
                            COALESCE((
                              SELECT COUNT(DISTINCT fc.doc_id)
                              FROM formula_cache fc
                              WHERE fc.canonical_key = wc.canonical_key
                            ), 0) AS formula_docs
                     FROM workspace_columns wc
                     ORDER BY wc.is_shared DESC, wc.name COLLATE \"NATURAL\" ASC",
                )
                .map_err(|e| format!("查询 workspace_columns 失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    let c_docs = r.get::<_, i64>(5)? as usize;
                    let f_docs = r.get::<_, i64>(6)? as usize;
                    Ok(WorkspaceColumnRecord {
                        canonical_key: r.get(0)?,
                        name: r.get(1)?,
                        r#type: r.get(2)?,
                        is_shared: r.get::<_, i64>(3)? != 0,
                        config_json: r.get(4)?,
                        doc_count: c_docs.max(f_docs),
                    })
                })
                .map_err(|e| format!("遍历 workspace_columns 失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析 workspace_columns 失败: {e}"))
        })
    }

    /// 确保工作空间列定义中包含 11 个间隔重复受保护列（`role:sr:*`），便于全局间隔重复视图零配置开箱即用。
    pub fn ensure_workspace_sr_columns(&self) -> Result<Vec<WorkspaceColumnRecord>, String> {
        {
            let mut guard = self
                .active
                .lock()
                .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
            let ws = guard
                .as_mut()
                .ok_or_else(|| "尚未打开工作空间".to_string())?;
            let tx = ws
                .conn
                .transaction()
                .map_err(|e| format!("开启初始化全局 SR 列事务失败: {e}"))?;

            for spec in SR_SPECS {
                let ck = format!("role:sr:{}", spec.role);
                let exists: i64 = tx
                    .query_row(
                        "SELECT COUNT(*) FROM workspace_columns WHERE canonical_key = ?1",
                        params![&ck],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                if exists > 0 {
                    continue;
                }
                let mut cfg = serde_json::Map::new();
                cfg.insert(
                    "protectedRole".to_string(),
                    serde_json::Value::String(spec.role.to_string()),
                );
                if let Some(fmt) = spec.format {
                    cfg.insert("format".to_string(), serde_json::Value::String(fmt.to_string()));
                }
                if spec.role == "archiveStatus" {
                    let opts = vec![
                        WorkspaceColumnOption {
                            id: format!("opt_{}", uuid::Uuid::new_v4()),
                            name: "未归档".to_string(),
                            color: "gray".to_string(),
                        },
                        WorkspaceColumnOption {
                            id: format!("opt_{}", uuid::Uuid::new_v4()),
                            name: "已归档".to_string(),
                            color: "green".to_string(),
                        },
                    ];
                    cfg.insert("options".to_string(), serde_json::to_value(opts).unwrap());
                } else if spec.col_type == "select" || spec.col_type == "multi_select" {
                    cfg.insert("options".to_string(), serde_json::json!([]));
                }
                tx.execute(
                    "INSERT INTO workspace_columns (canonical_key, name, type, is_shared, config_json)
                     VALUES (?1, ?2, ?3, 1, ?4)",
                    params![
                        &ck,
                        spec.name,
                        spec.col_type,
                        serde_json::Value::Object(cfg).to_string(),
                    ],
                )
                .map_err(|e| format!("初始化全局 SR 列 {ck} 失败: {e}"))?;
            }
            tx.commit()
                .map_err(|e| format!("提交全局 SR 列初始化事务失败: {e}"))?;
        }
        self.list_columns()
    }

    /// 新建工作空间共享字段（`ws:<uuid>`），写回具体行时再按需落入源 `.prg`。
    pub fn create_shared_column(
        &self,
        name: &str,
        col_type: &str,
        config_json: Option<&str>,
    ) -> Result<WorkspaceColumnRecord, String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("字段名称不能为空".to_string());
        }
        let ck = format!("ws:{}", uuid::Uuid::new_v4());
        let cfg = config_json.unwrap_or("{}");
        {
            let guard = self
                .active
                .lock()
                .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
            let ws = guard
                .as_ref()
                .ok_or_else(|| "尚未打开工作空间".to_string())?;
            ws.conn
                .execute(
                    "INSERT INTO workspace_columns (canonical_key, name, type, is_shared, config_json)
                     VALUES (?1, ?2, ?3, 1, ?4)",
                    params![&ck, trimmed, col_type, cfg],
                )
                .map_err(|e| format!("创建工作空间共享字段失败: {e}"))?;
        }
        Ok(WorkspaceColumnRecord {
            canonical_key: ck,
            name: trimmed.to_string(),
            r#type: col_type.to_string(),
            is_shared: true,
            config_json: cfg.to_string(),
            doc_count: 0,
        })
    }

    /// 在工作空间 `select`/`multi_select` 字段上查找或新建选项。
    pub fn create_or_get_workspace_option(
        &self,
        canonical_key: &str,
        option_name: &str,
    ) -> Result<WorkspaceColumnOption, String> {
        let clean = option_name.trim();
        if clean.is_empty() {
            return Err("选项名称不能为空".to_string());
        }
        let guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let ws = guard
            .as_ref()
            .ok_or_else(|| "尚未打开工作空间".to_string())?;

        let (col_type, cfg_json): (String, String) = ws
            .conn
            .query_row(
                "SELECT type, config_json FROM workspace_columns WHERE canonical_key = ?1",
                params![canonical_key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(|e| format!("找不到工作空间列 {canonical_key}: {e}"))?;
        if col_type != "select" && col_type != "multi_select" {
            return Err(format!("列 {canonical_key} 不是单选/多选类型"));
        }

        let mut opts = parse_options_from_config(&cfg_json);
        if let Some(found) = opts
            .iter()
            .find(|o| o.name.trim().eq_ignore_ascii_case(clean))
        {
            return Ok(found.clone());
        }
        let created = WorkspaceColumnOption {
            id: format!("opt_{}", uuid::Uuid::new_v4()),
            name: clean.to_string(),
            color: pick_next_option_color(&opts),
        };
        opts.push(created.clone());
        let mut cfg_val: serde_json::Value =
            serde_json::from_str(&cfg_json).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(obj) = cfg_val.as_object_mut() {
            obj.insert("options".to_string(), serde_json::to_value(&opts).unwrap());
        }
        ws.conn
            .execute(
                "UPDATE workspace_columns SET config_json = ?1 WHERE canonical_key = ?2",
                params![cfg_val.to_string(), canonical_key],
            )
            .map_err(|e| format!("更新工作空间列选项失败: {e}"))?;
        Ok(created)
    }

    /// 将 `auto:*` 列提升为工作空间共享字段 `ws:<uuid>`，并同步传播至所有含该列的 `.prg` 文件。
    pub fn promote_column_to_shared(
        &self,
        source_canonical_key: &str,
        target_name: Option<&str>,
        origin_window: &str,
    ) -> Result<(WorkspaceColumnRecord, Vec<DocChangeSet>), String> {
        let new_ck = if source_canonical_key.starts_with("ws:") {
            source_canonical_key.to_string()
        } else if source_canonical_key.starts_with("role:sr:") {
            return Err("间隔重复受保护列已是全局标准列，无需提升".to_string());
        } else {
            format!("ws:{}", uuid::Uuid::new_v4())
        };

        let (cur_name, col_type, cfg_json, affected_doc_paths): (
            String,
            String,
            String,
            Vec<PathBuf>,
        ) = self.with_index_conn(|conn, root| {
            let (name, ctype, cfg): (String, String, String) = conn
                .query_row(
                    "SELECT name, type, config_json FROM workspace_columns WHERE canonical_key = ?1",
                    params![source_canonical_key],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .map_err(|e| format!("未找到列 {source_canonical_key}: {e}"))?;
            let mut stmt = conn
                .prepare("SELECT rel_path FROM docs")
                .map_err(|e| format!("查询工作空间文档列表失败: {e}"))?;
            let paths = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| format!("遍历工作空间文档列表失败: {e}"))?
                .flatten()
                .map(|rel| root.join(rel))
                .collect::<Vec<_>>();
            Ok((name, ctype, cfg, paths))
        })?;

        let final_name = target_name
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .unwrap_or(&cur_name)
            .to_string();

        // 在 index.sqlite 中建立目标共享列并迁移索引键
        {
            let mut guard = self
                .active
                .lock()
                .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
            let ws = guard
                .as_mut()
                .ok_or_else(|| "尚未打开工作空间".to_string())?;
            let tx = ws
                .conn
                .transaction()
                .map_err(|e| format!("开启提升共享字段事务失败: {e}"))?;
            tx.execute(
                "INSERT INTO workspace_columns (canonical_key, name, type, is_shared, config_json)
                 VALUES (?1, ?2, ?3, 1, ?4)
                 ON CONFLICT(canonical_key) DO UPDATE SET name = excluded.name, is_shared = 1, config_json = excluded.config_json",
                params![&new_ck, &final_name, &col_type, &cfg_json],
            )
            .map_err(|e| format!("写入共享字段失败: {e}"))?;
            if new_ck != source_canonical_key {
                tx.execute(
                    "UPDATE OR REPLACE cell_values SET canonical_key = ?1 WHERE canonical_key = ?2",
                    params![&new_ck, source_canonical_key],
                )
                .map_err(|e| format!("迁移 cell_values canonical_key 失败: {e}"))?;
                tx.execute(
                    "UPDATE OR IGNORE cell_multi_options SET canonical_key = ?1 WHERE canonical_key = ?2",
                    params![&new_ck, source_canonical_key],
                )
                .map_err(|e| format!("迁移 cell_multi_options canonical_key 失败: {e}"))?;
                tx.execute(
                    "DELETE FROM cell_multi_options WHERE canonical_key = ?1",
                    params![source_canonical_key],
                )
                .map_err(|e| format!("清理旧 cell_multi_options 失败: {e}"))?;
                tx.execute(
                    "UPDATE OR REPLACE formula_cache SET canonical_key = ?1 WHERE canonical_key = ?2",
                    params![&new_ck, source_canonical_key],
                )
                .map_err(|e| format!("迁移 formula_cache canonical_key 失败: {e}"))?;
                tx.execute(
                    "DELETE FROM workspace_columns WHERE canonical_key = ?1",
                    params![source_canonical_key],
                )
                .map_err(|e| format!("清理旧 auto 字段失败: {e}"))?;
            }
            tx.commit()
                .map_err(|e| format!("提交提升共享字段事务失败: {e}"))?;
        }

        // 同步传播 canonical_key 到实际含该列的 .prg 文件
        let changesets = self.propagate_canonical_key_remap(
            &affected_doc_paths,
            &[source_canonical_key.to_string()],
            &new_ck,
            &final_name,
            origin_window,
        )?;

        let updated_col = self
            .list_columns()?
            .into_iter()
            .find(|c| c.canonical_key == new_ck)
            .unwrap_or(WorkspaceColumnRecord {
                canonical_key: new_ck,
                name: final_name,
                r#type: col_type,
                is_shared: true,
                config_json: cfg_json,
                doc_count: 0,
            });
        Ok((updated_col, changesets))
    }

    /// 将多个同类型字段合并到一个目标共享字段（`ws:<uuid>`），同步更新 `index.sqlite` 与源 `.prg` 文件。
    pub fn merge_columns(
        &self,
        source_canonical_keys: &[String],
        target_canonical_key: &str,
        origin_window: &str,
    ) -> Result<(WorkspaceColumnRecord, Vec<DocChangeSet>), String> {
        let filtered_sources: Vec<String> = source_canonical_keys
            .iter()
            .filter(|k| k.as_str() != target_canonical_key && !k.starts_with("role:sr:"))
            .cloned()
            .collect();
        if filtered_sources.is_empty() {
            let existing = self
                .list_columns()?
                .into_iter()
                .find(|c| c.canonical_key == target_canonical_key)
                .ok_or_else(|| format!("目标列不存在: {target_canonical_key}"))?;
            return Ok((existing, Vec::new()));
        }

        // 先确保目标列已是共享列（若是 auto:* 先提升为 ws:*）
        let (target_col, mut changesets) = if target_canonical_key.starts_with("ws:")
            || target_canonical_key.starts_with("role:sr:")
        {
            let col = self
                .list_columns()?
                .into_iter()
                .find(|c| c.canonical_key == target_canonical_key)
                .ok_or_else(|| format!("目标列不存在: {target_canonical_key}"))?;
            (col, Vec::new())
        } else {
            self.promote_column_to_shared(target_canonical_key, None, origin_window)?
        };

        let all_paths: Vec<PathBuf> = self.with_index_conn(|conn, root| {
            // 校验类型一致
            for src_ck in &filtered_sources {
                let src_type: String = conn
                    .query_row(
                        "SELECT type FROM workspace_columns WHERE canonical_key = ?1",
                        params![src_ck],
                        |r| r.get(0),
                    )
                    .map_err(|e| format!("未找到源列 {src_ck}: {e}"))?;
                if src_type != target_col.r#type {
                    return Err(format!(
                        "无法合并不同类型的字段：{src_ck}({src_type}) 与 {}({})",
                        target_col.canonical_key, target_col.r#type
                    ));
                }
            }
            let mut stmt = conn
                .prepare("SELECT rel_path FROM docs")
                .map_err(|e| format!("查询 docs 失败: {e}"))?;
            let paths = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| format!("遍历 docs 失败: {e}"))?
                .flatten()
                .map(|rel| root.join(rel))
                .collect::<Vec<_>>();
            Ok(paths)
        })?;

        // 合并选项与索引行
        {
            let mut guard = self
                .active
                .lock()
                .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
            let ws = guard
                .as_mut()
                .ok_or_else(|| "尚未打开工作空间".to_string())?;
            let tx = ws
                .conn
                .transaction()
                .map_err(|e| format!("开启合并列事务失败: {e}"))?;

            let mut target_cfg: serde_json::Value =
                serde_json::from_str(&target_col.config_json).unwrap_or_else(|_| serde_json::json!({}));
            let mut target_opts = parse_options_from_config(&target_col.config_json);
            let mut seen_opt_names: HashSet<String> = target_opts
                .iter()
                .map(|o| o.name.trim().to_lowercase())
                .collect();

            for src_ck in &filtered_sources {
                let src_cfg: Option<String> = tx
                    .query_row(
                        "SELECT config_json FROM workspace_columns WHERE canonical_key = ?1",
                        params![src_ck],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(|e| format!("读取源列配置失败: {e}"))?;
                if let Some(cfg_str) = src_cfg {
                    for opt in parse_options_from_config(&cfg_str) {
                        if seen_opt_names.insert(opt.name.trim().to_lowercase()) {
                            target_opts.push(opt);
                        }
                    }
                }
                tx.execute(
                    "UPDATE OR IGNORE cell_values SET canonical_key = ?1 WHERE canonical_key = ?2",
                    params![&target_col.canonical_key, src_ck],
                )
                .map_err(|e| format!("合并 cell_values 失败: {e}"))?;
                tx.execute(
                    "DELETE FROM cell_values WHERE canonical_key = ?1",
                    params![src_ck],
                )
                .map_err(|e| format!("清理源 cell_values 失败: {e}"))?;
                tx.execute(
                    "UPDATE OR IGNORE cell_multi_options SET canonical_key = ?1 WHERE canonical_key = ?2",
                    params![&target_col.canonical_key, src_ck],
                )
                .map_err(|e| format!("合并 cell_multi_options 失败: {e}"))?;
                tx.execute(
                    "DELETE FROM cell_multi_options WHERE canonical_key = ?1",
                    params![src_ck],
                )
                .map_err(|e| format!("清理源 cell_multi_options 失败: {e}"))?;
                tx.execute(
                    "UPDATE OR IGNORE formula_cache SET canonical_key = ?1 WHERE canonical_key = ?2",
                    params![&target_col.canonical_key, src_ck],
                )
                .map_err(|e| format!("合并 formula_cache 失败: {e}"))?;
                tx.execute(
                    "DELETE FROM formula_cache WHERE canonical_key = ?1",
                    params![src_ck],
                )
                .map_err(|e| format!("清理源 formula_cache 失败: {e}"))?;
                tx.execute(
                    "DELETE FROM workspace_columns WHERE canonical_key = ?1",
                    params![src_ck],
                )
                .map_err(|e| format!("删除已合并源列失败: {e}"))?;
            }

            if target_col.r#type == "select" || target_col.r#type == "multi_select" {
                if let Some(obj) = target_cfg.as_object_mut() {
                    obj.insert(
                        "options".to_string(),
                        serde_json::to_value(&target_opts).unwrap(),
                    );
                }
                tx.execute(
                    "UPDATE workspace_columns SET config_json = ?1 WHERE canonical_key = ?2",
                    params![target_cfg.to_string(), &target_col.canonical_key],
                )
                .map_err(|e| format!("更新合并目标列选项失败: {e}"))?;
            }
            tx.commit()
                .map_err(|e| format!("提交合并列事务失败: {e}"))?;
        }

        let prop_changes = self.propagate_canonical_key_remap(
            &all_paths,
            &filtered_sources,
            &target_col.canonical_key,
            &target_col.name,
            origin_window,
        )?;
        changesets.extend(prop_changes);

        let refreshed = self
            .list_columns()?
            .into_iter()
            .find(|c| c.canonical_key == target_col.canonical_key)
            .unwrap_or(target_col);
        Ok((refreshed, changesets))
    }

    fn propagate_canonical_key_remap(
        &self,
        doc_paths: &[PathBuf],
        source_keys: &[String],
        target_ck: &str,
        target_name: &str,
        origin_window: &str,
    ) -> Result<Vec<DocChangeSet>, String> {
        let source_set: HashSet<&str> = source_keys.iter().map(|s| s.as_str()).collect();
        let mut out_changesets = Vec::new();
        for path in doc_paths {
            if !path.exists() {
                continue;
            }
            // 快速只读检查该文件是否含目标 source_keys，避免打开无关文件
            let has_match = {
                let Ok(ro) = open_readonly(path) else {
                    continue;
                };
                let Ok(mut stmt) = ro.prepare("SELECT canonical_key FROM table_columns") else {
                    continue;
                };
                let matched = stmt
                    .query_map([], |r| r.get::<_, String>(0))
                    .ok()
                    .map(|rows| rows.flatten().any(|ck| source_set.contains(ck.as_str())))
                    .unwrap_or(false);
                matched
            };
            if !has_match {
                continue;
            }

            let actor = self.pool.open_for_background(path)?;
            let cs = {
                let mut guard = actor
                    .lock()
                    .map_err(|_| "DocumentActor 锁中毒".to_string())?;
                let cols: Vec<V3TableColumnRecord> = {
                    let mut stmt = guard
                        .conn
                        .prepare("SELECT id, canonical_key, name, type, position, config_json FROM table_columns ORDER BY position ASC, rowid ASC")
                        .map_err(|e| format!("读取文档列失败: {e}"))?;
                    let rows = stmt
                        .query_map([], |r| {
                            Ok(V3TableColumnRecord {
                                id: r.get(0)?,
                                canonical_key: r.get(1)?,
                                name: r.get(2)?,
                                r#type: r.get(3)?,
                                position: r.get(4)?,
                                config_json: r.get(5)?,
                            })
                        })
                        .map_err(|e| format!("遍历文档列失败: {e}"))?;
                    rows.collect::<Result<Vec<_>, _>>()
                        .map_err(|e| format!("解析文档列失败: {e}"))?
                };
                let mut cmds: Vec<DocCommand> = Vec::new();
                for mut col in cols {
                    if source_set.contains(col.canonical_key.as_str()) {
                        col.canonical_key = target_ck.to_string();
                        col.name = target_name.to_string();
                        let mut cfg: serde_json::Value = serde_json::from_str(&col.config_json)
                            .unwrap_or_else(|_| serde_json::json!({}));
                        if let Some(obj) = cfg.as_object_mut() {
                            obj.insert(
                                "canonicalKey".to_string(),
                                serde_json::Value::String(target_ck.to_string()),
                            );
                        }
                        col.config_json = cfg.to_string();
                        cmds.push(DocCommand::UpsertColumn { column: col });
                    }
                }
                if cmds.is_empty() {
                    continue;
                }
                let changeset =
                    guard.apply_commands(&cmds, "ws_promote_or_merge_column", false, None, None, origin_window)?;
                // 顺便同步更新 cell_values.canonical_key 字段
                for src_ck in source_keys {
                    let _ = guard.conn.execute(
                        "UPDATE cell_values SET canonical_key = ?1 WHERE canonical_key = ?2",
                        params![target_ck, src_ck],
                    );
                    let _ = guard.conn.execute(
                        "UPDATE formula_cache SET canonical_key = ?1 WHERE canonical_key = ?2",
                        params![target_ck, src_ck],
                    );
                }
                self.sync_from_actor(&guard)?;
                changeset
            };
            out_changesets.push(cs);
        }
        Ok(out_changesets)
    }

    pub fn list_views(&self) -> Result<Vec<WorkspaceViewRecord>, String> {
        self.with_index_conn(|conn, _root| {
            let mut stmt = conn
                .prepare(
                    "SELECT id, name, type, position, scope_json, config_json
                     FROM workspace_views ORDER BY position ASC, rowid ASC",
                )
                .map_err(|e| format!("查询 workspace_views 失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    let id: String = r.get(0)?;
                    let scope_json: String = r.get(4)?;
                    let config_json: String = r.get(5)?;
                    let scope: WorkspaceScope =
                        serde_json::from_str(&scope_json).unwrap_or_default();
                    let deletable = serde_json::from_str::<serde_json::Value>(&config_json)
                        .ok()
                        .and_then(|v| v.get("deletable").and_then(|b| b.as_bool()))
                        .unwrap_or(id != "default-ws-table-view");
                    Ok(WorkspaceViewRecord {
                        id,
                        name: r.get(1)?,
                        r#type: r.get(2)?,
                        deletable,
                        position: r.get(3)?,
                        scope,
                        config_json,
                    })
                })
                .map_err(|e| format!("遍历 workspace_views 失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析 workspace_views 失败: {e}"))
        })
    }

    pub fn upsert_view(&self, view: &WorkspaceViewRecord) -> Result<(), String> {
        let scope_json = serde_json::to_string(&view.scope)
            .map_err(|e| format!("序列化视图 scope 失败: {e}"))?;
        let mut cfg_val: serde_json::Value =
            serde_json::from_str(&view.config_json).unwrap_or_else(|_| serde_json::json!({}));
        if let Some(obj) = cfg_val.as_object_mut() {
            obj.insert("deletable".to_string(), serde_json::Value::Bool(view.deletable));
        }
        let guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let ws = guard
            .as_ref()
            .ok_or_else(|| "尚未打开工作空间".to_string())?;
        ws.conn
            .execute(
                "INSERT INTO workspace_views (id, name, type, position, scope_json, config_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                   name = excluded.name,
                   type = excluded.type,
                   position = excluded.position,
                   scope_json = excluded.scope_json,
                   config_json = excluded.config_json",
                params![
                    &view.id,
                    &view.name,
                    &view.r#type,
                    view.position,
                    scope_json,
                    cfg_val.to_string(),
                ],
            )
            .map_err(|e| format!("保存工作空间视图失败: {e}"))?;
        Ok(())
    }

    pub fn delete_view(&self, view_id: &str) -> Result<(), String> {
        let guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let ws = guard
            .as_ref()
            .ok_or_else(|| "尚未打开工作空间".to_string())?;
        ws.conn
            .execute("DELETE FROM workspace_views WHERE id = ?1", params![view_id])
            .map_err(|e| format!("删除工作空间视图失败: {e}"))?;
        Ok(())
    }

    pub fn reorder_views(&self, ordered_ids: &[String]) -> Result<(), String> {
        let mut guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let ws = guard
            .as_mut()
            .ok_or_else(|| "尚未打开工作空间".to_string())?;
        let tx = ws
            .conn
            .transaction()
            .map_err(|e| format!("开启视图排序事务失败: {e}"))?;
        for (idx, id) in ordered_ids.iter().enumerate() {
            tx.execute(
                "UPDATE workspace_views SET position = ?1 WHERE id = ?2",
                params![idx as i64, id],
            )
            .map_err(|e| format!("更新视图顺序失败: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("提交视图排序事务失败: {e}"))?;
        Ok(())
    }

    pub fn get_table_meta(&self) -> Result<String, String> {
        self.with_index_conn(|conn, _root| {
            let val: Option<String> = conn
                .query_row(
                    "SELECT value FROM workspace_meta WHERE key = 'table_meta_json'",
                    [],
                    |r| r.get(0),
                )
                .optional()
                .map_err(|e| format!("查询工作空间表元数据失败: {e}"))?;
            Ok(val.unwrap_or_else(|| "{}".to_string()))
        })
    }

    pub fn update_table_meta(&self, meta_json: &str) -> Result<(), String> {
        let guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let ws = guard
            .as_ref()
            .ok_or_else(|| "尚未打开工作空间".to_string())?;
        ws.conn
            .execute(
                "INSERT INTO workspace_meta (key, value) VALUES ('table_meta_json', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![meta_json],
            )
            .map_err(|e| format!("保存工作空间表元数据失败: {e}"))?;
        Ok(())
    }

    // ========================================================================
    // 跨文件直接写回路由（按 docId 经 DocumentActorPool 原子写回源 .prg）
    // ========================================================================

    fn get_actor_for_doc_id(&self, doc_id: &str) -> Result<Arc<Mutex<DocumentActor>>, String> {
        if let Some(actor) = self.pool.get_by_doc_id(doc_id)? {
            return Ok(actor);
        }
        let Some(path) = self.resolve_doc_path(doc_id)? else {
            return Err(format!("工作空间索引中未找到文档 docId={doc_id}"));
        };
        if !path.exists() {
            return Err(format!("目标文档不存在: {}", path.display()));
        }
        self.pool.open_for_background(&path)
    }

    /// 跨文件修改行标题（`name` 列）。
    pub fn update_row_text(
        &self,
        doc_id: &str,
        row_uuid: &str,
        text: &str,
        origin_window: &str,
    ) -> Result<DocChangeSet, String> {
        let actor = self.get_actor_for_doc_id(doc_id)?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;

        // 捕获旧 Section 名称以便联动更新 cross_doc_refs
        let old_section_name: Option<String> = guard
            .conn
            .query_row(
                "SELECT text FROM entities WHERE uuid = ?1 AND kind = 'section'",
                params![row_uuid],
                |r| r.get(0),
            )
            .optional()
            .unwrap_or(None);

        let changeset = guard.apply_commands(
            &[DocCommand::UpdateEntityText {
                uuid: row_uuid.to_string(),
                text: text.to_string(),
                x: None,
                y: None,
                w: None,
                h: None,
                props_patch: None,
                section_bounds: Vec::new(),
            }],
            "ws_update_row_text",
            true,
            None,
            None,
            origin_window,
        )?;
        self.sync_from_actor(&guard)?;
        drop(guard);

        if let Some(old_name) = old_section_name {
            if !old_name.is_empty() && old_name != text {
                let _ = self.repair_section_rename_references(doc_id, &old_name, text, origin_window);
            }
        }
        Ok(changeset)
    }

    /// 跨文件修改自定义单元格值（支持按 `canonical_key` 自动匹配/按需创建目标 `.prg` 的列与选项）。
    pub fn update_row_cells(
        &self,
        doc_id: &str,
        row_uuid: &str,
        updates: &[WorkspaceCellWriteInput],
        touch_updated_at: bool,
        today_key_opt: Option<&str>,
        origin_window: &str,
    ) -> Result<DocChangeSet, String> {
        // 读取工作空间列元信息（用于自动在目标 .prg 中创建列及解析 ws optionId -> optionName）
        let ws_cols: HashMap<String, WorkspaceColumnRecord> = self
            .list_columns()?
            .into_iter()
            .map(|c| (c.canonical_key.clone(), c))
            .collect();

        let actor = self.get_actor_for_doc_id(doc_id)?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;

        // 加载目标文档已有列
        let mut doc_cols: Vec<V3TableColumnRecord> = {
            let mut stmt = guard
                .conn
                .prepare("SELECT id, canonical_key, name, type, position, config_json FROM table_columns ORDER BY position ASC, rowid ASC")
                .map_err(|e| format!("读取目标文档列失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok(V3TableColumnRecord {
                        id: r.get(0)?,
                        canonical_key: r.get(1)?,
                        name: r.get(2)?,
                        r#type: r.get(3)?,
                        position: r.get(4)?,
                        config_json: r.get(5)?,
                    })
                })
                .map_err(|e| format!("遍历目标文档列失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析目标文档列失败: {e}"))?
        };

        let mut schema_cmds: Vec<DocCommand> = Vec::new();
        let mut cell_mutations: Vec<CellMutationItem> = Vec::new();
        let mut touched_sr_input = false;

        for item in updates {
            let ws_col = ws_cols.get(&item.canonical_key);
            // 查找目标文档中对应 canonical_key 的列；若不存在且正在写入非空值则自动创建
            let existing_idx = doc_cols
                .iter()
                .position(|c| c.canonical_key == item.canonical_key);

            let col_idx = match existing_idx {
                Some(idx) => idx,
                None => {
                    if item.value.is_none() {
                        continue;
                    }
                    let Some(wcol) = ws_col else {
                        continue;
                    };
                    if wcol.r#type == "formula" {
                        continue;
                    }
                    let new_col_id = format!("col_{}", uuid::Uuid::new_v4());
                    let mut cfg: serde_json::Value = serde_json::from_str(&wcol.config_json)
                        .unwrap_or_else(|_| serde_json::json!({}));
                    if let Some(obj) = cfg.as_object_mut() {
                        if wcol.canonical_key.starts_with("ws:") {
                            obj.insert(
                                "canonicalKey".to_string(),
                                serde_json::Value::String(wcol.canonical_key.clone()),
                            );
                        }
                    }
                    let rec = V3TableColumnRecord {
                        id: new_col_id,
                        canonical_key: wcol.canonical_key.clone(),
                        name: wcol.name.clone(),
                        r#type: wcol.r#type.clone(),
                        position: doc_cols.len() as i64,
                        config_json: cfg.to_string(),
                    };
                    schema_cmds.push(DocCommand::UpsertColumn {
                        column: rec.clone(),
                    });
                    doc_cols.push(rec);
                    doc_cols.len() - 1
                }
            };

            let target_col = &mut doc_cols[col_idx];
            if target_col.r#type == "formula" {
                continue;
            }
            if matches!(
                target_col.canonical_key.as_str(),
                "role:sr:correctCount" | "role:sr:delay" | "role:sr:answerDate" | "role:sr:archiveStatus"
            ) {
                touched_sr_input = true;
            }

            let ws_opts_by_id: HashMap<String, WorkspaceColumnOption> = ws_col
                .map(|wc| {
                    parse_options_from_config(&wc.config_json)
                        .into_iter()
                        .map(|o| (o.id.clone(), o))
                        .collect()
                })
                .unwrap_or_default();

            let cell_val = match &item.value {
                None | Some(serde_json::Value::Null) => None,
                Some(raw_val) => match target_col.r#type.as_str() {
                    "number" => {
                        let num = raw_val
                            .as_f64()
                            .or_else(|| raw_val.as_str().and_then(|s| s.trim().parse::<f64>().ok()));
                        num.filter(|n| n.is_finite()).map(|n| V3CellValueRecord {
                            entity_uuid: row_uuid.to_string(),
                            col_id: target_col.id.clone(),
                            canonical_key: target_col.canonical_key.clone(),
                            val_type: "number".to_string(),
                            val_text: Some(format_js_number(n)),
                            val_num: Some(n),
                            val_date: None,
                            val_json: None,
                            multi_options: Vec::new(),
                        })
                    }
                    "date" => {
                        let s = raw_val.as_str().unwrap_or("").trim();
                        if s.is_empty() {
                            None
                        } else {
                            Some(V3CellValueRecord {
                                entity_uuid: row_uuid.to_string(),
                                col_id: target_col.id.clone(),
                                canonical_key: target_col.canonical_key.clone(),
                                val_type: "date".to_string(),
                                val_text: Some(s.to_string()),
                                val_num: None,
                                val_date: Some(s.to_string()),
                                val_json: None,
                                multi_options: Vec::new(),
                            })
                        }
                    }
                    "select" => {
                        let raw_str = raw_val.as_str().unwrap_or("").trim();
                        if raw_str.is_empty() {
                            None
                        } else {
                            let (opt_name, opt_color) = ws_opts_by_id
                                .get(raw_str)
                                .map(|o| (o.name.clone(), Some(o.color.clone())))
                                .unwrap_or_else(|| (raw_str.to_string(), None));
                            let local_opt_id = ensure_local_option_in_column(
                                target_col,
                                &opt_name,
                                opt_color.as_deref(),
                                &mut schema_cmds,
                            );
                            Some(V3CellValueRecord {
                                entity_uuid: row_uuid.to_string(),
                                col_id: target_col.id.clone(),
                                canonical_key: target_col.canonical_key.clone(),
                                val_type: "select".to_string(),
                                val_text: Some(local_opt_id),
                                val_num: None,
                                val_date: None,
                                val_json: None,
                                multi_options: Vec::new(),
                            })
                        }
                    }
                    "multi_select" => {
                        let raw_arr: Vec<String> = raw_val
                            .as_array()
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.trim().to_string()))
                                    .filter(|s| !s.is_empty())
                                    .collect()
                            })
                            .unwrap_or_default();
                        if raw_arr.is_empty() {
                            None
                        } else {
                            let mut local_ids = Vec::new();
                            let mut multi_entries = Vec::new();
                            let mut seen = HashSet::new();
                            for item_key in raw_arr {
                                let (opt_name, opt_color) = ws_opts_by_id
                                    .get(&item_key)
                                    .map(|o| (o.name.clone(), Some(o.color.clone())))
                                    .unwrap_or_else(|| (item_key.clone(), None));
                                let local_id = ensure_local_option_in_column(
                                    target_col,
                                    &opt_name,
                                    opt_color.as_deref(),
                                    &mut schema_cmds,
                                );
                                if seen.insert(local_id.clone()) {
                                    local_ids.push(local_id.clone());
                                    multi_entries.push(V3MultiOptionEntry {
                                        option_id: local_id,
                                        option_name: opt_name,
                                    });
                                }
                            }
                            let joined = multi_entries
                                .iter()
                                .map(|m| m.option_name.as_str())
                                .collect::<Vec<_>>()
                                .join(",");
                            Some(V3CellValueRecord {
                                entity_uuid: row_uuid.to_string(),
                                col_id: target_col.id.clone(),
                                canonical_key: target_col.canonical_key.clone(),
                                val_type: "multi_select".to_string(),
                                val_text: Some(joined),
                                val_num: None,
                                val_date: None,
                                val_json: serde_json::to_string(&local_ids).ok(),
                                multi_options: multi_entries,
                            })
                        }
                    }
                    _ => {
                        let s = raw_val
                            .as_str()
                            .map(|v| v.to_string())
                            .unwrap_or_else(|| raw_val.to_string());
                        if s.is_empty() {
                            None
                        } else {
                            Some(V3CellValueRecord {
                                entity_uuid: row_uuid.to_string(),
                                col_id: target_col.id.clone(),
                                canonical_key: target_col.canonical_key.clone(),
                                val_type: "text".to_string(),
                                val_text: Some(s),
                                val_num: None,
                                val_date: None,
                                val_json: None,
                                multi_options: Vec::new(),
                            })
                        }
                    }
                },
            };

            cell_mutations.push(CellMutationItem {
                entity_uuid: row_uuid.to_string(),
                col_id: target_col.id.clone(),
                value: cell_val,
            });
        }

        let mut all_cmds = schema_cmds;
        if !cell_mutations.is_empty() {
            all_cmds.push(DocCommand::UpdateCells {
                updates: cell_mutations,
                touch_updated_at,
            });
        }

        let changeset = guard.apply_commands(
            &all_cmds,
            "ws_update_row_cells",
            true,
            None,
            None,
            origin_window,
        )?;

        if touched_sr_input {
            let today_key = resolve_today_key(&guard.conn, today_key_opt);
            refresh_row_sr_formula_cache_in_actor(&mut guard, row_uuid, &today_key, origin_window)?;
        }

        self.sync_from_actor(&guard)?;
        Ok(changeset)
    }

    /// 跨文件间隔重复刷卡作答（自动按需补齐源 `.prg` 的 11 个 SR 列、更新单元格且不刷新 `updated_at`、刷新 SR 公式缓存并同步 `index.sqlite`）。
    pub fn answer_spaced_repetition(
        &self,
        doc_id: &str,
        row_uuid: &str,
        choice: &str,
        today_key_opt: Option<&str>,
        baseline: Option<&SpacedRepetitionSnapshotDto>,
        origin_window: &str,
    ) -> Result<WorkspaceAnswerSrResult, String> {
        let actor = self.get_actor_for_doc_id(doc_id)?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;

        let (role_ids, schema_cmds) = ensure_doc_sr_columns_cmds(&guard.conn)?;
        let today_key = resolve_today_key(&guard.conn, today_key_opt);

        let snapshot = if let Some(b) = baseline {
            b.clone()
        } else {
            read_row_sr_snapshot(&guard.conn, row_uuid, &role_ids)?
        };

        let prev_correct = snapshot.correct_count.filter(|n| n.is_finite()).unwrap_or(0.0);
        let prev_delay = snapshot.delay.filter(|n| n.is_finite()).unwrap_or(0.0);
        let next_mastery: f64 = match choice {
            "correct_closed" => 1.0,
            "correct_open" => 2.0,
            _ => 3.0,
        };
        let next_correct = if choice == "wrong" {
            (prev_correct - 1.0).max(0.0)
        } else {
            prev_correct + 1.0
        };
        let next_delay = if choice == "wrong" {
            prev_delay + 1.0
        } else {
            0.0
        };

        let has_schema_cmds = !schema_cmds.is_empty();
        let archive_name = role_ids.get("archiveStatus").and_then(|cid| {
            let opt_id = guard
                .conn
                .query_row(
                    "SELECT val_text FROM cell_values WHERE entity_uuid = ?1 AND col_id = ?2",
                    params![row_uuid, cid],
                    |r| r.get::<_, Option<String>>(0),
                )
                .ok()
                .flatten()?;
            let cfg_json: String = guard
                .conn
                .query_row(
                    "SELECT config_json FROM table_columns WHERE id = ?1",
                    params![cid],
                    |r| r.get(0),
                )
                .unwrap_or_default();
            let resolved = parse_options_from_config(&cfg_json)
                .into_iter()
                .find(|o| o.id == opt_id)
                .map(|o| o.name)
                .unwrap_or(opt_id);
            Some(resolved)
        });

        let eval = evaluate_sr_formulas(
            Some(next_correct),
            Some(next_delay),
            Some(today_key.as_str()),
            archive_name.as_deref(),
            &today_key,
        );

        let sr_cell_records = vec![
            V3CellValueRecord {
                entity_uuid: row_uuid.to_string(),
                col_id: role_ids["mastery"].clone(),
                canonical_key: "role:sr:mastery".to_string(),
                val_type: "number".to_string(),
                val_text: Some(format_js_number(next_mastery)),
                val_num: Some(next_mastery),
                val_date: None,
                val_json: None,
                multi_options: Vec::new(),
            },
            V3CellValueRecord {
                entity_uuid: row_uuid.to_string(),
                col_id: role_ids["correctCount"].clone(),
                canonical_key: "role:sr:correctCount".to_string(),
                val_type: "number".to_string(),
                val_text: Some(format_js_number(next_correct)),
                val_num: Some(next_correct),
                val_date: None,
                val_json: None,
                multi_options: Vec::new(),
            },
            V3CellValueRecord {
                entity_uuid: row_uuid.to_string(),
                col_id: role_ids["delay"].clone(),
                canonical_key: "role:sr:delay".to_string(),
                val_type: "number".to_string(),
                val_text: Some(format_js_number(next_delay)),
                val_num: Some(next_delay),
                val_date: None,
                val_json: None,
                multi_options: Vec::new(),
            },
            V3CellValueRecord {
                entity_uuid: row_uuid.to_string(),
                col_id: role_ids["answerDate"].clone(),
                canonical_key: "role:sr:answerDate".to_string(),
                val_type: "date".to_string(),
                val_text: Some(today_key.clone()),
                val_num: None,
                val_date: Some(today_key.clone()),
                val_json: None,
                multi_options: Vec::new(),
            },
        ];

        let mut formula_entries = Vec::with_capacity(3);
        if let Some(cid) = role_ids.get("nextInterval") {
            formula_entries.push(FormulaCacheEntry {
                entity_uuid: row_uuid.to_string(),
                col_id: cid.clone(),
                canonical_key: "role:sr:nextInterval".to_string(),
                kind: "number".to_string(),
                display_text: format_js_number(eval.next_interval.round()),
                val_num: Some(eval.next_interval),
                val_date_ms: None,
                val_json: None,
                is_volatile: false,
                computed_day: Some(today_key.clone()),
            });
        }
        if let Some(cid) = role_ids.get("nextDueDate") {
            let (kind, disp, ms) = match (&eval.next_due_date, eval.next_due_date_ms) {
                (Some(d), Some(m)) => ("date", d.clone(), Some(m)),
                _ => ("empty", String::new(), None),
            };
            formula_entries.push(FormulaCacheEntry {
                entity_uuid: row_uuid.to_string(),
                col_id: cid.clone(),
                canonical_key: "role:sr:nextDueDate".to_string(),
                kind: kind.to_string(),
                display_text: disp,
                val_num: None,
                val_date_ms: ms,
                val_json: None,
                is_volatile: false,
                computed_day: Some(today_key.clone()),
            });
        }
        if let Some(cid) = role_ids.get("dueStatus") {
            formula_entries.push(FormulaCacheEntry {
                entity_uuid: row_uuid.to_string(),
                col_id: cid.clone(),
                canonical_key: "role:sr:dueStatus".to_string(),
                kind: "string".to_string(),
                display_text: eval.due_status.to_string(),
                val_num: None,
                val_date_ms: None,
                val_json: None,
                is_volatile: true,
                computed_day: Some(today_key.clone()),
            });
        }

        let mut cmds = schema_cmds;
        cmds.push(DocCommand::UpdateCells {
            updates: sr_cell_records
                .iter()
                .map(|rec| CellMutationItem {
                    entity_uuid: rec.entity_uuid.clone(),
                    col_id: rec.col_id.clone(),
                    value: Some(rec.clone()),
                })
                .collect(),
            touch_updated_at: false,
        });
        if !formula_entries.is_empty() {
            cmds.push(DocCommand::UpdateFormulaCacheBatch {
                entries: formula_entries.clone(),
            });
        }

        let changeset = guard.apply_commands(
            &cmds,
            "ws_spaced_repetition_answer",
            true,
            None,
            None,
            origin_window,
        )?;
        if has_schema_cmds {
            self.sync_from_actor(&guard)?;
        } else {
            self.sync_row_sr_fast(&guard, &sr_cell_records, &formula_entries)?;
        }
        Ok(WorkspaceAnswerSrResult {
            changeset,
            snapshot,
        })
    }

    /// 单行 O(1) 同步间隔重复 4 个单元格与 3 个公式缓存到 `index.sqlite`（免整文件重建，`< 1 ms`）。
    fn sync_row_sr_fast(
        &self,
        actor: &DocumentActor,
        cells: &[V3CellValueRecord],
        formulas: &[FormulaCacheEntry],
    ) -> Result<(), String> {
        let mut guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let Some(ws) = guard.as_mut() else {
            return Ok(());
        };
        let (mtime_ms, file_size) = fs::metadata(&actor.path)
            .map(|m| file_mtime_and_size(&m))
            .unwrap_or_else(|_| (current_unix_ms(), 0));
        let tx = ws
            .conn
            .transaction()
            .map_err(|e| format!("开启单行 SR 增量索引事务失败: {e}"))?;
        tx.execute(
            "UPDATE docs SET mtime_ms = ?1, file_size = ?2, revision = ?3 WHERE doc_id = ?4",
            params![mtime_ms, file_size, actor.revision, &actor.doc_id],
        )
        .map_err(|e| format!("更新 docs 元数据失败: {e}"))?;
        {
            let mut cell_stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO cell_values
                     (doc_id, entity_uuid, canonical_key, val_type, val_text, val_num, val_date, val_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                )
                .map_err(|e| format!("准备单行 SR 单元格更新失败: {e}"))?;
            for c in cells {
                cell_stmt
                    .execute(params![
                        &actor.doc_id,
                        &c.entity_uuid,
                        &c.canonical_key,
                        &c.val_type,
                        &c.val_text,
                        c.val_num,
                        &c.val_date,
                        &c.val_json,
                    ])
                    .map_err(|e| format!("写入单行 SR 单元格失败: {e}"))?;
            }
        }
        {
            let mut fc_stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO formula_cache
                     (doc_id, entity_uuid, canonical_key, kind, display_text, val_num, val_date_ms, val_json, is_volatile, computed_day)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )
                .map_err(|e| format!("准备单行 SR 公式缓存更新失败: {e}"))?;
            for f in formulas {
                fc_stmt
                    .execute(params![
                        &actor.doc_id,
                        &f.entity_uuid,
                        &f.canonical_key,
                        &f.kind,
                        &f.display_text,
                        f.val_num,
                        f.val_date_ms,
                        &f.val_json,
                        if f.is_volatile { 1i64 } else { 0i64 },
                        &f.computed_day,
                    ])
                    .map_err(|e| format!("写入单行 SR 公式缓存失败: {e}"))?;
                if f.canonical_key == "role:sr:dueStatus" {
                    let eff = if f.display_text.trim().is_empty() {
                        "待复习"
                    } else {
                        f.display_text.trim()
                    };
                    tx.execute(
                        "UPDATE entities SET sr_due_status = ?1 WHERE doc_id = ?2 AND uuid = ?3",
                        params![eff, &actor.doc_id, &f.entity_uuid],
                    )
                    .map_err(|e| format!("更新单行 SR sr_due_status 失败: {e}"))?;
                }
            }
        }
        tx.commit()
            .map_err(|e| format!("提交单行 SR 增量索引事务失败: {e}"))?;
        Ok(())
    }

    /// 跨文件间隔重复撤销恢复单卡快照。
    pub fn restore_spaced_repetition(
        &self,
        doc_id: &str,
        row_uuid: &str,
        snapshot: &SpacedRepetitionSnapshotDto,
        today_key_opt: Option<&str>,
        origin_window: &str,
    ) -> Result<DocChangeSet, String> {
        let actor = self.get_actor_for_doc_id(doc_id)?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        let (role_ids, schema_cmds) = ensure_doc_sr_columns_cmds(&guard.conn)?;
        let today_key = resolve_today_key(&guard.conn, today_key_opt);

        let num_cell = |role: &str, v: Option<f64>| CellMutationItem {
            entity_uuid: row_uuid.to_string(),
            col_id: role_ids[role].clone(),
            value: v.filter(|n| n.is_finite()).map(|n| V3CellValueRecord {
                entity_uuid: row_uuid.to_string(),
                col_id: role_ids[role].clone(),
                canonical_key: format!("role:sr:{role}"),
                val_type: "number".to_string(),
                val_text: Some(format_js_number(n)),
                val_num: Some(n),
                val_date: None,
                val_json: None,
                multi_options: Vec::new(),
            }),
        };
        let date_cell = CellMutationItem {
            entity_uuid: row_uuid.to_string(),
            col_id: role_ids["answerDate"].clone(),
            value: snapshot
                .answer_date
                .as_deref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|s| V3CellValueRecord {
                    entity_uuid: row_uuid.to_string(),
                    col_id: role_ids["answerDate"].clone(),
                    canonical_key: "role:sr:answerDate".to_string(),
                    val_type: "date".to_string(),
                    val_text: Some(s.to_string()),
                    val_num: None,
                    val_date: Some(s.to_string()),
                    val_json: None,
                    multi_options: Vec::new(),
                }),
        };

        let mut cmds = schema_cmds;
        cmds.push(DocCommand::UpdateCells {
            updates: vec![
                num_cell("mastery", snapshot.mastery),
                num_cell("correctCount", snapshot.correct_count),
                num_cell("delay", snapshot.delay),
                date_cell,
            ],
            touch_updated_at: false,
        });

        let changeset = guard.apply_commands(
            &cmds,
            "ws_spaced_repetition_restore",
            true,
            None,
            None,
            origin_window,
        )?;
        refresh_row_sr_formula_cache_in_actor(&mut guard, row_uuid, &today_key, origin_window)?;
        self.sync_from_actor(&guard)?;
        Ok(changeset)
    }

    /// 跨文件给指定行添加图片（自动写入附件 + WebP 缩略图，若为 TextNode 原地无损升级为 Section）。
    pub fn add_row_image(
        &self,
        doc_id: &str,
        row_uuid: &str,
        attachment_id: &str,
        mime: &str,
        bytes: &[u8],
        origin_window: &str,
    ) -> Result<DocChangeSet, String> {
        let actor = self.get_actor_for_doc_id(doc_id)?;
        let (width, height, thumb) = inspect_and_make_thumbnail(mime, bytes);
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;
        guard.put_attachment(attachment_id, mime, width, height, thumb.as_deref(), bytes)?;

        let row_ent: V3EntityRecord = guard
            .conn
            .query_row(
                "SELECT uuid, kind, parent_section_uuid, text, details_json, details_plain,
                        x, y, w, h, props_json, created_at, updated_at, is_row, sort_order
                 FROM entities WHERE uuid = ?1",
                params![row_uuid],
                |r| {
                    Ok(V3EntityRecord {
                        uuid: r.get(0)?,
                        kind: r.get(1)?,
                        parent_section_uuid: r.get(2)?,
                        text: r.get(3)?,
                        details_json: r.get(4)?,
                        details_plain: r.get(5)?,
                        x: r.get(6)?,
                        y: r.get(7)?,
                        w: r.get(8)?,
                        h: r.get(9)?,
                        props_json: r.get(10)?,
                        created_at: r.get(11)?,
                        updated_at: r.get(12)?,
                        is_row: r.get::<_, i64>(13)? != 0,
                        sort_order: r.get(14)?,
                    })
                },
            )
            .map_err(|e| format!("未找到目标实体 {row_uuid}: {e}"))?;

        if row_ent.kind != "text" && row_ent.kind != "section" {
            return Err("当前实体类型不支持内嵌图片".to_string());
        }

        let img_w = width.unwrap_or(240).min(360) as f64;
        let img_h = height.unwrap_or(180).min(280) as f64;
        let now_ms = current_unix_ms();
        let img_uuid = uuid::Uuid::new_v4().to_string();
        let next_sort: i64 = guard
            .conn
            .query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM entities", [], |r| r.get(0))
            .unwrap_or(1);

        let mut cmds: Vec<DocCommand> = Vec::new();
        if row_ent.kind == "text" {
            cmds.push(DocCommand::PromoteTextToSection {
                uuid: row_uuid.to_string(),
                props_json: serde_json::json!({
                    "color": [0, 0, 0, 0],
                    "isCollapsed": false,
                    "isHidden": false,
                    "locked": false,
                    "childOrder": [&img_uuid]
                })
                .to_string(),
                x: Some(row_ent.x),
                y: Some(row_ent.y),
                w: Some(row_ent.w.max(img_w + 60.0)),
                h: Some(row_ent.h.max(img_h + 80.0)),
                touch_updated_at: true,
            });
        }

        let img_entity = V3EntityRecord {
            uuid: img_uuid,
            kind: "image".to_string(),
            parent_section_uuid: Some(row_uuid.to_string()),
            text: String::new(),
            details_json: "[]".to_string(),
            details_plain: String::new(),
            x: row_ent.x + 24.0,
            y: row_ent.y + 44.0,
            w: img_w,
            h: img_h,
            props_json: serde_json::json!({
                "attachmentId": attachment_id,
                "scale": 1.0,
                "isBackground": false
            })
            .to_string(),
            created_at: now_ms,
            updated_at: now_ms,
            is_row: false,
            sort_order: next_sort,
        };

        cmds.push(DocCommand::AddEntityImage {
            image_entity: img_entity,
            parent_section_uuid: row_uuid.to_string(),
            section_child_order: None,
            section_bounds: Vec::new(),
        });

        let changeset = guard.apply_commands(&cmds, "ws_add_row_image", true, Some(now_ms), None, origin_window)?;
        self.sync_from_actor(&guard)?;
        Ok(changeset)
    }

    /// 跨文件从指定行移除图片（若移除后 Section 无任何子节点，自动无损退化回同 UUID TextNode）。
    pub fn remove_row_image(
        &self,
        doc_id: &str,
        row_uuid: &str,
        image_node_uuid: &str,
        origin_window: &str,
    ) -> Result<DocChangeSet, String> {
        let actor = self.get_actor_for_doc_id(doc_id)?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;

        let remaining_children: i64 = guard
            .conn
            .query_row(
                "SELECT COUNT(*) FROM entities WHERE parent_section_uuid = ?1 AND uuid != ?2",
                params![row_uuid, image_node_uuid],
                |r| r.get(0),
            )
            .unwrap_or(0);
        let is_section: bool = guard
            .conn
            .query_row(
                "SELECT kind = 'section' FROM entities WHERE uuid = ?1",
                params![row_uuid],
                |r| r.get(0),
            )
            .unwrap_or(false);

        let mut cmds = vec![DocCommand::RemoveEntityImage {
            image_uuid: image_node_uuid.to_string(),
            parent_section_uuid: row_uuid.to_string(),
            section_child_order: None,
            section_bounds: Vec::new(),
        }];

        if is_section && remaining_children == 0 {
            cmds.push(DocCommand::DemoteSectionToText {
                uuid: row_uuid.to_string(),
                props_json: serde_json::json!({
                    "color": [0, 0, 0, 0],
                    "fontScaleLevel": 0,
                    "sizeAdjust": "auto"
                })
                .to_string(),
                x: None,
                y: None,
                w: None,
                h: None,
                touch_updated_at: true,
            });
        }

        let changeset = guard.apply_commands(&cmds, "ws_remove_row_image", true, None, None, origin_window)?;
        self.sync_from_actor(&guard)?;
        Ok(changeset)
    }

    /// 跨文件修改某行在其所属 `.prg` 内的 1-hop 拓扑关系（`parents` / `children` / `outer` / `inner`）。
    pub fn set_row_relations(
        &self,
        doc_id: &str,
        row_uuid: &str,
        relation_kind: &str,
        target_uuids: &[String],
        origin_window: &str,
    ) -> Result<DocChangeSet, String> {
        let actor = self.get_actor_for_doc_id(doc_id)?;
        let mut guard = actor
            .lock()
            .map_err(|_| "DocumentActor 锁中毒".to_string())?;

        let target_set: HashSet<String> = target_uuids
            .iter()
            .filter(|u| u.as_str() != row_uuid)
            .cloned()
            .collect();
        let mut cmds: Vec<DocCommand> = Vec::new();

        match relation_kind {
            "parents" | "children" => {
                let is_parents = relation_kind == "parents";
                let sql = if is_parents {
                    "SELECT uuid, source_uuid FROM edges WHERE target_uuid = ?1 AND source_uuid != ?1"
                } else {
                    "SELECT uuid, target_uuid FROM edges WHERE source_uuid = ?1 AND target_uuid != ?1"
                };
                let existing: Vec<(String, String)> = {
                    let mut stmt = guard.conn.prepare(sql).map_err(|e| format!("查询已有连线失败: {e}"))?;
                    let rows = stmt
                        .query_map(params![row_uuid], |r| Ok((r.get(0)?, r.get(1)?)))
                        .map_err(|e| format!("遍历已有连线失败: {e}"))?;
                    rows.collect::<Result<Vec<_>, _>>()
                        .map_err(|e| format!("解析已有连线失败: {e}"))?
                };
                let mut existing_peers = HashSet::new();
                let mut to_delete = Vec::new();
                for (edge_uuid, peer_uuid) in existing {
                    if !target_set.contains(&peer_uuid) {
                        to_delete.push(edge_uuid);
                    } else {
                        existing_peers.insert(peer_uuid);
                    }
                }
                if !to_delete.is_empty() {
                    cmds.push(DocCommand::DeleteEdges { uuids: to_delete });
                }
                let mut next_order: i64 = guard
                    .conn
                    .query_row("SELECT COALESCE(MAX(sort_order), 0) + 1 FROM edges", [], |r| r.get(0))
                    .unwrap_or(1);
                let mut to_create = Vec::new();
                for peer in target_uuids {
                    if peer == row_uuid || existing_peers.contains(peer) {
                        continue;
                    }
                    let (src, dst) = if is_parents {
                        (peer.clone(), row_uuid.to_string())
                    } else {
                        (row_uuid.to_string(), peer.clone())
                    };
                    to_create.push(V3EdgeRecord {
                        uuid: uuid::Uuid::new_v4().to_string(),
                        kind: "line".to_string(),
                        source_uuid: src,
                        target_uuid: dst,
                        text: String::new(),
                        props_json: "{}".to_string(),
                        sort_order: next_order,
                    });
                    next_order += 1;
                }
                if !to_create.is_empty() {
                    cmds.push(DocCommand::CreateEdges { edges: to_create });
                }
            }
            "outer" => {
                let new_outer = target_uuids.first().filter(|u| u.as_str() != row_uuid).cloned();
                if let Some(ref outer_id) = new_outer {
                    let outer_kind: Option<String> = guard
                        .conn
                        .query_row("SELECT kind FROM entities WHERE uuid = ?1", params![outer_id], |r| r.get(0))
                        .optional()
                        .unwrap_or(None);
                    if outer_kind.as_deref() == Some("text") {
                        cmds.push(DocCommand::PromoteTextToSection {
                            uuid: outer_id.clone(),
                            props_json: serde_json::json!({
                                "color": [0, 0, 0, 0],
                                "isCollapsed": false,
                                "isHidden": false,
                                "locked": false
                            })
                            .to_string(),
                            x: None,
                            y: None,
                            w: None,
                            h: None,
                            touch_updated_at: true,
                        });
                    }
                }
                cmds.push(DocCommand::ReparentEntities {
                    items: vec![ReparentItem {
                        uuid: row_uuid.to_string(),
                        parent_section_uuid: new_outer,
                        x: None,
                        y: None,
                        w: None,
                        h: None,
                    }],
                    section_child_orders: Vec::<SectionChildOrderPatch>::new(),
                    section_bounds: Vec::<EntityBoundsItem>::new(),
                });
            }
            "inner" => {
                let cur_inner: Vec<String> = {
                    let mut stmt = guard
                        .conn
                        .prepare("SELECT uuid FROM entities WHERE parent_section_uuid = ?1 AND is_row = 1")
                        .map_err(|e| format!("查询已有内节点失败: {e}"))?;
                    let rows = stmt
                        .query_map(params![row_uuid], |r| r.get::<_, String>(0))
                        .map_err(|e| format!("遍历已有内节点失败: {e}"))?;
                    rows.collect::<Result<Vec<_>, _>>()
                        .map_err(|e| format!("解析已有内节点失败: {e}"))?
                };
                let cur_set: HashSet<String> = cur_inner.iter().cloned().collect();
                let mut reparents = Vec::new();
                for old_child in &cur_inner {
                    if !target_set.contains(old_child) {
                        reparents.push(ReparentItem {
                            uuid: old_child.clone(),
                            parent_section_uuid: None,
                            x: None,
                            y: None,
                            w: None,
                            h: None,
                        });
                    }
                }
                for new_child in target_uuids {
                    if new_child != row_uuid && !cur_set.contains(new_child) {
                        reparents.push(ReparentItem {
                            uuid: new_child.clone(),
                            parent_section_uuid: Some(row_uuid.to_string()),
                            x: None,
                            y: None,
                            w: None,
                            h: None,
                        });
                    }
                }
                if !target_set.is_empty() {
                    let self_kind: Option<String> = guard
                        .conn
                        .query_row("SELECT kind FROM entities WHERE uuid = ?1", params![row_uuid], |r| r.get(0))
                        .optional()
                        .unwrap_or(None);
                    if self_kind.as_deref() == Some("text") {
                        cmds.push(DocCommand::PromoteTextToSection {
                            uuid: row_uuid.to_string(),
                            props_json: serde_json::json!({
                                "color": [0, 0, 0, 0],
                                "isCollapsed": false,
                                "isHidden": false,
                                "locked": false
                            })
                            .to_string(),
                            x: None,
                            y: None,
                            w: None,
                            h: None,
                            touch_updated_at: true,
                        });
                    }
                }
                if !reparents.is_empty() {
                    cmds.push(DocCommand::ReparentEntities {
                        items: reparents,
                        section_child_orders: Vec::new(),
                        section_bounds: Vec::new(),
                    });
                }
            }
            other => return Err(format!("未知关系类型: {other}")),
        }

        let changeset = guard.apply_commands(&cmds, "ws_set_row_relations", true, None, None, origin_window)?;
        self.sync_from_actor(&guard)?;
        Ok(changeset)
    }

    /// 跨文件在指定 `.prg` 中新建一行（TextNode）并可选写入初始单元格。
    pub fn create_row(
        &self,
        doc_id: &str,
        text: &str,
        initial_cells: &[WorkspaceCellWriteInput],
        origin_window: &str,
    ) -> Result<WorkspaceCreateRowResult, String> {
        let actor = self.get_actor_for_doc_id(doc_id)?;
        let new_uuid = uuid::Uuid::new_v4().to_string();
        let changeset = {
            let mut guard = actor
                .lock()
                .map_err(|_| "DocumentActor 锁中毒".to_string())?;
            let now_ms = current_unix_ms();
            let (next_x, next_y, next_sort): (f64, f64, i64) = guard
                .conn
                .query_row(
                    "SELECT COALESCE(MAX(x), 0.0), COALESCE(MAX(y + h), 0.0) + 40.0, COALESCE(MAX(sort_order), 0) + 1
                     FROM entities WHERE is_row = 1",
                    [],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                )
                .unwrap_or((0.0, 0.0, 1));
            let entity = V3EntityRecord {
                uuid: new_uuid.clone(),
                kind: "text".to_string(),
                parent_section_uuid: None,
                text: text.to_string(),
                details_json: "[]".to_string(),
                details_plain: String::new(),
                x: next_x,
                y: next_y,
                w: 160.0,
                h: 60.0,
                props_json: serde_json::json!({
                    "color": [0, 0, 0, 0],
                    "fontScaleLevel": 0,
                    "sizeAdjust": "auto"
                })
                .to_string(),
                created_at: now_ms,
                updated_at: now_ms,
                is_row: true,
                sort_order: next_sort,
            };
            let cs = guard.apply_commands(
                &[DocCommand::CreateEntities {
                    entities: vec![entity],
                    section_child_orders: Vec::new(),
                    section_bounds: Vec::new(),
                }],
                "ws_create_row",
                true,
                Some(now_ms),
                None,
                origin_window,
            )?;
            self.sync_from_actor(&guard)?;
            cs
        };

        let final_cs = if !initial_cells.is_empty() {
            self.update_row_cells(doc_id, &new_uuid, initial_cells, true, None, origin_window)?
        } else {
            changeset
        };

        Ok(WorkspaceCreateRowResult {
            doc_id: doc_id.to_string(),
            uuid: new_uuid,
            changeset: final_cs,
        })
    }

    // ========================================================================
    // 工作空间文件操作协调（重命名 / 移动 / 删除 / 复制重签 docId + cross_doc_refs 断链修复）
    // ========================================================================

    /// 文件或目录重命名/移动后原子更新 `index.sqlite` 的 `docs.rel_path`、`folder_path`、`title`，
    /// 若 `.prg` 标题变化则自动联动更新所有指向它的 `ReferenceBlockNode` 防止引用失效。
    pub fn notify_path_renamed(
        &self,
        old_path: &Path,
        new_path: &Path,
        is_dir: bool,
        origin_window: &str,
    ) -> Result<WorkspacePathSyncResult, String> {
        if is_dir {
            self.pool.release_under_prefix(old_path)?;
        } else {
            self.pool.release_path(old_path)?;
        }

        let mut renamed_titles: Vec<(String, String, String)> = Vec::new(); // (doc_id, old_title, new_title)
        let updated_docs: usize;

        {
            let mut guard = self
                .active
                .lock()
                .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
            let Some(ws) = guard.as_mut() else {
                return Ok(WorkspacePathSyncResult {
                    updated_docs: 0,
                    updated_ref_docs: Vec::new(),
                });
            };
            let Some(old_rel) = compute_rel_path_insensitive(&ws.root, old_path) else {
                return Ok(WorkspacePathSyncResult {
                    updated_docs: 0,
                    updated_ref_docs: Vec::new(),
                });
            };
            let Some(new_rel) = compute_rel_path_insensitive(&ws.root, new_path) else {
                return Ok(WorkspacePathSyncResult {
                    updated_docs: 0,
                    updated_ref_docs: Vec::new(),
                });
            };

            let tx = ws
                .conn
                .transaction()
                .map_err(|e| format!("开启路径重命名索引事务失败: {e}"))?;

            if is_dir {
                let prefix = format!("{}/", old_rel.trim_end_matches('/'));
                let new_prefix = format!("{}/", new_rel.trim_end_matches('/'));
                let escaped_prefix = prefix
                    .replace('\\', "\\\\")
                    .replace('%', "\\%")
                    .replace('_', "\\_");
                let rows: Vec<(String, String)> = {
                    let mut stmt = tx
                        .prepare("SELECT doc_id, rel_path FROM docs WHERE lower(rel_path) LIKE lower(?1) ESCAPE '\\'")
                        .map_err(|e| format!("查询目录内文档失败: {e}"))?;
                    let r = stmt
                        .query_map(params![format!("{escaped_prefix}%")], |row| {
                            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                        })
                        .map_err(|e| format!("遍历目录内文档失败: {e}"))?;
                    r.collect::<Result<Vec<_>, _>>()
                        .map_err(|e| format!("解析目录内文档失败: {e}"))?
                };
                let mut count = 0usize;
                for (doc_id, cur_rel) in rows {
                    let Some(tail) = strip_prefix_case_insensitive(&cur_rel, &prefix) else {
                        continue;
                    };
                    let next_rel = format!("{new_prefix}{tail}");
                    let (next_folder, next_title) = split_rel_path_meta(&next_rel);
                    let (mtime_ms, file_size) = fs::metadata(ws.root.join(&next_rel))
                        .map(|m| file_mtime_and_size(&m))
                        .unwrap_or_else(|_| (current_unix_ms(), 0));
                    tx.execute(
                        "UPDATE docs SET rel_path = ?1, folder_path = ?2, title = ?3, mtime_ms = ?4, file_size = ?5 WHERE doc_id = ?6",
                        params![&next_rel, &next_folder, &next_title, mtime_ms, file_size, &doc_id],
                    )
                    .map_err(|e| format!("更新目录内文档路径失败: {e}"))?;
                    count += 1;
                }
                updated_docs = count;
            } else {
                let existing: Option<(String, String)> = tx
                    .query_row(
                        "SELECT doc_id, title FROM docs WHERE lower(rel_path) = lower(?1)",
                        params![&old_rel],
                        |r| Ok((r.get(0)?, r.get(1)?)),
                    )
                    .optional()
                    .map_err(|e| format!("查询旧文档路径失败: {e}"))?;

                let (next_folder, next_title) = split_rel_path_meta(&new_rel);
                let (mtime_ms, file_size) = fs::metadata(ws.root.join(&new_rel))
                    .map(|m| file_mtime_and_size(&m))
                    .unwrap_or_else(|_| (current_unix_ms(), 0));

                if let Some((doc_id, old_title)) = existing {
                    tx.execute(
                        "UPDATE docs SET rel_path = ?1, folder_path = ?2, title = ?3, mtime_ms = ?4, file_size = ?5 WHERE doc_id = ?6",
                        params![&new_rel, &next_folder, &next_title, mtime_ms, file_size, &doc_id],
                    )
                    .map_err(|e| format!("更新文档路径失败: {e}"))?;
                    if old_title != next_title {
                        renamed_titles.push((doc_id, old_title, next_title));
                    }
                    updated_docs = 1;
                } else {
                    updated_docs = 0;
                }
            }

            tx.commit()
                .map_err(|e| format!("提交路径重命名索引事务失败: {e}"))?;
        }

        // 若单文件改名且不在旧索引中，兜底同步一次
        if !is_dir && updated_docs == 0 && new_path.exists() {
            let _ = self.sync_file_by_path(new_path);
        }

        // 自动修复跨文件引用块中的旧文件名（[[old_title#sec]] -> [[new_title#sec]]）
        let mut updated_ref_docs = Vec::new();
        for (target_doc_id, _old_title, new_title) in renamed_titles {
            if let Ok(changes) =
                self.repair_file_rename_references(&target_doc_id, &new_title, origin_window)
            {
                updated_ref_docs.extend(changes);
            }
        }

        Ok(WorkspacePathSyncResult {
            updated_docs,
            updated_ref_docs,
        })
    }

    fn repair_file_rename_references(
        &self,
        target_doc_id: &str,
        new_title: &str,
        origin_window: &str,
    ) -> Result<Vec<DocChangeSet>, String> {
        let refs_by_source: HashMap<String, Vec<(String, String)>> =
            self.with_index_conn(|conn, _root| {
                let mut stmt = conn
                    .prepare(
                        "SELECT source_doc_id, source_uuid, target_section_name
                         FROM cross_doc_refs WHERE target_doc_id = ?1",
                    )
                    .map_err(|e| format!("查询反向引用失败: {e}"))?;
                let rows = stmt
                    .query_map(params![target_doc_id], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    })
                    .map_err(|e| format!("遍历反向引用失败: {e}"))?;
                let mut map: HashMap<String, Vec<(String, String)>> = HashMap::new();
                for r in rows.flatten() {
                    map.entry(r.0).or_default().push((r.1, r.2));
                }
                Ok(map)
            })?;

        let mut out = Vec::new();
        for (source_doc_id, items) in refs_by_source {
            let Ok(actor) = self.get_actor_for_doc_id(&source_doc_id) else {
                continue;
            };
            let mut guard = actor
                .lock()
                .map_err(|_| "DocumentActor 锁中毒".to_string())?;
            let mut cmds = Vec::new();
            for (src_uuid, sec_name) in items {
                let new_text = if sec_name.is_empty() {
                    format!("[[{new_title}]]")
                } else {
                    format!("[[{new_title}#{sec_name}]]")
                };
                cmds.push(DocCommand::UpdateEntityText {
                    uuid: src_uuid,
                    text: new_text,
                    x: None,
                    y: None,
                    w: None,
                    h: None,
                    props_patch: Some(serde_json::json!({ "fileName": new_title })),
                    section_bounds: Vec::new(),
                });
            }
            if !cmds.is_empty() {
                let cs = guard.apply_commands(
                    &cmds,
                    "ws_repair_file_rename_refs",
                    false,
                    None,
                    None,
                    origin_window,
                )?;
                self.sync_from_actor(&guard)?;
                out.push(cs);
            }
        }
        Ok(out)
    }

    pub fn repair_section_rename_references(
        &self,
        target_doc_id: &str,
        old_section_name: &str,
        new_section_name: &str,
        origin_window: &str,
    ) -> Result<Vec<DocChangeSet>, String> {
        let refs_by_source: HashMap<String, Vec<String>> = self.with_index_conn(|conn, _root| {
            let mut stmt = conn
                .prepare(
                    "SELECT source_doc_id, source_uuid
                     FROM cross_doc_refs
                     WHERE target_doc_id = ?1 AND target_section_name = ?2",
                )
                .map_err(|e| format!("查询分组反向引用失败: {e}"))?;
            let rows = stmt
                .query_map(params![target_doc_id, old_section_name], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })
                .map_err(|e| format!("遍历分组反向引用失败: {e}"))?;
            let mut map: HashMap<String, Vec<String>> = HashMap::new();
            for r in rows.flatten() {
                map.entry(r.0).or_default().push(r.1);
            }
            Ok(map)
        })?;

        if refs_by_source.is_empty() {
            return Ok(Vec::new());
        }

        let target_title: String = self.with_index_conn(|conn, _root| {
            conn.query_row(
                "SELECT title FROM docs WHERE doc_id = ?1",
                params![target_doc_id],
                |r| r.get(0),
            )
            .map_err(|e| format!("查询目标文档标题失败: {e}"))
        })?;

        let mut out = Vec::new();
        for (source_doc_id, uuids) in refs_by_source {
            let Ok(actor) = self.get_actor_for_doc_id(&source_doc_id) else {
                continue;
            };
            let mut guard = actor
                .lock()
                .map_err(|_| "DocumentActor 锁中毒".to_string())?;
            let mut cmds = Vec::new();
            for src_uuid in uuids {
                let new_text = if new_section_name.is_empty() {
                    format!("[[{target_title}]]")
                } else {
                    format!("[[{target_title}#{new_section_name}]]")
                };
                cmds.push(DocCommand::UpdateEntityText {
                    uuid: src_uuid,
                    text: new_text,
                    x: None,
                    y: None,
                    w: None,
                    h: None,
                    props_patch: Some(serde_json::json!({ "sectionName": new_section_name })),
                    section_bounds: Vec::new(),
                });
            }
            if !cmds.is_empty() {
                let cs = guard.apply_commands(
                    &cmds,
                    "ws_repair_section_rename_refs",
                    false,
                    None,
                    None,
                    origin_window,
                )?;
                self.sync_from_actor(&guard)?;
                out.push(cs);
            }
        }
        Ok(out)
    }

    /// 删除页面或目录后立即清理 `index.sqlite` 中的对应文档与 FTS 索引行。
    pub fn notify_path_deleted(&self, path: &Path, is_dir: bool) -> Result<usize, String> {
        if is_dir {
            self.pool.release_under_prefix(path)?;
        } else {
            self.pool.release_path(path)?;
        }
        let mut guard = self
            .active
            .lock()
            .map_err(|_| "WorkspaceEngine 锁中毒".to_string())?;
        let Some(ws) = guard.as_mut() else {
            return Ok(0);
        };
        let Some(rel) = compute_rel_path_insensitive(&ws.root, path) else {
            return Ok(0);
        };
        let tx = ws
            .conn
            .transaction()
            .map_err(|e| format!("开启删除文档索引事务失败: {e}"))?;
        let doc_ids: Vec<String> = if is_dir {
            let prefix = format!("{}/%", rel.trim_end_matches('/'));
            let mut stmt = tx
                .prepare("SELECT doc_id FROM docs WHERE lower(rel_path) LIKE lower(?1)")
                .map_err(|e| format!("查询待删目录文档失败: {e}"))?;
            let r = stmt
                .query_map(params![prefix], |row| row.get::<_, String>(0))
                .map_err(|e| format!("遍历待删目录文档失败: {e}"))?;
            r.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析待删目录文档失败: {e}"))?
        } else {
            let mut stmt = tx
                .prepare("SELECT doc_id FROM docs WHERE lower(rel_path) = lower(?1)")
                .map_err(|e| format!("查询待删文档失败: {e}"))?;
            let r = stmt
                .query_map(params![rel], |row| row.get::<_, String>(0))
                .map_err(|e| format!("遍历待删文档失败: {e}"))?;
            r.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析待删文档失败: {e}"))?
        };

        for id in &doc_ids {
            tx.execute("DELETE FROM entities_fts WHERE doc_id = ?1", params![id])
                .map_err(|e| format!("清理已删文档 FTS 失败: {e}"))?;
            tx.execute("DELETE FROM docs WHERE doc_id = ?1", params![id])
                .map_err(|e| format!("删除 docs 索引失败: {e}"))?;
        }
        tx.commit()
            .map_err(|e| format!("提交删除文档索引事务失败: {e}"))?;
        Ok(doc_ids.len())
    }

    /// 复制 `.prg` 文件或整棵目录后，为副本内每个 SQLite v3 `.prg` 重签发唯一 `docId` 并同步入 `index.sqlite`。
    pub fn reissue_copied_doc_ids(&self, copied_path: &Path, is_dir: bool) -> Result<Vec<String>, String> {
        let mut files = Vec::new();
        if is_dir {
            let mut entries = Vec::new();
            collect_disk_prg_entries(copied_path, copied_path, &mut entries);
            for e in entries {
                files.push(e.abs_path);
            }
        } else if copied_path.exists() {
            files.push(copied_path.to_path_buf());
        }

        let mut new_ids = Vec::new();
        for file in files {
            if detect_prg_format(&file)? != PrgFormat::V3Sqlite {
                continue;
            }
            let new_id = self.pool.reissue_doc_id(&file)?;
            let _ = self.sync_file_by_path(&file)?;
            new_ids.push(new_id);
        }
        Ok(new_ids)
    }

    pub fn list_backlinks(&self, target_doc_id: &str) -> Result<Vec<WorkspaceBacklinkRecord>, String> {
        self.with_index_conn(|conn, _root| {
            let mut stmt = conn
                .prepare(
                    "SELECT r.source_doc_id, d.rel_path, d.title, r.source_uuid, r.target_doc_id, r.target_section_name
                     FROM cross_doc_refs r
                     JOIN docs d ON d.doc_id = r.source_doc_id
                     WHERE r.target_doc_id = ?1
                     ORDER BY d.rel_path COLLATE \"NATURAL\" ASC",
                )
                .map_err(|e| format!("查询反向引用列表失败: {e}"))?;
            let rows = stmt
                .query_map(params![target_doc_id], |r| {
                    Ok(WorkspaceBacklinkRecord {
                        source_doc_id: r.get(0)?,
                        source_rel_path: r.get(1)?,
                        source_title: r.get(2)?,
                        source_uuid: r.get(3)?,
                        target_doc_id: r.get(4)?,
                        target_section_name: r.get(5)?,
                    })
                })
                .map_err(|e| format!("遍历反向引用列表失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析反向引用列表失败: {e}"))
        })
    }
}

// ============================================================================
// 目标 .prg 内部辅助函数（SR 列自动创建、选项自动补齐、SR 公式缓存写回）
// ============================================================================

fn ensure_local_option_in_column(
    col: &mut V3TableColumnRecord,
    option_name: &str,
    preferred_color: Option<&str>,
    schema_cmds: &mut Vec<DocCommand>,
) -> String {
    let mut opts = parse_options_from_config(&col.config_json);
    if let Some(existing) = opts
        .iter()
        .find(|o| o.name.trim().eq_ignore_ascii_case(option_name.trim()))
    {
        return existing.id.clone();
    }
    let new_opt = WorkspaceColumnOption {
        id: format!("opt_{}", uuid::Uuid::new_v4()),
        name: option_name.trim().to_string(),
        color: preferred_color
            .map(|c| c.to_string())
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| pick_next_option_color(&opts)),
    };
    let created_id = new_opt.id.clone();
    opts.push(new_opt);
    let mut cfg: serde_json::Value =
        serde_json::from_str(&col.config_json).unwrap_or_else(|_| serde_json::json!({}));
    if let Some(obj) = cfg.as_object_mut() {
        obj.insert("options".to_string(), serde_json::to_value(&opts).unwrap());
    }
    col.config_json = cfg.to_string();
    schema_cmds.push(DocCommand::UpsertColumn {
        column: col.clone(),
    });
    created_id
}

fn ensure_doc_sr_columns_cmds(
    conn: &Connection,
) -> Result<(HashMap<String, String>, Vec<DocCommand>), String> {
    let mut role_ids: HashMap<String, String> = HashMap::new();
    let mut next_pos: i64 = 0;
    {
        let mut stmt = conn
            .prepare("SELECT id, canonical_key, position FROM table_columns ORDER BY position ASC, rowid ASC")
            .map_err(|e| format!("查询目标文档 SR 列失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)?,
                ))
            })
            .map_err(|e| format!("遍历目标文档 SR 列失败: {e}"))?;
        for row in rows.flatten() {
            next_pos = next_pos.max(row.2 + 1);
            if let Some(role) = row.1.strip_prefix("role:sr:") {
                role_ids.insert(role.to_string(), row.0);
            }
        }
    }

    let mut missing_specs: Vec<&SrSpec> = Vec::new();
    for spec in SR_SPECS {
        if !role_ids.contains_key(spec.role) {
            role_ids.insert(
                spec.role.to_string(),
                format!("col_{}", uuid::Uuid::new_v4()),
            );
            missing_specs.push(spec);
        }
    }

    let mut cmds = Vec::new();
    for spec in missing_specs {
        let col_id = role_ids[spec.role].clone();
        let mut cfg = serde_json::Map::new();
        cfg.insert(
            "protectedRole".to_string(),
            serde_json::Value::String(spec.role.to_string()),
        );
        if let Some(fmt) = spec.format {
            cfg.insert(
                "format".to_string(),
                serde_json::Value::String(fmt.to_string()),
            );
        }
        if let Some(formula) = build_sr_formula_text(spec.role, &role_ids) {
            cfg.insert("formula".to_string(), serde_json::Value::String(formula));
        }
        if spec.role == "archiveStatus" {
            let opts = vec![
                WorkspaceColumnOption {
                    id: format!("opt_{}", uuid::Uuid::new_v4()),
                    name: "未归档".to_string(),
                    color: "gray".to_string(),
                },
                WorkspaceColumnOption {
                    id: format!("opt_{}", uuid::Uuid::new_v4()),
                    name: "已归档".to_string(),
                    color: "green".to_string(),
                },
            ];
            cfg.insert("options".to_string(), serde_json::to_value(opts).unwrap());
        } else if spec.col_type == "select" || spec.col_type == "multi_select" {
            cfg.insert("options".to_string(), serde_json::json!([]));
        }
        cmds.push(DocCommand::UpsertColumn {
            column: V3TableColumnRecord {
                id: col_id,
                canonical_key: format!("role:sr:{}", spec.role),
                name: spec.name.to_string(),
                r#type: spec.col_type.to_string(),
                position: next_pos,
                config_json: serde_json::Value::Object(cfg).to_string(),
            },
        });
        next_pos += 1;
    }

    Ok((role_ids, cmds))
}

fn read_row_sr_snapshot(
    conn: &Connection,
    row_uuid: &str,
    role_ids: &HashMap<String, String>,
) -> Result<SpacedRepetitionSnapshotDto, String> {
    let read_num = |role: &str| -> Option<f64> {
        let cid = role_ids.get(role)?;
        conn.query_row(
            "SELECT val_num FROM cell_values WHERE entity_uuid = ?1 AND col_id = ?2",
            params![row_uuid, cid],
            |r| r.get::<_, Option<f64>>(0),
        )
        .ok()
        .flatten()
    };
    let answer_date = role_ids.get("answerDate").and_then(|cid| {
        conn.query_row(
            "SELECT COALESCE(val_date, val_text) FROM cell_values WHERE entity_uuid = ?1 AND col_id = ?2",
            params![row_uuid, cid],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    });
    Ok(SpacedRepetitionSnapshotDto {
        mastery: read_num("mastery"),
        correct_count: read_num("correctCount"),
        delay: read_num("delay"),
        answer_date,
    })
}

fn refresh_row_sr_formula_cache_in_actor(
    actor: &mut DocumentActor,
    row_uuid: &str,
    today_key: &str,
    origin_window: &str,
) -> Result<(), String> {
    let mut role_ids: HashMap<String, String> = HashMap::new();
    let mut archive_opt_names: HashMap<String, String> = HashMap::new();
    {
        let mut stmt = actor
            .conn
            .prepare("SELECT id, canonical_key, config_json FROM table_columns WHERE canonical_key LIKE 'role:sr:%'")
            .map_err(|e| format!("查询目标文档 SR 列失败: {e}"))?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| format!("遍历目标文档 SR 列失败: {e}"))?;
        for r in rows.flatten() {
            if let Some(role) = r.1.strip_prefix("role:sr:") {
                role_ids.insert(role.to_string(), r.0);
                if role == "archiveStatus" {
                    for o in parse_options_from_config(&r.2) {
                        archive_opt_names.insert(o.id, o.name);
                    }
                }
            }
        }
    }
    if role_ids.is_empty() {
        return Ok(());
    }
    let snap = read_row_sr_snapshot(&actor.conn, row_uuid, &role_ids)?;
    let archive_name = role_ids.get("archiveStatus").and_then(|cid| {
        actor
            .conn
            .query_row(
                "SELECT val_text FROM cell_values WHERE entity_uuid = ?1 AND col_id = ?2",
                params![row_uuid, cid],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
            .map(|opt_id| {
                archive_opt_names
                    .get(&opt_id)
                    .cloned()
                    .unwrap_or(opt_id)
            })
    });

    let eval = evaluate_sr_formulas(
        snap.correct_count,
        snap.delay,
        snap.answer_date.as_deref(),
        archive_name.as_deref(),
        today_key,
    );

    let mut entries = Vec::new();
    if let Some(cid) = role_ids.get("nextInterval") {
        entries.push(FormulaCacheEntry {
            entity_uuid: row_uuid.to_string(),
            col_id: cid.clone(),
            canonical_key: "role:sr:nextInterval".to_string(),
            kind: "number".to_string(),
            display_text: format_js_number(eval.next_interval.round()),
            val_num: Some(eval.next_interval),
            val_date_ms: None,
            val_json: None,
            is_volatile: false,
            computed_day: Some(today_key.to_string()),
        });
    }
    if let Some(cid) = role_ids.get("nextDueDate") {
        let (kind, disp, ms) = match (&eval.next_due_date, eval.next_due_date_ms) {
            (Some(d), Some(m)) => ("date", d.clone(), Some(m)),
            _ => ("empty", String::new(), None),
        };
        entries.push(FormulaCacheEntry {
            entity_uuid: row_uuid.to_string(),
            col_id: cid.clone(),
            canonical_key: "role:sr:nextDueDate".to_string(),
            kind: kind.to_string(),
            display_text: disp,
            val_num: None,
            val_date_ms: ms,
            val_json: None,
            is_volatile: false,
            computed_day: Some(today_key.to_string()),
        });
    }
    if let Some(cid) = role_ids.get("dueStatus") {
        entries.push(FormulaCacheEntry {
            entity_uuid: row_uuid.to_string(),
            col_id: cid.clone(),
            canonical_key: "role:sr:dueStatus".to_string(),
            kind: "string".to_string(),
            display_text: eval.due_status.to_string(),
            val_num: None,
            val_date_ms: None,
            val_json: None,
            is_volatile: true,
            computed_day: Some(today_key.to_string()),
        });
    }

    if !entries.is_empty() {
        let _ = actor.apply_commands(
            &[DocCommand::UpdateFormulaCacheBatch { entries }],
            "ws_sr_formula_refresh",
            false,
            None,
            None,
            origin_window,
        )?;
    }
    Ok(())
}
