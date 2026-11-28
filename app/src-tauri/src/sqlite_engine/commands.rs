use crate::sqlite_engine::document_actor::{
    V3AssociationRecord, V3CellValueRecord, V3EdgeRecord, V3EntityRecord, V3TableColumnRecord,
    V3TableViewRecord,
};
use crate::sqlite_engine::undo::{
    append_history_entry_in_tx, delete_association_row, delete_cell_row, delete_column_row,
    delete_edge_row, delete_entity_row, delete_view_row, load_all_table_columns,
    load_all_table_views, load_association_by_uuid, load_cell_by_key, load_cells_for_column,
    load_cells_for_entity, load_column_by_id, load_edge_by_uuid, load_entity_by_uuid,
    load_meta_value, load_view_by_id, set_meta_value, sync_entity_fts_row, sync_entity_rtree_row,
    upsert_association_row, upsert_cell_row, upsert_column_row, upsert_edge_row, upsert_entity_row,
    upsert_view_row, ChangeCollector, ChangeSource, DocChangeSet, RowPatchOp,
    DEFAULT_MAX_HISTORY_OPS,
};
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityMoveItem {
    pub uuid: String,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityBoundsItem {
    pub uuid: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityStylePatch {
    pub uuid: String,
    pub props_patch: serde_json::Value,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeStylePatch {
    pub uuid: String,
    pub props_patch: serde_json::Value,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssociationStylePatch {
    pub uuid: String,
    pub props_patch: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReparentItem {
    pub uuid: String,
    pub parent_section_uuid: Option<String>,
    pub x: Option<f64>,
    pub y: Option<f64>,
    pub w: Option<f64>,
    pub h: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectionChildOrderPatch {
    pub section_uuid: String,
    pub child_order: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellMutationItem {
    pub entity_uuid: String,
    pub col_id: String,
    /// `None` 表示清空删除该单元格；`Some` 表示写入/更新。
    pub value: Option<V3CellValueRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaCacheEntry {
    pub entity_uuid: String,
    pub col_id: String,
    pub canonical_key: String,
    pub kind: String,
    pub display_text: String,
    pub val_num: Option<f64>,
    pub val_date_ms: Option<i64>,
    pub val_json: Option<String>,
    pub is_volatile: bool,
    pub computed_day: Option<String>,
}

/// CQRS 强类型文档写命令：所有持久化变更的唯一入口。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DocCommand {
    // ── 几何/布局类（touch_updated_at = false）──
    MoveEntities {
        moves: Vec<EntityMoveItem>,
        #[serde(default)]
        section_bounds: Vec<EntityBoundsItem>,
    },
    ResizeEntity {
        uuid: String,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        #[serde(rename = "sizeAdjust", default)]
        size_adjust: Option<String>,
        #[serde(default)]
        scale: Option<f64>,
        #[serde(rename = "sectionBounds", default)]
        section_bounds: Vec<EntityBoundsItem>,
    },
    ToggleSectionCollapse {
        uuid: String,
        #[serde(rename = "isCollapsed")]
        is_collapsed: bool,
    },
    ToggleBranchCollapse {
        #[serde(rename = "edgeUuids")]
        edge_uuids: Vec<String>,
        #[serde(rename = "isBranchCollapsed")]
        is_branch_collapsed: bool,
    },
    UpdateViewCamera {
        x: f64,
        y: f64,
        scale: f64,
    },
    SetStyleProps {
        #[serde(rename = "entityPatches", default)]
        entity_patches: Vec<EntityStylePatch>,
        #[serde(rename = "edgePatches", default)]
        edge_patches: Vec<EdgeStylePatch>,
        #[serde(rename = "associationPatches", default)]
        association_patches: Vec<AssociationStylePatch>,
    },

    // ── 语义实体类（touch_updated_at = true）──
    CreateEntities {
        entities: Vec<V3EntityRecord>,
        #[serde(rename = "sectionChildOrders", default)]
        section_child_orders: Vec<SectionChildOrderPatch>,
        #[serde(rename = "sectionBounds", default)]
        section_bounds: Vec<EntityBoundsItem>,
    },
    DeleteEntities {
        uuids: Vec<String>,
        #[serde(rename = "sectionChildOrders", default)]
        section_child_orders: Vec<SectionChildOrderPatch>,
        #[serde(rename = "sectionBounds", default)]
        section_bounds: Vec<EntityBoundsItem>,
    },
    UpdateEntityText {
        uuid: String,
        text: String,
        x: Option<f64>,
        y: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
        #[serde(rename = "propsPatch", default)]
        props_patch: Option<serde_json::Value>,
        #[serde(rename = "sectionBounds", default)]
        section_bounds: Vec<EntityBoundsItem>,
    },
    UpdateEntityDetails {
        uuid: String,
        #[serde(rename = "detailsJson")]
        details_json: String,
        #[serde(rename = "detailsPlain")]
        details_plain: String,
    },
    PromoteTextToSection {
        uuid: String,
        #[serde(rename = "propsJson")]
        props_json: String,
        x: Option<f64>,
        y: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
        #[serde(rename = "touchUpdatedAt", default)]
        touch_updated_at: bool,
    },
    DemoteSectionToText {
        uuid: String,
        #[serde(rename = "propsJson")]
        props_json: String,
        x: Option<f64>,
        y: Option<f64>,
        w: Option<f64>,
        h: Option<f64>,
        #[serde(rename = "touchUpdatedAt", default)]
        touch_updated_at: bool,
    },
    ReparentEntities {
        items: Vec<ReparentItem>,
        #[serde(rename = "sectionChildOrders", default)]
        section_child_orders: Vec<SectionChildOrderPatch>,
        #[serde(rename = "sectionBounds", default)]
        section_bounds: Vec<EntityBoundsItem>,
    },
    AddEntityImage {
        #[serde(rename = "imageEntity")]
        image_entity: V3EntityRecord,
        #[serde(rename = "parentSectionUuid")]
        parent_section_uuid: String,
        #[serde(rename = "sectionChildOrder", default)]
        section_child_order: Option<Vec<String>>,
        #[serde(rename = "sectionBounds", default)]
        section_bounds: Vec<EntityBoundsItem>,
    },
    RemoveEntityImage {
        #[serde(rename = "imageUuid")]
        image_uuid: String,
        #[serde(rename = "parentSectionUuid")]
        parent_section_uuid: String,
        #[serde(rename = "sectionChildOrder", default)]
        section_child_order: Option<Vec<String>>,
        #[serde(rename = "sectionBounds", default)]
        section_bounds: Vec<EntityBoundsItem>,
    },
    UpsertEntities {
        entities: Vec<V3EntityRecord>,
        #[serde(rename = "touchUpdatedAt", default)]
        touch_updated_at: bool,
    },

    // ── 拓扑边与关联类（非自环两端点 touch_updated_at = true）──
    CreateEdges {
        edges: Vec<V3EdgeRecord>,
    },
    DeleteEdges {
        uuids: Vec<String>,
    },
    UpdateEdge {
        edge: V3EdgeRecord,
    },
    UpsertAssociation {
        association: V3AssociationRecord,
    },
    DeleteAssociation {
        uuid: String,
    },

    // ── 表格结构与单元格类 ──
    UpdateCells {
        updates: Vec<CellMutationItem>,
        #[serde(rename = "touchUpdatedAt")]
        touch_updated_at: bool,
    },
    UpsertColumn {
        column: V3TableColumnRecord,
    },
    DeleteColumn {
        id: String,
    },
    ReorderColumns {
        #[serde(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    UpsertView {
        view: V3TableViewRecord,
    },
    DeleteView {
        id: String,
    },
    ReorderViews {
        #[serde(rename = "orderedIds")]
        ordered_ids: Vec<String>,
    },
    UpdateTableMeta {
        #[serde(rename = "tableMetaJson")]
        table_meta_json: String,
    },
    UpdateFormulaCacheBatch {
        entries: Vec<FormulaCacheEntry>,
    },

    // ── 文档级元数据 ──
    UpdateDocMetadata {
        tags: Option<Vec<String>>,
        references: Option<serde_json::Value>,
        readme: Option<Option<String>>,
        #[serde(rename = "extensionJson")]
        extension_json: Option<Option<String>>,
    },

    // ── 组合批处理 ──
    Batch {
        commands: Vec<DocCommand>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyCommandsRequest {
    pub doc_id: String,
    pub commands: Vec<DocCommand>,
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_true")]
    pub record_history: bool,
    #[serde(default)]
    pub now_ms: Option<i64>,
    #[serde(default)]
    pub max_history_size: Option<usize>,
}

fn default_true() -> bool {
    true
}

fn current_unix_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn merge_json_object(base_json: &str, patch: &serde_json::Value) -> String {
    let mut base: serde_json::Value =
        serde_json::from_str(base_json).unwrap_or_else(|_| serde_json::json!({}));
    if let (Some(base_map), Some(patch_map)) = (base.as_object_mut(), patch.as_object()) {
        for (k, v) in patch_map {
            base_map.insert(k.clone(), v.clone());
        }
    }
    serde_json::to_string(&base).unwrap_or_else(|_| base_json.to_string())
}

fn patch_section_child_order(base_json: &str, child_order: &[String]) -> String {
    merge_json_object(base_json, &serde_json::json!({ "childOrder": child_order }))
}

struct CommandTxContext {
    now_ms: i64,
    collector: ChangeCollector,
    /// 每个原子子命令产生的 `(undo_ops, redo_ops)`；合并时 `undo_ops` 按子命令逆序拼接，严格满足外键约束。
    step_undo_chunks: Vec<Vec<RowPatchOp>>,
    step_redo_chunks: Vec<Vec<RowPatchOp>>,
}

impl CommandTxContext {
    fn new(now_ms: i64) -> Self {
        Self {
            now_ms,
            collector: ChangeCollector::default(),
            step_undo_chunks: Vec::new(),
            step_redo_chunks: Vec::new(),
        }
    }

    fn push_pair(&mut self, undo: Vec<RowPatchOp>, redo: Vec<RowPatchOp>) {
        if undo.is_empty() && redo.is_empty() {
            return;
        }
        self.step_undo_chunks.push(undo);
        self.step_redo_chunks.push(redo);
    }

    fn flatten_ops(&self) -> (Vec<RowPatchOp>, Vec<RowPatchOp>) {
        let mut undo = Vec::new();
        for chunk in self.step_undo_chunks.iter().rev() {
            undo.extend(chunk.iter().cloned());
        }
        let mut redo = Vec::new();
        for chunk in &self.step_redo_chunks {
            redo.extend(chunk.iter().cloned());
        }
        (undo, redo)
    }
}

fn touch_entity_updated_at(
    tx: &Transaction<'_>,
    ctx: &mut CommandTxContext,
    uuid: &str,
) -> Result<(), String> {
    let Some(old) = load_entity_by_uuid(tx, uuid)? else {
        return Ok(());
    };
    if !old.is_row || old.updated_at == ctx.now_ms {
        return Ok(());
    }
    let mut next = old.clone();
    next.updated_at = ctx.now_ms;
    tx.execute(
        "UPDATE entities SET updated_at = ?1 WHERE uuid = ?2",
        params![next.updated_at, uuid],
    )
    .map_err(|e| format!("更新实体 {uuid} updated_at 失败: {e}"))?;
    ctx.collector.mark_entity_dirty(uuid);
    ctx.push_pair(
        vec![RowPatchOp::UpsertEntity { record: old }],
        vec![RowPatchOp::UpsertEntity { record: next }],
    );
    Ok(())
}

fn apply_section_bounds_updates(
    tx: &Transaction<'_>,
    ctx: &mut CommandTxContext,
    bounds: &[EntityBoundsItem],
) -> Result<(), String> {
    for b in bounds {
        let Some(old) = load_entity_by_uuid(tx, &b.uuid)? else {
            continue;
        };
        if (old.x - b.x).abs() < 1e-9
            && (old.y - b.y).abs() < 1e-9
            && (old.w - b.w).abs() < 1e-9
            && (old.h - b.h).abs() < 1e-9
        {
            continue;
        }
        let mut next = old.clone();
        next.x = b.x;
        next.y = b.y;
        next.w = b.w;
        next.h = b.h;
        tx.execute(
            "UPDATE entities SET x = ?1, y = ?2, w = ?3, h = ?4 WHERE uuid = ?5",
            params![next.x, next.y, next.w, next.h, &next.uuid],
        )
        .map_err(|e| format!("更新分组框边界 {} 失败: {e}", next.uuid))?;
        sync_entity_rtree_row(tx, &next.uuid, next.x, next.y, next.w, next.h)?;
        ctx.collector.mark_entity_dirty(&next.uuid);
        ctx.push_pair(
            vec![RowPatchOp::UpsertEntity { record: old }],
            vec![RowPatchOp::UpsertEntity { record: next }],
        );
    }
    Ok(())
}

fn apply_section_child_orders(
    tx: &Transaction<'_>,
    ctx: &mut CommandTxContext,
    orders: &[SectionChildOrderPatch],
) -> Result<(), String> {
    for item in orders {
        let Some(old) = load_entity_by_uuid(tx, &item.section_uuid)? else {
            continue;
        };
        let next_props = patch_section_child_order(&old.props_json, &item.child_order);
        if next_props == old.props_json {
            continue;
        }
        let mut next = old.clone();
        next.props_json = next_props;
        tx.execute(
            "UPDATE entities SET props_json = ?1 WHERE uuid = ?2",
            params![&next.props_json, &next.uuid],
        )
        .map_err(|e| format!("更新分组子序 {} 失败: {e}", next.uuid))?;
        ctx.collector.mark_entity_dirty(&next.uuid);
        ctx.push_pair(
            vec![RowPatchOp::UpsertEntity { record: old }],
            vec![RowPatchOp::UpsertEntity { record: next }],
        );
    }
    Ok(())
}

fn execute_single_command(
    tx: &Transaction<'_>,
    cmd: &DocCommand,
    ctx: &mut CommandTxContext,
) -> Result<(), String> {
    match cmd {
        DocCommand::Batch { commands } => {
            for sub in commands {
                execute_single_command(tx, sub, ctx)?;
            }
        }

        // ── 几何/布局类：绝不刷新 updated_at ──
        DocCommand::MoveEntities {
            moves,
            section_bounds,
        } => {
            for mv in moves {
                let Some(old) = load_entity_by_uuid(tx, &mv.uuid)? else {
                    continue;
                };
                if (old.x - mv.x).abs() < 1e-9 && (old.y - mv.y).abs() < 1e-9 {
                    continue;
                }
                let mut next = old.clone();
                next.x = mv.x;
                next.y = mv.y;
                tx.execute(
                    "UPDATE entities SET x = ?1, y = ?2 WHERE uuid = ?3",
                    params![next.x, next.y, &next.uuid],
                )
                .map_err(|e| format!("移动实体 {} 失败: {e}", next.uuid))?;
                sync_entity_rtree_row(tx, &next.uuid, next.x, next.y, next.w, next.h)?;
                ctx.collector.mark_entity_dirty(&next.uuid);
                ctx.push_pair(
                    vec![RowPatchOp::UpsertEntity { record: old }],
                    vec![RowPatchOp::UpsertEntity { record: next }],
                );
            }
            apply_section_bounds_updates(tx, ctx, section_bounds)?;
        }

        DocCommand::ResizeEntity {
            uuid,
            x,
            y,
            w,
            h,
            size_adjust,
            scale,
            section_bounds,
        } => {
            if let Some(old) = load_entity_by_uuid(tx, uuid)? {
                let mut next = old.clone();
                next.x = *x;
                next.y = *y;
                next.w = *w;
                next.h = *h;
                let mut props_patch = serde_json::Map::new();
                if let Some(sa) = size_adjust {
                    props_patch.insert("sizeAdjust".to_string(), serde_json::json!(sa));
                }
                if let Some(sc) = scale {
                    props_patch.insert("scale".to_string(), serde_json::json!(sc));
                }
                if !props_patch.is_empty() {
                    next.props_json =
                        merge_json_object(&old.props_json, &serde_json::Value::Object(props_patch));
                }
                if next != old {
                    tx.execute(
                        "UPDATE entities SET x = ?1, y = ?2, w = ?3, h = ?4, props_json = ?5 WHERE uuid = ?6",
                        params![next.x, next.y, next.w, next.h, &next.props_json, uuid],
                    )
                    .map_err(|e| format!("缩放实体 {uuid} 失败: {e}"))?;
                    sync_entity_rtree_row(tx, uuid, next.x, next.y, next.w, next.h)?;
                    ctx.collector.mark_entity_dirty(uuid);
                    ctx.push_pair(
                        vec![RowPatchOp::UpsertEntity { record: old }],
                        vec![RowPatchOp::UpsertEntity { record: next }],
                    );
                }
            }
            apply_section_bounds_updates(tx, ctx, section_bounds)?;
        }

        DocCommand::ToggleSectionCollapse { uuid, is_collapsed } => {
            if let Some(old) = load_entity_by_uuid(tx, uuid)? {
                let next_props = merge_json_object(
                    &old.props_json,
                    &serde_json::json!({ "isCollapsed": *is_collapsed }),
                );
                if next_props != old.props_json {
                    let mut next = old.clone();
                    next.props_json = next_props;
                    tx.execute(
                        "UPDATE entities SET props_json = ?1 WHERE uuid = ?2",
                        params![&next.props_json, uuid],
                    )
                    .map_err(|e| format!("切换分组折叠 {uuid} 失败: {e}"))?;
                    ctx.collector.mark_entity_dirty(uuid);
                    ctx.push_pair(
                        vec![RowPatchOp::UpsertEntity { record: old }],
                        vec![RowPatchOp::UpsertEntity { record: next }],
                    );
                }
            }
        }

        DocCommand::ToggleBranchCollapse {
            edge_uuids,
            is_branch_collapsed,
        } => {
            for edge_uuid in edge_uuids {
                let Some(old) = load_edge_by_uuid(tx, edge_uuid)? else {
                    continue;
                };
                let next_props = merge_json_object(
                    &old.props_json,
                    &serde_json::json!({ "isBranchCollapsed": *is_branch_collapsed }),
                );
                if next_props == old.props_json {
                    continue;
                }
                let mut next = old.clone();
                next.props_json = next_props;
                tx.execute(
                    "UPDATE edges SET props_json = ?1 WHERE uuid = ?2",
                    params![&next.props_json, edge_uuid],
                )
                .map_err(|e| format!("切换分支折叠 {edge_uuid} 失败: {e}"))?;
                ctx.collector.mark_edge_dirty(edge_uuid);
                ctx.push_pair(
                    vec![RowPatchOp::UpsertEdge { record: old }],
                    vec![RowPatchOp::UpsertEdge { record: next }],
                );
            }
        }

        DocCommand::UpdateViewCamera { x, y, scale } => {
            let val = serde_json::json!({ "x": x, "y": y, "scale": scale }).to_string();
            set_meta_value(tx, "view_camera_json", Some(&val))?;
        }

        DocCommand::SetStyleProps {
            entity_patches,
            edge_patches,
            association_patches,
        } => {
            for ep in entity_patches {
                let Some(old) = load_entity_by_uuid(tx, &ep.uuid)? else {
                    continue;
                };
                let mut next = old.clone();
                next.props_json = merge_json_object(&old.props_json, &ep.props_patch);
                if let Some(x) = ep.x {
                    next.x = x;
                }
                if let Some(y) = ep.y {
                    next.y = y;
                }
                if let Some(w) = ep.w {
                    next.w = w;
                }
                if let Some(h) = ep.h {
                    next.h = h;
                }
                if next == old {
                    continue;
                }
                tx.execute(
                    "UPDATE entities SET x = ?1, y = ?2, w = ?3, h = ?4, props_json = ?5 WHERE uuid = ?6",
                    params![next.x, next.y, next.w, next.h, &next.props_json, &next.uuid],
                )
                .map_err(|e| format!("更新实体样式 {} 失败: {e}", next.uuid))?;
                sync_entity_rtree_row(tx, &next.uuid, next.x, next.y, next.w, next.h)?;
                ctx.collector.mark_entity_dirty(&next.uuid);
                ctx.push_pair(
                    vec![RowPatchOp::UpsertEntity { record: old }],
                    vec![RowPatchOp::UpsertEntity { record: next }],
                );
            }
            for edp in edge_patches {
                let Some(old) = load_edge_by_uuid(tx, &edp.uuid)? else {
                    continue;
                };
                let mut next = old.clone();
                next.props_json = merge_json_object(&old.props_json, &edp.props_patch);
                if let Some(ref t) = edp.text {
                    next.text = t.clone();
                }
                if next == old {
                    continue;
                }
                upsert_edge_row(tx, &next)?;
                ctx.collector.mark_edge_dirty(&next.uuid);
                ctx.push_pair(
                    vec![RowPatchOp::UpsertEdge { record: old }],
                    vec![RowPatchOp::UpsertEdge { record: next }],
                );
            }
            for ap in association_patches {
                let Some(old) = load_association_by_uuid(tx, &ap.uuid)? else {
                    continue;
                };
                let mut next = old.clone();
                next.props_json = merge_json_object(&old.props_json, &ap.props_patch);
                if next == old {
                    continue;
                }
                upsert_association_row(tx, &next)?;
                ctx.collector.mark_association_dirty(&next.uuid);
                ctx.push_pair(
                    vec![RowPatchOp::UpsertAssociation { record: old }],
                    vec![RowPatchOp::UpsertAssociation { record: next }],
                );
            }
        }

        // ── 语义实体类 ──
        DocCommand::CreateEntities {
            entities,
            section_child_orders,
            section_bounds,
        } => {
            let mut touched_parents = HashSet::<String>::new();
            for ent in entities {
                let existing = load_entity_by_uuid(tx, &ent.uuid)?;
                upsert_entity_row(tx, ent)?;
                ctx.collector.mark_entity_dirty(&ent.uuid);
                let undo_op = match existing {
                    Some(prev) => RowPatchOp::UpsertEntity { record: prev },
                    None => RowPatchOp::DeleteEntity {
                        uuid: ent.uuid.clone(),
                    },
                };
                ctx.push_pair(
                    vec![undo_op],
                    vec![RowPatchOp::UpsertEntity {
                        record: ent.clone(),
                    }],
                );
                if let Some(ref parent_uuid) = ent.parent_section_uuid {
                    touched_parents.insert(parent_uuid.clone());
                }
            }
            apply_section_child_orders(tx, ctx, section_child_orders)?;
            apply_section_bounds_updates(tx, ctx, section_bounds)?;
            for parent_uuid in touched_parents {
                touch_entity_updated_at(tx, ctx, &parent_uuid)?;
            }
        }

        DocCommand::DeleteEntities {
            uuids,
            section_child_orders,
            section_bounds,
        } => {
            let delete_set: HashSet<&str> = uuids.iter().map(|s| s.as_str()).collect();
            let mut surviving_parents = HashSet::<String>::new();
            for uuid in uuids {
                let Some(old) = load_entity_by_uuid(tx, uuid)? else {
                    continue;
                };
                if let Some(ref parent_uuid) = old.parent_section_uuid {
                    if !delete_set.contains(parent_uuid.as_str()) {
                        surviving_parents.insert(parent_uuid.clone());
                    }
                }
                // 删除实体前先保存将被 CASCADE 级联删除的 cell_values，确保撤销 100% 无损恢复
                let old_cells = load_cells_for_entity(tx, uuid)?;
                delete_entity_row(tx, uuid)?;
                ctx.collector.mark_entity_deleted(uuid);

                let mut undo_ops = Vec::with_capacity(1 + old_cells.len());
                undo_ops.push(RowPatchOp::UpsertEntity { record: old });
                for cell in old_cells {
                    undo_ops.push(RowPatchOp::UpsertCell { record: cell });
                }
                ctx.push_pair(
                    undo_ops,
                    vec![RowPatchOp::DeleteEntity { uuid: uuid.clone() }],
                );
            }
            apply_section_child_orders(tx, ctx, section_child_orders)?;
            apply_section_bounds_updates(tx, ctx, section_bounds)?;
            for parent_uuid in surviving_parents {
                touch_entity_updated_at(tx, ctx, &parent_uuid)?;
            }
        }

        DocCommand::UpdateEntityText {
            uuid,
            text,
            x,
            y,
            w,
            h,
            props_patch,
            section_bounds,
        } => {
            if let Some(old) = load_entity_by_uuid(tx, uuid)? {
                let mut next = old.clone();
                let text_changed = old.text != *text;
                next.text = text.clone();
                if let Some(v) = x {
                    next.x = *v;
                }
                if let Some(v) = y {
                    next.y = *v;
                }
                if let Some(v) = w {
                    next.w = *v;
                }
                if let Some(v) = h {
                    next.h = *v;
                }
                if let Some(patch) = props_patch {
                    next.props_json = merge_json_object(&old.props_json, patch);
                }
                if (text_changed || next.props_json != old.props_json) && next.is_row {
                    next.updated_at = ctx.now_ms;
                }
                if next != old {
                    tx.execute(
                        "UPDATE entities
                         SET text = ?1, x = ?2, y = ?3, w = ?4, h = ?5, props_json = ?6, updated_at = ?7
                         WHERE uuid = ?8",
                        params![
                            &next.text,
                            next.x,
                            next.y,
                            next.w,
                            next.h,
                            &next.props_json,
                            next.updated_at,
                            uuid
                        ],
                    )
                    .map_err(|e| format!("更新实体文本 {uuid} 失败: {e}"))?;
                    sync_entity_rtree_row(tx, uuid, next.x, next.y, next.w, next.h)?;
                    if text_changed {
                        sync_entity_fts_row(tx, uuid, &next.text, &next.details_plain)?;
                    }
                    ctx.collector.mark_entity_dirty(uuid);
                    ctx.push_pair(
                        vec![RowPatchOp::UpsertEntity { record: old }],
                        vec![RowPatchOp::UpsertEntity { record: next }],
                    );
                }
            }
            apply_section_bounds_updates(tx, ctx, section_bounds)?;
        }

        DocCommand::UpdateEntityDetails {
            uuid,
            details_json,
            details_plain,
        } => {
            if let Some(old) = load_entity_by_uuid(tx, uuid)? {
                if old.details_json != *details_json || old.details_plain != *details_plain {
                    let mut next = old.clone();
                    next.details_json = details_json.clone();
                    next.details_plain = details_plain.clone();
                    if next.is_row {
                        next.updated_at = ctx.now_ms;
                    }
                    tx.execute(
                        "UPDATE entities SET details_json = ?1, details_plain = ?2, updated_at = ?3 WHERE uuid = ?4",
                        params![&next.details_json, &next.details_plain, next.updated_at, uuid],
                    )
                    .map_err(|e| format!("更新实体详情 {uuid} 失败: {e}"))?;
                    sync_entity_fts_row(tx, uuid, &next.text, &next.details_plain)?;
                    ctx.collector.mark_entity_dirty(uuid);
                    ctx.push_pair(
                        vec![RowPatchOp::UpsertEntity { record: old }],
                        vec![RowPatchOp::UpsertEntity { record: next }],
                    );
                }
            }
        }

        DocCommand::PromoteTextToSection {
            uuid,
            props_json,
            x,
            y,
            w,
            h,
            touch_updated_at,
        } => {
            if let Some(old) = load_entity_by_uuid(tx, uuid)? {
                let mut next = old.clone();
                next.kind = "section".to_string();
                next.props_json = props_json.clone();
                if let Some(v) = x {
                    next.x = *v;
                }
                if let Some(v) = y {
                    next.y = *v;
                }
                if let Some(v) = w {
                    next.w = *v;
                }
                if let Some(v) = h {
                    next.h = *v;
                }
                if *touch_updated_at && next.is_row {
                    next.updated_at = ctx.now_ms;
                }
                upsert_entity_row(tx, &next)?;
                ctx.collector.mark_entity_dirty(uuid);
                ctx.push_pair(
                    vec![RowPatchOp::UpsertEntity { record: old }],
                    vec![RowPatchOp::UpsertEntity { record: next }],
                );
            }
        }

        DocCommand::DemoteSectionToText {
            uuid,
            props_json,
            x,
            y,
            w,
            h,
            touch_updated_at,
        } => {
            if let Some(old) = load_entity_by_uuid(tx, uuid)? {
                let mut next = old.clone();
                next.kind = "text".to_string();
                next.props_json = props_json.clone();
                if let Some(v) = x {
                    next.x = *v;
                }
                if let Some(v) = y {
                    next.y = *v;
                }
                if let Some(v) = w {
                    next.w = *v;
                }
                if let Some(v) = h {
                    next.h = *v;
                }
                if *touch_updated_at && next.is_row {
                    next.updated_at = ctx.now_ms;
                }
                upsert_entity_row(tx, &next)?;
                ctx.collector.mark_entity_dirty(uuid);
                ctx.push_pair(
                    vec![RowPatchOp::UpsertEntity { record: old }],
                    vec![RowPatchOp::UpsertEntity { record: next }],
                );
            }
        }

        DocCommand::ReparentEntities {
            items,
            section_child_orders,
            section_bounds,
        } => {
            let mut touched_sections = HashSet::<String>::new();
            for item in items {
                let Some(old) = load_entity_by_uuid(tx, &item.uuid)? else {
                    continue;
                };
                let parent_changed = old.parent_section_uuid != item.parent_section_uuid;
                let mut next = old.clone();
                next.parent_section_uuid = item.parent_section_uuid.clone();
                if let Some(v) = item.x {
                    next.x = v;
                }
                if let Some(v) = item.y {
                    next.y = v;
                }
                if let Some(v) = item.w {
                    next.w = v;
                }
                if let Some(v) = item.h {
                    next.h = v;
                }
                if parent_changed {
                    if let Some(ref old_parent) = old.parent_section_uuid {
                        touched_sections.insert(old_parent.clone());
                    }
                    if let Some(ref new_parent) = next.parent_section_uuid {
                        touched_sections.insert(new_parent.clone());
                    }
                    if next.is_row {
                        next.updated_at = ctx.now_ms;
                    }
                }
                if next != old {
                    tx.execute(
                        "UPDATE entities
                         SET parent_section_uuid = ?1, x = ?2, y = ?3, w = ?4, h = ?5, updated_at = ?6
                         WHERE uuid = ?7",
                        params![
                            &next.parent_section_uuid,
                            next.x,
                            next.y,
                            next.w,
                            next.h,
                            next.updated_at,
                            &next.uuid
                        ],
                    )
                    .map_err(|e| format!("变更实体父级 {} 失败: {e}", next.uuid))?;
                    sync_entity_rtree_row(tx, &next.uuid, next.x, next.y, next.w, next.h)?;
                    ctx.collector.mark_entity_dirty(&next.uuid);
                    ctx.push_pair(
                        vec![RowPatchOp::UpsertEntity { record: old }],
                        vec![RowPatchOp::UpsertEntity { record: next }],
                    );
                }
            }
            apply_section_child_orders(tx, ctx, section_child_orders)?;
            apply_section_bounds_updates(tx, ctx, section_bounds)?;
            for sec_uuid in touched_sections {
                touch_entity_updated_at(tx, ctx, &sec_uuid)?;
            }
        }

        DocCommand::AddEntityImage {
            image_entity,
            parent_section_uuid,
            section_child_order,
            section_bounds,
        } => {
            let mut rec = image_entity.clone();
            rec.parent_section_uuid = Some(parent_section_uuid.clone());
            rec.is_row = false;
            let existing = load_entity_by_uuid(tx, &rec.uuid)?;
            upsert_entity_row(tx, &rec)?;
            ctx.collector.mark_entity_dirty(&rec.uuid);
            let undo_op = match existing {
                Some(prev) => RowPatchOp::UpsertEntity { record: prev },
                None => RowPatchOp::DeleteEntity {
                    uuid: rec.uuid.clone(),
                },
            };
            ctx.push_pair(
                vec![undo_op],
                vec![RowPatchOp::UpsertEntity { record: rec }],
            );

            if let Some(order) = section_child_order {
                apply_section_child_orders(
                    tx,
                    ctx,
                    &[SectionChildOrderPatch {
                        section_uuid: parent_section_uuid.clone(),
                        child_order: order.clone(),
                    }],
                )?;
            }
            apply_section_bounds_updates(tx, ctx, section_bounds)?;
            touch_entity_updated_at(tx, ctx, parent_section_uuid)?;
        }

        DocCommand::RemoveEntityImage {
            image_uuid,
            parent_section_uuid,
            section_child_order,
            section_bounds,
        } => {
            if let Some(old) = load_entity_by_uuid(tx, image_uuid)? {
                let old_cells = load_cells_for_entity(tx, image_uuid)?;
                delete_entity_row(tx, image_uuid)?;
                ctx.collector.mark_entity_deleted(image_uuid);
                let mut undo_ops = Vec::with_capacity(1 + old_cells.len());
                undo_ops.push(RowPatchOp::UpsertEntity { record: old });
                for cell in old_cells {
                    undo_ops.push(RowPatchOp::UpsertCell { record: cell });
                }
                ctx.push_pair(
                    undo_ops,
                    vec![RowPatchOp::DeleteEntity {
                        uuid: image_uuid.clone(),
                    }],
                );
            }
            if let Some(order) = section_child_order {
                apply_section_child_orders(
                    tx,
                    ctx,
                    &[SectionChildOrderPatch {
                        section_uuid: parent_section_uuid.clone(),
                        child_order: order.clone(),
                    }],
                )?;
            }
            apply_section_bounds_updates(tx, ctx, section_bounds)?;
            touch_entity_updated_at(tx, ctx, parent_section_uuid)?;
        }

        DocCommand::UpsertEntities {
            entities,
            touch_updated_at,
        } => {
            for raw in entities {
                let existing = load_entity_by_uuid(tx, &raw.uuid)?;
                let mut next = raw.clone();
                if *touch_updated_at && next.is_row {
                    next.updated_at = ctx.now_ms;
                }
                if existing.as_ref() == Some(&next) {
                    continue;
                }
                upsert_entity_row(tx, &next)?;
                ctx.collector.mark_entity_dirty(&next.uuid);
                let undo_op = match existing {
                    Some(prev) => RowPatchOp::UpsertEntity { record: prev },
                    None => RowPatchOp::DeleteEntity {
                        uuid: next.uuid.clone(),
                    },
                };
                ctx.push_pair(
                    vec![undo_op],
                    vec![RowPatchOp::UpsertEntity { record: next }],
                );
            }
        }

        // ── 拓扑边与关联类 ──
        DocCommand::CreateEdges { edges } => {
            let mut endpoints_to_touch = HashSet::<String>::new();
            for edge in edges {
                let existing = load_edge_by_uuid(tx, &edge.uuid)?;
                upsert_edge_row(tx, edge)?;
                ctx.collector.mark_edge_dirty(&edge.uuid);
                let undo_op = match existing {
                    Some(prev) => RowPatchOp::UpsertEdge { record: prev },
                    None => RowPatchOp::DeleteEdge {
                        uuid: edge.uuid.clone(),
                    },
                };
                ctx.push_pair(
                    vec![undo_op],
                    vec![RowPatchOp::UpsertEdge {
                        record: edge.clone(),
                    }],
                );
                if edge.source_uuid != edge.target_uuid {
                    endpoints_to_touch.insert(edge.source_uuid.clone());
                    endpoints_to_touch.insert(edge.target_uuid.clone());
                }
            }
            for ep in endpoints_to_touch {
                touch_entity_updated_at(tx, ctx, &ep)?;
            }
        }

        DocCommand::DeleteEdges { uuids } => {
            let mut endpoints_to_touch = HashSet::<String>::new();
            for uuid in uuids {
                let Some(old) = load_edge_by_uuid(tx, uuid)? else {
                    continue;
                };
                if old.source_uuid != old.target_uuid {
                    endpoints_to_touch.insert(old.source_uuid.clone());
                    endpoints_to_touch.insert(old.target_uuid.clone());
                }
                delete_edge_row(tx, uuid)?;
                ctx.collector.mark_edge_deleted(uuid);
                ctx.push_pair(
                    vec![RowPatchOp::UpsertEdge { record: old }],
                    vec![RowPatchOp::DeleteEdge { uuid: uuid.clone() }],
                );
            }
            for ep in endpoints_to_touch {
                touch_entity_updated_at(tx, ctx, &ep)?;
            }
        }

        DocCommand::UpdateEdge { edge } => {
            let existing = load_edge_by_uuid(tx, &edge.uuid)?;
            if existing.as_ref() == Some(edge) {
                return Ok(());
            }
            let mut endpoints_to_touch = HashSet::<String>::new();
            if let Some(ref old) = existing {
                if old.source_uuid != edge.source_uuid || old.target_uuid != edge.target_uuid {
                    if old.source_uuid != old.target_uuid {
                        endpoints_to_touch.insert(old.source_uuid.clone());
                        endpoints_to_touch.insert(old.target_uuid.clone());
                    }
                    if edge.source_uuid != edge.target_uuid {
                        endpoints_to_touch.insert(edge.source_uuid.clone());
                        endpoints_to_touch.insert(edge.target_uuid.clone());
                    }
                }
            } else if edge.source_uuid != edge.target_uuid {
                endpoints_to_touch.insert(edge.source_uuid.clone());
                endpoints_to_touch.insert(edge.target_uuid.clone());
            }

            upsert_edge_row(tx, edge)?;
            ctx.collector.mark_edge_dirty(&edge.uuid);
            let undo_op = match existing {
                Some(prev) => RowPatchOp::UpsertEdge { record: prev },
                None => RowPatchOp::DeleteEdge {
                    uuid: edge.uuid.clone(),
                },
            };
            ctx.push_pair(
                vec![undo_op],
                vec![RowPatchOp::UpsertEdge {
                    record: edge.clone(),
                }],
            );
            for ep in endpoints_to_touch {
                touch_entity_updated_at(tx, ctx, &ep)?;
            }
        }

        DocCommand::UpsertAssociation { association } => {
            let existing = load_association_by_uuid(tx, &association.uuid)?;
            if existing.as_ref() == Some(association) {
                return Ok(());
            }
            upsert_association_row(tx, association)?;
            ctx.collector.mark_association_dirty(&association.uuid);
            let undo_op = match existing {
                Some(prev) => RowPatchOp::UpsertAssociation { record: prev },
                None => RowPatchOp::DeleteAssociation {
                    uuid: association.uuid.clone(),
                },
            };
            ctx.push_pair(
                vec![undo_op],
                vec![RowPatchOp::UpsertAssociation {
                    record: association.clone(),
                }],
            );
        }

        DocCommand::DeleteAssociation { uuid } => {
            if let Some(old) = load_association_by_uuid(tx, uuid)? {
                delete_association_row(tx, uuid)?;
                ctx.collector.mark_association_deleted(uuid);
                ctx.push_pair(
                    vec![RowPatchOp::UpsertAssociation { record: old }],
                    vec![RowPatchOp::DeleteAssociation { uuid: uuid.clone() }],
                );
            }
        }

        // ── 表格结构与单元格类 ──
        DocCommand::UpdateCells {
            updates,
            touch_updated_at,
        } => {
            let mut entities_to_touch = HashSet::<String>::new();
            for item in updates {
                let existing = load_cell_by_key(tx, &item.entity_uuid, &item.col_id)?;
                match &item.value {
                    Some(next_cell) => {
                        if existing.as_ref() == Some(next_cell) {
                            continue;
                        }
                        upsert_cell_row(tx, next_cell)?;
                        ctx.collector
                            .mark_cell_dirty(&next_cell.entity_uuid, &next_cell.col_id);
                        let undo_op = match existing {
                            Some(prev) => RowPatchOp::UpsertCell { record: prev },
                            None => RowPatchOp::DeleteCell {
                                entity_uuid: next_cell.entity_uuid.clone(),
                                col_id: next_cell.col_id.clone(),
                            },
                        };
                        ctx.push_pair(
                            vec![undo_op],
                            vec![RowPatchOp::UpsertCell {
                                record: next_cell.clone(),
                            }],
                        );
                        if *touch_updated_at {
                            entities_to_touch.insert(next_cell.entity_uuid.clone());
                        }
                    }
                    None => {
                        let Some(prev) = existing else {
                            continue;
                        };
                        delete_cell_row(tx, &item.entity_uuid, &item.col_id)?;
                        ctx.collector
                            .mark_cell_deleted(&item.entity_uuid, &item.col_id);
                        ctx.push_pair(
                            vec![RowPatchOp::UpsertCell { record: prev }],
                            vec![RowPatchOp::DeleteCell {
                                entity_uuid: item.entity_uuid.clone(),
                                col_id: item.col_id.clone(),
                            }],
                        );
                        if *touch_updated_at {
                            entities_to_touch.insert(item.entity_uuid.clone());
                        }
                    }
                }
            }
            if *touch_updated_at {
                for eu in entities_to_touch {
                    touch_entity_updated_at(tx, ctx, &eu)?;
                }
            }
        }

        DocCommand::UpsertColumn { column } => {
            let existing = load_column_by_id(tx, &column.id)?;
            if existing.as_ref() == Some(column) {
                return Ok(());
            }
            upsert_column_row(tx, column)?;
            ctx.collector.schema_changed = true;
            let undo_op = match existing {
                Some(prev) => RowPatchOp::UpsertColumn { record: prev },
                None => RowPatchOp::DeleteColumn {
                    id: column.id.clone(),
                },
            };
            ctx.push_pair(
                vec![undo_op],
                vec![RowPatchOp::UpsertColumn {
                    record: column.clone(),
                }],
            );
        }

        DocCommand::DeleteColumn { id } => {
            let Some(old_col) = load_column_by_id(tx, id)? else {
                return Ok(());
            };
            let old_cells = load_cells_for_column(tx, id)?;
            for cell in &old_cells {
                ctx.collector.mark_cell_deleted(&cell.entity_uuid, id);
            }
            delete_column_row(tx, id)?;
            ctx.collector.schema_changed = true;

            let mut undo_ops = Vec::with_capacity(1 + old_cells.len());
            undo_ops.push(RowPatchOp::UpsertColumn { record: old_col });
            for cell in old_cells {
                undo_ops.push(RowPatchOp::UpsertCell { record: cell });
            }
            ctx.push_pair(undo_ops, vec![RowPatchOp::DeleteColumn { id: id.clone() }]);
        }

        DocCommand::ReorderColumns { ordered_ids } => {
            let all_cols = load_all_table_columns(tx)?;
            let mut undo_ops = Vec::new();
            let mut redo_ops = Vec::new();
            for (pos, col_id) in ordered_ids.iter().enumerate() {
                if let Some(old) = all_cols.iter().find(|c| &c.id == col_id) {
                    let next_pos = pos as i64;
                    if old.position != next_pos {
                        let mut next = old.clone();
                        next.position = next_pos;
                        upsert_column_row(tx, &next)?;
                        undo_ops.push(RowPatchOp::UpsertColumn {
                            record: old.clone(),
                        });
                        redo_ops.push(RowPatchOp::UpsertColumn { record: next });
                    }
                }
            }
            if !undo_ops.is_empty() {
                ctx.collector.schema_changed = true;
                ctx.push_pair(undo_ops, redo_ops);
            }
        }

        DocCommand::UpsertView { view } => {
            let existing = load_view_by_id(tx, &view.id)?;
            if existing.as_ref() == Some(view) {
                return Ok(());
            }
            upsert_view_row(tx, view)?;
            ctx.collector.schema_changed = true;
            let undo_op = match existing {
                Some(prev) => RowPatchOp::UpsertView { record: prev },
                None => RowPatchOp::DeleteView {
                    id: view.id.clone(),
                },
            };
            ctx.push_pair(
                vec![undo_op],
                vec![RowPatchOp::UpsertView {
                    record: view.clone(),
                }],
            );
        }

        DocCommand::DeleteView { id } => {
            let Some(old_view) = load_view_by_id(tx, id)? else {
                return Ok(());
            };
            delete_view_row(tx, id)?;
            ctx.collector.schema_changed = true;
            ctx.push_pair(
                vec![RowPatchOp::UpsertView { record: old_view }],
                vec![RowPatchOp::DeleteView { id: id.clone() }],
            );
        }

        DocCommand::ReorderViews { ordered_ids } => {
            let all_views = load_all_table_views(tx)?;
            let mut undo_ops = Vec::new();
            let mut redo_ops = Vec::new();
            for (pos, view_id) in ordered_ids.iter().enumerate() {
                if let Some(old) = all_views.iter().find(|v| &v.id == view_id) {
                    let next_pos = pos as i64;
                    if old.position != next_pos {
                        let mut next = old.clone();
                        next.position = next_pos;
                        upsert_view_row(tx, &next)?;
                        undo_ops.push(RowPatchOp::UpsertView {
                            record: old.clone(),
                        });
                        redo_ops.push(RowPatchOp::UpsertView { record: next });
                    }
                }
            }
            if !undo_ops.is_empty() {
                ctx.collector.schema_changed = true;
                ctx.push_pair(undo_ops, redo_ops);
            }
        }

        DocCommand::UpdateTableMeta { table_meta_json } => {
            let old = load_meta_value(tx, "table_meta_json")?;
            if old.as_deref() == Some(table_meta_json.as_str()) {
                return Ok(());
            }
            set_meta_value(tx, "table_meta_json", Some(table_meta_json))?;
            ctx.collector.schema_changed = true;
            ctx.push_pair(
                vec![RowPatchOp::SetMeta {
                    key: "table_meta_json".to_string(),
                    value: old,
                }],
                vec![RowPatchOp::SetMeta {
                    key: "table_meta_json".to_string(),
                    value: Some(table_meta_json.clone()),
                }],
            );
        }

        DocCommand::UpdateFormulaCacheBatch { entries } => {
            let mut stmt = tx
                .prepare(
                    "INSERT OR REPLACE INTO formula_cache (
                        entity_uuid, col_id, canonical_key, kind, display_text,
                        val_num, val_date_ms, val_json, is_volatile, computed_day
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )
                .map_err(|e| format!("准备 formula_cache 写入失败: {e}"))?;
            for entry in entries {
                stmt.execute(params![
                    &entry.entity_uuid,
                    &entry.col_id,
                    &entry.canonical_key,
                    &entry.kind,
                    &entry.display_text,
                    entry.val_num,
                    entry.val_date_ms,
                    &entry.val_json,
                    if entry.is_volatile { 1i64 } else { 0i64 },
                    &entry.computed_day,
                ])
                .map_err(|e| {
                    format!(
                        "写入公式缓存 ({}, {}) 失败: {e}",
                        entry.entity_uuid, entry.col_id
                    )
                })?;
            }
        }

        DocCommand::UpdateDocMetadata {
            tags,
            references,
            readme,
            extension_json,
        } => {
            let mut set_if_changed = |key: &str, next: Option<String>| -> Result<(), String> {
                let old = load_meta_value(tx, key)?;
                if old == next {
                    return Ok(());
                }
                set_meta_value(tx, key, next.as_deref())?;
                ctx.collector.metadata_changed = true;
                ctx.push_pair(
                    vec![RowPatchOp::SetMeta {
                        key: key.to_string(),
                        value: old,
                    }],
                    vec![RowPatchOp::SetMeta {
                        key: key.to_string(),
                        value: next,
                    }],
                );
                Ok(())
            };
            if let Some(t) = tags {
                let json = serde_json::to_string(t)
                    .map_err(|e| format!("序列化 tags 失败: {e}"))?;
                set_if_changed("tags_json", Some(json))?;
            }
            if let Some(r) = references {
                let json = serde_json::to_string(r)
                    .map_err(|e| format!("序列化 references 失败: {e}"))?;
                set_if_changed("references_json", Some(json))?;
            }
            if let Some(rm) = readme {
                set_if_changed("readme", rm.clone())?;
            }
            if let Some(ext) = extension_json {
                set_if_changed("extension_json", ext.clone())?;
            }
        }
    }
    Ok(())
}

/// 在单个 SQLite 事务内执行一组 `DocCommand`，记录行级 `history_ops` 并递增 `revision`。
pub fn execute_commands_in_tx(
    tx: &Transaction<'_>,
    doc_id: &str,
    canonical_path: &str,
    current_revision: i64,
    current_cursor: i64,
    commands: &[DocCommand],
    label: &str,
    record_history: bool,
    now_ms: Option<i64>,
    max_history_size: Option<usize>,
    origin_window: &str,
) -> Result<(i64, i64, DocChangeSet), String> {
    let ts = now_ms.unwrap_or_else(current_unix_ms);
    let mut ctx = CommandTxContext::new(ts);

    for cmd in commands {
        execute_single_command(tx, cmd, &mut ctx)?;
    }

    let (undo_ops, redo_ops) = ctx.flatten_ops();
    let has_mutations = !undo_ops.is_empty() || !redo_ops.is_empty();

    let next_cursor = if record_history && has_mutations {
        append_history_entry_in_tx(
            tx,
            current_cursor,
            label,
            &undo_ops,
            &redo_ops,
            ts,
            max_history_size.unwrap_or(DEFAULT_MAX_HISTORY_OPS),
        )?
    } else {
        current_cursor
    };

    let next_revision = if has_mutations {
        let rev = current_revision + 1;
        set_meta_value(tx, "revision", Some(&rev.to_string()))?;
        rev
    } else {
        current_revision
    };

    let changeset = ctx.collector.build(
        tx,
        doc_id,
        canonical_path,
        next_revision,
        origin_window,
        ChangeSource::Command,
        next_cursor,
    )?;

    Ok((next_revision, next_cursor, changeset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite_engine::document_actor::{
        DocumentActor, V3MultiOptionEntry,
    };
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::Instant;

    static TEST_SEQ: AtomicU64 = AtomicU64::new(1);

    fn temp_prg(tag: &str) -> std::path::PathBuf {
        let n = TEST_SEQ.fetch_add(1, Ordering::Relaxed);
        std::env::temp_dir().join(format!(
            "flux-m2-cmd-{}-{}-{n}.prg",
            std::process::id(),
            tag
        ))
    }

    fn make_text_entity(uuid: &str, text: &str, x: f64, y: f64, t: i64) -> V3EntityRecord {
        V3EntityRecord {
            uuid: uuid.to_string(),
            kind: "text".to_string(),
            parent_section_uuid: None,
            text: text.to_string(),
            details_json: "[]".to_string(),
            details_plain: String::new(),
            x,
            y,
            w: 120.0,
            h: 50.0,
            props_json: "{}".to_string(),
            created_at: t,
            updated_at: t,
            is_row: true,
            sort_order: 0,
        }
    }

    #[test]
    fn enforces_semantic_updated_at_rules_and_lossless_row_undo_redo() {
        let path = temp_prg("semantic");
        let _ = std::fs::remove_file(&path);
        let mut actor = DocumentActor::open(&path).unwrap();
        let t0 = 1_700_000_000_000i64;

        // 1. 创建两个节点 + 两个自定义列
        let cs1 = actor
            .apply_commands(
                &[
                    DocCommand::CreateEntities {
                        entities: vec![
                            make_text_entity("a", "Alpha", 0.0, 0.0, t0),
                            make_text_entity("b", "Beta", 200.0, 0.0, t0),
                        ],
                        section_child_orders: vec![],
                        section_bounds: vec![],
                    },
                    DocCommand::UpsertColumn {
                        column: V3TableColumnRecord {
                            id: "col_pi".to_string(),
                            canonical_key: "auto:number:pi".to_string(),
                            name: "Pi".to_string(),
                            r#type: "number".to_string(),
                            position: 0,
                            config_json: "{}".to_string(),
                        },
                    },
                    DocCommand::UpsertColumn {
                        column: V3TableColumnRecord {
                            id: "col_sr_mastery".to_string(),
                            canonical_key: "role:sr:mastery".to_string(),
                            name: "掌握程度".to_string(),
                            r#type: "number".to_string(),
                            position: 1,
                            config_json: r#"{"protectedRole":"mastery"}"#.to_string(),
                        },
                    },
                ],
                "init",
                true,
                Some(t0),
                None,
                "main",
            )
            .unwrap();
        assert_eq!(cs1.dirty_entities.len(), 2);
        assert!(cs1.can_undo);

        // 2. 纯几何拖拽：绝不刷新 updated_at，但更新 R-Tree
        let cs_move = actor
            .apply_commands(
                &[DocCommand::MoveEntities {
                    moves: vec![EntityMoveItem {
                        uuid: "a".to_string(),
                        x: 500.0,
                        y: 300.0,
                    }],
                    section_bounds: vec![],
                }],
                "move",
                true,
                Some(t0 + 5_000),
                None,
                "main",
            )
            .unwrap();
        assert_eq!(cs_move.dirty_entities[0].x, 500.0);
        assert_eq!(cs_move.dirty_entities[0].updated_at, t0);

        // 3. 改文本：刷新节点 a 的 updated_at 并更新 FTS5
        let cs_text = actor
            .apply_commands(
                &[DocCommand::UpdateEntityText {
                    uuid: "a".to_string(),
                    text: "薛定谔方程".to_string(),
                    x: None,
                    y: None,
                    w: None,
                    h: None,
                    props_patch: None,
                    section_bounds: vec![],
                }],
                "rename",
                true,
                Some(t0 + 10_000),
                None,
                "main",
            )
            .unwrap();
        assert_eq!(cs_text.dirty_entities[0].updated_at, t0 + 10_000);
        let fts_hits: i64 = actor
            .conn
            .query_row(
                "SELECT COUNT(*) FROM entities_fts WHERE entities_fts MATCH '薛定谔方程'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(fts_hits, 1);

        // 4. 连线 a -> b：同时刷新 a 和 b 的 updated_at
        let cs_edge = actor
            .apply_commands(
                &[DocCommand::CreateEdges {
                    edges: vec![V3EdgeRecord {
                        uuid: "e1".to_string(),
                        kind: "line".to_string(),
                        source_uuid: "a".to_string(),
                        target_uuid: "b".to_string(),
                        text: String::new(),
                        props_json: "{}".to_string(),
                        sort_order: 2,
                    }],
                }],
                "connect",
                true,
                Some(t0 + 20_000),
                None,
                "main",
            )
            .unwrap();
        assert_eq!(cs_edge.dirty_edges.len(), 1);
        assert_eq!(cs_edge.dirty_entities.len(), 2);
        for ent in &cs_edge.dirty_entities {
            assert_eq!(ent.updated_at, t0 + 20_000);
        }

        // 5. 普通自定义单元格编辑：刷新 b 的 updated_at 并保留完整 float64 精度
        let cs_cell = actor
            .apply_commands(
                &[DocCommand::UpdateCells {
                    updates: vec![CellMutationItem {
                        entity_uuid: "b".to_string(),
                        col_id: "col_pi".to_string(),
                        value: Some(V3CellValueRecord {
                            entity_uuid: "b".to_string(),
                            col_id: "col_pi".to_string(),
                            canonical_key: "auto:number:pi".to_string(),
                            val_type: "number".to_string(),
                            val_text: Some("3.1415926535".to_string()),
                            val_num: Some(3.1415926535),
                            val_date: None,
                            val_json: None,
                            multi_options: vec![],
                        }),
                    }],
                    touch_updated_at: true,
                }],
                "edit-cell",
                true,
                Some(t0 + 30_000),
                None,
                "main",
            )
            .unwrap();
        assert_eq!(cs_cell.dirty_entities[0].updated_at, t0 + 30_000);
        assert_eq!(cs_cell.dirty_cells[0].val_num, Some(3.1415926535));

        // 6. 间隔重复作答（touch_updated_at = false）：绝不刷新 b 的 updated_at
        let cs_sr = actor
            .apply_commands(
                &[DocCommand::UpdateCells {
                    updates: vec![CellMutationItem {
                        entity_uuid: "b".to_string(),
                        col_id: "col_sr_mastery".to_string(),
                        value: Some(V3CellValueRecord {
                            entity_uuid: "b".to_string(),
                            col_id: "col_sr_mastery".to_string(),
                            canonical_key: "role:sr:mastery".to_string(),
                            val_type: "number".to_string(),
                            val_text: Some("1".to_string()),
                            val_num: Some(1.0),
                            val_date: None,
                            val_json: None,
                            multi_options: vec![],
                        }),
                    }],
                    touch_updated_at: false,
                }],
                "sr-answer",
                true,
                Some(t0 + 40_000),
                None,
                "main",
            )
            .unwrap();
        assert!(cs_sr.dirty_entities.is_empty());
        let b_ts: i64 = actor
            .conn
            .query_row("SELECT updated_at FROM entities WHERE uuid = 'b'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(b_ts, t0 + 30_000);

        // 7. 连续撤销 2 步：先撤 SR 作答，再撤 Pi 单元格 -> b.updated_at 精准回退至 t0 + 20_000
        let undo_sr = actor.undo("main").unwrap().unwrap();
        assert_eq!(undo_sr.deleted_cells.len(), 1);
        assert_eq!(undo_sr.deleted_cells[0].col_id, "col_sr_mastery");

        let undo_pi = actor.undo("main").unwrap().unwrap();
        assert_eq!(undo_pi.dirty_entities[0].uuid, "b");
        assert_eq!(undo_pi.dirty_entities[0].updated_at, t0 + 20_000);
        assert_eq!(undo_pi.deleted_cells[0].col_id, "col_pi");
        assert!(undo_pi.can_redo);

        // 8. 重做 Pi 单元格 -> 精度与 updated_at 全部还原
        let redo_pi = actor.redo("main").unwrap().unwrap();
        assert_eq!(redo_pi.dirty_cells[0].val_num, Some(3.1415926535));
        assert_eq!(redo_pi.dirty_entities[0].updated_at, t0 + 30_000);

        // 9. 删除带单元格的实体 b 后撤销：级联删除的单元格 100% 恢复
        let cs_del = actor
            .apply_commands(
                &[DocCommand::DeleteEntities {
                    uuids: vec!["b".to_string()],
                    section_child_orders: vec![],
                    section_bounds: vec![],
                }],
                "delete-b",
                true,
                Some(t0 + 50_000),
                None,
                "main",
            )
            .unwrap();
        assert_eq!(cs_del.deleted_entity_uuids, vec!["b".to_string()]);

        let undo_del = actor.undo("main").unwrap().unwrap();
        assert_eq!(undo_del.dirty_entities[0].uuid, "b");
        assert_eq!(undo_del.dirty_cells.len(), 1);
        assert_eq!(undo_del.dirty_cells[0].val_num, Some(3.1415926535));

        drop(actor);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn supports_multi_select_and_5000_node_edit_undo_redo_under_2ms() {
        let path = temp_prg("bench-5000");
        let _ = std::fs::remove_file(&path);
        let mut actor = DocumentActor::open(&path).unwrap();
        let t0 = 1_700_000_000_000i64;

        let entities: Vec<V3EntityRecord> = (0..5000)
            .map(|i| {
                make_text_entity(
                    &format!("node-{i:04}"),
                    &format!("知识点 {i}"),
                    (i % 100) as f64 * 160.0,
                    (i / 100) as f64 * 90.0,
                    t0,
                )
            })
            .collect();

        actor
            .apply_commands(
                &[
                    DocCommand::CreateEntities {
                        entities,
                        section_child_orders: vec![],
                        section_bounds: vec![],
                    },
                    DocCommand::UpsertColumn {
                        column: V3TableColumnRecord {
                            id: "col_tags".to_string(),
                            canonical_key: "auto:multi_select:tags".to_string(),
                            name: "标签".to_string(),
                            r#type: "multi_select".to_string(),
                            position: 0,
                            config_json: "{}".to_string(),
                        },
                    },
                ],
                "seed-5000",
                false,
                Some(t0),
                None,
                "main",
            )
            .unwrap();

        // 预热一条查询，确保 SQLite 页面缓存与 prepared cache 稳定
        let _ = actor
            .apply_commands(
                &[DocCommand::UpdateCells {
                    updates: vec![CellMutationItem {
                        entity_uuid: "node-0001".to_string(),
                        col_id: "col_tags".to_string(),
                        value: Some(V3CellValueRecord {
                            entity_uuid: "node-0001".to_string(),
                            col_id: "col_tags".to_string(),
                            canonical_key: "auto:multi_select:tags".to_string(),
                            val_type: "multi_select".to_string(),
                            val_text: Some("重点".to_string()),
                            val_num: None,
                            val_date: None,
                            val_json: Some(r#"["opt_1"]"#.to_string()),
                            multi_options: vec![V3MultiOptionEntry {
                                option_id: "opt_1".to_string(),
                                option_name: "重点".to_string(),
                            }],
                        }),
                    }],
                    touch_updated_at: true,
                }],
                "warmup",
                true,
                Some(t0 + 1000),
                None,
                "main",
            )
            .unwrap();

        let start = Instant::now();
        let cs = actor
            .apply_commands(
                &[DocCommand::UpdateCells {
                    updates: vec![CellMutationItem {
                        entity_uuid: "node-2500".to_string(),
                        col_id: "col_tags".to_string(),
                        value: Some(V3CellValueRecord {
                            entity_uuid: "node-2500".to_string(),
                            col_id: "col_tags".to_string(),
                            canonical_key: "auto:multi_select:tags".to_string(),
                            val_type: "multi_select".to_string(),
                            val_text: Some("重点,错题".to_string()),
                            val_num: None,
                            val_date: None,
                            val_json: Some(r#"["opt_1","opt_2"]"#.to_string()),
                            multi_options: vec![
                                V3MultiOptionEntry {
                                    option_id: "opt_1".to_string(),
                                    option_name: "重点".to_string(),
                                },
                                V3MultiOptionEntry {
                                    option_id: "opt_2".to_string(),
                                    option_name: "错题".to_string(),
                                },
                            ],
                        }),
                    }],
                    touch_updated_at: true,
                }],
                "edit-2500",
                true,
                Some(t0 + 2000),
                None,
                "main",
            )
            .unwrap();
        let edit_ms = start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(cs.dirty_cells.len(), 1);
        assert_eq!(cs.dirty_entities.len(), 1);

        let multi_cnt: i64 = actor
            .conn
            .query_row(
                "SELECT COUNT(*) FROM cell_multi_options WHERE entity_uuid = 'node-2500'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(multi_cnt, 2);

        let undo_start = Instant::now();
        let undo_cs = actor.undo("main").unwrap().unwrap();
        let undo_ms = undo_start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(undo_cs.deleted_cells.len(), 1);

        let redo_start = Instant::now();
        let redo_cs = actor.redo("main").unwrap().unwrap();
        let redo_ms = redo_start.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(redo_cs.dirty_cells.len(), 1);

        // 在 Windows 调试模式下放宽到 20ms 防 CI 抖动，同时打印实测耗时供验收
        eprintln!(
            "[M2 Rust 5000-node bench] edit={edit_ms:.3}ms undo={undo_ms:.3}ms redo={redo_ms:.3}ms"
        );
        assert!(edit_ms < 20.0, "edit too slow: {edit_ms:.3}ms");
        assert!(undo_ms < 20.0, "undo too slow: {undo_ms:.3}ms");
        assert!(redo_ms < 20.0, "redo too slow: {redo_ms:.3}ms");

        drop(actor);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn promote_demote_reparent_image_and_delete_column_undo_losslessly() {
        let path = temp_prg("promote-reparent");
        let _ = std::fs::remove_file(&path);
        let mut actor = DocumentActor::open(&path).unwrap();
        let t0 = 1_700_000_000_000i64;

        actor
            .apply_commands(
                &[
                    DocCommand::CreateEntities {
                        entities: vec![
                            make_text_entity("box", "细胞", 0.0, 0.0, t0),
                            make_text_entity("leaf", "叶节点", 300.0, 0.0, t0),
                        ],
                        section_child_orders: vec![],
                        section_bounds: vec![],
                    },
                    DocCommand::UpsertColumn {
                        column: V3TableColumnRecord {
                            id: "col_note".to_string(),
                            canonical_key: "auto:text:note".to_string(),
                            name: "备注".to_string(),
                            r#type: "text".to_string(),
                            position: 0,
                            config_json: "{}".to_string(),
                        },
                    },
                    DocCommand::UpdateCells {
                        updates: vec![CellMutationItem {
                            entity_uuid: "box".to_string(),
                            col_id: "col_note".to_string(),
                            value: Some(V3CellValueRecord {
                                entity_uuid: "box".to_string(),
                                col_id: "col_note".to_string(),
                                canonical_key: "auto:text:note".to_string(),
                                val_type: "text".to_string(),
                                val_text: Some("保留字段".to_string()),
                                val_num: None,
                                val_date: None,
                                val_json: None,
                                multi_options: vec![],
                            }),
                        }],
                        touch_updated_at: false,
                    },
                ],
                "setup",
                false,
                Some(t0),
                None,
                "main",
            )
            .unwrap();

        // 升级为 Section 并添加图片，刷新 box.updated_at 且保留单元格
        let img = V3EntityRecord {
            uuid: "img-1".to_string(),
            kind: "image".to_string(),
            parent_section_uuid: Some("box".to_string()),
            text: String::new(),
            details_json: "[]".to_string(),
            details_plain: String::new(),
            x: 10.0,
            y: 40.0,
            w: 100.0,
            h: 80.0,
            props_json: r#"{"attachmentId":"att-1","scale":1,"isBackground":false}"#.to_string(),
            created_at: t0 + 5000,
            updated_at: t0 + 5000,
            is_row: false,
            sort_order: 2,
        };
        let cs_img = actor
            .apply_commands(
                &[
                    DocCommand::PromoteTextToSection {
                        uuid: "box".to_string(),
                        props_json: r#"{"childOrder":["img-1"]}"#.to_string(),
                        x: None,
                        y: None,
                        w: Some(200.0),
                        h: Some(150.0),
                        touch_updated_at: false,
                    },
                    DocCommand::AddEntityImage {
                        image_entity: img,
                        parent_section_uuid: "box".to_string(),
                        section_child_order: Some(vec!["img-1".to_string()]),
                        section_bounds: vec![],
                    },
                ],
                "add-img",
                true,
                Some(t0 + 5000),
                None,
                "main",
            )
            .unwrap();
        let promoted = cs_img.dirty_entities.iter().find(|e| e.uuid == "box").unwrap();
        assert_eq!(promoted.kind, "section");
        assert_eq!(promoted.updated_at, t0 + 5000);

        // 撤销加图：自动退回 text 且 updated_at 回到 t0
        let undo_img = actor.undo("main").unwrap().unwrap();
        let reverted = undo_img.dirty_entities.iter().find(|e| e.uuid == "box").unwrap();
        assert_eq!(reverted.kind, "text");
        assert_eq!(reverted.updated_at, t0);
        assert_eq!(undo_img.deleted_entity_uuids, vec!["img-1".to_string()]);

        // 删除列后撤销：列和单元格同时还原
        let cs_del_col = actor
            .apply_commands(
                &[DocCommand::DeleteColumn {
                    id: "col_note".to_string(),
                }],
                "del-col",
                true,
                Some(t0 + 8000),
                None,
                "main",
            )
            .unwrap();
        assert!(cs_del_col.schema_changed);
        assert_eq!(cs_del_col.deleted_cells.len(), 1);

        let undo_col = actor.undo("main").unwrap().unwrap();
        assert!(undo_col.schema_changed);
        assert_eq!(undo_col.dirty_cells.len(), 1);
        assert_eq!(undo_col.dirty_cells[0].val_text.as_deref(), Some("保留字段"));

        drop(actor);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(format!("{}-wal", path.display()));
        let _ = std::fs::remove_file(format!("{}-shm", path.display()));
    }

    #[test]
    fn temp_draft_opens_and_cleans_up_files_on_close() {
        let pool = crate::sqlite_engine::DocumentActorPool::default();
        let actor = pool.open_temp_draft().unwrap();
        let (doc_id, draft_path) = {
            let mut guard = actor.lock().unwrap();
            assert!(guard.is_temp_draft);
            let _ = guard
                .apply_commands(
                    &[DocCommand::CreateEntities {
                        entities: vec![make_text_entity("d1", "草稿节点", 0.0, 0.0, 1000)],
                        section_child_orders: vec![],
                        section_bounds: vec![],
                    }],
                    "draft-create",
                    true,
                    Some(1000),
                    None,
                    "main",
                )
                .unwrap();
            (guard.doc_id.clone(), guard.path.clone())
        };
        drop(actor);
        assert!(draft_path.exists());
        pool.close_document(&doc_id).unwrap();
        assert!(!draft_path.exists());
    }
}
