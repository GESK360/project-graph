use crate::sqlite_engine::document_actor::{
    sanitize_rtree_bounds, V3AssociationRecord, V3CellValueRecord, V3EdgeRecord, V3EntityRecord,
    V3MultiOptionEntry, V3TableColumnRecord, V3TableViewRecord,
};
use rusqlite::{params, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub const DEFAULT_MAX_HISTORY_OPS: usize = 500;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeSource {
    Command,
    Undo,
    Redo,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3CellKey {
    pub entity_uuid: String,
    pub col_id: String,
}

/// 精确行级补丁，同时作为 `history_ops` 中的 `undo_ops` / `redo_ops` 载荷。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum RowPatchOp {
    UpsertEntity {
        record: V3EntityRecord,
    },
    DeleteEntity {
        uuid: String,
    },
    UpsertEdge {
        record: V3EdgeRecord,
    },
    DeleteEdge {
        uuid: String,
    },
    UpsertAssociation {
        record: V3AssociationRecord,
    },
    DeleteAssociation {
        uuid: String,
    },
    UpsertCell {
        record: V3CellValueRecord,
    },
    DeleteCell {
        #[serde(rename = "entityUuid")]
        entity_uuid: String,
        #[serde(rename = "colId")]
        col_id: String,
    },
    UpsertColumn {
        record: V3TableColumnRecord,
    },
    DeleteColumn {
        id: String,
    },
    UpsertView {
        record: V3TableViewRecord,
    },
    DeleteView {
        id: String,
    },
    SetMeta {
        key: String,
        value: Option<String>,
    },
}

/// 提交命令或撤销/重做后返回的百字节级增量变更集，并用于跨窗口 `pg-doc-changeset` 原生广播。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocChangeSet {
    pub doc_id: String,
    pub canonical_path: String,
    pub revision: i64,
    pub origin_window: String,
    pub source: ChangeSource,
    pub dirty_entities: Vec<V3EntityRecord>,
    pub deleted_entity_uuids: Vec<String>,
    pub dirty_edges: Vec<V3EdgeRecord>,
    pub deleted_edge_uuids: Vec<String>,
    pub dirty_associations: Vec<V3AssociationRecord>,
    pub deleted_association_uuids: Vec<String>,
    pub dirty_cells: Vec<V3CellValueRecord>,
    pub deleted_cells: Vec<V3CellKey>,
    pub schema_changed: bool,
    pub table_columns: Option<Vec<V3TableColumnRecord>>,
    pub table_views: Option<Vec<V3TableViewRecord>>,
    pub table_meta_json: Option<String>,
    pub metadata_changed: bool,
    pub tags: Option<Vec<String>>,
    pub references: Option<serde_json::Value>,
    pub readme: Option<Option<String>>,
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_cursor: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStateInfo {
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_cursor: i64,
    pub total_entries: usize,
}

/// 收集单次事务内实际变更的行集合，事务提交前按需回查最新行组装 `DocChangeSet`。
#[derive(Default)]
pub struct ChangeCollector {
    pub dirty_entities: HashSet<String>,
    pub deleted_entities: HashSet<String>,
    pub dirty_edges: HashSet<String>,
    pub deleted_edges: HashSet<String>,
    pub dirty_associations: HashSet<String>,
    pub deleted_associations: HashSet<String>,
    pub dirty_cells: HashSet<(String, String)>,
    pub deleted_cells: HashSet<(String, String)>,
    pub schema_changed: bool,
    pub metadata_changed: bool,
}

impl ChangeCollector {
    pub fn mark_entity_dirty(&mut self, uuid: &str) {
        self.deleted_entities.remove(uuid);
        self.dirty_entities.insert(uuid.to_string());
    }

    pub fn mark_entity_deleted(&mut self, uuid: &str) {
        self.dirty_entities.remove(uuid);
        self.deleted_entities.insert(uuid.to_string());
        self.dirty_cells.retain(|(eu, _)| eu != uuid);
        self.deleted_cells.retain(|(eu, _)| eu != uuid);
    }

    pub fn mark_edge_dirty(&mut self, uuid: &str) {
        self.deleted_edges.remove(uuid);
        self.dirty_edges.insert(uuid.to_string());
    }

    pub fn mark_edge_deleted(&mut self, uuid: &str) {
        self.dirty_edges.remove(uuid);
        self.deleted_edges.insert(uuid.to_string());
    }

    pub fn mark_association_dirty(&mut self, uuid: &str) {
        self.deleted_associations.remove(uuid);
        self.dirty_associations.insert(uuid.to_string());
    }

    pub fn mark_association_deleted(&mut self, uuid: &str) {
        self.dirty_associations.remove(uuid);
        self.deleted_associations.insert(uuid.to_string());
    }

    pub fn mark_cell_dirty(&mut self, entity_uuid: &str, col_id: &str) {
        let key = (entity_uuid.to_string(), col_id.to_string());
        self.deleted_cells.remove(&key);
        self.dirty_cells.insert(key);
    }

    pub fn mark_cell_deleted(&mut self, entity_uuid: &str, col_id: &str) {
        let key = (entity_uuid.to_string(), col_id.to_string());
        self.dirty_cells.remove(&key);
        self.deleted_cells.insert(key);
    }

    pub fn build(
        &self,
        tx: &Transaction<'_>,
        doc_id: &str,
        canonical_path: &str,
        revision: i64,
        origin_window: &str,
        source: ChangeSource,
        undo_cursor: i64,
    ) -> Result<DocChangeSet, String> {
        let mut dirty_entities = Vec::with_capacity(self.dirty_entities.len());
        let mut entity_ids: Vec<&String> = self.dirty_entities.iter().collect();
        entity_ids.sort();
        for uuid in entity_ids {
            if let Some(rec) = load_entity_by_uuid(tx, uuid)? {
                dirty_entities.push(rec);
            }
        }
        let mut deleted_entity_uuids: Vec<String> = self.deleted_entities.iter().cloned().collect();
        deleted_entity_uuids.sort();

        let mut dirty_edges = Vec::with_capacity(self.dirty_edges.len());
        let mut edge_ids: Vec<&String> = self.dirty_edges.iter().collect();
        edge_ids.sort();
        for uuid in edge_ids {
            if let Some(rec) = load_edge_by_uuid(tx, uuid)? {
                dirty_edges.push(rec);
            }
        }
        let mut deleted_edge_uuids: Vec<String> = self.deleted_edges.iter().cloned().collect();
        deleted_edge_uuids.sort();

        let mut dirty_associations = Vec::with_capacity(self.dirty_associations.len());
        let mut assoc_ids: Vec<&String> = self.dirty_associations.iter().collect();
        assoc_ids.sort();
        for uuid in assoc_ids {
            if let Some(rec) = load_association_by_uuid(tx, uuid)? {
                dirty_associations.push(rec);
            }
        }
        let mut deleted_association_uuids: Vec<String> =
            self.deleted_associations.iter().cloned().collect();
        deleted_association_uuids.sort();

        let mut dirty_cells = Vec::with_capacity(self.dirty_cells.len());
        let mut cell_keys: Vec<&(String, String)> = self.dirty_cells.iter().collect();
        cell_keys.sort();
        for (entity_uuid, col_id) in cell_keys {
            if self.deleted_entities.contains(entity_uuid) {
                continue;
            }
            if let Some(rec) = load_cell_by_key(tx, entity_uuid, col_id)? {
                dirty_cells.push(rec);
            }
        }

        let mut deleted_cells: Vec<V3CellKey> = self
            .deleted_cells
            .iter()
            .filter(|(eu, _)| !self.deleted_entities.contains(eu))
            .map(|(entity_uuid, col_id)| V3CellKey {
                entity_uuid: entity_uuid.clone(),
                col_id: col_id.clone(),
            })
            .collect();
        deleted_cells.sort_by(|a, b| {
            a.entity_uuid
                .cmp(&b.entity_uuid)
                .then_with(|| a.col_id.cmp(&b.col_id))
        });

        let (table_columns, table_views, table_meta_json) = if self.schema_changed {
            (
                Some(load_all_table_columns(tx)?),
                Some(load_all_table_views(tx)?),
                Some(
                    load_meta_value(tx, "table_meta_json")?
                        .unwrap_or_else(|| "{}".to_string()),
                ),
            )
        } else {
            (None, None, None)
        };

        let (tags, references, readme) = if self.metadata_changed {
            let tags_val: Vec<String> = load_meta_value(tx, "tags_json")?
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_default();
            let refs_val: serde_json::Value = load_meta_value(tx, "references_json")?
                .and_then(|s| serde_json::from_str(&s).ok())
                .unwrap_or_else(|| serde_json::json!({ "sections": {}, "files": [] }));
            let readme_val = load_meta_value(tx, "readme")?;
            (Some(tags_val), Some(refs_val), Some(readme_val))
        } else {
            (None, None, None)
        };

        let history_state = query_history_state_in_tx(tx, undo_cursor)?;

        Ok(DocChangeSet {
            doc_id: doc_id.to_string(),
            canonical_path: canonical_path.to_string(),
            revision,
            origin_window: origin_window.to_string(),
            source,
            dirty_entities,
            deleted_entity_uuids,
            dirty_edges,
            deleted_edge_uuids,
            dirty_associations,
            deleted_association_uuids,
            dirty_cells,
            deleted_cells,
            schema_changed: self.schema_changed,
            table_columns,
            table_views,
            table_meta_json,
            metadata_changed: self.metadata_changed,
            tags,
            references,
            readme,
            can_undo: history_state.can_undo,
            can_redo: history_state.can_redo,
            undo_cursor: history_state.undo_cursor,
        })
    }
}

pub fn load_entity_by_uuid(
    tx: &Transaction<'_>,
    uuid: &str,
) -> Result<Option<V3EntityRecord>, String> {
    tx.query_row(
        "SELECT uuid, kind, parent_section_uuid, text, details_json, details_plain,
                x, y, w, h, props_json, created_at, updated_at, is_row, sort_order
         FROM entities WHERE uuid = ?1",
        params![uuid],
        |row| {
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
        },
    )
    .optional()
    .map_err(|e| format!("读取实体 {uuid} 失败: {e}"))
}

pub fn load_edge_by_uuid(tx: &Transaction<'_>, uuid: &str) -> Result<Option<V3EdgeRecord>, String> {
    tx.query_row(
        "SELECT uuid, kind, source_uuid, target_uuid, text, props_json, sort_order
         FROM edges WHERE uuid = ?1",
        params![uuid],
        |row| {
            Ok(V3EdgeRecord {
                uuid: row.get(0)?,
                kind: row.get(1)?,
                source_uuid: row.get(2)?,
                target_uuid: row.get(3)?,
                text: row.get(4)?,
                props_json: row.get(5)?,
                sort_order: row.get(6)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("读取边 {uuid} 失败: {e}"))
}

pub fn load_association_by_uuid(
    tx: &Transaction<'_>,
    uuid: &str,
) -> Result<Option<V3AssociationRecord>, String> {
    tx.query_row(
        "SELECT uuid, kind, member_uuids_json, props_json, sort_order
         FROM associations WHERE uuid = ?1",
        params![uuid],
        |row| {
            Ok(V3AssociationRecord {
                uuid: row.get(0)?,
                kind: row.get(1)?,
                member_uuids_json: row.get(2)?,
                props_json: row.get(3)?,
                sort_order: row.get(4)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("读取关联 {uuid} 失败: {e}"))
}

pub fn load_cell_multi_options(
    tx: &Transaction<'_>,
    entity_uuid: &str,
    col_id: &str,
) -> Result<Vec<V3MultiOptionEntry>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT option_id, option_name FROM cell_multi_options
             WHERE entity_uuid = ?1 AND col_id = ?2 ORDER BY option_id ASC",
        )
        .map_err(|e| format!("准备多选查询失败: {e}"))?;
    let rows = stmt
        .query_map(params![entity_uuid, col_id], |row| {
            Ok(V3MultiOptionEntry {
                option_id: row.get(0)?,
                option_name: row.get(1)?,
            })
        })
        .map_err(|e| format!("读取多选失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集多选失败: {e}"))
}

pub fn load_cell_by_key(
    tx: &Transaction<'_>,
    entity_uuid: &str,
    col_id: &str,
) -> Result<Option<V3CellValueRecord>, String> {
    let cell = tx
        .query_row(
            "SELECT entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json
             FROM cell_values WHERE entity_uuid = ?1 AND col_id = ?2",
            params![entity_uuid, col_id],
            |row| {
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
            },
        )
        .optional()
        .map_err(|e| format!("读取单元格 ({entity_uuid}, {col_id}) 失败: {e}"))?;

    match cell {
        Some(mut rec) => {
            if rec.val_type == "multi_select" {
                rec.multi_options = load_cell_multi_options(tx, entity_uuid, col_id)?;
            }
            Ok(Some(rec))
        }
        None => Ok(None),
    }
}

pub fn load_cells_for_entity(
    tx: &Transaction<'_>,
    entity_uuid: &str,
) -> Result<Vec<V3CellValueRecord>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json
             FROM cell_values WHERE entity_uuid = ?1",
        )
        .map_err(|e| format!("查询实体单元格失败: {e}"))?;
    let rows = stmt
        .query_map(params![entity_uuid], |row| {
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
        .map_err(|e| format!("迭代实体单元格失败: {e}"))?;
    let mut cells = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集实体单元格失败: {e}"))?;
    for cell in &mut cells {
        if cell.val_type == "multi_select" {
            cell.multi_options = load_cell_multi_options(tx, &cell.entity_uuid, &cell.col_id)?;
        }
    }
    Ok(cells)
}

pub fn load_cells_for_column(
    tx: &Transaction<'_>,
    col_id: &str,
) -> Result<Vec<V3CellValueRecord>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json
             FROM cell_values WHERE col_id = ?1",
        )
        .map_err(|e| format!("查询列单元格失败: {e}"))?;
    let rows = stmt
        .query_map(params![col_id], |row| {
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
        .map_err(|e| format!("迭代列单元格失败: {e}"))?;
    let mut cells = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集列单元格失败: {e}"))?;

    // 批量查回该列所有 multi_options
    let mut multi_map = HashMap::<String, Vec<V3MultiOptionEntry>>::new();
    {
        let mut mstmt = tx
            .prepare(
                "SELECT entity_uuid, option_id, option_name FROM cell_multi_options
                 WHERE col_id = ?1 ORDER BY option_id ASC",
            )
            .map_err(|e| format!("查询列多选索引失败: {e}"))?;
        let mrows = mstmt
            .query_map(params![col_id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    V3MultiOptionEntry {
                        option_id: row.get(1)?,
                        option_name: row.get(2)?,
                    },
                ))
            })
            .map_err(|e| format!("迭代列多选索引失败: {e}"))?;
        for r in mrows {
            let (eu, entry) = r.map_err(|e| format!("解析列多选索引失败: {e}"))?;
            multi_map.entry(eu).or_default().push(entry);
        }
    }
    for cell in &mut cells {
        if let Some(opts) = multi_map.remove(&cell.entity_uuid) {
            cell.multi_options = opts;
        }
    }
    Ok(cells)
}

pub fn load_column_by_id(
    tx: &Transaction<'_>,
    id: &str,
) -> Result<Option<V3TableColumnRecord>, String> {
    tx.query_row(
        "SELECT id, canonical_key, name, type, position, config_json FROM table_columns WHERE id = ?1",
        params![id],
        |row| {
            Ok(V3TableColumnRecord {
                id: row.get(0)?,
                canonical_key: row.get(1)?,
                name: row.get(2)?,
                r#type: row.get(3)?,
                position: row.get(4)?,
                config_json: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("读取列 {id} 失败: {e}"))
}

pub fn load_all_table_columns(tx: &Transaction<'_>) -> Result<Vec<V3TableColumnRecord>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT id, canonical_key, name, type, position, config_json
             FROM table_columns ORDER BY position ASC, rowid ASC",
        )
        .map_err(|e| format!("查询全部列失败: {e}"))?;
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
        .map_err(|e| format!("迭代全部列失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集全部列失败: {e}"))
}

pub fn load_view_by_id(
    tx: &Transaction<'_>,
    id: &str,
) -> Result<Option<V3TableViewRecord>, String> {
    tx.query_row(
        "SELECT id, name, type, deletable, position, config_json FROM table_views WHERE id = ?1",
        params![id],
        |row| {
            Ok(V3TableViewRecord {
                id: row.get(0)?,
                name: row.get(1)?,
                r#type: row.get(2)?,
                deletable: row.get::<_, i64>(3)? != 0,
                position: row.get(4)?,
                config_json: row.get(5)?,
            })
        },
    )
    .optional()
    .map_err(|e| format!("读取视图 {id} 失败: {e}"))
}

pub fn load_all_table_views(tx: &Transaction<'_>) -> Result<Vec<V3TableViewRecord>, String> {
    let mut stmt = tx
        .prepare(
            "SELECT id, name, type, deletable, position, config_json
             FROM table_views ORDER BY position ASC, rowid ASC",
        )
        .map_err(|e| format!("查询全部视图失败: {e}"))?;
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
        .map_err(|e| format!("迭代全部视图失败: {e}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("收集全部视图失败: {e}"))
}

pub fn load_meta_value(tx: &Transaction<'_>, key: &str) -> Result<Option<String>, String> {
    tx.query_row(
        "SELECT value FROM metadata WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| format!("读取 metadata[{key}] 失败: {e}"))
}

pub fn set_meta_value(
    tx: &Transaction<'_>,
    key: &str,
    value: Option<&str>,
) -> Result<(), String> {
    match value {
        Some(v) => {
            tx.execute(
                "INSERT INTO metadata (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, v],
            )
            .map_err(|e| format!("写入 metadata[{key}] 失败: {e}"))?;
        }
        None => {
            tx.execute("DELETE FROM metadata WHERE key = ?1", params![key])
                .map_err(|e| format!("删除 metadata[{key}] 失败: {e}"))?;
        }
    }
    Ok(())
}

/// 原子写入单条实体行并增量同步 R-Tree 与 FTS5 索引（保留现有单元格外键行）。
pub fn upsert_entity_row(tx: &Transaction<'_>, rec: &V3EntityRecord) -> Result<(), String> {
    tx.execute(
        "INSERT INTO entities (
            uuid, kind, parent_section_uuid, text, details_json, details_plain,
            x, y, w, h, props_json, created_at, updated_at, is_row, sort_order
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
         ON CONFLICT(uuid) DO UPDATE SET
            kind = excluded.kind,
            parent_section_uuid = excluded.parent_section_uuid,
            text = excluded.text,
            details_json = excluded.details_json,
            details_plain = excluded.details_plain,
            x = excluded.x,
            y = excluded.y,
            w = excluded.w,
            h = excluded.h,
            props_json = excluded.props_json,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            is_row = excluded.is_row,
            sort_order = excluded.sort_order",
        params![
            &rec.uuid,
            &rec.kind,
            &rec.parent_section_uuid,
            &rec.text,
            &rec.details_json,
            &rec.details_plain,
            rec.x,
            rec.y,
            rec.w,
            rec.h,
            &rec.props_json,
            rec.created_at,
            rec.updated_at,
            if rec.is_row { 1i64 } else { 0i64 },
            rec.sort_order,
        ],
    )
    .map_err(|e| format!("写入实体 {} 失败: {e}", rec.uuid))?;

    sync_entity_rtree_row(tx, &rec.uuid, rec.x, rec.y, rec.w, rec.h)?;
    sync_entity_fts_row(tx, &rec.uuid, &rec.text, &rec.details_plain)?;
    Ok(())
}

pub fn sync_entity_rtree_row(
    tx: &Transaction<'_>,
    uuid: &str,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let existing_id: Option<i64> = tx
        .query_row(
            "SELECT rtree_id FROM entity_rtree_map WHERE uuid = ?1",
            params![uuid],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| format!("查询 entity_rtree_map 失败: {e}"))?;

    let rtree_id = match existing_id {
        Some(id) => id,
        None => {
            tx.execute("INSERT INTO entity_rtree_map (uuid) VALUES (?1)", params![uuid])
                .map_err(|e| format!("写入 entity_rtree_map 失败: {e}"))?;
            tx.last_insert_rowid()
        }
    };
    let (min_x, max_x, min_y, max_y) = sanitize_rtree_bounds(x, y, w, h);
    tx.execute(
        "INSERT OR REPLACE INTO entities_rtree (id, min_x, max_x, min_y, max_y)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![rtree_id, min_x, max_x, min_y, max_y],
    )
    .map_err(|e| format!("更新 entities_rtree 失败: {e}"))?;
    Ok(())
}

pub fn sync_entity_fts_row(
    tx: &Transaction<'_>,
    uuid: &str,
    text: &str,
    details_plain: &str,
) -> Result<(), String> {
    tx.execute("DELETE FROM entities_fts WHERE uuid = ?1", params![uuid])
        .map_err(|e| format!("删除旧 FTS 行失败: {e}"))?;
    tx.execute(
        "INSERT INTO entities_fts (uuid, text, details_plain) VALUES (?1, ?2, ?3)",
        params![uuid, text, details_plain],
    )
    .map_err(|e| format!("写入 FTS 行失败: {e}"))?;
    Ok(())
}

pub fn delete_entity_row(tx: &Transaction<'_>, uuid: &str) -> Result<(), String> {
    if let Some(rtree_id) = tx
        .query_row(
            "SELECT rtree_id FROM entity_rtree_map WHERE uuid = ?1",
            params![uuid],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|e| format!("查询删除实体 R-Tree ID 失败: {e}"))?
    {
        tx.execute("DELETE FROM entities_rtree WHERE id = ?1", params![rtree_id])
            .map_err(|e| format!("删除 R-Tree 行失败: {e}"))?;
    }
    tx.execute("DELETE FROM entities_fts WHERE uuid = ?1", params![uuid])
        .map_err(|e| format!("删除 FTS 行失败: {e}"))?;
    tx.execute("DELETE FROM entities WHERE uuid = ?1", params![uuid])
        .map_err(|e| format!("删除实体 {uuid} 失败: {e}"))?;
    Ok(())
}

pub fn upsert_edge_row(tx: &Transaction<'_>, rec: &V3EdgeRecord) -> Result<(), String> {
    tx.execute(
        "INSERT INTO edges (uuid, kind, source_uuid, target_uuid, text, props_json, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(uuid) DO UPDATE SET
            kind = excluded.kind,
            source_uuid = excluded.source_uuid,
            target_uuid = excluded.target_uuid,
            text = excluded.text,
            props_json = excluded.props_json,
            sort_order = excluded.sort_order",
        params![
            &rec.uuid,
            &rec.kind,
            &rec.source_uuid,
            &rec.target_uuid,
            &rec.text,
            &rec.props_json,
            rec.sort_order,
        ],
    )
    .map_err(|e| format!("写入边 {} 失败: {e}", rec.uuid))?;
    Ok(())
}

pub fn delete_edge_row(tx: &Transaction<'_>, uuid: &str) -> Result<(), String> {
    tx.execute("DELETE FROM edges WHERE uuid = ?1", params![uuid])
        .map_err(|e| format!("删除边 {uuid} 失败: {e}"))?;
    Ok(())
}

pub fn upsert_association_row(
    tx: &Transaction<'_>,
    rec: &V3AssociationRecord,
) -> Result<(), String> {
    tx.execute(
        "INSERT INTO associations (uuid, kind, member_uuids_json, props_json, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(uuid) DO UPDATE SET
            kind = excluded.kind,
            member_uuids_json = excluded.member_uuids_json,
            props_json = excluded.props_json,
            sort_order = excluded.sort_order",
        params![
            &rec.uuid,
            &rec.kind,
            &rec.member_uuids_json,
            &rec.props_json,
            rec.sort_order,
        ],
    )
    .map_err(|e| format!("写入关联 {} 失败: {e}", rec.uuid))?;
    Ok(())
}

pub fn delete_association_row(tx: &Transaction<'_>, uuid: &str) -> Result<(), String> {
    tx.execute("DELETE FROM associations WHERE uuid = ?1", params![uuid])
        .map_err(|e| format!("删除关联 {uuid} 失败: {e}"))?;
    Ok(())
}

pub fn upsert_cell_row(tx: &Transaction<'_>, rec: &V3CellValueRecord) -> Result<(), String> {
    tx.execute(
        "INSERT OR REPLACE INTO cell_values (
            entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            &rec.entity_uuid,
            &rec.col_id,
            &rec.canonical_key,
            &rec.val_type,
            &rec.val_text,
            rec.val_num,
            &rec.val_date,
            &rec.val_json,
        ],
    )
    .map_err(|e| format!("写入单元格 ({}, {}) 失败: {e}", rec.entity_uuid, rec.col_id))?;

    tx.execute(
        "DELETE FROM cell_multi_options WHERE entity_uuid = ?1 AND col_id = ?2",
        params![&rec.entity_uuid, &rec.col_id],
    )
    .map_err(|e| format!("清理多选倒排索引失败: {e}"))?;

    for opt in &rec.multi_options {
        tx.execute(
            "INSERT OR REPLACE INTO cell_multi_options (entity_uuid, col_id, option_id, option_name)
             VALUES (?1, ?2, ?3, ?4)",
            params![&rec.entity_uuid, &rec.col_id, &opt.option_id, &opt.option_name],
        )
        .map_err(|e| format!("写入多选倒排索引失败: {e}"))?;
    }
    Ok(())
}

pub fn delete_cell_row(
    tx: &Transaction<'_>,
    entity_uuid: &str,
    col_id: &str,
) -> Result<(), String> {
    tx.execute(
        "DELETE FROM cell_multi_options WHERE entity_uuid = ?1 AND col_id = ?2",
        params![entity_uuid, col_id],
    )
    .map_err(|e| format!("删除多选倒排索引失败: {e}"))?;
    tx.execute(
        "DELETE FROM cell_values WHERE entity_uuid = ?1 AND col_id = ?2",
        params![entity_uuid, col_id],
    )
    .map_err(|e| format!("删除单元格 ({entity_uuid}, {col_id}) 失败: {e}"))?;
    Ok(())
}

pub fn upsert_column_row(tx: &Transaction<'_>, rec: &V3TableColumnRecord) -> Result<(), String> {
    tx.execute(
        "INSERT INTO table_columns (id, canonical_key, name, type, position, config_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            canonical_key = excluded.canonical_key,
            name = excluded.name,
            type = excluded.type,
            position = excluded.position,
            config_json = excluded.config_json",
        params![
            &rec.id,
            &rec.canonical_key,
            &rec.name,
            &rec.r#type,
            rec.position,
            &rec.config_json,
        ],
    )
    .map_err(|e| format!("写入列 {} 失败: {e}", rec.id))?;
    Ok(())
}

pub fn delete_column_row(tx: &Transaction<'_>, id: &str) -> Result<(), String> {
    tx.execute("DELETE FROM table_columns WHERE id = ?1", params![id])
        .map_err(|e| format!("删除列 {id} 失败: {e}"))?;
    Ok(())
}

pub fn upsert_view_row(tx: &Transaction<'_>, rec: &V3TableViewRecord) -> Result<(), String> {
    tx.execute(
        "INSERT INTO table_views (id, name, type, deletable, position, config_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            type = excluded.type,
            deletable = excluded.deletable,
            position = excluded.position,
            config_json = excluded.config_json",
        params![
            &rec.id,
            &rec.name,
            &rec.r#type,
            if rec.deletable { 1i64 } else { 0i64 },
            rec.position,
            &rec.config_json,
        ],
    )
    .map_err(|e| format!("写入视图 {} 失败: {e}", rec.id))?;
    Ok(())
}

pub fn delete_view_row(tx: &Transaction<'_>, id: &str) -> Result<(), String> {
    tx.execute("DELETE FROM table_views WHERE id = ?1", params![id])
        .map_err(|e| format!("删除视图 {id} 失败: {e}"))?;
    Ok(())
}

/// 在事务内顺序应用一组行级补丁，并登记到 `ChangeCollector`。
pub fn apply_row_patch_ops(
    tx: &Transaction<'_>,
    ops: &[RowPatchOp],
    collector: &mut ChangeCollector,
) -> Result<(), String> {
    for op in ops {
        match op {
            RowPatchOp::UpsertEntity { record } => {
                upsert_entity_row(tx, record)?;
                collector.mark_entity_dirty(&record.uuid);
            }
            RowPatchOp::DeleteEntity { uuid } => {
                delete_entity_row(tx, uuid)?;
                collector.mark_entity_deleted(uuid);
            }
            RowPatchOp::UpsertEdge { record } => {
                upsert_edge_row(tx, record)?;
                collector.mark_edge_dirty(&record.uuid);
            }
            RowPatchOp::DeleteEdge { uuid } => {
                delete_edge_row(tx, uuid)?;
                collector.mark_edge_deleted(uuid);
            }
            RowPatchOp::UpsertAssociation { record } => {
                upsert_association_row(tx, record)?;
                collector.mark_association_dirty(&record.uuid);
            }
            RowPatchOp::DeleteAssociation { uuid } => {
                delete_association_row(tx, uuid)?;
                collector.mark_association_deleted(uuid);
            }
            RowPatchOp::UpsertCell { record } => {
                upsert_cell_row(tx, record)?;
                collector.mark_cell_dirty(&record.entity_uuid, &record.col_id);
            }
            RowPatchOp::DeleteCell {
                entity_uuid,
                col_id,
            } => {
                delete_cell_row(tx, entity_uuid, col_id)?;
                collector.mark_cell_deleted(entity_uuid, col_id);
            }
            RowPatchOp::UpsertColumn { record } => {
                upsert_column_row(tx, record)?;
                collector.schema_changed = true;
            }
            RowPatchOp::DeleteColumn { id } => {
                // 级联删除该列下单元格之前记录清理标记
                let affected_entities: Vec<String> = {
                    let mut stmt = tx
                        .prepare("SELECT entity_uuid FROM cell_values WHERE col_id = ?1")
                        .map_err(|e| format!("查询删除列受影响实体失败: {e}"))?;
                    let rows = stmt
                        .query_map(params![id], |r| r.get(0))
                        .map_err(|e| format!("迭代删除列受影响实体失败: {e}"))?;
                    rows.collect::<Result<Vec<_>, _>>()
                        .map_err(|e| format!("收集删除列受影响实体失败: {e}"))?
                };
                for eu in affected_entities {
                    collector.mark_cell_deleted(&eu, id);
                }
                delete_column_row(tx, id)?;
                collector.schema_changed = true;
            }
            RowPatchOp::UpsertView { record } => {
                upsert_view_row(tx, record)?;
                collector.schema_changed = true;
            }
            RowPatchOp::DeleteView { id } => {
                delete_view_row(tx, id)?;
                collector.schema_changed = true;
            }
            RowPatchOp::SetMeta { key, value } => {
                set_meta_value(tx, key, value.as_deref())?;
                if key == "table_meta_json" {
                    collector.schema_changed = true;
                } else if matches!(key.as_str(), "tags_json" | "references_json" | "readme") {
                    collector.metadata_changed = true;
                }
            }
        }
    }
    Ok(())
}

pub fn query_history_state_in_tx(
    tx: &Transaction<'_>,
    undo_cursor: i64,
) -> Result<HistoryStateInfo, String> {
    let can_undo: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM history_ops WHERE seq <= ?1)",
            params![undo_cursor],
            |row| Ok(row.get::<_, i64>(0)? != 0),
        )
        .map_err(|e| format!("查询 can_undo 失败: {e}"))?;
    let can_redo: bool = tx
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM history_ops WHERE seq > ?1)",
            params![undo_cursor],
            |row| Ok(row.get::<_, i64>(0)? != 0),
        )
        .map_err(|e| format!("查询 can_redo 失败: {e}"))?;
    let total_entries: usize = tx
        .query_row("SELECT COUNT(*) FROM history_ops", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|e| format!("查询 history_ops 长度失败: {e}"))? as usize;

    Ok(HistoryStateInfo {
        can_undo,
        can_redo,
        undo_cursor,
        total_entries,
    })
}

/// 写入新一步行级历史，自动截断 `undo_cursor` 之后的 redo 分支并按上限裁剪。
pub fn append_history_entry_in_tx(
    tx: &Transaction<'_>,
    current_cursor: i64,
    label: &str,
    undo_ops: &[RowPatchOp],
    redo_ops: &[RowPatchOp],
    now_ms: i64,
    max_entries: usize,
) -> Result<i64, String> {
    tx.execute(
        "DELETE FROM history_ops WHERE seq > ?1",
        params![current_cursor],
    )
    .map_err(|e| format!("截断未来 redo 分支失败: {e}"))?;

    let tx_id = uuid::Uuid::new_v4().to_string();
    let undo_json = serde_json::to_string(undo_ops)
        .map_err(|e| format!("序列化 undo_ops 失败: {e}"))?;
    let redo_json = serde_json::to_string(redo_ops)
        .map_err(|e| format!("序列化 redo_ops 失败: {e}"))?;

    tx.execute(
        "INSERT INTO history_ops (tx_id, label, undo_ops_json, redo_ops_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![tx_id, label, undo_json, redo_json, now_ms],
    )
    .map_err(|e| format!("写入 history_ops 失败: {e}"))?;

    let new_cursor = tx.last_insert_rowid();

    if max_entries > 0 {
        let count: usize = tx
            .query_row("SELECT COUNT(*) FROM history_ops", [], |r| r.get::<_, i64>(0))
            .map_err(|e| format!("统计 history_ops 失败: {e}"))? as usize;
        if count > max_entries {
            let overflow = (count - max_entries) as i64;
            tx.execute(
                "DELETE FROM history_ops WHERE seq IN (
                    SELECT seq FROM history_ops ORDER BY seq ASC LIMIT ?1
                 )",
                params![overflow],
            )
            .map_err(|e| format!("裁剪旧 history_ops 失败: {e}"))?;
        }
    }

    Ok(new_cursor)
}

/// 在事务内执行一步撤销，返回 `(new_cursor, Some(ChangeCollector))`；若无可撤销项返回 `(current_cursor, None)`。
pub fn apply_undo_in_tx(
    tx: &Transaction<'_>,
    current_cursor: i64,
) -> Result<(i64, Option<ChangeCollector>), String> {
    let row: Option<(i64, String)> = tx
        .query_row(
            "SELECT seq, undo_ops_json FROM history_ops WHERE seq <= ?1 ORDER BY seq DESC LIMIT 1",
            params![current_cursor],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取撤销记录失败: {e}"))?;

    let Some((seq, undo_json)) = row else {
        return Ok((current_cursor, None));
    };

    let ops: Vec<RowPatchOp> = serde_json::from_str(&undo_json)
        .map_err(|e| format!("反序列化 undo_ops (seq={seq}) 失败: {e}"))?;
    let mut collector = ChangeCollector::default();
    apply_row_patch_ops(tx, &ops, &mut collector)?;

    let prev_cursor: i64 = tx
        .query_row(
            "SELECT COALESCE(MAX(seq), 0) FROM history_ops WHERE seq < ?1",
            params![seq],
            |r| r.get(0),
        )
        .map_err(|e| format!("计算前一撤销游标失败: {e}"))?;

    Ok((prev_cursor, Some(collector)))
}

/// 在事务内执行一步重做，返回 `(new_cursor, Some(ChangeCollector))`；若无可重做项返回 `(current_cursor, None)`。
pub fn apply_redo_in_tx(
    tx: &Transaction<'_>,
    current_cursor: i64,
) -> Result<(i64, Option<ChangeCollector>), String> {
    let row: Option<(i64, String)> = tx
        .query_row(
            "SELECT seq, redo_ops_json FROM history_ops WHERE seq > ?1 ORDER BY seq ASC LIMIT 1",
            params![current_cursor],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|e| format!("读取重做记录失败: {e}"))?;

    let Some((seq, redo_json)) = row else {
        return Ok((current_cursor, None));
    };

    let ops: Vec<RowPatchOp> = serde_json::from_str(&redo_json)
        .map_err(|e| format!("反序列化 redo_ops (seq={seq}) 失败: {e}"))?;
    let mut collector = ChangeCollector::default();
    apply_row_patch_ops(tx, &ops, &mut collector)?;

    Ok((seq, Some(collector)))
}
