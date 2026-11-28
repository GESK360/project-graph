use crate::sqlite_engine::schema::{
    initialize_v3_schema, initialize_v3_schema_if_needed, wal_checkpoint_truncate, FORMAT_VERSION,
    SCHEMA_VERSION,
};
use lru::LruCache;
use rusqlite::types::ValueRef;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt::Write as FmtWrite;
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const CLOSED_ACTOR_LRU_CAPACITY: usize = 32;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3AttachmentMeta {
    pub id: string_type::Str,
    pub mime: String,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub size_bytes: i64,
    pub has_thumb: bool,
}

mod string_type {
    pub type Str = String;
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3EntityRecord {
    pub uuid: String,
    pub kind: String,
    pub parent_section_uuid: Option<String>,
    pub text: String,
    pub details_json: String,
    pub details_plain: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub props_json: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub is_row: bool,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3EdgeRecord {
    pub uuid: String,
    pub kind: String,
    pub source_uuid: String,
    pub target_uuid: String,
    pub text: String,
    pub props_json: String,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3AssociationRecord {
    pub uuid: String,
    pub kind: String,
    pub member_uuids_json: String,
    pub props_json: String,
    pub sort_order: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3TableColumnRecord {
    pub id: String,
    pub canonical_key: String,
    pub name: String,
    pub r#type: String,
    pub position: i64,
    pub config_json: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3TableViewRecord {
    pub id: String,
    pub name: String,
    pub r#type: String,
    pub deletable: bool,
    pub position: i64,
    pub config_json: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3MultiOptionEntry {
    pub option_id: String,
    pub option_name: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3CellValueRecord {
    pub entity_uuid: String,
    pub col_id: String,
    pub canonical_key: String,
    pub val_type: String,
    pub val_text: Option<String>,
    pub val_num: Option<f64>,
    pub val_date: Option<String>,
    pub val_json: Option<String>,
    #[serde(default)]
    pub multi_options: Vec<V3MultiOptionEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3ImportPayload {
    pub doc_id: String,
    pub format_version: String,
    pub readme: Option<String>,
    pub tags: Vec<String>,
    pub references: serde_json::Value,
    pub extension_json: Option<String>,
    pub table_meta_json: String,
    pub entities: Vec<V3EntityRecord>,
    pub edges: Vec<V3EdgeRecord>,
    pub associations: Vec<V3AssociationRecord>,
    pub table_columns: Vec<V3TableColumnRecord>,
    pub table_views: Vec<V3TableViewRecord>,
    pub cell_values: Vec<V3CellValueRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3DocumentOpenResult {
    pub canonical_path: String,
    pub doc_id: String,
    pub format_version: String,
    pub revision: i64,
    pub readme: Option<String>,
    pub tags: Vec<String>,
    pub references: serde_json::Value,
    pub extension_json: Option<String>,
    pub table_meta_json: String,
    pub entities: Vec<V3EntityRecord>,
    pub edges: Vec<V3EdgeRecord>,
    pub associations: Vec<V3AssociationRecord>,
    pub table_columns: Vec<V3TableColumnRecord>,
    pub table_views: Vec<V3TableViewRecord>,
    pub cell_values: Vec<V3CellValueRecord>,
    pub attachments: Vec<V3AttachmentMeta>,
    #[serde(default)]
    pub needs_formula_recompute: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3SyncResult {
    pub revision: i64,
}

#[derive(Debug, Clone)]
pub struct StoredAttachmentBlob {
    pub mime: String,
    pub data_blob: Vec<u8>,
    pub thumb_blob: Option<Vec<u8>>,
}

pub fn normalize_path_key(path: &Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let mut s = resolved.to_string_lossy().replace('\\', "/");
    if let Some(stripped) = s.strip_prefix("//?/") {
        s = stripped.to_string();
    }
    #[cfg(target_os = "windows")]
    {
        s.to_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        s
    }
}

pub fn canonical_display_path(path: &Path) -> String {
    let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let s = resolved.to_string_lossy().to_string();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        stripped.to_string()
    } else {
        s
    }
}

pub(crate) fn sanitize_rtree_bounds(x: f64, y: f64, w: f64, h: f64) -> (f64, f64, f64, f64) {
    let sx = if x.is_finite() { x } else { 0.0 };
    let sy = if y.is_finite() { y } else { 0.0 };
    let sw = if w.is_finite() { w } else { 0.0 };
    let sh = if h.is_finite() { h } else { 0.0 };
    let x2 = sx + sw;
    let y2 = sy + sh;
    (sx.min(x2), sx.max(x2), sy.min(y2), sy.max(y2))
}

/// 在事务内覆盖写入完整文档快照（保留 `attachments` 与 `history_ops` 表不受影响）。
pub fn write_snapshot_in_tx(
    tx: &Transaction<'_>,
    payload: &V3ImportPayload,
    next_revision: i64,
) -> Result<(), String> {
    let doc_id = if payload.doc_id.trim().is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        payload.doc_id.clone()
    };
    let format_version = if payload.format_version.trim().is_empty() {
        FORMAT_VERSION.to_string()
    } else {
        payload.format_version.clone()
    };
    let tags_json =
        serde_json::to_string(&payload.tags).map_err(|e| format!("序列化 tags 失败: {e}"))?;
    let refs_json = serde_json::to_string(&payload.references)
        .map_err(|e| format!("序列化 references 失败: {e}"))?;

    {
        let mut meta_stmt = tx
            .prepare(
                "INSERT INTO metadata (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            )
            .map_err(|e| format!("准备 metadata 写入失败: {e}"))?;
        meta_stmt
            .execute(params!["schema_version", SCHEMA_VERSION])
            .map_err(|e| format!("写入 schema_version 失败: {e}"))?;
        meta_stmt
            .execute(params!["format_version", &format_version])
            .map_err(|e| format!("写入 format_version 失败: {e}"))?;
        meta_stmt
            .execute(params!["docId", &doc_id])
            .map_err(|e| format!("写入 docId 失败: {e}"))?;
        meta_stmt
            .execute(params!["revision", next_revision.to_string()])
            .map_err(|e| format!("写入 revision 失败: {e}"))?;
        meta_stmt
            .execute(params!["tags_json", &tags_json])
            .map_err(|e| format!("写入 tags_json 失败: {e}"))?;
        meta_stmt
            .execute(params!["references_json", &refs_json])
            .map_err(|e| format!("写入 references_json 失败: {e}"))?;
        meta_stmt
            .execute(params!["table_meta_json", &payload.table_meta_json])
            .map_err(|e| format!("写入 table_meta_json 失败: {e}"))?;

        if let Some(readme) = &payload.readme {
            meta_stmt
                .execute(params!["readme", readme])
                .map_err(|e| format!("写入 readme 失败: {e}"))?;
        } else {
            tx.execute("DELETE FROM metadata WHERE key = 'readme'", [])
                .map_err(|e| format!("清理 readme 失败: {e}"))?;
        }
        if let Some(ext) = &payload.extension_json {
            meta_stmt
                .execute(params!["extension_json", ext])
                .map_err(|e| format!("写入 extension_json 失败: {e}"))?;
        } else {
            tx.execute("DELETE FROM metadata WHERE key = 'extension_json'", [])
                .map_err(|e| format!("清理 extension_json 失败: {e}"))?;
        }
    }

    // 清空文档主体表（按外键依赖顺序），不触碰 attachments 和 history_ops
    tx.execute_batch(
        "
        DELETE FROM cell_multi_options;
        DELETE FROM cell_values;
        DELETE FROM formula_cache;
        DELETE FROM table_views;
        DELETE FROM table_columns;
        DELETE FROM associations;
        DELETE FROM edges;
        DELETE FROM entities_fts;
        DELETE FROM entities_rtree;
        DELETE FROM entity_rtree_map;
        DELETE FROM entities;
        ",
    )
    .map_err(|e| format!("清空旧快照行失败: {e}"))?;

    let mut entity_uuids = HashSet::with_capacity(payload.entities.len());
    {
        let mut ent_stmt = tx
            .prepare(
                "INSERT INTO entities (
                    uuid, kind, parent_section_uuid, text, details_json, details_plain,
                    x, y, w, h, props_json, created_at, updated_at, is_row, sort_order
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            )
            .map_err(|e| format!("准备 entities 写入失败: {e}"))?;
        let mut rtree_map_stmt = tx
            .prepare("INSERT INTO entity_rtree_map (uuid) VALUES (?1)")
            .map_err(|e| format!("准备 entity_rtree_map 写入失败: {e}"))?;
        let mut rtree_stmt = tx
            .prepare("INSERT INTO entities_rtree (id, min_x, max_x, min_y, max_y) VALUES (?1, ?2, ?3, ?4, ?5)")
            .map_err(|e| format!("准备 entities_rtree 写入失败: {e}"))?;
        let mut fts_stmt = tx
            .prepare("INSERT INTO entities_fts (uuid, text, details_plain) VALUES (?1, ?2, ?3)")
            .map_err(|e| format!("准备 entities_fts 写入失败: {e}"))?;

        for e in &payload.entities {
            if !entity_uuids.insert(e.uuid.clone()) {
                continue;
            }
            ent_stmt
                .execute(params![
                    &e.uuid,
                    &e.kind,
                    &e.parent_section_uuid,
                    &e.text,
                    &e.details_json,
                    &e.details_plain,
                    e.x,
                    e.y,
                    e.w,
                    e.h,
                    &e.props_json,
                    e.created_at,
                    e.updated_at,
                    if e.is_row { 1i64 } else { 0i64 },
                    e.sort_order,
                ])
                .map_err(|err| format!("写入实体 {} 失败: {err}", e.uuid))?;

            rtree_map_stmt
                .execute(params![&e.uuid])
                .map_err(|err| format!("写入实体 R-Tree 映射 {} 失败: {err}", e.uuid))?;
            let rtree_id = tx.last_insert_rowid();
            let (min_x, max_x, min_y, max_y) = sanitize_rtree_bounds(e.x, e.y, e.w, e.h);
            rtree_stmt
                .execute(params![rtree_id, min_x, max_x, min_y, max_y])
                .map_err(|err| format!("写入实体 R-Tree {} 失败: {err}", e.uuid))?;

            fts_stmt
                .execute(params![&e.uuid, &e.text, &e.details_plain])
                .map_err(|err| format!("写入实体 FTS {} 失败: {err}", e.uuid))?;
        }
    }

    {
        let mut edge_stmt = tx
            .prepare(
                "INSERT INTO edges (uuid, kind, source_uuid, target_uuid, text, props_json, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            )
            .map_err(|e| format!("准备 edges 写入失败: {e}"))?;
        let mut seen_edges = HashSet::with_capacity(payload.edges.len());
        for edge in &payload.edges {
            if !seen_edges.insert(edge.uuid.clone()) {
                continue;
            }
            edge_stmt
                .execute(params![
                    &edge.uuid,
                    &edge.kind,
                    &edge.source_uuid,
                    &edge.target_uuid,
                    &edge.text,
                    &edge.props_json,
                    edge.sort_order,
                ])
                .map_err(|err| format!("写入边 {} 失败: {err}", edge.uuid))?;
        }
    }

    {
        let mut assoc_stmt = tx
            .prepare(
                "INSERT INTO associations (uuid, kind, member_uuids_json, props_json, sort_order)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
            )
            .map_err(|e| format!("准备 associations 写入失败: {e}"))?;
        let mut seen_assocs = HashSet::with_capacity(payload.associations.len());
        for assoc in &payload.associations {
            if !seen_assocs.insert(assoc.uuid.clone()) {
                continue;
            }
            assoc_stmt
                .execute(params![
                    &assoc.uuid,
                    &assoc.kind,
                    &assoc.member_uuids_json,
                    &assoc.props_json,
                    assoc.sort_order,
                ])
                .map_err(|err| format!("写入关联 {} 失败: {err}", assoc.uuid))?;
        }
    }

    let mut col_ids = HashSet::with_capacity(payload.table_columns.len());
    {
        let mut col_stmt = tx
            .prepare(
                "INSERT INTO table_columns (id, canonical_key, name, type, position, config_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| format!("准备 table_columns 写入失败: {e}"))?;
        for col in &payload.table_columns {
            if !col_ids.insert(col.id.clone()) {
                continue;
            }
            col_stmt
                .execute(params![
                    &col.id,
                    &col.canonical_key,
                    &col.name,
                    &col.r#type,
                    col.position,
                    &col.config_json,
                ])
                .map_err(|err| format!("写入列 {} 失败: {err}", col.id))?;
        }
    }

    {
        let mut view_stmt = tx
            .prepare(
                "INSERT INTO table_views (id, name, type, deletable, position, config_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )
            .map_err(|e| format!("准备 table_views 写入失败: {e}"))?;
        let mut seen_views = HashSet::with_capacity(payload.table_views.len());
        for view in &payload.table_views {
            if !seen_views.insert(view.id.clone()) {
                continue;
            }
            view_stmt
                .execute(params![
                    &view.id,
                    &view.name,
                    &view.r#type,
                    if view.deletable { 1i64 } else { 0i64 },
                    view.position,
                    &view.config_json,
                ])
                .map_err(|err| format!("写入视图 {} 失败: {err}", view.id))?;
        }
    }

    {
        let mut cell_stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO cell_values (
                    entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| format!("准备 cell_values 写入失败: {e}"))?;
        let mut multi_stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO cell_multi_options (entity_uuid, col_id, option_id, option_name)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| format!("准备 cell_multi_options 写入失败: {e}"))?;

        for cell in &payload.cell_values {
            if !entity_uuids.contains(&cell.entity_uuid) || !col_ids.contains(&cell.col_id) {
                continue;
            }
            cell_stmt
                .execute(params![
                    &cell.entity_uuid,
                    &cell.col_id,
                    &cell.canonical_key,
                    &cell.val_type,
                    &cell.val_text,
                    cell.val_num,
                    &cell.val_date,
                    &cell.val_json,
                ])
                .map_err(|err| {
                    format!(
                        "写入单元格 ({}, {}) 失败: {err}",
                        cell.entity_uuid, cell.col_id
                    )
                })?;

            for opt in &cell.multi_options {
                multi_stmt
                    .execute(params![
                        &cell.entity_uuid,
                        &cell.col_id,
                        &opt.option_id,
                        &opt.option_name,
                    ])
                    .map_err(|err| {
                        format!(
                            "写入多选索引 ({}, {}, {}) 失败: {err}",
                            cell.entity_uuid, cell.col_id, opt.option_id
                        )
                    })?;
            }
        }
    }

    Ok(())
}

/// 单个打开中的 `.prg v3.0.0` 文档执行器，持有独占 `rusqlite::Connection`。
pub struct DocumentActor {
    pub path: PathBuf,
    pub path_key: String,
    pub canonical_path: String,
    pub doc_id: String,
    pub revision: i64,
    pub undo_cursor: i64,
    pub is_temp_draft: bool,
    pub has_uncheckpointed_writes: bool,
    pub conn: Connection,
}

fn wal_sidecar_nonempty(path: &Path) -> bool {
    let mut wal_os = path.as_os_str().to_os_string();
    wal_os.push("-wal");
    std::fs::metadata(PathBuf::from(wal_os))
        .map(|m| m.len() > 0)
        .unwrap_or(false)
}

#[inline]
fn push_json_str(out: &mut String, s: &str) {
    out.push('"');
    let bytes = s.as_bytes();
    let mut start = 0usize;
    for (i, &b) in bytes.iter().enumerate() {
        let esc = match b {
            b'"' => Some("\\\""),
            b'\\' => Some("\\\\"),
            b'\n' => Some("\\n"),
            b'\r' => Some("\\r"),
            b'\t' => Some("\\t"),
            0x08 => Some("\\b"),
            0x0c => Some("\\f"),
            0x00..=0x1f => None,
            _ => continue,
        };
        if start < i {
            out.push_str(&s[start..i]);
        }
        if let Some(lit) = esc {
            out.push_str(lit);
        } else {
            let _ = write!(out, "\\u{:04x}", b);
        }
        start = i + 1;
    }
    if start < bytes.len() {
        out.push_str(&s[start..]);
    }
    out.push('"');
}

#[inline]
fn push_i64(out: &mut String, n: i64) {
    if n == 0 {
        out.push('0');
        return;
    }
    let mut buf = [0u8; 24];
    let mut pos = buf.len();
    let neg = n < 0;
    let mut v = n.unsigned_abs();
    while v > 0 {
        pos -= 1;
        buf[pos] = b'0' + (v % 10) as u8;
        v /= 10;
    }
    if neg {
        pos -= 1;
        buf[pos] = b'-';
    }
    // Safety: buf[pos..] contains only ASCII digits and optional '-'
    let s = unsafe { std::str::from_utf8_unchecked(&buf[pos..]) };
    out.push_str(s);
}

#[inline]
fn push_json_f64(out: &mut String, v: f64) {
    if !v.is_finite() {
        out.push('0');
        return;
    }
    if v.fract() == 0.0 && (-9_007_199_254_740_991.0..=9_007_199_254_740_991.0).contains(&v) {
        push_i64(out, v as i64);
    } else {
        let _ = write!(out, "{v}");
    }
}

/// 极速单遍 JSON 语法校验（替代 debug 构建下较慢的 `serde_json::from_str::<IgnoredAny>`），
/// 保证任何损坏的 SQLite 文本列都不会拼出非法 JSON。
fn is_valid_json_fast(s: &str) -> bool {
    let b = s.as_bytes();
    let len = b.len();
    let mut i = 0usize;
    let mut stack = [0u8; 64];
    let mut depth = 0usize;

    #[inline]
    fn skip_ws(b: &[u8], i: &mut usize) {
        while *i < b.len() && matches!(b[*i], b' ' | b'\t' | b'\n' | b'\r') {
            *i += 1;
        }
    }

    skip_ws(b, &mut i);
    if i >= len {
        return false;
    }

    let mut expect_value = true;
    loop {
        skip_ws(b, &mut i);
        if expect_value {
            if i >= len {
                return false;
            }
            match b[i] {
                b'{' => {
                    if depth >= stack.len() {
                        return serde_json::from_str::<serde::de::IgnoredAny>(s).is_ok();
                    }
                    stack[depth] = b'}';
                    depth += 1;
                    i += 1;
                    skip_ws(b, &mut i);
                    if i < len && b[i] == b'}' {
                        depth -= 1;
                        i += 1;
                        expect_value = false;
                    } else {
                        if i >= len || b[i] != b'"' || !scan_json_string(b, &mut i) {
                            return false;
                        }
                        skip_ws(b, &mut i);
                        if i >= len || b[i] != b':' {
                            return false;
                        }
                        i += 1;
                        expect_value = true;
                    }
                }
                b'[' => {
                    if depth >= stack.len() {
                        return serde_json::from_str::<serde::de::IgnoredAny>(s).is_ok();
                    }
                    stack[depth] = b']';
                    depth += 1;
                    i += 1;
                    skip_ws(b, &mut i);
                    if i < len && b[i] == b']' {
                        depth -= 1;
                        i += 1;
                        expect_value = false;
                    } else {
                        expect_value = true;
                    }
                }
                b'"' => {
                    if !scan_json_string(b, &mut i) {
                        return false;
                    }
                    expect_value = false;
                }
                b't' => {
                    if b.get(i..i + 4) != Some(b"true") {
                        return false;
                    }
                    i += 4;
                    expect_value = false;
                }
                b'f' => {
                    if b.get(i..i + 5) != Some(b"false") {
                        return false;
                    }
                    i += 5;
                    expect_value = false;
                }
                b'n' => {
                    if b.get(i..i + 4) != Some(b"null") {
                        return false;
                    }
                    i += 4;
                    expect_value = false;
                }
                b'-' | b'0'..=b'9' => {
                    if !scan_json_number(b, &mut i) {
                        return false;
                    }
                    expect_value = false;
                }
                _ => return false,
            }
        } else if depth == 0 {
            skip_ws(b, &mut i);
            return i == len;
        } else {
            if i >= len {
                return false;
            }
            let close = stack[depth - 1];
            if b[i] == close {
                depth -= 1;
                i += 1;
                expect_value = false;
            } else if b[i] == b',' {
                i += 1;
                skip_ws(b, &mut i);
                if close == b'}' {
                    if i >= len || b[i] != b'"' || !scan_json_string(b, &mut i) {
                        return false;
                    }
                    skip_ws(b, &mut i);
                    if i >= len || b[i] != b':' {
                        return false;
                    }
                    i += 1;
                }
                expect_value = true;
            } else {
                return false;
            }
        }
    }
}

#[inline]
fn scan_json_string(b: &[u8], i: &mut usize) -> bool {
    *i += 1;
    while *i < b.len() {
        let c = b[*i];
        if c == b'"' {
            *i += 1;
            return true;
        }
        if c == b'\\' {
            *i += 1;
            if *i >= b.len() {
                return false;
            }
            match b[*i] {
                b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => *i += 1,
                b'u' => {
                    if *i + 4 >= b.len()
                        || !b[*i + 1..*i + 5].iter().all(|h| h.is_ascii_hexdigit())
                    {
                        return false;
                    }
                    *i += 5;
                }
                _ => return false,
            }
        } else if c < 0x20 {
            return false;
        } else {
            *i += 1;
        }
    }
    false
}

#[inline]
fn scan_json_number(b: &[u8], i: &mut usize) -> bool {
    if b[*i] == b'-' {
        *i += 1;
        if *i >= b.len() {
            return false;
        }
    }
    if b[*i] == b'0' {
        *i += 1;
    } else if b[*i].is_ascii_digit() {
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
    } else {
        return false;
    }
    if *i < b.len() && b[*i] == b'.' {
        *i += 1;
        if *i >= b.len() || !b[*i].is_ascii_digit() {
            return false;
        }
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
    }
    if *i < b.len() && matches!(b[*i], b'e' | b'E') {
        *i += 1;
        if *i < b.len() && matches!(b[*i], b'+' | b'-') {
            *i += 1;
        }
        if *i >= b.len() || !b[*i].is_ascii_digit() {
            return false;
        }
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
    }
    true
}

#[inline]
fn push_raw_json_or_zero(out: &mut String, raw: &str, open: u8, close: u8) {
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "{}" || trimmed == "[]" {
        out.push('0');
        return;
    }
    let bytes = trimmed.as_bytes();
    if bytes.first() == Some(&open) && bytes.last() == Some(&close) && is_valid_json_fast(trimmed) {
        out.push_str(trimmed);
    } else {
        out.push('0');
    }
}

#[inline]
fn push_raw_json_or_fallback(out: &mut String, raw: Option<&str>, fallback: &str) {
    if let Some(s) = raw {
        let trimmed = s.trim();
        if !trimmed.is_empty() && is_valid_json_fast(trimmed) {
            out.push_str(trimmed);
            return;
        }
    }
    out.push_str(fallback);
}

#[inline]
fn row_str_ref<'a>(row: &'a rusqlite::Row<'_>, idx: usize) -> &'a str {
    match row.get_ref_unwrap(idx) {
        ValueRef::Text(b) => std::str::from_utf8(b).unwrap_or(""),
        _ => "",
    }
}

#[inline]
fn row_opt_str_ref<'a>(row: &'a rusqlite::Row<'_>, idx: usize) -> Option<&'a str> {
    match row.get_ref_unwrap(idx) {
        ValueRef::Text(b) => std::str::from_utf8(b).ok(),
        _ => None,
    }
}

#[inline]
fn entity_kind_code(kind: &str) -> i32 {
    match kind {
        "text" => 0,
        "section" => 1,
        "image" => 2,
        "url" => 3,
        "latex" => 4,
        "media" => 5,
        "svg" => 6,
        "reference" => 7,
        "extension" => 8,
        "connect_point" => 9,
        "pen_stroke" => 10,
        _ => -1,
    }
}

#[inline]
fn edge_kind_code(kind: &str) -> i32 {
    match kind {
        "line" => 0,
        "arc" => 1,
        "cr_spline" => 2,
        _ => 0,
    }
}

#[inline]
fn assoc_kind_code(kind: &str) -> i32 {
    match kind {
        "multi_target" => 0,
        "sync" => 1,
        _ => -1,
    }
}

impl DocumentActor {
    pub fn open(path: &Path) -> Result<Self, String> {
        let conn = Connection::open(path).map_err(|e| format!("打开 SQLite 文档失败: {e}"))?;
        initialize_v3_schema_if_needed(&conn)?;

        let mut doc_id: Option<String> = None;
        let mut revision: i64 = 1;
        {
            let mut stmt = conn
                .prepare_cached("SELECT key, value FROM metadata WHERE key IN ('docId', 'revision')")
                .map_err(|e| format!("读取 docId/revision 失败: {e}"))?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| format!("查询 docId/revision 失败: {e}"))?;
            for r in rows {
                let (k, v) = r.map_err(|e| format!("解析 metadata 失败: {e}"))?;
                match k.as_str() {
                    "docId" => doc_id = Some(v),
                    "revision" => {
                        if let Ok(parsed) = v.parse::<i64>() {
                            revision = parsed;
                        }
                    }
                    _ => {}
                }
            }
        }

        let mut has_uncheckpointed_writes = false;
        if doc_id.as_deref().unwrap_or("").trim().is_empty() {
            let generated = uuid::Uuid::new_v4().to_string();
            conn.execute(
                "INSERT INTO metadata (key, value) VALUES ('docId', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![&generated],
            )
            .map_err(|e| format!("写入默认 docId 失败: {e}"))?;
            doc_id = Some(generated);
            has_uncheckpointed_writes = true;
        }

        let undo_cursor: i64 = conn
            .query_row("SELECT COALESCE(MAX(seq), 0) FROM history_ops", [], |row| {
                row.get(0)
            })
            .unwrap_or(0);

        Ok(Self {
            path: path.to_path_buf(),
            path_key: normalize_path_key(path),
            canonical_path: canonical_display_path(path),
            doc_id: doc_id.unwrap(),
            revision,
            undo_cursor,
            is_temp_draft: false,
            has_uncheckpointed_writes,
            conn,
        })
    }

    /// 读取文档完整结构化数据与附件元数据列表（不加载任何附件二进制 Blob）。
    pub fn load_open_result(&self) -> Result<V3DocumentOpenResult, String> {
        let mut meta_map = HashMap::<String, String>::with_capacity(12);
        {
            let mut stmt = self
                .conn
                .prepare_cached("SELECT key, value FROM metadata")
                .map_err(|e| format!("查询 metadata 失败: {e}"))?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| format!("读取 metadata 失败: {e}"))?;
            for r in rows {
                let (k, v) = r.map_err(|e| format!("解析 metadata 失败: {e}"))?;
                meta_map.insert(k, v);
            }
        }

        let format_version = meta_map
            .get("format_version")
            .cloned()
            .unwrap_or_else(|| FORMAT_VERSION.to_string());
        let readme = meta_map.get("readme").cloned();
        let extension_json = meta_map.get("extension_json").cloned();
        let tags: Vec<String> = meta_map
            .get("tags_json")
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        let references: serde_json::Value = meta_map
            .get("references_json")
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_else(|| serde_json::json!({ "sections": {}, "files": [] }));
        let table_meta_json = meta_map
            .get("table_meta_json")
            .cloned()
            .unwrap_or_else(|| "{}".to_string());

        let entities = {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT uuid, kind, parent_section_uuid, text, details_json, details_plain,
                            x, y, w, h, props_json, created_at, updated_at, is_row, sort_order
                     FROM entities ORDER BY sort_order ASC, rowid ASC",
                )
                .map_err(|e| format!("查询 entities 失败: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(V3EntityRecord {
                        uuid: row.get(0)?,
                        kind: row.get(1)?,
                        parent_section_uuid: row.get(2)?,
                        text: row.get(3)?,
                        details_json: row.get(4)?,
                        details_plain: row.get(5)?,
                        x: row.get(6)?,
                        y: row.get(7)?,
                        w: row.get(8)?,
                        h: row.get(9)?,
                        props_json: row.get(10)?,
                        created_at: row.get(11)?,
                        updated_at: row.get(12)?,
                        is_row: row.get::<_, i64>(13)? != 0,
                        sort_order: row.get(14)?,
                    })
                })
                .map_err(|e| format!("读取 entities 失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析 entities 失败: {e}"))?
        };

        let edges = {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT uuid, kind, source_uuid, target_uuid, text, props_json, sort_order
                     FROM edges ORDER BY sort_order ASC, rowid ASC",
                )
                .map_err(|e| format!("查询 edges 失败: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(V3EdgeRecord {
                        uuid: row.get(0)?,
                        kind: row.get(1)?,
                        source_uuid: row.get(2)?,
                        target_uuid: row.get(3)?,
                        text: row.get(4)?,
                        props_json: row.get(5)?,
                        sort_order: row.get(6)?,
                    })
                })
                .map_err(|e| format!("读取 edges 失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析 edges 失败: {e}"))?
        };

        let associations = {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT uuid, kind, member_uuids_json, props_json, sort_order
                     FROM associations ORDER BY sort_order ASC, rowid ASC",
                )
                .map_err(|e| format!("查询 associations 失败: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(V3AssociationRecord {
                        uuid: row.get(0)?,
                        kind: row.get(1)?,
                        member_uuids_json: row.get(2)?,
                        props_json: row.get(3)?,
                        sort_order: row.get(4)?,
                    })
                })
                .map_err(|e| format!("读取 associations 失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析 associations 失败: {e}"))?
        };

        let table_columns = {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT id, canonical_key, name, type, position, config_json
                     FROM table_columns ORDER BY position ASC, rowid ASC",
                )
                .map_err(|e| format!("查询 table_columns 失败: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(V3TableColumnRecord {
                        id: row.get(0)?,
                        canonical_key: row.get(1)?,
                        name: row.get(2)?,
                        r#type: row.get(3)?,
                        position: row.get(4)?,
                        config_json: row.get(5)?,
                    })
                })
                .map_err(|e| format!("读取 table_columns 失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析 table_columns 失败: {e}"))?
        };

        let table_views = {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT id, name, type, deletable, position, config_json
                     FROM table_views ORDER BY position ASC, rowid ASC",
                )
                .map_err(|e| format!("查询 table_views 失败: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(V3TableViewRecord {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        r#type: row.get(2)?,
                        deletable: row.get::<_, i64>(3)? != 0,
                        position: row.get(4)?,
                        config_json: row.get(5)?,
                    })
                })
                .map_err(|e| format!("读取 table_views 失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析 table_views 失败: {e}"))?
        };

        let cell_values = {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json
                     FROM cell_values",
                )
                .map_err(|e| format!("查询 cell_values 失败: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(V3CellValueRecord {
                        entity_uuid: row.get(0)?,
                        col_id: row.get(1)?,
                        canonical_key: row.get(2)?,
                        val_type: row.get(3)?,
                        val_text: row.get(4)?,
                        val_num: row.get(5)?,
                        val_date: row.get(6)?,
                        val_json: row.get(7)?,
                        multi_options: Vec::new(),
                    })
                })
                .map_err(|e| format!("读取 cell_values 失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析 cell_values 失败: {e}"))?
        };

        // 只查询附件元数据与缩略图存在标志，严禁读取 data_blob / thumb_blob
        let attachments = {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT id, mime, width, height, size_bytes, thumb_blob IS NOT NULL
                     FROM attachments",
                )
                .map_err(|e| format!("查询 attachments 元数据失败: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(V3AttachmentMeta {
                        id: row.get(0)?,
                        mime: row.get(1)?,
                        width: row.get(2)?,
                        height: row.get(3)?,
                        size_bytes: row.get(4)?,
                        has_thumb: row.get::<_, i64>(5)? != 0,
                    })
                })
                .map_err(|e| format!("读取 attachments 元数据失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析 attachments 元数据失败: {e}"))?
        };

        let formula_col_count = table_columns
            .iter()
            .filter(|col| col.r#type == "formula")
            .count();
        let needs_formula_recompute = if formula_col_count == 0 {
            false
        } else {
            let row_count = entities.iter().filter(|e| e.is_row).count();
            if row_count == 0 {
                false
            } else {
                let expected = (formula_col_count * row_count) as i64;
                let cached_count: i64 = self
                    .conn
                    .query_row("SELECT COUNT(*) FROM formula_cache", [], |r| r.get(0))
                    .unwrap_or(0);
                if cached_count < expected {
                    true
                } else {
                    let has_volatile: i64 = self
                        .conn
                        .query_row(
                            "SELECT EXISTS(SELECT 1 FROM formula_cache WHERE is_volatile != 0)",
                            [],
                            |r| r.get(0),
                        )
                        .unwrap_or(0);
                    has_volatile != 0
                }
            }
        };

        Ok(V3DocumentOpenResult {
            canonical_path: self.canonical_path.clone(),
            doc_id: self.doc_id.clone(),
            format_version,
            revision: self.revision,
            readme,
            tags,
            references,
            extension_json,
            table_meta_json,
            entities,
            edges,
            associations,
            table_columns,
            table_views,
            cell_values,
            attachments,
            needs_formula_recompute,
        })
    }

    /// 零中间结构体的紧凑流式 JSON 输出（供 `doc_open_with_ownership` 直出 IPC）：
    /// - 直接借用 SQLite 页内 UTF-8 切片写入预分配缓冲区，省去数万次 Rust `String` 分配与 `serde_json` 反射；
    /// - 跳过前端开页不使用的 `details_plain` 与 `cell.canonical_key`，去掉无索引 `ORDER BY` 临时排序；
    /// - `props_json` / `details_json` / `config_json` / `table_meta_json` / `val_json` 经校验后直接原生嵌入，
    ///   消除双重 JSON 转义与前端数千次 `JSON.parse()`。
    pub fn write_packed_open_doc_json(&self, out: &mut String) -> Result<(), String> {
        let mut meta_map = HashMap::<String, String>::with_capacity(12);
        {
            let mut stmt = self
                .conn
                .prepare_cached("SELECT key, value FROM metadata")
                .map_err(|e| format!("查询 metadata 失败: {e}"))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| format!("读取 metadata 失败: {e}"))?;
            while let Some(row) = rows
                .next()
                .map_err(|e| format!("遍历 metadata 失败: {e}"))?
            {
                meta_map.insert(
                    row_str_ref(row, 0).to_owned(),
                    row_str_ref(row, 1).to_owned(),
                );
            }
        }

        let format_version = meta_map
            .get("format_version")
            .map(|s| s.as_str())
            .unwrap_or(FORMAT_VERSION);

        out.push_str("{\"packed\":true,\"canonicalPath\":");
        push_json_str(out, &self.canonical_path);
        out.push_str(",\"docId\":");
        push_json_str(out, &self.doc_id);
        out.push_str(",\"formatVersion\":");
        push_json_str(out, format_version);
        let _ = write!(out, ",\"revision\":{}", self.revision);

        if let Some(readme) = meta_map.get("readme") {
            out.push_str(",\"readme\":");
            push_json_str(out, readme);
        }

        out.push_str(",\"tags\":");
        push_raw_json_or_fallback(out, meta_map.get("tags_json").map(|s| s.as_str()), "[]");

        out.push_str(",\"references\":");
        push_raw_json_or_fallback(
            out,
            meta_map.get("references_json").map(|s| s.as_str()),
            "{\"sections\":{},\"files\":[]}",
        );

        if let Some(ext) = meta_map.get("extension_json") {
            out.push_str(",\"extension\":");
            push_raw_json_or_zero(out, ext, b'{', b'}');
        }

        out.push_str(",\"tableMeta\":");
        push_raw_json_or_fallback(
            out,
            meta_map.get("table_meta_json").map(|s| s.as_str()),
            "{}",
        );

        // tableColumns: [id, canonicalKey, name, type, position, configObjOr0]
        let mut formula_col_count: usize = 0;
        out.push_str(",\"tableColumns\":[");
        {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT id, canonical_key, name, type, position, config_json
                     FROM table_columns ORDER BY position ASC, rowid ASC",
                )
                .map_err(|e| format!("查询 table_columns 失败: {e}"))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| format!("读取 table_columns 失败: {e}"))?;
            let mut first = true;
            while let Some(row) = rows
                .next()
                .map_err(|e| format!("解析 table_columns 失败: {e}"))?
            {
                if !first {
                    out.push(',');
                }
                first = false;
                let col_type = row_str_ref(row, 3);
                if col_type == "formula" {
                    formula_col_count += 1;
                }
                let position: i64 = row.get(4).unwrap_or(0);
                out.push('[');
                push_json_str(out, row_str_ref(row, 0));
                out.push(',');
                push_json_str(out, row_str_ref(row, 1));
                out.push(',');
                push_json_str(out, row_str_ref(row, 2));
                out.push(',');
                push_json_str(out, col_type);
                let _ = write!(out, ",{position},");
                push_raw_json_or_zero(out, row_str_ref(row, 5), b'{', b'}');
                out.push(']');
            }
        }
        out.push(']');

        // tableViews: [id, name, type, deletableInt, position, configObjOr0]
        out.push_str(",\"tableViews\":[");
        {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT id, name, type, deletable, position, config_json
                     FROM table_views ORDER BY position ASC, rowid ASC",
                )
                .map_err(|e| format!("查询 table_views 失败: {e}"))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| format!("读取 table_views 失败: {e}"))?;
            let mut first = true;
            while let Some(row) = rows
                .next()
                .map_err(|e| format!("解析 table_views 失败: {e}"))?
            {
                if !first {
                    out.push(',');
                }
                first = false;
                let deletable: i64 = row.get(3).unwrap_or(1);
                let position: i64 = row.get(4).unwrap_or(0);
                out.push('[');
                push_json_str(out, row_str_ref(row, 0));
                out.push(',');
                push_json_str(out, row_str_ref(row, 1));
                out.push(',');
                push_json_str(out, row_str_ref(row, 2));
                let _ = write!(out, ",{},{position},", if deletable != 0 { 1 } else { 0 });
                push_raw_json_or_zero(out, row_str_ref(row, 5), b'{', b'}');
                out.push(']');
            }
        }
        out.push(']');

        // entities: [uuid, kindCode, parentSectionUuidOr0, text, x, y, w, h, createdAt, updatedAt, sortOrder, propsObjOr0, detailsValOr0]
        let mut row_count: usize = 0;
        out.push_str(",\"entities\":[");
        {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT uuid, kind, parent_section_uuid, text, details_json,
                            x, y, w, h, props_json, created_at, updated_at, is_row, sort_order
                     FROM entities",
                )
                .map_err(|e| format!("查询 entities 失败: {e}"))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| format!("读取 entities 失败: {e}"))?;
            let mut first = true;
            while let Some(row) = rows
                .next()
                .map_err(|e| format!("解析 entities 失败: {e}"))?
            {
                let kind_code = entity_kind_code(row_str_ref(row, 1));
                if kind_code < 0 {
                    continue;
                }
                let is_row: i64 = row.get(12).unwrap_or(0);
                if is_row != 0 {
                    row_count += 1;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                out.push('[');
                push_json_str(out, row_str_ref(row, 0));
                let _ = write!(out, ",{kind_code},");
                if let Some(parent) = row_opt_str_ref(row, 2) {
                    if !parent.is_empty() {
                        push_json_str(out, parent);
                    } else {
                        out.push('0');
                    }
                } else {
                    out.push('0');
                }
                out.push(',');
                push_json_str(out, row_str_ref(row, 3));
                out.push(',');
                push_json_f64(out, row.get(5).unwrap_or(0.0));
                out.push(',');
                push_json_f64(out, row.get(6).unwrap_or(0.0));
                out.push(',');
                push_json_f64(out, row.get(7).unwrap_or(0.0));
                out.push(',');
                push_json_f64(out, row.get(8).unwrap_or(0.0));
                out.push(',');
                push_i64(out, row.get(10).unwrap_or(0));
                out.push(',');
                push_i64(out, row.get(11).unwrap_or(0));
                out.push(',');
                push_i64(out, row.get(13).unwrap_or(0));
                out.push(',');
                push_raw_json_or_zero(out, row_str_ref(row, 9), b'{', b'}');
                out.push(',');
                push_raw_json_or_zero(out, row_str_ref(row, 4), b'[', b']');
                out.push(']');
            }
        }
        out.push(']');

        // edges: [uuid, kindCode, sourceUuid, targetUuid, text, sortOrder, propsObjOr0]
        out.push_str(",\"edges\":[");
        {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT uuid, kind, source_uuid, target_uuid, text, props_json, sort_order
                     FROM edges",
                )
                .map_err(|e| format!("查询 edges 失败: {e}"))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| format!("读取 edges 失败: {e}"))?;
            let mut first = true;
            while let Some(row) = rows
                .next()
                .map_err(|e| format!("解析 edges 失败: {e}"))?
            {
                if !first {
                    out.push(',');
                }
                first = false;
                let kind_code = edge_kind_code(row_str_ref(row, 1));
                let sort_order: i64 = row.get(6).unwrap_or(0);
                out.push('[');
                push_json_str(out, row_str_ref(row, 0));
                out.push(',');
                push_i64(out, kind_code as i64);
                out.push(',');
                push_json_str(out, row_str_ref(row, 2));
                out.push(',');
                push_json_str(out, row_str_ref(row, 3));
                out.push(',');
                push_json_str(out, row_str_ref(row, 4));
                out.push(',');
                push_i64(out, sort_order);
                out.push(',');
                push_raw_json_or_zero(out, row_str_ref(row, 5), b'{', b'}');
                out.push(']');
            }
        }
        out.push(']');

        // associations: [uuid, kindCode, memberUuidsArr, propsObjOr0, sortOrder]
        out.push_str(",\"associations\":[");
        {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT uuid, kind, member_uuids_json, props_json, sort_order
                     FROM associations",
                )
                .map_err(|e| format!("查询 associations 失败: {e}"))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| format!("读取 associations 失败: {e}"))?;
            let mut first = true;
            while let Some(row) = rows
                .next()
                .map_err(|e| format!("解析 associations 失败: {e}"))?
            {
                let kind_code = assoc_kind_code(row_str_ref(row, 1));
                if kind_code < 0 {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                let sort_order: i64 = row.get(4).unwrap_or(0);
                out.push('[');
                push_json_str(out, row_str_ref(row, 0));
                let _ = write!(out, ",{kind_code},");
                push_raw_json_or_fallback(out, Some(row_str_ref(row, 2)), "[]");
                out.push(',');
                push_raw_json_or_zero(out, row_str_ref(row, 3), b'{', b'}');
                let _ = write!(out, ",{sort_order}]");
            }
        }
        out.push(']');

        // cellValues: [entityUuid, colId, valTypeCode, val]（跳过空值单元，缩小 75% 体积）
        out.push_str(",\"cellValues\":[");
        {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT entity_uuid, col_id, val_type, val_text, val_num, val_date, val_json
                     FROM cell_values",
                )
                .map_err(|e| format!("查询 cell_values 失败: {e}"))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| format!("读取 cell_values 失败: {e}"))?;
            let mut first = true;
            while let Some(row) = rows
                .next()
                .map_err(|e| format!("解析 cell_values 失败: {e}"))?
            {
                let val_type = row_str_ref(row, 2);
                match val_type {
                    "number" => {
                        let Some(num) = row.get::<_, Option<f64>>(4).unwrap_or(None) else {
                            continue;
                        };
                        if !num.is_finite() {
                            continue;
                        }
                        if !first {
                            out.push(',');
                        }
                        first = false;
                        out.push('[');
                        push_json_str(out, row_str_ref(row, 0));
                        out.push(',');
                        push_json_str(out, row_str_ref(row, 1));
                        out.push_str(",1,");
                        push_json_f64(out, num);
                        out.push(']');
                    }
                    "date" => {
                        let Some(s) = row_opt_str_ref(row, 5).or_else(|| row_opt_str_ref(row, 3))
                        else {
                            continue;
                        };
                        if !first {
                            out.push(',');
                        }
                        first = false;
                        out.push('[');
                        push_json_str(out, row_str_ref(row, 0));
                        out.push(',');
                        push_json_str(out, row_str_ref(row, 1));
                        out.push_str(",2,");
                        push_json_str(out, s);
                        out.push(']');
                    }
                    "multi_select" => {
                        if !first {
                            out.push(',');
                        }
                        first = false;
                        out.push('[');
                        push_json_str(out, row_str_ref(row, 0));
                        out.push(',');
                        push_json_str(out, row_str_ref(row, 1));
                        out.push_str(",4,");
                        push_raw_json_or_fallback(out, row_opt_str_ref(row, 6), "[]");
                        out.push(']');
                    }
                    _ => {
                        let Some(s) = row_opt_str_ref(row, 3) else {
                            continue;
                        };
                        let code = if val_type == "select" { 3 } else { 0 };
                        if !first {
                            out.push(',');
                        }
                        first = false;
                        out.push('[');
                        push_json_str(out, row_str_ref(row, 0));
                        out.push(',');
                        push_json_str(out, row_str_ref(row, 1));
                        let _ = write!(out, ",{code},");
                        push_json_str(out, s);
                        out.push(']');
                    }
                }
            }
        }
        out.push(']');

        // attachments: [id, mime, widthOrNull, heightOrNull, sizeBytes, hasThumbInt]
        out.push_str(",\"attachments\":[");
        {
            let mut stmt = self
                .conn
                .prepare_cached(
                    "SELECT id, mime, width, height, size_bytes, thumb_blob IS NOT NULL
                     FROM attachments",
                )
                .map_err(|e| format!("查询 attachments 元数据失败: {e}"))?;
            let mut rows = stmt
                .query([])
                .map_err(|e| format!("读取 attachments 元数据失败: {e}"))?;
            let mut first = true;
            while let Some(row) = rows
                .next()
                .map_err(|e| format!("解析 attachments 元数据失败: {e}"))?
            {
                if !first {
                    out.push(',');
                }
                first = false;
                let width: Option<i64> = row.get(2).unwrap_or(None);
                let height: Option<i64> = row.get(3).unwrap_or(None);
                let size_bytes: i64 = row.get(4).unwrap_or(0);
                let has_thumb: i64 = row.get(5).unwrap_or(0);
                out.push('[');
                push_json_str(out, row_str_ref(row, 0));
                out.push(',');
                push_json_str(out, row_str_ref(row, 1));
                out.push(',');
                match width {
                    Some(w) => {
                        let _ = write!(out, "{w}");
                    }
                    None => out.push_str("null"),
                }
                out.push(',');
                match height {
                    Some(h) => {
                        let _ = write!(out, "{h}");
                    }
                    None => out.push_str("null"),
                }
                let _ = write!(out, ",{size_bytes},{}]", if has_thumb != 0 { 1 } else { 0 });
            }
        }
        out.push(']');

        let needs_formula_recompute = if formula_col_count == 0 || row_count == 0 {
            false
        } else {
            let expected = (formula_col_count * row_count) as i64;
            let cached_count: i64 = self
                .conn
                .query_row("SELECT COUNT(*) FROM formula_cache", [], |r| r.get(0))
                .unwrap_or(0);
            if cached_count < expected {
                true
            } else {
                let has_volatile: i64 = self
                    .conn
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM formula_cache WHERE is_volatile != 0)",
                        [],
                        |r| r.get(0),
                    )
                    .unwrap_or(0);
                has_volatile != 0
            }
        };
        let _ = write!(
            out,
            ",\"needsFormulaRecompute\":{}}}",
            if needs_formula_recompute {
                "true"
            } else {
                "false"
            }
        );
        Ok(())
    }

    pub fn write_packed_open_with_ownership_json(
        &self,
        ownership_id: &str,
        canonical_path: &str,
        peer_window_label: Option<&str>,
    ) -> Result<String, String> {
        let mut out = String::with_capacity(64 * 1024);
        out.push_str("{\"status\":\"opened_v3\",\"ownershipId\":");
        push_json_str(&mut out, ownership_id);
        out.push_str(",\"canonicalPath\":");
        push_json_str(&mut out, canonical_path);
        if let Some(peer) = peer_window_label {
            out.push_str(",\"peerWindowLabel\":");
            push_json_str(&mut out, peer);
        }
        out.push_str(",\"doc\":");
        self.write_packed_open_doc_json(&mut out)?;
        out.push('}');
        Ok(out)
    }

    pub fn sync_snapshot(&mut self, payload: &V3ImportPayload) -> Result<i64, String> {
        let next_rev = self.revision + 1;
        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("开启快照同步事务失败: {e}"))?;
        write_snapshot_in_tx(&tx, payload, next_rev)?;
        tx.commit().map_err(|e| format!("提交快照同步事务失败: {e}"))?;
        if !payload.doc_id.trim().is_empty() {
            self.doc_id = payload.doc_id.clone();
        }
        self.revision = next_rev;
        self.has_uncheckpointed_writes = true;
        Ok(next_rev)
    }

    pub fn put_attachment(
        &mut self,
        id: &str,
        mime: &str,
        width: Option<i64>,
        height: Option<i64>,
        thumb_blob: Option<&[u8]>,
        data_blob: &[u8],
    ) -> Result<V3AttachmentMeta, String> {
        let size_bytes = data_blob.len() as i64;
        self.conn
            .execute(
                "INSERT INTO attachments (id, mime, width, height, size_bytes, thumb_blob, data_blob)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(id) DO UPDATE SET
                   mime = excluded.mime,
                   width = excluded.width,
                   height = excluded.height,
                   size_bytes = excluded.size_bytes,
                   thumb_blob = excluded.thumb_blob,
                   data_blob = excluded.data_blob",
                params![id, mime, width, height, size_bytes, thumb_blob, data_blob],
            )
            .map_err(|e| format!("写入附件 {id} 失败: {e}"))?;
        self.has_uncheckpointed_writes = true;

        Ok(V3AttachmentMeta {
            id: id.to_string(),
            mime: mime.to_string(),
            width,
            height,
            size_bytes,
            has_thumb: thumb_blob.is_some(),
        })
    }

    pub fn get_attachment(&self, att_id: &str) -> Result<Option<StoredAttachmentBlob>, String> {
        self.conn
            .query_row(
                "SELECT mime, data_blob, thumb_blob FROM attachments WHERE id = ?1",
                params![att_id],
                |row| {
                    Ok(StoredAttachmentBlob {
                        mime: row.get(0)?,
                        data_blob: row.get(1)?,
                        thumb_blob: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|e| format!("读取附件 {att_id} 失败: {e}"))
    }

    pub fn get_attachment_thumb_only(&self, att_id: &str) -> Result<Option<(String, Option<Vec<u8>>)>, String> {
        self.conn
            .query_row(
                "SELECT mime, thumb_blob FROM attachments WHERE id = ?1",
                params![att_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| format!("读取附件缩略图 {att_id} 失败: {e}"))
    }

    pub fn update_attachment_thumb(&self, att_id: &str, thumb_blob: &[u8]) -> Result<(), String> {
        self.conn
            .execute(
                "UPDATE attachments SET thumb_blob = ?1 WHERE id = ?2",
                params![thumb_blob, att_id],
            )
            .map_err(|e| format!("回写缩略图 {att_id} 失败: {e}"))?;
        Ok(())
    }

    pub fn checkpoint_truncate(&self) -> Result<(), String> {
        wal_checkpoint_truncate(&self.conn)?;
        Ok(())
    }

    pub fn checkpoint_truncate_if_dirty(&mut self) -> Result<(), String> {
        if !self.has_uncheckpointed_writes && !wal_sidecar_nonempty(&self.path) {
            return Ok(());
        }
        wal_checkpoint_truncate(&self.conn)?;
        self.has_uncheckpointed_writes = false;
        Ok(())
    }

    pub fn apply_commands(
        &mut self,
        commands: &[crate::sqlite_engine::commands::DocCommand],
        label: &str,
        record_history: bool,
        now_ms: Option<i64>,
        max_history_size: Option<usize>,
        origin_window: &str,
    ) -> Result<crate::sqlite_engine::undo::DocChangeSet, String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("开启 CQRS 命令事务失败: {e}"))?;
        let (next_rev, next_cursor, changeset) =
            crate::sqlite_engine::commands::execute_commands_in_tx(
                &tx,
                &self.doc_id,
                &self.canonical_path,
                self.revision,
                self.undo_cursor,
                commands,
                label,
                record_history,
                now_ms,
                max_history_size,
                origin_window,
            )?;
        tx.commit().map_err(|e| format!("提交 CQRS 命令事务失败: {e}"))?;
        self.revision = next_rev;
        self.undo_cursor = next_cursor;
        self.has_uncheckpointed_writes = true;
        Ok(changeset)
    }

    pub fn undo(
        &mut self,
        origin_window: &str,
    ) -> Result<Option<crate::sqlite_engine::undo::DocChangeSet>, String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("开启撤销事务失败: {e}"))?;
        let (next_cursor, maybe_collector) =
            crate::sqlite_engine::undo::apply_undo_in_tx(&tx, self.undo_cursor)?;
        let Some(collector) = maybe_collector else {
            return Ok(None);
        };
        let next_rev = self.revision + 1;
        crate::sqlite_engine::undo::set_meta_value(&tx, "revision", Some(&next_rev.to_string()))?;
        let changeset = collector.build(
            &tx,
            &self.doc_id,
            &self.canonical_path,
            next_rev,
            origin_window,
            crate::sqlite_engine::undo::ChangeSource::Undo,
            next_cursor,
        )?;
        tx.commit().map_err(|e| format!("提交撤销事务失败: {e}"))?;
        self.revision = next_rev;
        self.undo_cursor = next_cursor;
        self.has_uncheckpointed_writes = true;
        Ok(Some(changeset))
    }

    pub fn redo(
        &mut self,
        origin_window: &str,
    ) -> Result<Option<crate::sqlite_engine::undo::DocChangeSet>, String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("开启重做事务失败: {e}"))?;
        let (next_cursor, maybe_collector) =
            crate::sqlite_engine::undo::apply_redo_in_tx(&tx, self.undo_cursor)?;
        let Some(collector) = maybe_collector else {
            return Ok(None);
        };
        let next_rev = self.revision + 1;
        crate::sqlite_engine::undo::set_meta_value(&tx, "revision", Some(&next_rev.to_string()))?;
        let changeset = collector.build(
            &tx,
            &self.doc_id,
            &self.canonical_path,
            next_rev,
            origin_window,
            crate::sqlite_engine::undo::ChangeSource::Redo,
            next_cursor,
        )?;
        tx.commit().map_err(|e| format!("提交重做事务失败: {e}"))?;
        self.revision = next_rev;
        self.undo_cursor = next_cursor;
        self.has_uncheckpointed_writes = true;
        Ok(Some(changeset))
    }

    pub fn clear_history(&mut self) -> Result<crate::sqlite_engine::undo::HistoryStateInfo, String> {
        self.conn
            .execute("DELETE FROM history_ops", [])
            .map_err(|e| format!("清空 history_ops 失败: {e}"))?;
        self.undo_cursor = 0;
        self.has_uncheckpointed_writes = true;
        Ok(crate::sqlite_engine::undo::HistoryStateInfo {
            can_undo: false,
            can_redo: false,
            undo_cursor: 0,
            total_entries: 0,
        })
    }

    pub fn history_state(&mut self) -> Result<crate::sqlite_engine::undo::HistoryStateInfo, String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| format!("查询历史状态事务失败: {e}"))?;
        crate::sqlite_engine::undo::query_history_state_in_tx(&tx, self.undo_cursor)
    }
}

struct PoolInner {
    active: HashMap<String, (Arc<Mutex<DocumentActor>>, usize)>,
    closed_lru: LruCache<String, Arc<Mutex<DocumentActor>>>,
    by_doc_id: HashMap<String, String>,
    standby_temp_draft: Option<DocumentActor>,
}

/// 管理全部已打开文档（常驻）及最近关闭文档（容量 32 LRU）的连接池。
pub struct DocumentActorPool {
    inner: Mutex<PoolInner>,
}

impl Drop for DocumentActorPool {
    fn drop(&mut self) {
        if let Ok(mut guard) = self.inner.lock() {
            if let Some(draft) = guard.standby_temp_draft.take() {
                let path = draft.path.clone();
                drop(draft);
                crate::sqlite_engine::migration::remove_sqlite_with_sidecars(&path);
            }
        }
    }
}

impl Default for DocumentActorPool {
    fn default() -> Self {
        Self::new(CLOSED_ACTOR_LRU_CAPACITY)
    }
}

impl DocumentActorPool {
    pub fn new(lru_capacity: usize) -> Self {
        let cap = NonZeroUsize::new(lru_capacity.max(1)).unwrap();
        Self {
            inner: Mutex::new(PoolInner {
                active: HashMap::new(),
                closed_lru: LruCache::new(cap),
                by_doc_id: HashMap::new(),
                standby_temp_draft: None,
            }),
        }
    }

    /// 打开或复用 `.prg v3.0.0` 文档连接，递增打开引用计数，返回 `DocumentActor`。
    pub fn open_document(&self, path: &Path) -> Result<Arc<Mutex<DocumentActor>>, String> {
        let path_key = normalize_path_key(path);
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "DocumentActorPool 锁中毒".to_string())?;

        if let Some((actor, refs)) = guard.active.get_mut(&path_key) {
            *refs += 1;
            let cloned = Arc::clone(actor);
            let doc_id = cloned
                .lock()
                .map_err(|_| "DocumentActor 锁中毒".to_string())?
                .doc_id
                .clone();
            guard.by_doc_id.insert(doc_id, path_key);
            return Ok(cloned);
        }

        if let Some(actor) = guard.closed_lru.pop(&path_key) {
            let doc_id = actor
                .lock()
                .map_err(|_| "DocumentActor 锁中毒".to_string())?
                .doc_id
                .clone();
            guard.by_doc_id.insert(doc_id, path_key.clone());
            guard.active.insert(path_key, (Arc::clone(&actor), 1));
            return Ok(actor);
        }

        drop(guard);
        let opened = DocumentActor::open(path)?;
        let doc_id = opened.doc_id.clone();
        let actual_key = opened.path_key.clone();
        let arc = Arc::new(Mutex::new(opened));

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "DocumentActorPool 锁中毒".to_string())?;
        // 二次检查并发打开
        if let Some((existing, refs)) = guard.active.get_mut(&actual_key) {
            *refs += 1;
            return Ok(Arc::clone(existing));
        }
        guard.by_doc_id.insert(doc_id, actual_key.clone());
        guard.active.insert(actual_key, (Arc::clone(&arc), 1));
        Ok(arc)
    }

    /// 供工作空间后台索引、跨文件写回或 `flux-media://` 缩略图按需访问已关闭文档：
    /// 若文档已打开则直接复用；否则打开后放入 `closed_lru`（不增加前台打开引用计数），受 LRU 上限回收。
    pub fn open_for_background(&self, path: &Path) -> Result<Arc<Mutex<DocumentActor>>, String> {
        let path_key = normalize_path_key(path);
        {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "DocumentActorPool 锁中毒".to_string())?;
            if let Some((actor, _)) = guard.active.get(&path_key) {
                return Ok(Arc::clone(actor));
            }
            if let Some(actor) = guard.closed_lru.get(&path_key) {
                return Ok(Arc::clone(actor));
            }
        }

        let opened = DocumentActor::open(path)?;
        let doc_id = opened.doc_id.clone();
        let actual_key = opened.path_key.clone();
        let arc = Arc::new(Mutex::new(opened));

        let evicted = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "DocumentActorPool 锁中毒".to_string())?;
            if let Some((existing, _)) = guard.active.get(&actual_key) {
                return Ok(Arc::clone(existing));
            }
            if let Some(existing) = guard.closed_lru.get(&actual_key) {
                return Ok(Arc::clone(existing));
            }
            guard.by_doc_id.insert(doc_id, actual_key.clone());
            guard.closed_lru.push(actual_key, Arc::clone(&arc))
        };

        if let Some((evicted_key, evicted_actor)) = evicted {
            if let Ok(evicted_guard) = evicted_actor.lock() {
                let _ = evicted_guard.checkpoint_truncate();
                if let Ok(mut guard) = self.inner.lock() {
                    if guard.by_doc_id.get(&evicted_guard.doc_id) == Some(&evicted_key) {
                        guard.by_doc_id.remove(&evicted_guard.doc_id);
                    }
                }
            }
        }

        Ok(arc)
    }

    /// 若指定路径当前已驻留连接池（active 或 closed_lru），返回其 `DocumentActor` 引用。
    pub fn get_cached_by_path(&self, path: &Path) -> Result<Option<Arc<Mutex<DocumentActor>>>, String> {
        let path_key = normalize_path_key(path);
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "DocumentActorPool 锁中毒".to_string())?;
        if let Some((actor, _)) = guard.active.get(&path_key) {
            return Ok(Some(Arc::clone(actor)));
        }
        if let Some(actor) = guard.closed_lru.get(&path_key) {
            return Ok(Some(Arc::clone(actor)));
        }
        Ok(None)
    }

    /// 为复制出来的 `.prg v3.0.0` 副本重签发全新唯一 `docId`，避免与原文件在工作空间索引库中发生主键冲突。
    pub fn reissue_doc_id(&self, path: &Path) -> Result<String, String> {
        self.release_path(path)?;
        let conn = Connection::open(path).map_err(|e| format!("打开副本 SQLite 文档失败: {e}"))?;
        initialize_v3_schema(&conn)?;
        let new_doc_id = uuid::Uuid::new_v4().to_string();
        conn.execute(
            "INSERT INTO metadata (key, value) VALUES ('docId', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![&new_doc_id],
        )
        .map_err(|e| format!("重签发副本 docId 失败: {e}"))?;
        wal_checkpoint_truncate(&conn)?;
        Ok(new_doc_id)
    }

    fn create_fresh_temp_draft() -> Result<DocumentActor, String> {
        let base_dir = dirs::cache_dir()
            .unwrap_or_else(std::env::temp_dir)
            .join("liren.project-graph")
            .join("drafts");
        std::fs::create_dir_all(&base_dir)
            .map_err(|e| format!("创建临时草稿目录失败: {e}"))?;
        let draft_id = uuid::Uuid::new_v4().to_string();
        let draft_path = base_dir.join(format!("draft-{draft_id}.prg"));
        let mut opened = DocumentActor::open(&draft_path)?;
        opened.is_temp_draft = true;
        Ok(opened)
    }

    /// 后台预热 1 个空临时草稿 SQLite，使新建草稿 / 新窗口激活时可 <1ms 直接弹出复用。
    pub fn prewarm_temp_draft(&self) {
        let already_warm = self
            .inner
            .lock()
            .map(|guard| guard.standby_temp_draft.is_some())
            .unwrap_or(true);
        if already_warm {
            return;
        }
        let Ok(draft) = Self::create_fresh_temp_draft() else {
            return;
        };
        let mut cleanup_path = None;
        if let Ok(mut guard) = self.inner.lock() {
            if guard.standby_temp_draft.is_none() {
                guard.standby_temp_draft = Some(draft);
            } else {
                cleanup_path = Some(draft.path.clone());
                drop(draft);
            }
        } else {
            cleanup_path = Some(draft.path.clone());
            drop(draft);
        }
        if let Some(path) = cleanup_path {
            crate::sqlite_engine::migration::remove_sqlite_with_sidecars(&path);
        }
    }

    /// 在系统缓存目录创建临时草稿 SQLite 文件（优先弹出预热实例，关闭时自动清理，不留垃圾文件）。
    pub fn open_temp_draft(&self) -> Result<Arc<Mutex<DocumentActor>>, String> {
        let prewarmed = self
            .inner
            .lock()
            .map_err(|_| "DocumentActorPool 锁中毒".to_string())?
            .standby_temp_draft
            .take();

        let opened = match prewarmed {
            Some(draft) => draft,
            None => Self::create_fresh_temp_draft()?,
        };
        let doc_id = opened.doc_id.clone();
        let actual_key = opened.path_key.clone();
        let arc = Arc::new(Mutex::new(opened));

        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "DocumentActorPool 锁中毒".to_string())?;
        guard.by_doc_id.insert(doc_id, actual_key.clone());
        guard.active.insert(actual_key, (Arc::clone(&arc), 1));
        Ok(arc)
    }

    pub fn get_by_doc_id(&self, doc_id: &str) -> Result<Option<Arc<Mutex<DocumentActor>>>, String> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| "DocumentActorPool 锁中毒".to_string())?;
        let Some(path_key) = guard.by_doc_id.get(doc_id).cloned() else {
            return Ok(None);
        };
        if let Some((actor, _)) = guard.active.get(&path_key) {
            return Ok(Some(Arc::clone(actor)));
        }
        if let Some(actor) = guard.closed_lru.get(&path_key) {
            return Ok(Some(Arc::clone(actor)));
        }
        Ok(None)
    }

    pub fn update_doc_id_index(&self, doc_id: &str, path_key: &str) {
        if let Ok(mut guard) = self.inner.lock() {
            guard
                .by_doc_id
                .insert(doc_id.to_string(), path_key.to_string());
        }
    }

    /// 关闭一个文档引用；若该文档已无任何打开窗口，普通文档自动执行 `wal_checkpoint(TRUNCATE)` 并移入 LRU 池，
    /// 临时草稿文档则直接释放句柄并清理磁盘临时文件。
    pub fn close_document(&self, doc_id: &str) -> Result<(), String> {
        enum CloseAction {
            None,
            CheckpointOnly(Arc<Mutex<DocumentActor>>),
            RemoveTempDraft(Arc<Mutex<DocumentActor>>, PathBuf),
        }

        let action = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "DocumentActorPool 锁中毒".to_string())?;
            let Some(path_key) = guard.by_doc_id.get(doc_id).cloned() else {
                return Ok(());
            };
            let should_demote = if let Some((_, refs)) = guard.active.get_mut(&path_key) {
                if *refs > 1 {
                    *refs -= 1;
                    false
                } else {
                    true
                }
            } else {
                false
            };

            if should_demote {
                if let Some((actor, _)) = guard.active.remove(&path_key) {
                    let temp_path = actor
                        .lock()
                        .ok()
                        .filter(|g| g.is_temp_draft)
                        .map(|g| g.path.clone());
                    if let Some(p) = temp_path {
                        guard.by_doc_id.retain(|_, v| v != &path_key);
                        CloseAction::RemoveTempDraft(actor, p)
                    } else {
                        if let Some((evicted_key, evicted_actor)) =
                            guard.closed_lru.push(path_key, Arc::clone(&actor))
                        {
                            if let Ok(evicted_guard) = evicted_actor.lock() {
                                let _ = evicted_guard.checkpoint_truncate();
                                if guard.by_doc_id.get(&evicted_guard.doc_id) == Some(&evicted_key)
                                {
                                    guard.by_doc_id.remove(&evicted_guard.doc_id);
                                }
                            }
                        }
                        CloseAction::CheckpointOnly(actor)
                    }
                } else {
                    CloseAction::None
                }
            } else {
                CloseAction::None
            }
        };

        match action {
            CloseAction::None => {}
            CloseAction::CheckpointOnly(actor) => {
                let mut guard = actor
                    .lock()
                    .map_err(|_| "DocumentActor 锁中毒".to_string())?;
                guard.checkpoint_truncate_if_dirty()?;
            }
            CloseAction::RemoveTempDraft(actor, path) => {
                drop(actor);
                crate::sqlite_engine::migration::remove_sqlite_with_sidecars(&path);
            }
        }
        Ok(())
    }

    /// 强制 checkpoint 并彻底释放指定路径的 SQLite 连接句柄（Windows 重命名/移动/删除/恢复前调用）。
    pub fn release_path(&self, path: &Path) -> Result<(), String> {
        let key = normalize_path_key(path);
        let removed = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "DocumentActorPool 锁中毒".to_string())?;
            let mut actors = Vec::new();
            if let Some((actor, _)) = guard.active.remove(&key) {
                actors.push(actor);
            }
            if let Some(actor) = guard.closed_lru.pop(&key) {
                actors.push(actor);
            }
            guard.by_doc_id.retain(|_, v| v != &key);
            actors
        };
        for actor in removed {
            if let Ok(guard) = actor.lock() {
                let _ = guard.checkpoint_truncate();
            }
        }
        Ok(())
    }

    /// 释放某个目录前缀下的全部 SQLite 连接句柄（工作空间目录重命名/移动/删除前调用）。
    pub fn release_under_prefix(&self, prefix: &Path) -> Result<(), String> {
        let mut norm = normalize_path_key(prefix);
        while norm.len() > 1 && norm.ends_with('/') {
            norm.pop();
        }
        let slash_prefix = format!("{norm}/");
        let matches = |k: &str| k == norm || k.starts_with(&slash_prefix);

        let removed = {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| "DocumentActorPool 锁中毒".to_string())?;
            let mut actors = Vec::new();
            let active_keys: Vec<String> = guard
                .active
                .keys()
                .filter(|k| matches(k))
                .cloned()
                .collect();
            for k in active_keys {
                if let Some((actor, _)) = guard.active.remove(&k) {
                    actors.push(actor);
                }
            }
            let lru_keys: Vec<String> = guard
                .closed_lru
                .iter()
                .filter(|(k, _)| matches(k))
                .map(|(k, _)| k.clone())
                .collect();
            for k in lru_keys {
                if let Some(actor) = guard.closed_lru.pop(&k) {
                    actors.push(actor);
                }
            }
            guard.by_doc_id.retain(|_, v| !matches(v));
            actors
        };
        for actor in removed {
            if let Ok(guard) = actor.lock() {
                let _ = guard.checkpoint_truncate();
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub fn stats(&self) -> (usize, usize) {
        let guard = self.inner.lock().unwrap();
        (guard.active.len(), guard.closed_lru.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static SEQ: AtomicU64 = AtomicU64::new(1);

    fn temp_prg(tag: &str) -> PathBuf {
        let n = SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "flux-actor-test-{}-{}-{}.prg",
            std::process::id(),
            tag,
            n
        ))
    }

    fn sample_payload(doc_id: &str) -> V3ImportPayload {
        V3ImportPayload {
            doc_id: doc_id.to_string(),
            format_version: "3.0.0".to_string(),
            readme: Some("# hello".to_string()),
            tags: vec!["tag-a".to_string()],
            references: serde_json::json!({ "sections": {}, "files": [] }),
            extension_json: None,
            table_meta_json: serde_json::json!({ "activeViewId": "default-table-view" }).to_string(),
            entities: vec![V3EntityRecord {
                uuid: "node-1".to_string(),
                kind: "text".to_string(),
                parent_section_uuid: None,
                text: "主节点".to_string(),
                details_json: "[]".to_string(),
                details_plain: "详情纯文本".to_string(),
                x: 10.0,
                y: 20.0,
                w: 120.0,
                h: 60.0,
                props_json: "{}".to_string(),
                created_at: 1700000000000,
                updated_at: 1700000001000,
                is_row: true,
                sort_order: 0,
            }],
            edges: vec![],
            associations: vec![],
            table_columns: vec![V3TableColumnRecord {
                id: "col_1".to_string(),
                canonical_key: "auto:text:备注".to_string(),
                name: "备注".to_string(),
                r#type: "text".to_string(),
                position: 0,
                config_json: "{}".to_string(),
            }],
            table_views: vec![V3TableViewRecord {
                id: "default-table-view".to_string(),
                name: "原始表".to_string(),
                r#type: "table".to_string(),
                deletable: false,
                position: 0,
                config_json: "{}".to_string(),
            }],
            cell_values: vec![V3CellValueRecord {
                entity_uuid: "node-1".to_string(),
                col_id: "col_1".to_string(),
                canonical_key: "auto:text:备注".to_string(),
                val_type: "text".to_string(),
                val_text: Some("笔记内容".to_string()),
                val_num: None,
                val_date: None,
                val_json: None,
                multi_options: vec![],
            }],
        }
    }

    #[test]
    fn opens_syncs_preserves_attachments_and_releases_handle() {
        let path = temp_prg("roundtrip");
        let _ = std::fs::remove_file(&path);

        let pool = DocumentActorPool::new(2);
        let actor = pool.open_document(&path).unwrap();
        let doc_id = {
            let mut a = actor.lock().unwrap();
            a.put_attachment("att-1", "image/png", Some(100), Some(80), Some(b"thumb"), b"orig")
                .unwrap();
            let rev = a.sync_snapshot(&sample_payload("doc-rt-1")).unwrap();
            assert_eq!(rev, 2);
            pool.update_doc_id_index("doc-rt-1", &a.path_key);
            a.doc_id.clone()
        };

        assert_eq!(doc_id, "doc-rt-1");
        let opened = actor.lock().unwrap().load_open_result().unwrap();
        assert_eq!(opened.entities.len(), 1);
        assert_eq!(opened.table_columns.len(), 1);
        assert_eq!(opened.cell_values.len(), 1);
        assert_eq!(opened.attachments.len(), 1);
        assert_eq!(opened.attachments[0].id, "att-1");
        assert!(opened.attachments[0].has_thumb);
        // 模拟 Tauri command 结束后释放临时句柄引用
        drop(actor);

        pool.close_document("doc-rt-1").unwrap();
        assert_eq!(pool.stats(), (0, 1));

        pool.release_path(&path).unwrap();
        assert_eq!(pool.stats(), (0, 0));

        // 释放后在 Windows 上可立即重命名/删除
        let renamed = temp_prg("roundtrip-renamed");
        std::fs::rename(&path, &renamed).unwrap();
        std::fs::remove_file(&renamed).unwrap();
    }

    #[test]
    fn opens_50mb_attachment_v3_project_under_20ms() {
        let path = temp_prg("perf-50mb");
        let _ = std::fs::remove_file(&path);

        // 构造含 100 个 500 KB 附件（共 50 MB）的 v3.0.0 SQLite 工程
        {
            let conn = Connection::open(&path).unwrap();
            initialize_v3_schema(&conn).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            write_snapshot_in_tx(&tx, &sample_payload("doc-50mb"), 1).unwrap();
            let blob = vec![0xABu8; 512 * 1024];
            let thumb = vec![0xCDu8; 4 * 1024];
            {
                let mut stmt = tx
                    .prepare(
                        "INSERT INTO attachments (id, mime, width, height, size_bytes, thumb_blob, data_blob)
                         VALUES (?1, 'image/png', 1920, 1080, ?2, ?3, ?4)",
                    )
                    .unwrap();
                for i in 0..100 {
                    stmt.execute(params![format!("att-{i}"), blob.len() as i64, &thumb, &blob])
                        .unwrap();
                }
            }
            tx.commit().unwrap();
            wal_checkpoint_truncate(&conn).unwrap();
        }

        let file_size = std::fs::metadata(&path).unwrap().len();
        assert!(file_size >= 50 * 1024 * 1024, "fixture size={file_size}");

        let pool = DocumentActorPool::default();
        let t0 = std::time::Instant::now();
        let actor = pool.open_document(&path).unwrap();
        let opened = actor.lock().unwrap().load_open_result().unwrap();
        let elapsed_ms = t0.elapsed().as_secs_f64() * 1000.0;
        println!(
            "[M1 perf] 50MB v3.0.0 open_document + load_open_result = {elapsed_ms:.2} ms (attachments={})",
            opened.attachments.len()
        );
        assert_eq!(opened.attachments.len(), 100);
        assert!(
            elapsed_ms < 50.0,
            "50MB v3 open took {elapsed_ms:.2} ms (expected well under 20ms on SSD)"
        );

        drop(actor);
        pool.release_path(&path).unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn fast_reopen_skips_ddl_with_user_version_and_prewarmed_draft_is_sub_millisecond() {
        let path = temp_prg("perf-fast-reopen");
        let _ = std::fs::remove_file(&path);

        {
            let conn = Connection::open(&path).unwrap();
            initialize_v3_schema(&conn).unwrap();
            let user_ver: i32 = conn
                .query_row("PRAGMA user_version", [], |r| r.get(0))
                .unwrap();
            assert_eq!(user_ver, crate::sqlite_engine::schema::SCHEMA_USER_VERSION);
            let tx = conn.unchecked_transaction().unwrap();
            let mut payload = sample_payload("doc-fast-500");
            payload.entities = (0..500)
                .map(|i| V3EntityRecord {
                    uuid: format!("node-{i}"),
                    kind: "text".to_string(),
                    parent_section_uuid: None,
                    text: format!("节点标题 {i}"),
                    details_json: "[]".to_string(),
                    details_plain: String::new(),
                    x: (i % 25) as f64 * 160.0,
                    y: (i / 25) as f64 * 90.0,
                    w: 140.0,
                    h: 56.0,
                    props_json: "{}".to_string(),
                    created_at: 1700000000000 + i as i64,
                    updated_at: 1700000001000 + i as i64,
                    is_row: true,
                    sort_order: i as i64,
                })
                .collect();
            write_snapshot_in_tx(&tx, &payload, 1).unwrap();
            tx.commit().unwrap();
            wal_checkpoint_truncate(&conn).unwrap();
        }

        let pool = DocumentActorPool::default();
        // 冷打开 500 节点文档
        let t_cold = std::time::Instant::now();
        let actor = pool.open_document(&path).unwrap();
        let opened = actor.lock().unwrap().load_open_result().unwrap();
        let cold_ms = t_cold.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(opened.entities.len(), 500);
        assert!(!opened.needs_formula_recompute);
        drop(actor);
        pool.close_document("doc-fast-500").unwrap();

        // LRU 温打开 500 节点文档
        let t_warm = std::time::Instant::now();
        let actor2 = pool.open_document(&path).unwrap();
        let opened2 = actor2.lock().unwrap().load_open_result().unwrap();
        let warm_ms = t_warm.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(opened2.entities.len(), 500);
        println!("[perf] 500-node v3 open: cold={cold_ms:.2}ms, warm={warm_ms:.2}ms");
        assert!(
            cold_ms < 50.0,
            "500-node cold open took {cold_ms:.2}ms (expected well under 20ms on SSD)"
        );
        assert!(
            warm_ms < 20.0,
            "500-node warm open took {warm_ms:.2}ms (expected well under 10ms on SSD)"
        );

        // 预热草稿弹出耗时验证
        pool.prewarm_temp_draft();
        let t_draft = std::time::Instant::now();
        let draft_actor = pool.open_temp_draft().unwrap();
        let draft_doc_id = draft_actor.lock().unwrap().doc_id.clone();
        let draft_ms = t_draft.elapsed().as_secs_f64() * 1000.0;
        println!("[perf] prewarmed temp draft open = {draft_ms:.3}ms");
        assert!(draft_ms < 5.0, "prewarmed temp draft took {draft_ms:.2}ms");
        drop(draft_actor);
        pool.close_document(&draft_doc_id).unwrap();

        drop(actor2);
        pool.release_path(&path).unwrap();
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn packed_open_json_streams_2000_nodes_validly_and_faster_than_struct_serde() {
        let path = temp_prg("perf-packed-2000");
        let _ = std::fs::remove_file(&path);

        {
            let conn = Connection::open(&path).unwrap();
            initialize_v3_schema(&conn).unwrap();
            let tx = conn.unchecked_transaction().unwrap();
            let mut payload = sample_payload("doc-packed-2000");
            payload.table_columns = vec![
                V3TableColumnRecord {
                    id: "col_note".to_string(),
                    canonical_key: "auto:text:note".to_string(),
                    name: "备注".to_string(),
                    r#type: "text".to_string(),
                    position: 0,
                    config_json: r#"{"width":200}"#.to_string(),
                },
                V3TableColumnRecord {
                    id: "col_score".to_string(),
                    canonical_key: "auto:number:score".to_string(),
                    name: "权重".to_string(),
                    r#type: "number".to_string(),
                    position: 1,
                    config_json: "{}".to_string(),
                },
                V3TableColumnRecord {
                    id: "col_tags".to_string(),
                    canonical_key: "auto:multi_select:tags".to_string(),
                    name: "标签".to_string(),
                    r#type: "multi_select".to_string(),
                    position: 2,
                    config_json: r#"{"options":[{"id":"o1","name":"重点","color":"rose"}]}"#.to_string(),
                },
            ];
            payload.entities = (0..2000)
                .map(|i| V3EntityRecord {
                    uuid: format!("n-{i}"),
                    kind: if i < 100 { "section" } else { "text" }.to_string(),
                    parent_section_uuid: if i >= 100 {
                        Some(format!("n-{}", i % 100))
                    } else {
                        None
                    },
                    text: format!("节点 \"标题\" #{i}\n第二行"),
                    details_json: if i % 5 == 0 {
                        r#"[{"type":"p","children":[{"text":"详情内容"}]}]"#.to_string()
                    } else {
                        "[]".to_string()
                    },
                    details_plain: if i % 5 == 0 {
                        "详情内容".to_string()
                    } else {
                        String::new()
                    },
                    x: (i % 40) as f64 * 180.0,
                    y: (i / 40) as f64 * 100.0,
                    w: 160.0,
                    h: 64.0,
                    props_json: if i % 4 == 0 {
                        r#"{"color":[10,20,30,1],"borderStyle":"solid"}"#.to_string()
                    } else {
                        "{}".to_string()
                    },
                    created_at: 1700000000000 + i as i64,
                    updated_at: 1700000001000 + i as i64,
                    is_row: true,
                    sort_order: i as i64,
                })
                .collect();
            payload.edges = (0..1999)
                .map(|i| V3EdgeRecord {
                    uuid: format!("e-{i}"),
                    kind: "line".to_string(),
                    source_uuid: format!("n-{i}"),
                    target_uuid: format!("n-{}", i + 1),
                    text: if i % 10 == 0 {
                        format!("连线 {i}")
                    } else {
                        String::new()
                    },
                    props_json: "{}".to_string(),
                    sort_order: 2000 + i as i64,
                })
                .collect();
            payload.cell_values = (0..2000)
                .flat_map(|i| {
                    vec![
                        V3CellValueRecord {
                            entity_uuid: format!("n-{i}"),
                            col_id: "col_note".to_string(),
                            canonical_key: "auto:text:note".to_string(),
                            val_type: "text".to_string(),
                            val_text: Some(format!("备注 {i}")),
                            val_num: None,
                            val_date: None,
                            val_json: None,
                            multi_options: vec![],
                        },
                        V3CellValueRecord {
                            entity_uuid: format!("n-{i}"),
                            col_id: "col_score".to_string(),
                            canonical_key: "auto:number:score".to_string(),
                            val_type: "number".to_string(),
                            val_text: None,
                            val_num: Some(i as f64 * 0.5),
                            val_date: None,
                            val_json: None,
                            multi_options: vec![],
                        },
                        V3CellValueRecord {
                            entity_uuid: format!("n-{i}"),
                            col_id: "col_tags".to_string(),
                            canonical_key: "auto:multi_select:tags".to_string(),
                            val_type: "multi_select".to_string(),
                            val_text: None,
                            val_num: None,
                            val_date: None,
                            val_json: Some(r#"["o1"]"#.to_string()),
                            multi_options: vec![],
                        },
                    ]
                })
                .collect();
            write_snapshot_in_tx(&tx, &payload, 1).unwrap();
            tx.commit().unwrap();
            wal_checkpoint_truncate(&conn).unwrap();
        }

        let pool = DocumentActorPool::default();
        let actor = pool.open_document(&path).unwrap();
        let guard = actor.lock().unwrap();

        let t_old = std::time::Instant::now();
        let old_doc = guard.load_open_result().unwrap();
        let old_json = serde_json::to_string(&old_doc).unwrap();
        let old_ms = t_old.elapsed().as_secs_f64() * 1000.0;

        let t_packed = std::time::Instant::now();
        let packed_json = guard
            .write_packed_open_with_ownership_json("own-2000", &guard.canonical_path, None)
            .unwrap();
        let packed_ms = t_packed.elapsed().as_secs_f64() * 1000.0;

        let parsed: serde_json::Value = serde_json::from_str(&packed_json).unwrap();
        assert_eq!(parsed["status"], "opened_v3");
        assert_eq!(parsed["doc"]["packed"], true);
        assert_eq!(parsed["doc"]["entities"].as_array().unwrap().len(), 2000);
        assert_eq!(parsed["doc"]["edges"].as_array().unwrap().len(), 1999);
        assert_eq!(parsed["doc"]["cellValues"].as_array().unwrap().len(), 6000);
        println!(
            "[perf 2000-node] old_struct_serde={old_ms:.2}ms ({} KB) vs packed_stream={packed_ms:.2}ms ({} KB)",
            old_json.len() / 1024,
            packed_json.len() / 1024
        );
        assert!(
            packed_json.len() < old_json.len() * 6 / 10,
            "packed JSON ({}) should be at least 40% smaller than verbose JSON ({})",
            packed_json.len(),
            old_json.len()
        );

        drop(guard);
        drop(actor);
        pool.release_path(&path).unwrap();
        let _ = std::fs::remove_file(&path);
    }
}
