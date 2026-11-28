use crate::sqlite_engine::document_actor::V3CellValueRecord;
use crate::sqlite_engine::table_query::{
    combine_empty_and_match, format_date_key, format_js_number, is_editable_container_kind,
    is_editable_text_kind, natural_cmp, parse_date_key, resolve_date_preset_range,
    resolve_today_key, ColumnFilterBucketRecord, TableColumnFilterInput, TableDateRangeResult,
    TableExtraGroupFilter, TableFilterBucketsResult, TableFilterConditionInput,
    TableFilterGroupInput, TableGroupCountItem, TableGroupCountsResult, TablePageResult,
    TableSortInput, V3FormulaCellRecord, V3ImageItemRecord, V3RelationItemRecord, V3TableRowRecord,
};
use crate::sqlite_engine::workspace_engine::WorkspaceScope;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

const WORKSPACE_SYSTEM_COLUMNS: &[&str] = &[
    "name",
    "sourceFile",
    "sourceFolder",
    "images",
    "createdAt",
    "updatedAt",
    "parents",
    "children",
    "outer",
    "inner",
];

// ============================================================================
// 跨文件查询请求与响应类型
// ============================================================================

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTablePageQuery {
    #[serde(default)]
    pub scope: WorkspaceScope,
    #[serde(default)]
    pub offset: usize,
    #[serde(default = "default_page_limit")]
    pub limit: usize,
    #[serde(default)]
    pub filters: Vec<TableColumnFilterInput>,
    pub filter_group: Option<TableFilterGroupInput>,
    pub sort: Option<TableSortInput>,
    pub today_key: Option<String>,
    pub extra_group_filter: Option<TableExtraGroupFilter>,
}

fn default_page_limit() -> usize {
    200
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTableFilterBucketsQuery {
    #[serde(default)]
    pub scope: WorkspaceScope,
    pub column_id: String,
    pub search: Option<String>,
    #[serde(default = "default_buckets_limit")]
    pub limit: usize,
}

fn default_buckets_limit() -> usize {
    300
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTableGroupCountsQuery {
    #[serde(default)]
    pub scope: WorkspaceScope,
    pub group_by_column_id: String,
    #[serde(default)]
    pub filters: Vec<TableColumnFilterInput>,
    pub filter_group: Option<TableFilterGroupInput>,
    pub today_key: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceTableDateRangeQuery {
    #[serde(default)]
    pub scope: WorkspaceScope,
    pub start_column_id: String,
    pub end_column_id: Option<String>,
    pub min_date: String,
    pub max_date: String,
    #[serde(default)]
    pub filters: Vec<TableColumnFilterInput>,
    pub filter_group: Option<TableFilterGroupInput>,
    pub sort: Option<TableSortInput>,
    pub today_key: Option<String>,
    #[serde(default)]
    pub include_undated: bool,
    #[serde(default = "default_undated_limit")]
    pub undated_limit: usize,
}

fn default_undated_limit() -> usize {
    200
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchFtsQuery {
    pub query: String,
    #[serde(default)]
    pub scope: Option<WorkspaceScope>,
    #[serde(default = "default_fts_limit")]
    pub limit: usize,
}

fn default_fts_limit() -> usize {
    100
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchFtsHit {
    pub doc_id: String,
    pub rel_path: String,
    pub folder_path: String,
    pub title: String,
    pub uuid: String,
    pub kind: String,
    pub text: String,
    pub details_plain: String,
}

// ============================================================================
// 内部列元数据与参数构造器
// ============================================================================

#[derive(Debug, Clone)]
struct WsOptionMeta {
    id: String,
    name: String,
    color: Option<String>,
}

#[derive(Debug, Clone)]
struct WsColumnMeta {
    canonical_key: String,
    col_type: String,
    options: Vec<WsOptionMeta>,
    opt_id_by_name: HashMap<String, String>,
    opt_name_by_id: HashMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WsFilterKind {
    Images,
    Number,
    Date,
    Select,
    Relation,
    Text,
}

struct SqlParams {
    values: Vec<SqlValue>,
}

impl SqlParams {
    fn new() -> Self {
        Self { values: Vec::new() }
    }

    fn bind_str(&mut self, s: impl Into<String>) -> String {
        self.values.push(SqlValue::Text(s.into()));
        format!("?{}", self.values.len())
    }

    fn bind_f64(&mut self, n: f64) -> String {
        self.values.push(SqlValue::Real(n));
        format!("?{}", self.values.len())
    }

    fn bind_list_str(&mut self, items: &[String]) -> String {
        let mut phs = Vec::with_capacity(items.len());
        for item in items {
            phs.push(self.bind_str(item.clone()));
        }
        phs.join(", ")
    }
}

fn is_ws_system_col(col_id: &str) -> bool {
    WORKSPACE_SYSTEM_COLUMNS.contains(&col_id)
}

fn load_ws_column_meta_map(conn: &Connection) -> Result<HashMap<String, WsColumnMeta>, String> {
    let mut stmt = conn
        .prepare("SELECT canonical_key, type, config_json FROM workspace_columns")
        .map_err(|e| format!("查询 workspace_columns 失败: {e}"))?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("遍历 workspace_columns 失败: {e}"))?;

    let mut map = HashMap::new();
    for item in rows {
        let (canonical_key, col_type, config_json) =
            item.map_err(|e| format!("解析 workspace_columns 失败: {e}"))?;
        let mut options = Vec::new();
        let mut opt_id_by_name = HashMap::new();
        let mut opt_name_by_id = HashMap::new();
        if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&config_json) {
            if let Some(arr) = cfg.get("options").and_then(|v| v.as_array()) {
                for opt in arr {
                    let id = opt.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let name = opt.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if !id.is_empty() && !name.is_empty() {
                        opt_id_by_name.insert(name.to_string(), id.to_string());
                        opt_name_by_id.insert(id.to_string(), name.to_string());
                        options.push(WsOptionMeta {
                            id: id.to_string(),
                            name: name.to_string(),
                            color: opt
                                .get("color")
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string()),
                        });
                    }
                }
            }
        }
        map.insert(
            canonical_key.clone(),
            WsColumnMeta {
                canonical_key,
                col_type,
                options,
                opt_id_by_name,
                opt_name_by_id,
            },
        );
    }
    Ok(map)
}

fn get_ws_filter_kind(col_id: &str, col_meta: Option<&WsColumnMeta>) -> WsFilterKind {
    match col_id {
        "images" => WsFilterKind::Images,
        "createdAt" | "updatedAt" => WsFilterKind::Date,
        "parents" | "children" | "outer" | "inner" => WsFilterKind::Relation,
        "name" | "sourceFile" | "sourceFolder" => WsFilterKind::Text,
        _ => match col_meta.map(|c| c.col_type.as_str()) {
            Some("number") => WsFilterKind::Number,
            Some("date") => WsFilterKind::Date,
            Some("select") | Some("multi_select") => WsFilterKind::Select,
            _ => WsFilterKind::Text,
        },
    }
}

fn is_valid_ws_operator(kind: WsFilterKind, op: &str) -> bool {
    match kind {
        WsFilterKind::Images => matches!(op, "is_empty" | "is_not_empty"),
        WsFilterKind::Number | WsFilterKind::Date => matches!(
            op,
            "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "is_empty" | "is_not_empty"
        ),
        WsFilterKind::Select | WsFilterKind::Relation | WsFilterKind::Text => matches!(
            op,
            "contains" | "not_contains" | "eq" | "neq" | "is_empty" | "is_not_empty"
        ),
    }
}

fn build_scope_sql(scope: &WorkspaceScope, params: &mut SqlParams) -> String {
    match scope.kind.as_str() {
        "folders" => {
            if scope.paths.is_empty() {
                return "1 = 1".to_string();
            }
            let mut parts = Vec::new();
            for raw in &scope.paths {
                let clean = raw.replace('\\', "/").trim_matches('/').to_string();
                if clean.is_empty() {
                    return "1 = 1".to_string();
                }
                let p_exact = params.bind_str(clean.clone());
                let p_prefix = params.bind_str(format!("{clean}/%"));
                parts.push(format!(
                    "(lower(d.folder_path) = lower({p_exact}) OR lower(d.folder_path) LIKE lower({p_prefix}))"
                ));
            }
            format!("({})", parts.join(" OR "))
        }
        "docs" => {
            if scope.paths.is_empty() {
                return "0 = 1".to_string();
            }
            let mut parts = Vec::new();
            for raw in &scope.paths {
                let clean = raw.replace('\\', "/").trim_start_matches('/').to_string();
                let p = params.bind_str(clean);
                parts.push(format!("(lower(d.rel_path) = lower({p}) OR d.doc_id = {p})"));
            }
            format!("({})", parts.join(" OR "))
        }
        _ => "1 = 1".to_string(),
    }
}

/// 将前端传入的选项键（可能是 ws optionId，也可能是 optionName）统一解析为 `index.sqlite` 中的 `option_name`。
fn resolve_option_names_for_filter(values: &[String], meta: &WsColumnMeta) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for v in values {
        let name = meta
            .opt_name_by_id
            .get(v)
            .cloned()
            .unwrap_or_else(|| v.clone());
        if !name.is_empty() && seen.insert(name.clone()) {
            out.push(name);
        }
    }
    out
}

fn build_ws_date_key_expr(
    col_id: &str,
    col_meta: Option<&WsColumnMeta>,
    params: &mut SqlParams,
) -> Option<String> {
    match col_id {
        "createdAt" => Some(
            "(CASE WHEN e.created_at > 0 THEN strftime('%Y-%m-%d', e.created_at / 1000, 'unixepoch', 'localtime') ELSE NULL END)".to_string(),
        ),
        "updatedAt" => Some(
            "(CASE WHEN e.updated_at > 0 THEN strftime('%Y-%m-%d', e.updated_at / 1000, 'unixepoch', 'localtime') ELSE NULL END)".to_string(),
        ),
        _ => {
            let meta = col_meta?;
            let p_ck = params.bind_str(meta.canonical_key.clone());
            if meta.col_type == "formula" {
                Some(format!(
                    "(SELECT CASE
                        WHEN fc.kind IN ('empty', 'error') THEN NULL
                        WHEN fc.kind = 'date' AND fc.val_date_ms IS NOT NULL AND fc.val_date_ms > 0
                          THEN strftime('%Y-%m-%d', fc.val_date_ms / 1000, 'unixepoch', 'localtime')
                        WHEN length(trim(fc.display_text)) >= 10
                          AND substr(trim(fc.display_text), 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                          THEN substr(trim(fc.display_text), 1, 10)
                        ELSE NULL
                      END
                      FROM formula_cache fc
                      WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p_ck})"
                ))
            } else {
                Some(format!(
                    "(SELECT CASE
                        WHEN cv.val_date IS NOT NULL AND length(trim(cv.val_date)) >= 10
                          AND substr(trim(cv.val_date), 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                          THEN substr(trim(cv.val_date), 1, 10)
                        WHEN cv.val_text IS NOT NULL AND length(trim(cv.val_text)) >= 10
                          AND substr(trim(cv.val_text), 1, 10) GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                          THEN substr(trim(cv.val_text), 1, 10)
                        ELSE NULL
                      END
                      FROM cell_values cv
                      WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck})"
                ))
            }
        }
    }
}

fn build_ws_column_filter_sql(
    flt: &TableColumnFilterInput,
    col_map: &HashMap<String, WsColumnMeta>,
    params: &mut SqlParams,
) -> Option<String> {
    let col_meta = col_map.get(&flt.column_id);
    if !is_ws_system_col(&flt.column_id) && col_meta.is_none() {
        return None;
    }
    let values = &flt.values;
    let include_empty = flt.include_empty;

    match flt.column_id.as_str() {
        "name" => {
            let is_empty = "TRIM(e.text) = ''";
            let has_match = if values.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(values);
                format!("TRIM(e.text) IN ({list})")
            };
            Some(combine_empty_and_match(is_empty, &has_match, include_empty))
        }
        "sourceFile" => {
            let is_empty = "TRIM(d.title) = ''";
            let has_match = if values.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(values);
                format!("(d.doc_id IN ({list}) OR d.rel_path IN ({list}) OR TRIM(d.title) IN ({list}))")
            };
            Some(combine_empty_and_match(is_empty, &has_match, include_empty))
        }
        "sourceFolder" => {
            let is_empty = "TRIM(d.folder_path) = ''";
            let has_match = if values.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(values);
                format!("TRIM(d.folder_path) IN ({list})")
            };
            Some(combine_empty_and_match(is_empty, &has_match, include_empty))
        }
        "images" => {
            let is_empty = "e.image_count = 0";
            let num_vals: Vec<String> = values
                .iter()
                .filter(|v| v.parse::<i64>().is_ok())
                .cloned()
                .collect();
            let has_match = if num_vals.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(&num_vals);
                format!("CAST(e.image_count AS TEXT) IN ({list})")
            };
            Some(combine_empty_and_match(is_empty, &has_match, include_empty))
        }
        "createdAt" | "updatedAt" => {
            let expr = build_ws_date_key_expr(&flt.column_id, None, params)?;
            let is_empty = format!("{expr} IS NULL");
            let has_match = if values.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(values);
                format!("{expr} IN ({list})")
            };
            Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
        }
        "outer" => {
            let is_empty = "(e.parent_section_uuid IS NULL OR COALESCE(TRIM(e.outer_label), '') = '')";
            let has_match = if values.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(values);
                format!("(e.parent_section_uuid IN ({list}) OR TRIM(COALESCE(e.outer_label, '')) IN ({list}))")
            };
            Some(combine_empty_and_match(is_empty, &has_match, include_empty))
        }
        "parents" | "children" | "inner" => {
            let json_col = match flt.column_id.as_str() {
                "parents" => "e.parents_json",
                "children" => "e.children_json",
                _ => "e.inner_json",
            };
            let is_empty = format!("json_array_length({json_col}) = 0");
            let has_match = if values.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(values);
                format!(
                    "EXISTS (SELECT 1 FROM json_each({json_col}) je WHERE json_extract(je.value, '$.uuid') IN ({list}))"
                )
            };
            Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
        }
        _ => {
            let meta = col_meta?;
            match meta.col_type.as_str() {
                "number" => {
                    let p_ck1 = params.bind_str(meta.canonical_key.clone());
                    let is_empty = format!(
                        "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck1} AND cv.val_num IS NOT NULL)"
                    );
                    let nums: Vec<f64> = values
                        .iter()
                        .filter_map(|s| s.trim().parse::<f64>().ok().filter(|n| n.is_finite()))
                        .collect();
                    let has_match = if nums.is_empty() {
                        "0".to_string()
                    } else {
                        let p_ck2 = params.bind_str(meta.canonical_key.clone());
                        let phs: Vec<String> = nums.into_iter().map(|n| params.bind_f64(n)).collect();
                        format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck2} AND cv.val_num IN ({}))",
                            phs.join(", ")
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
                "select" => {
                    let p_ck1 = params.bind_str(meta.canonical_key.clone());
                    let is_empty = format!(
                        "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck1} AND TRIM(COALESCE(cv.val_text, '')) != '')"
                    );
                    let opt_names = resolve_option_names_for_filter(values, meta);
                    let has_match = if opt_names.is_empty() {
                        "0".to_string()
                    } else {
                        let p_ck2 = params.bind_str(meta.canonical_key.clone());
                        let list = params.bind_list_str(&opt_names);
                        format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck2} AND cv.val_text IN ({list}))"
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
                "multi_select" => {
                    let p_ck1 = params.bind_str(meta.canonical_key.clone());
                    let is_empty = format!(
                        "NOT EXISTS (SELECT 1 FROM cell_multi_options cm WHERE cm.doc_id = e.doc_id AND cm.entity_uuid = e.uuid AND cm.canonical_key = {p_ck1})"
                    );
                    let opt_names = resolve_option_names_for_filter(values, meta);
                    let has_match = if opt_names.is_empty() {
                        "0".to_string()
                    } else {
                        let p_ck2 = params.bind_str(meta.canonical_key.clone());
                        let list = params.bind_list_str(&opt_names);
                        format!(
                            "EXISTS (SELECT 1 FROM cell_multi_options cm WHERE cm.doc_id = e.doc_id AND cm.entity_uuid = e.uuid AND cm.canonical_key = {p_ck2} AND cm.option_name IN ({list}))"
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
                "date" => {
                    let p_ck1 = params.bind_str(meta.canonical_key.clone());
                    let is_empty = format!(
                        "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck1} AND TRIM(COALESCE(cv.val_date, cv.val_text, '')) != '')"
                    );
                    let has_match = if values.is_empty() {
                        "0".to_string()
                    } else {
                        let p_ck2 = params.bind_str(meta.canonical_key.clone());
                        let list = params.bind_list_str(values);
                        format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck2} AND TRIM(COALESCE(cv.val_date, cv.val_text, '')) IN ({list}))"
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
                "formula" => {
                    if meta.canonical_key == "role:sr:dueStatus" {
                        let p_ck = params.bind_str(meta.canonical_key.clone());
                        let status_expr = format!(
                            "COALESCE(NULLIF(TRIM((SELECT fc.display_text FROM formula_cache fc WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p_ck})), ''), '待复习')"
                        );
                        if values.is_empty() {
                            return Some(if include_empty { "0".to_string() } else { "0".to_string() });
                        }
                        let list = params.bind_list_str(values);
                        return Some(format!("{status_expr} IN ({list})"));
                    }
                    let p_ck1 = params.bind_str(meta.canonical_key.clone());
                    let is_empty = format!(
                        "NOT EXISTS (SELECT 1 FROM formula_cache fc WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p_ck1} AND fc.kind != 'empty' AND TRIM(fc.display_text) != '')"
                    );
                    let has_match = if values.is_empty() {
                        "0".to_string()
                    } else {
                        let p_ck2 = params.bind_str(meta.canonical_key.clone());
                        let list = params.bind_list_str(values);
                        format!(
                            "EXISTS (SELECT 1 FROM formula_cache fc WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p_ck2} AND fc.kind != 'empty' AND TRIM(fc.display_text) IN ({list}))"
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
                _ => {
                    let p_ck1 = params.bind_str(meta.canonical_key.clone());
                    let is_empty = format!(
                        "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck1} AND TRIM(COALESCE(cv.val_text, '')) != '')"
                    );
                    let has_match = if values.is_empty() {
                        "0".to_string()
                    } else {
                        let p_ck2 = params.bind_str(meta.canonical_key.clone());
                        let list = params.bind_list_str(values);
                        format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck2} AND TRIM(COALESCE(cv.val_text, '')) IN ({list}))"
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
            }
        }
    }
}

fn build_ws_filter_condition_sql(
    cond: &TableFilterConditionInput,
    col_map: &HashMap<String, WsColumnMeta>,
    today_key: &str,
    params: &mut SqlParams,
) -> Option<String> {
    let col_meta = col_map.get(&cond.column_id);
    if !is_ws_system_col(&cond.column_id) && col_meta.is_none() {
        return None;
    }
    let kind = get_ws_filter_kind(&cond.column_id, col_meta);
    let op = cond.operator.as_str();
    if !is_valid_ws_operator(kind, op) {
        return None;
    }

    match kind {
        WsFilterKind::Images => {
            if op == "is_empty" {
                Some("e.image_count = 0".to_string())
            } else {
                Some("e.image_count > 0".to_string())
            }
        }
        WsFilterKind::Number => {
            let meta = col_meta?;
            let p_ck = params.bind_str(meta.canonical_key.clone());
            let val_expr = format!(
                "(SELECT cv.val_num FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck})"
            );
            match op {
                "is_empty" => Some(format!("{val_expr} IS NULL")),
                "is_not_empty" => Some(format!("{val_expr} IS NOT NULL")),
                _ => {
                    let target: f64 = cond.value.as_deref()?.trim().parse().ok()?;
                    if !target.is_finite() {
                        return None;
                    }
                    let p_num = params.bind_f64(target);
                    match op {
                        "eq" => Some(format!("{val_expr} = {p_num}")),
                        "neq" => Some(format!("({val_expr} IS NULL OR {val_expr} != {p_num})")),
                        "gt" => Some(format!("{val_expr} > {p_num}")),
                        "gte" => Some(format!("{val_expr} >= {p_num}")),
                        "lt" => Some(format!("{val_expr} < {p_num}")),
                        "lte" => Some(format!("{val_expr} <= {p_num}")),
                        _ => None,
                    }
                }
            }
        }
        WsFilterKind::Date => {
            let date_expr = build_ws_date_key_expr(&cond.column_id, col_meta, params)?;
            match op {
                "is_empty" => Some(format!("{date_expr} IS NULL")),
                "is_not_empty" => Some(format!("{date_expr} IS NOT NULL")),
                _ => {
                    let (start_key, end_key) = if let Some(preset) = cond.date_preset.as_deref() {
                        resolve_date_preset_range(preset, today_key)?
                    } else {
                        let (y, m, d) = parse_date_key(cond.value.as_deref()?)?;
                        let k = format_date_key(y, m, d);
                        (k.clone(), k)
                    };
                    match op {
                        "eq" => {
                            let ps = params.bind_str(start_key);
                            let pe = params.bind_str(end_key);
                            Some(format!(
                                "({date_expr} IS NOT NULL AND {date_expr} >= {ps} AND {date_expr} <= {pe})"
                            ))
                        }
                        "neq" => {
                            let ps = params.bind_str(start_key);
                            let pe = params.bind_str(end_key);
                            Some(format!(
                                "({date_expr} IS NULL OR {date_expr} < {ps} OR {date_expr} > {pe})"
                            ))
                        }
                        "gt" => {
                            let pe = params.bind_str(end_key);
                            Some(format!("({date_expr} IS NOT NULL AND {date_expr} > {pe})"))
                        }
                        "gte" => {
                            let ps = params.bind_str(start_key);
                            Some(format!("({date_expr} IS NOT NULL AND {date_expr} >= {ps})"))
                        }
                        "lt" => {
                            let ps = params.bind_str(start_key);
                            Some(format!("({date_expr} IS NOT NULL AND {date_expr} < {ps})"))
                        }
                        "lte" => {
                            let pe = params.bind_str(end_key);
                            Some(format!("({date_expr} IS NOT NULL AND {date_expr} <= {pe})"))
                        }
                        _ => None,
                    }
                }
            }
        }
        WsFilterKind::Select | WsFilterKind::Relation => {
            let requires_val = !matches!(op, "is_empty" | "is_not_empty");
            let selected_tokens: Vec<String> = if requires_val {
                let raw = cond.values.as_deref()?;
                if raw.is_empty() {
                    return None;
                }
                if let Some(meta) = col_meta {
                    resolve_option_names_for_filter(raw, meta)
                } else {
                    raw.to_vec()
                }
            } else {
                Vec::new()
            };
            // 单选列快路径：直接命中 idx_ws_cells_ck_text 覆盖索引，避免双重嵌套 COUNT(*) 子查询
            if let Some(meta) = col_meta.filter(|m| m.col_type == "select") {
                let p_ck = params.bind_str(meta.canonical_key.clone());
                match op {
                    "is_empty" => {
                        return Some(format!(
                            "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck} AND cv.val_text IS NOT NULL AND cv.val_text != '')"
                        ));
                    }
                    "is_not_empty" => {
                        return Some(format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck} AND cv.val_text IS NOT NULL AND cv.val_text != '')"
                        ));
                    }
                    "contains" | "not_contains" => {
                        let list = params.bind_list_str(&selected_tokens);
                        let cond_sql = format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck} AND cv.val_text IN ({list}))"
                        );
                        return Some(if op == "contains" {
                            cond_sql
                        } else {
                            format!("NOT {cond_sql}")
                        });
                    }
                    "eq" | "neq" => {
                        if selected_tokens.len() > 1 {
                            return Some(if op == "eq" {
                                "0 = 1".to_string()
                            } else {
                                "1 = 1".to_string()
                            });
                        }
                        let p_val = params.bind_str(selected_tokens[0].clone());
                        let exact = format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck} AND cv.val_text = {p_val})"
                        );
                        return Some(if op == "eq" {
                            exact
                        } else {
                            format!("NOT {exact}")
                        });
                    }
                    _ => {}
                }
            }
            let make_sub = |params: &mut SqlParams| -> Option<String> {
                match cond.column_id.as_str() {
                    "outer" => Some(
                        "SELECT e.parent_section_uuid AS tok WHERE e.parent_section_uuid IS NOT NULL".to_string(),
                    ),
                    "parents" | "children" | "inner" => {
                        let col = match cond.column_id.as_str() {
                            "parents" => "e.parents_json",
                            "children" => "e.children_json",
                            _ => "e.inner_json",
                        };
                        Some(format!(
                            "SELECT json_extract(je.value, '$.uuid') AS tok FROM json_each({col}) je"
                        ))
                    }
                    _ => {
                        let meta = col_meta?;
                        let p_ck = params.bind_str(meta.canonical_key.clone());
                        if meta.col_type == "multi_select" {
                            Some(format!(
                                "SELECT DISTINCT cm.option_name AS tok FROM cell_multi_options cm WHERE cm.doc_id = e.doc_id AND cm.entity_uuid = e.uuid AND cm.canonical_key = {p_ck}"
                            ))
                        } else {
                            Some(format!(
                                "SELECT cv.val_text AS tok FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck} AND TRIM(COALESCE(cv.val_text, '')) != ''"
                            ))
                        }
                    }
                }
            };
            match op {
                "is_empty" => {
                    let sub = make_sub(params)?;
                    Some(format!("NOT EXISTS ({sub})"))
                }
                "is_not_empty" => {
                    let sub = make_sub(params)?;
                    Some(format!("EXISTS ({sub})"))
                }
                "contains" => {
                    let sub = make_sub(params)?;
                    let list = params.bind_list_str(&selected_tokens);
                    Some(format!("EXISTS (SELECT 1 FROM ({sub}) t WHERE t.tok IN ({list}))"))
                }
                "not_contains" => {
                    let sub = make_sub(params)?;
                    let list = params.bind_list_str(&selected_tokens);
                    Some(format!("NOT EXISTS (SELECT 1 FROM ({sub}) t WHERE t.tok IN ({list}))"))
                }
                "eq" | "neq" => {
                    let sub1 = make_sub(params)?;
                    let sub2 = make_sub(params)?;
                    let list = params.bind_list_str(&selected_tokens);
                    let n = selected_tokens.len();
                    let exact = format!(
                        "((SELECT COUNT(*) FROM ({sub1})) = {n} AND (SELECT COUNT(*) FROM ({sub2}) t WHERE t.tok IN ({list})) = {n})"
                    );
                    if op == "eq" {
                        Some(exact)
                    } else {
                        Some(format!("NOT {exact}"))
                    }
                }
                _ => None,
            }
        }
        WsFilterKind::Text => {
            // 间隔重复 role:sr:dueStatus 快路径：直接命中 entities.sr_due_status 覆盖索引（< 1 ms）
            if col_meta.map(|m| m.canonical_key.as_str()) == Some("role:sr:dueStatus")
                || cond.column_id == "role:sr:dueStatus"
            {
                if op == "eq" || op == "neq" {
                    let target = cond.value.as_deref()?.trim();
                    if target.is_empty() {
                        return None;
                    }
                    let p_val = params.bind_str(target.to_string());
                    return Some(if op == "eq" {
                        format!("e.sr_due_status = {p_val}")
                    } else {
                        format!("e.sr_due_status != {p_val}")
                    });
                }
            }
            // sourceFolder 精确匹配快路径：直接命中 idx_ws_docs_folder_nc 索引
            if cond.column_id == "sourceFolder" && (op == "eq" || op == "neq") {
                let target = cond.value.as_deref()?.trim();
                if target.is_empty() {
                    return None;
                }
                let p_val = params.bind_str(target.to_string());
                return Some(if op == "eq" {
                    format!("d.folder_path COLLATE NOCASE = {p_val}")
                } else {
                    format!("d.folder_path COLLATE NOCASE != {p_val}")
                });
            }
            let text_expr = match cond.column_id.as_str() {
                "name" => "TRIM(e.text)".to_string(),
                "sourceFile" => "TRIM(d.title)".to_string(),
                "sourceFolder" => "TRIM(d.folder_path)".to_string(),
                _ => {
                    let meta = col_meta?;
                    let p_ck = params.bind_str(meta.canonical_key.clone());
                    if meta.canonical_key == "role:sr:dueStatus" {
                        format!(
                            "COALESCE(NULLIF(TRIM((SELECT fc.display_text FROM formula_cache fc WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p_ck})), ''), '待复习')"
                        )
                    } else if meta.col_type == "formula" {
                        format!(
                            "COALESCE((SELECT CASE WHEN fc.kind = 'empty' THEN '' ELSE TRIM(fc.display_text) END FROM formula_cache fc WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p_ck}), '')"
                        )
                    } else {
                        format!(
                            "COALESCE((SELECT TRIM(COALESCE(cv.val_text, '')) FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck}), '')"
                        )
                    }
                }
            };
            match op {
                "is_empty" => Some(format!("{text_expr} = ''")),
                "is_not_empty" => Some(format!("{text_expr} != ''")),
                _ => {
                    let target = cond.value.as_deref()?.trim();
                    if target.is_empty() {
                        return None;
                    }
                    let pt = params.bind_str(target.to_lowercase());
                    match op {
                        "contains" => Some(format!("INSTR(lower({text_expr}), {pt}) > 0")),
                        "not_contains" => Some(format!("INSTR(lower({text_expr}), {pt}) = 0")),
                        "eq" => Some(format!("lower({text_expr}) = {pt}")),
                        "neq" => Some(format!("lower({text_expr}) != {pt}")),
                        _ => None,
                    }
                }
            }
        }
    }
}

fn build_ws_extra_group_filter_sql(
    extra: &TableExtraGroupFilter,
    col_map: &HashMap<String, WsColumnMeta>,
    params: &mut SqlParams,
) -> Option<String> {
    let col_meta = col_map.get(&extra.column_id);
    if !is_ws_system_col(&extra.column_id) && col_meta.is_none() {
        return None;
    }

    let core = match extra.column_id.as_str() {
        "sourceFile" => match &extra.group_key {
            None => "TRIM(d.title) = ''".to_string(),
            Some(k) => {
                let pk = params.bind_str(k.clone());
                format!("(d.doc_id = {pk} OR d.rel_path = {pk} OR d.title = {pk})")
            }
        },
        "sourceFolder" => match &extra.group_key {
            None => "TRIM(d.folder_path) = ''".to_string(),
            Some(k) => {
                let pk = params.bind_str(k.clone());
                format!("d.folder_path = {pk}")
            }
        },
        "outer" => match &extra.group_key {
            None => "e.parent_section_uuid IS NULL".to_string(),
            Some(k) => {
                let pk = params.bind_str(k.clone());
                format!("e.parent_section_uuid = {pk}")
            }
        },
        _ => {
            let meta = col_meta?;
            let p_ck = params.bind_str(meta.canonical_key.clone());
            if meta.canonical_key == "role:sr:dueStatus" {
                let expr = format!(
                    "COALESCE(NULLIF(TRIM((SELECT fc.display_text FROM formula_cache fc WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p_ck})), ''), '待复习')"
                );
                match &extra.group_key {
                    None => "0 = 1".to_string(),
                    Some(k) => {
                        let pk = params.bind_str(k.clone());
                        format!("{expr} = {pk}")
                    }
                }
            } else {
                match meta.col_type.as_str() {
                    "select" => match &extra.group_key {
                        None => format!(
                            "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck} AND TRIM(COALESCE(cv.val_text, '')) != '')"
                        ),
                        Some(k) => {
                            let resolved = meta.opt_name_by_id.get(k).cloned().unwrap_or_else(|| k.clone());
                            let pk = params.bind_str(resolved);
                            format!(
                                "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck} AND cv.val_text = {pk})"
                            )
                        }
                    },
                    "formula" => match &extra.group_key {
                        None => format!(
                            "NOT EXISTS (SELECT 1 FROM formula_cache fc WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p_ck} AND fc.kind != 'empty' AND TRIM(fc.display_text) != '')"
                        ),
                        Some(k) => {
                            let pk = params.bind_str(k.clone());
                            format!(
                                "EXISTS (SELECT 1 FROM formula_cache fc WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p_ck} AND fc.kind != 'empty' AND TRIM(fc.display_text) = {pk})"
                            )
                        }
                    },
                    _ => match &extra.group_key {
                        None => format!(
                            "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck} AND TRIM(COALESCE(cv.val_text, '')) != '')"
                        ),
                        Some(k) => {
                            let pk = params.bind_str(k.clone());
                            format!(
                                "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck} AND TRIM(COALESCE(cv.val_text, '')) = {pk})"
                            )
                        }
                    },
                }
            }
        }
    };

    if extra.pinned_uuids.is_empty() {
        Some(core)
    } else {
        // 支持纯 uuid 或 "docId:uuid" 复合键
        let mut plain_uuids = Vec::new();
        let mut composite_clauses = Vec::new();
        for item in &extra.pinned_uuids {
            if let Some((did, uid)) = item.split_once(':') {
                let p_d = params.bind_str(did.to_string());
                let p_u = params.bind_str(uid.to_string());
                composite_clauses.push(format!("(e.doc_id = {p_d} AND e.uuid = {p_u})"));
            } else {
                plain_uuids.push(item.clone());
            }
        }
        let mut pin_parts = composite_clauses;
        if !plain_uuids.is_empty() {
            let list = params.bind_list_str(&plain_uuids);
            pin_parts.push(format!("e.uuid IN ({list})"));
        }
        Some(format!("(({core}) OR ({}))", pin_parts.join(" OR ")))
    }
}

fn build_ws_where_clause(
    scope: &WorkspaceScope,
    filters: &[TableColumnFilterInput],
    filter_group: Option<&TableFilterGroupInput>,
    extra_group_filter: Option<&TableExtraGroupFilter>,
    col_map: &HashMap<String, WsColumnMeta>,
    today_key: &str,
    params: &mut SqlParams,
) -> String {
    let mut clauses = vec![
        "e.is_row = 1".to_string(),
        build_scope_sql(scope, params),
    ];

    for flt in filters {
        if let Some(sql) = build_ws_column_filter_sql(flt, col_map, params) {
            clauses.push(sql);
        }
    }

    if let Some(grp) = filter_group {
        let mut cond_sqls = Vec::new();
        for cond in &grp.conditions {
            if let Some(sql) = build_ws_filter_condition_sql(cond, col_map, today_key, params) {
                cond_sqls.push(sql);
            }
        }
        if !cond_sqls.is_empty() {
            let joiner = if grp.conjunction == "or" {
                " OR "
            } else {
                " AND "
            };
            clauses.push(format!("({})", cond_sqls.join(joiner)));
        }
    }

    if let Some(extra) = extra_group_filter {
        if let Some(sql) = build_ws_extra_group_filter_sql(extra, col_map, params) {
            clauses.push(sql);
        }
    }

    clauses.join(" AND ")
}

fn build_ws_order_by_clause(
    sort: Option<&TableSortInput>,
    col_map: &HashMap<String, WsColumnMeta>,
    params: &mut SqlParams,
) -> String {
    let tie = "d.rel_path COLLATE \"NATURAL\" ASC, e.sort_order ASC";
    let Some(sort) = sort else {
        return tie.to_string();
    };
    let dir = if sort.direction == "desc" { "DESC" } else { "ASC" };

    match sort.column_id.as_str() {
        "name" => format!(
            "CASE WHEN TRIM(e.text) = '' THEN 1 ELSE 0 END ASC, TRIM(e.text) COLLATE \"NATURAL\" {dir}, {tie}"
        ),
        "sourceFile" => format!(
            "CASE WHEN TRIM(d.title) = '' THEN 1 ELSE 0 END ASC, TRIM(d.title) COLLATE \"NATURAL\" {dir}, {tie}"
        ),
        "sourceFolder" => format!(
            "CASE WHEN TRIM(d.folder_path) = '' THEN 1 ELSE 0 END ASC, TRIM(d.folder_path) COLLATE \"NATURAL\" {dir}, {tie}"
        ),
        "images" => format!("e.image_count {dir}, {tie}"),
        "createdAt" => {
            if dir == "DESC" {
                format!("e.created_at DESC, {tie}")
            } else {
                format!("CASE WHEN e.created_at <= 0 THEN 1 ELSE 0 END ASC, e.created_at ASC, {tie}")
            }
        }
        "updatedAt" => {
            if dir == "DESC" {
                format!("e.updated_at DESC, {tie}")
            } else {
                format!("CASE WHEN e.updated_at <= 0 THEN 1 ELSE 0 END ASC, e.updated_at ASC, {tie}")
            }
        }
        "outer" => format!(
            "CASE WHEN COALESCE(TRIM(e.outer_label), '') = '' THEN 1 ELSE 0 END ASC, COALESCE(TRIM(e.outer_label), '') COLLATE \"NATURAL\" {dir}, {tie}"
        ),
        _ => {
            let Some(meta) = col_map.get(&sort.column_id) else {
                return tie.to_string();
            };
            match meta.col_type.as_str() {
                "number" => {
                    let p1 = params.bind_str(meta.canonical_key.clone());
                    let p2 = params.bind_str(meta.canonical_key.clone());
                    format!(
                        "CASE WHEN (SELECT cv.val_num FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p1}) IS NULL THEN 1 ELSE 0 END ASC,
                         (SELECT cv.val_num FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p2}) {dir}, {tie}"
                    )
                }
                "date" => {
                    let p1 = params.bind_str(meta.canonical_key.clone());
                    let p2 = params.bind_str(meta.canonical_key.clone());
                    format!(
                        "CASE WHEN COALESCE((SELECT TRIM(COALESCE(cv.val_date, cv.val_text, '')) FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p1}), '') = '' THEN 1 ELSE 0 END ASC,
                         COALESCE((SELECT TRIM(COALESCE(cv.val_date, cv.val_text, '')) FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p2}), '') COLLATE \"NATURAL\" {dir}, {tie}"
                    )
                }
                "formula" => {
                    let p1 = params.bind_str(meta.canonical_key.clone());
                    let p2 = params.bind_str(meta.canonical_key.clone());
                    let p3 = params.bind_str(meta.canonical_key.clone());
                    format!(
                        "CASE WHEN COALESCE((SELECT CASE WHEN fc.kind = 'empty' THEN 1 WHEN fc.kind IN ('number', 'date', 'boolean') THEN 0 WHEN TRIM(fc.display_text) = '' THEN 1 ELSE 0 END FROM formula_cache fc WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p1}), 1) = 1 THEN 1 ELSE 0 END ASC,
                         (SELECT CASE
                            WHEN fc.kind = 'number' THEN fc.val_num
                            WHEN fc.kind = 'date' THEN CAST(fc.val_date_ms AS REAL)
                            WHEN fc.kind = 'boolean' THEN CASE WHEN UPPER(fc.display_text) = 'TRUE' THEN 1.0 ELSE 0.0 END
                            ELSE NULL
                          END FROM formula_cache fc WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p2}) {dir},
                         COALESCE((SELECT TRIM(fc.display_text) FROM formula_cache fc WHERE fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p3}), '') COLLATE \"NATURAL\" {dir}, {tie}"
                    )
                }
                _ => {
                    let p1 = params.bind_str(meta.canonical_key.clone());
                    let p2 = params.bind_str(meta.canonical_key.clone());
                    format!(
                        "CASE WHEN COALESCE((SELECT TRIM(COALESCE(cv.val_text, '')) FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p1}), '') = '' THEN 1 ELSE 0 END ASC,
                         COALESCE((SELECT TRIM(COALESCE(cv.val_text, '')) FROM cell_values cv WHERE cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p2}), '') COLLATE \"NATURAL\" {dir}, {tie}"
                    )
                }
            }
        }
    }
}

// ============================================================================
// 当前页批量组装（O(page_size)，零全表扫描）
// ============================================================================

struct RawWsEntityRow {
    doc_id: String,
    uuid: String,
    kind: String,
    parent_section_uuid: Option<String>,
    outer_label: Option<String>,
    text: String,
    images_json: String,
    parents_json: String,
    children_json: String,
    inner_json: String,
    created_at: i64,
    updated_at: i64,
    sort_order: i64,
    source_file: String,
    source_folder: String,
    source_rel_path: String,
}

fn hydrate_ws_page_rows(
    conn: &Connection,
    raw_rows: Vec<RawWsEntityRow>,
    col_map: &HashMap<String, WsColumnMeta>,
) -> Result<Vec<V3TableRowRecord>, String> {
    if raw_rows.is_empty() {
        return Ok(Vec::new());
    }

    // 收集本页涉及的 (doc_id, uuid) 键集与 doc_id 集
    let page_keys: HashSet<(String, String)> = raw_rows
        .iter()
        .map(|r| (r.doc_id.clone(), r.uuid.clone()))
        .collect();
    let unique_uuids: Vec<String> = raw_rows
        .iter()
        .map(|r| r.uuid.clone())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let phs: String = (1..=unique_uuids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let sql_vals: Vec<SqlValue> = unique_uuids.into_iter().map(SqlValue::Text).collect();

    // 1. 批量加载 cell_values 并把 select/multi_select 的 option_name 映射为工作空间稳定 ws optionId
    let mut cells_by_row: HashMap<(String, String), Vec<V3CellValueRecord>> = HashMap::new();
    {
        let sql = format!(
            "SELECT doc_id, entity_uuid, canonical_key, val_type, val_text, val_num, val_date, val_json
             FROM cell_values WHERE entity_uuid IN ({phs})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("批量查询跨文件 cell_values 失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(sql_vals.iter()), |r| {
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
            .map_err(|e| format!("遍历跨文件 cell_values 失败: {e}"))?;

        for row in rows {
            let (doc_id, entity_uuid, canonical_key, val_type, val_text, val_num, val_date, val_json) =
                row.map_err(|e| format!("解析跨文件 cell_values 失败: {e}"))?;
            let key = (doc_id, entity_uuid.clone());
            if !page_keys.contains(&key) {
                continue;
            }
            let meta = col_map.get(&canonical_key);
            let (mapped_text, mapped_json) = match val_type.as_str() {
                "select" => {
                    let opt_id = val_text.as_deref().map(|name| {
                        meta.and_then(|m| m.opt_id_by_name.get(name).cloned())
                            .unwrap_or_else(|| name.to_string())
                    });
                    (opt_id, None)
                }
                "multi_select" => {
                    let ids: Vec<String> = val_json
                        .as_deref()
                        .and_then(|s| serde_json::from_str::<Vec<String>>(s).ok())
                        .unwrap_or_default()
                        .into_iter()
                        .map(|name| {
                            meta.and_then(|m| m.opt_id_by_name.get(&name).cloned())
                                .unwrap_or(name)
                        })
                        .collect();
                    (val_text, serde_json::to_string(&ids).ok())
                }
                _ => (val_text, val_json),
            };
            cells_by_row
                .entry(key)
                .or_default()
                .push(V3CellValueRecord {
                    entity_uuid,
                    col_id: canonical_key.clone(),
                    canonical_key,
                    val_type,
                    val_text: mapped_text,
                    val_num,
                    val_date,
                    val_json: mapped_json,
                    multi_options: Vec::new(),
                });
        }
    }

    // 2. 批量加载 formula_cache
    let mut formulas_by_row: HashMap<(String, String), HashMap<String, V3FormulaCellRecord>> =
        HashMap::new();
    {
        let sql = format!(
            "SELECT doc_id, entity_uuid, canonical_key, kind, display_text, val_num, val_date_ms, val_json
             FROM formula_cache WHERE entity_uuid IN ({phs})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("批量查询跨文件 formula_cache 失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(sql_vals.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<f64>>(5)?,
                    r.get::<_, Option<i64>>(6)?,
                    r.get::<_, Option<String>>(7)?,
                ))
            })
            .map_err(|e| format!("遍历跨文件 formula_cache 失败: {e}"))?;

        for row in rows {
            let (doc_id, entity_uuid, canonical_key, kind, display_text, val_num, val_date_ms, val_json) =
                row.map_err(|e| format!("解析跨文件 formula_cache 失败: {e}"))?;
            let key = (doc_id, entity_uuid);
            if !page_keys.contains(&key) {
                continue;
            }
            let meta_val: Option<serde_json::Value> =
                val_json.as_deref().and_then(|s| serde_json::from_str(s).ok());
            let date_has_time = meta_val
                .as_ref()
                .and_then(|v| v.get("dateHasTime"))
                .and_then(|v| v.as_bool());
            let boolean_value = if kind == "boolean" {
                meta_val
                    .as_ref()
                    .and_then(|v| v.get("booleanValue"))
                    .and_then(|v| v.as_bool())
                    .or_else(|| Some(display_text.eq_ignore_ascii_case("true")))
            } else {
                None
            };
            let list_items = meta_val
                .as_ref()
                .and_then(|v| v.get("listItems"))
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str().map(|s| s.to_string()))
                        .collect::<Vec<_>>()
                });
            let error_code = meta_val
                .as_ref()
                .and_then(|v| v.get("errorCode"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let error_message = meta_val
                .as_ref()
                .and_then(|v| v.get("errorMessage"))
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());

            formulas_by_row
                .entry(key)
                .or_default()
                .insert(
                    canonical_key,
                    V3FormulaCellRecord {
                        kind,
                        display_text,
                        numeric_value: val_num,
                        date_ms: val_date_ms,
                        date_has_time,
                        boolean_value,
                        list_items,
                        error_code,
                        error_message,
                    },
                );
        }
    }

    let mut out = Vec::with_capacity(raw_rows.len());
    for raw in raw_rows {
        let key = (raw.doc_id.clone(), raw.uuid.clone());
        let images: Vec<V3ImageItemRecord> =
            serde_json::from_str(&raw.images_json).unwrap_or_default();
        let parents: Vec<V3RelationItemRecord> =
            serde_json::from_str(&raw.parents_json).unwrap_or_default();
        let children: Vec<V3RelationItemRecord> =
            serde_json::from_str(&raw.children_json).unwrap_or_default();
        let inner: Vec<V3RelationItemRecord> =
            serde_json::from_str(&raw.inner_json).unwrap_or_default();
        let outer = raw.parent_section_uuid.map(|pid| V3RelationItemRecord {
            uuid: pid,
            label: raw.outer_label.unwrap_or_default(),
            kind: "section".to_string(),
        });
        let is_container = is_editable_container_kind(&raw.kind);

        out.push(V3TableRowRecord {
            doc_id: raw.doc_id,
            editable_text: is_editable_text_kind(&raw.kind),
            can_edit_images: is_container,
            can_edit_inner: is_container,
            primary_text: raw.text,
            images,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            parents,
            children,
            outer,
            inner,
            cell_values: cells_by_row.remove(&key).unwrap_or_default(),
            formula_values: formulas_by_row.remove(&key).unwrap_or_default(),
            sort_order: raw.sort_order,
            uuid: raw.uuid,
            kind: raw.kind,
            source_file: Some(raw.source_file),
            source_folder: Some(raw.source_folder),
            source_rel_path: Some(raw.source_rel_path),
        });
    }
    Ok(out)
}

// ============================================================================
// 5 大跨文件查询入口
// ============================================================================

/// 1. 跨文件分页查询表格行。
pub fn query_workspace_table_page(
    conn: &Connection,
    query: &WorkspaceTablePageQuery,
) -> Result<TablePageResult, String> {
    let col_map = load_ws_column_meta_map(conn)?;
    let today_key = resolve_today_key(conn, query.today_key.as_deref());

    let unfiltered_total_count: usize = if query.scope.kind == "all" {
        conn.query_row("SELECT COUNT(*) FROM entities WHERE is_row = 1", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| format!("查询跨文件总行数失败: {e}"))? as usize
    } else {
        let mut unflt_params = SqlParams::new();
        let scope_sql = build_scope_sql(&query.scope, &mut unflt_params);
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM entities e JOIN docs d ON d.doc_id = e.doc_id WHERE e.is_row = 1 AND {scope_sql}"
            ),
            params_from_iter(unflt_params.values.iter()),
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| format!("查询跨文件总行数失败: {e}"))? as usize
    };

    let mut count_params = SqlParams::new();
    let count_where = build_ws_where_clause(
        &query.scope,
        &query.filters,
        query.filter_group.as_ref(),
        query.extra_group_filter.as_ref(),
        &col_map,
        &today_key,
        &mut count_params,
    );
    let count_needs_docs = count_where.contains("d.");
    let count_from = if count_needs_docs {
        if count_where.contains("d.folder_path") || query.scope.kind != "all" {
            "FROM docs d CROSS JOIN entities e ON e.doc_id = d.doc_id"
        } else {
            "FROM entities e JOIN docs d ON d.doc_id = e.doc_id"
        }
    } else {
        "FROM entities e"
    };
    let total_count: usize = conn
        .query_row(
            &format!("SELECT COUNT(*) {count_from} WHERE {count_where}"),
            params_from_iter(count_params.values.iter()),
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| format!("查询跨文件筛选后行数失败: {e}"))? as usize;

    let effective_limit = query.limit.clamp(1, 5000);
    let mut page_params = SqlParams::new();
    let page_where = build_ws_where_clause(
        &query.scope,
        &query.filters,
        query.filter_group.as_ref(),
        query.extra_group_filter.as_ref(),
        &col_map,
        &today_key,
        &mut page_params,
    );
    let order_by = build_ws_order_by_clause(query.sort.as_ref(), &col_map, &mut page_params);
    page_params
        .values
        .push(SqlValue::Integer(effective_limit as i64));
    let p_limit = format!("?{}", page_params.values.len());
    page_params
        .values
        .push(SqlValue::Integer(query.offset as i64));
    let p_offset = format!("?{}", page_params.values.len());

    let drive_from_docs =
        query.sort.is_none() || page_where.contains("d.folder_path") || query.scope.kind != "all";
    let page_from = if drive_from_docs {
        "FROM docs d CROSS JOIN entities e ON e.doc_id = d.doc_id"
    } else {
        "FROM entities e JOIN docs d ON d.doc_id = e.doc_id"
    };

    let page_sql = format!(
        "SELECT e.doc_id, e.uuid, e.kind, e.parent_section_uuid, e.outer_label, e.text,
                e.images_json, e.parents_json, e.children_json, e.inner_json,
                e.created_at, e.updated_at, e.sort_order,
                d.title, d.folder_path, d.rel_path
         {page_from}
         WHERE {page_where}
         ORDER BY {order_by}
         LIMIT {p_limit} OFFSET {p_offset}"
    );

    let raw_rows = {
        let mut stmt = conn
            .prepare(&page_sql)
            .map_err(|e| format!("准备跨文件分页查询失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(page_params.values.iter()), |row| {
                Ok(RawWsEntityRow {
                    doc_id: row.get(0)?,
                    uuid: row.get(1)?,
                    kind: row.get(2)?,
                    parent_section_uuid: row.get(3)?,
                    outer_label: row.get(4)?,
                    text: row.get(5)?,
                    images_json: row.get(6)?,
                    parents_json: row.get(7)?,
                    children_json: row.get(8)?,
                    inner_json: row.get(9)?,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                    sort_order: row.get(12)?,
                    source_file: row.get(13)?,
                    source_folder: row.get(14)?,
                    source_rel_path: row.get(15)?,
                })
            })
            .map_err(|e| format!("执行跨文件分页查询失败: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("解析跨文件分页结果失败: {e}"))?
    };

    let hydrated = hydrate_ws_page_rows(conn, raw_rows, &col_map)?;
    Ok(TablePageResult {
        total_count,
        unfiltered_total_count,
        offset: query.offset,
        limit: effective_limit,
        rows: hydrated,
    })
}

/// 2. 跨文件列值筛选分桶聚合。
pub fn query_workspace_filter_buckets(
    conn: &Connection,
    query: &WorkspaceTableFilterBucketsQuery,
) -> Result<TableFilterBucketsResult, String> {
    let col_map = load_ws_column_meta_map(conn)?;
    let col_meta = col_map.get(&query.column_id);
    if !is_ws_system_col(&query.column_id) && col_meta.is_none() {
        return Ok(TableFilterBucketsResult {
            buckets: Vec::new(),
            empty_count: 0,
            total_buckets: 0,
        });
    }

    let mut scope_params = SqlParams::new();
    let scope_sql = build_scope_sql(&query.scope, &mut scope_params);
    let total_rows: usize = conn
        .query_row(
            &format!(
                "SELECT COUNT(*) FROM entities e JOIN docs d ON d.doc_id = e.doc_id WHERE e.is_row = 1 AND {scope_sql}"
            ),
            params_from_iter(scope_params.values.iter()),
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| format!("统计跨文件总行数失败: {e}"))? as usize;

    let mut buckets: Vec<ColumnFilterBucketRecord> = Vec::new();
    let empty_count: usize;

    match query.column_id.as_str() {
        "name" => {
            let mut p = SqlParams::new();
            let s = build_scope_sql(&query.scope, &mut p);
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT TRIM(e.text) AS k, COUNT(*) FROM entities e JOIN docs d ON d.doc_id = e.doc_id
                     WHERE e.is_row = 1 AND {s} AND TRIM(e.text) != '' GROUP BY k"
                ))
                .map_err(|e| format!("查询 name 分桶失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(p.values.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                })
                .map_err(|e| format!("遍历 name 分桶失败: {e}"))?;
            let mut non_empty = 0usize;
            for r in rows.flatten() {
                non_empty += r.1;
                buckets.push(ColumnFilterBucketRecord {
                    key: r.0.clone(),
                    label: r.0,
                    count: r.1,
                    color: None,
                });
            }
            empty_count = total_rows.saturating_sub(non_empty);
            buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        }
        "sourceFile" => {
            let mut p = SqlParams::new();
            let s = build_scope_sql(&query.scope, &mut p);
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT d.doc_id, d.title, d.rel_path, COUNT(*)
                     FROM entities e JOIN docs d ON d.doc_id = e.doc_id
                     WHERE e.is_row = 1 AND {s}
                     GROUP BY d.doc_id"
                ))
                .map_err(|e| format!("查询 sourceFile 分桶失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(p.values.iter()), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, i64>(3)? as usize,
                    ))
                })
                .map_err(|e| format!("遍历 sourceFile 分桶失败: {e}"))?;
            let mut non_empty = 0usize;
            for r in rows.flatten() {
                non_empty += r.3;
                buckets.push(ColumnFilterBucketRecord {
                    key: r.0,
                    label: if r.1.is_empty() { r.2 } else { r.1 },
                    count: r.3,
                    color: None,
                });
            }
            empty_count = total_rows.saturating_sub(non_empty);
            buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        }
        "sourceFolder" => {
            let mut p = SqlParams::new();
            let s = build_scope_sql(&query.scope, &mut p);
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT TRIM(d.folder_path) AS f, COUNT(*)
                     FROM entities e JOIN docs d ON d.doc_id = e.doc_id
                     WHERE e.is_row = 1 AND {s}
                     GROUP BY f"
                ))
                .map_err(|e| format!("查询 sourceFolder 分桶失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(p.values.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                })
                .map_err(|e| format!("遍历 sourceFolder 分桶失败: {e}"))?;
            let mut ec = 0usize;
            for r in rows.flatten() {
                if r.0.is_empty() {
                    ec += r.1;
                } else {
                    buckets.push(ColumnFilterBucketRecord {
                        key: r.0.clone(),
                        label: r.0,
                        count: r.1,
                        color: None,
                    });
                }
            }
            empty_count = ec;
            buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        }
        "images" => {
            let mut p = SqlParams::new();
            let s = build_scope_sql(&query.scope, &mut p);
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT e.image_count, COUNT(*) FROM entities e JOIN docs d ON d.doc_id = e.doc_id
                     WHERE e.is_row = 1 AND {s} GROUP BY e.image_count"
                ))
                .map_err(|e| format!("查询 images 分桶失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(p.values.iter()), |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? as usize))
                })
                .map_err(|e| format!("遍历 images 分桶失败: {e}"))?;
            let mut ec = 0usize;
            for (cnt_val, row_cnt) in rows.flatten() {
                if cnt_val <= 0 {
                    ec += row_cnt;
                } else {
                    let s = cnt_val.to_string();
                    buckets.push(ColumnFilterBucketRecord {
                        key: s.clone(),
                        label: s,
                        count: row_cnt,
                        color: None,
                    });
                }
            }
            empty_count = ec;
            buckets.sort_by_key(|b| b.key.parse::<i64>().unwrap_or(0));
        }
        "createdAt" | "updatedAt" => {
            let col_sql = if query.column_id == "createdAt" {
                "e.created_at"
            } else {
                "e.updated_at"
            };
            let mut p = SqlParams::new();
            let s = build_scope_sql(&query.scope, &mut p);
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT CASE WHEN {col_sql} > 0 THEN strftime('%Y-%m-%d', {col_sql} / 1000, 'unixepoch', 'localtime') ELSE '' END AS dt, COUNT(*)
                     FROM entities e JOIN docs d ON d.doc_id = e.doc_id
                     WHERE e.is_row = 1 AND {s} GROUP BY dt"
                ))
                .map_err(|e| format!("查询时间分桶失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(p.values.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                })
                .map_err(|e| format!("遍历时间分桶失败: {e}"))?;
            let mut ec = 0usize;
            for (dt, cnt) in rows.flatten() {
                if dt.is_empty() {
                    ec += cnt;
                } else {
                    buckets.push(ColumnFilterBucketRecord {
                        key: dt.clone(),
                        label: dt,
                        count: cnt,
                        color: None,
                    });
                }
            }
            empty_count = ec;
            buckets.sort_by(|a, b| b.key.cmp(&a.key));
        }
        "outer" => {
            let mut p = SqlParams::new();
            let s = build_scope_sql(&query.scope, &mut p);
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT e.parent_section_uuid, COALESCE(TRIM(e.outer_label), ''), COUNT(*)
                     FROM entities e JOIN docs d ON d.doc_id = e.doc_id
                     WHERE e.is_row = 1 AND {s} AND e.parent_section_uuid IS NOT NULL
                     GROUP BY e.parent_section_uuid"
                ))
                .map_err(|e| format!("查询 outer 分桶失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(p.values.iter()), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)? as usize,
                    ))
                })
                .map_err(|e| format!("遍历 outer 分桶失败: {e}"))?;
            let mut non_empty = 0usize;
            for (uid, lbl, cnt) in rows.flatten() {
                non_empty += cnt;
                buckets.push(ColumnFilterBucketRecord {
                    label: if lbl.is_empty() { uid.clone() } else { lbl },
                    key: uid,
                    count: cnt,
                    color: None,
                });
            }
            empty_count = total_rows.saturating_sub(non_empty);
            buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        }
        "parents" | "children" | "inner" => {
            let json_col = match query.column_id.as_str() {
                "parents" => "e.parents_json",
                "children" => "e.children_json",
                _ => "e.inner_json",
            };
            let mut p = SqlParams::new();
            let s = build_scope_sql(&query.scope, &mut p);
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT json_extract(je.value, '$.uuid') AS uid,
                            COALESCE(json_extract(je.value, '$.label'), '') AS lbl,
                            COUNT(*)
                     FROM entities e
                     JOIN docs d ON d.doc_id = e.doc_id
                     JOIN json_each({json_col}) je
                     WHERE e.is_row = 1 AND {s}
                     GROUP BY uid"
                ))
                .map_err(|e| format!("查询关系分桶失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(p.values.iter()), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, i64>(2)? as usize,
                    ))
                })
                .map_err(|e| format!("遍历关系分桶失败: {e}"))?;
            for (uid, lbl, cnt) in rows.flatten() {
                buckets.push(ColumnFilterBucketRecord {
                    label: if lbl.trim().is_empty() { uid.clone() } else { lbl },
                    key: uid,
                    count: cnt,
                    color: None,
                });
            }
            let mut p2 = SqlParams::new();
            let s2 = build_scope_sql(&query.scope, &mut p2);
            let non_empty: usize = conn
                .query_row(
                    &format!(
                        "SELECT COUNT(*) FROM entities e JOIN docs d ON d.doc_id = e.doc_id
                         WHERE e.is_row = 1 AND {s2} AND json_array_length({json_col}) > 0"
                    ),
                    params_from_iter(p2.values.iter()),
                    |r| r.get::<_, i64>(0),
                )
                .unwrap_or(0) as usize;
            empty_count = total_rows.saturating_sub(non_empty);
            buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        }
        _ => {
            let meta = col_meta.unwrap();
            let mut p = SqlParams::new();
            let s = build_scope_sql(&query.scope, &mut p);
            let p_ck = p.bind_str(meta.canonical_key.clone());
            match meta.col_type.as_str() {
                "number" => {
                    let mut stmt = conn
                        .prepare(&format!(
                            "SELECT cv.val_num, COUNT(*)
                             FROM cell_values cv
                             JOIN entities e ON e.doc_id = cv.doc_id AND e.uuid = cv.entity_uuid AND e.is_row = 1
                             JOIN docs d ON d.doc_id = e.doc_id
                             WHERE {s} AND cv.canonical_key = {p_ck} AND cv.val_num IS NOT NULL
                             GROUP BY cv.val_num ORDER BY cv.val_num ASC"
                        ))
                        .map_err(|e| format!("查询 number 分桶失败: {e}"))?;
                    let rows = stmt
                        .query_map(params_from_iter(p.values.iter()), |r| {
                            Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)? as usize))
                        })
                        .map_err(|e| format!("遍历 number 分桶失败: {e}"))?;
                    let mut non_empty = 0usize;
                    for (num, cnt) in rows.flatten() {
                        non_empty += cnt;
                        let st = format_js_number(num);
                        buckets.push(ColumnFilterBucketRecord {
                            key: st.clone(),
                            label: st,
                            count: cnt,
                            color: None,
                        });
                    }
                    empty_count = total_rows.saturating_sub(non_empty);
                }
                "date" => {
                    let mut stmt = conn
                        .prepare(&format!(
                            "SELECT TRIM(COALESCE(cv.val_date, cv.val_text, '')) AS k, COUNT(*)
                             FROM cell_values cv
                             JOIN entities e ON e.doc_id = cv.doc_id AND e.uuid = cv.entity_uuid AND e.is_row = 1
                             JOIN docs d ON d.doc_id = e.doc_id
                             WHERE {s} AND cv.canonical_key = {p_ck} AND TRIM(COALESCE(cv.val_date, cv.val_text, '')) != ''
                             GROUP BY k ORDER BY k DESC"
                        ))
                        .map_err(|e| format!("查询 date 分桶失败: {e}"))?;
                    let rows = stmt
                        .query_map(params_from_iter(p.values.iter()), |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                        })
                        .map_err(|e| format!("遍历 date 分桶失败: {e}"))?;
                    let mut non_empty = 0usize;
                    for (k, cnt) in rows.flatten() {
                        non_empty += cnt;
                        buckets.push(ColumnFilterBucketRecord {
                            key: k.clone(),
                            label: k,
                            count: cnt,
                            color: None,
                        });
                    }
                    empty_count = total_rows.saturating_sub(non_empty);
                }
                "select" => {
                    let mut counts: HashMap<String, usize> = HashMap::new();
                    let mut stmt = conn
                        .prepare(&format!(
                            "SELECT cv.val_text, COUNT(*)
                             FROM cell_values cv
                             JOIN entities e ON e.doc_id = cv.doc_id AND e.uuid = cv.entity_uuid AND e.is_row = 1
                             JOIN docs d ON d.doc_id = e.doc_id
                             WHERE {s} AND cv.canonical_key = {p_ck} AND TRIM(COALESCE(cv.val_text, '')) != ''
                             GROUP BY cv.val_text"
                        ))
                        .map_err(|e| format!("查询 select 分桶失败: {e}"))?;
                    let rows = stmt
                        .query_map(params_from_iter(p.values.iter()), |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                        })
                        .map_err(|e| format!("遍历 select 分桶失败: {e}"))?;
                    for (name, cnt) in rows.flatten() {
                        counts.insert(name, cnt);
                    }
                    let mut non_empty = 0usize;
                    for opt in &meta.options {
                        if let Some(&cnt) = counts.get(&opt.name) {
                            non_empty += cnt;
                            buckets.push(ColumnFilterBucketRecord {
                                key: opt.id.clone(),
                                label: opt.name.clone(),
                                count: cnt,
                                color: opt.color.clone(),
                            });
                        }
                    }
                    empty_count = total_rows.saturating_sub(non_empty);
                }
                "multi_select" => {
                    let mut counts: HashMap<String, usize> = HashMap::new();
                    let mut stmt = conn
                        .prepare(&format!(
                            "SELECT cm.option_name, COUNT(*)
                             FROM cell_multi_options cm
                             JOIN entities e ON e.doc_id = cm.doc_id AND e.uuid = cm.entity_uuid AND e.is_row = 1
                             JOIN docs d ON d.doc_id = e.doc_id
                             WHERE {s} AND cm.canonical_key = {p_ck}
                             GROUP BY cm.option_name"
                        ))
                        .map_err(|e| format!("查询 multi_select 分桶失败: {e}"))?;
                    let rows = stmt
                        .query_map(params_from_iter(p.values.iter()), |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                        })
                        .map_err(|e| format!("遍历 multi_select 分桶失败: {e}"))?;
                    for (name, cnt) in rows.flatten() {
                        counts.insert(name, cnt);
                    }
                    for opt in &meta.options {
                        if let Some(&cnt) = counts.get(&opt.name) {
                            buckets.push(ColumnFilterBucketRecord {
                                key: opt.id.clone(),
                                label: opt.name.clone(),
                                count: cnt,
                                color: opt.color.clone(),
                            });
                        }
                    }
                    let mut p2 = SqlParams::new();
                    let s2 = build_scope_sql(&query.scope, &mut p2);
                    let p_ck2 = p2.bind_str(meta.canonical_key.clone());
                    let non_empty: usize = conn
                        .query_row(
                            &format!(
                                "SELECT COUNT(*) FROM entities e JOIN docs d ON d.doc_id = e.doc_id
                                 WHERE e.is_row = 1 AND {s2}
                                   AND EXISTS (SELECT 1 FROM cell_multi_options cm WHERE cm.doc_id = e.doc_id AND cm.entity_uuid = e.uuid AND cm.canonical_key = {p_ck2})"
                            ),
                            params_from_iter(p2.values.iter()),
                            |r| r.get::<_, i64>(0),
                        )
                        .unwrap_or(0) as usize;
                    empty_count = total_rows.saturating_sub(non_empty);
                }
                "formula" => {
                    if meta.canonical_key == "role:sr:dueStatus" {
                        let mut stmt = conn
                            .prepare(&format!(
                                "SELECT COALESCE(NULLIF(TRIM(fc.display_text), ''), '待复习') AS st, COUNT(*)
                                 FROM entities e
                                 JOIN docs d ON d.doc_id = e.doc_id
                                 LEFT JOIN formula_cache fc
                                   ON fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p_ck}
                                 WHERE e.is_row = 1 AND {s}
                                 GROUP BY st"
                            ))
                            .map_err(|e| format!("查询 SR dueStatus 分桶失败: {e}"))?;
                        let rows = stmt
                            .query_map(params_from_iter(p.values.iter()), |r| {
                                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                            })
                            .map_err(|e| format!("遍历 SR dueStatus 分桶失败: {e}"))?;
                        for (st, cnt) in rows.flatten() {
                            buckets.push(ColumnFilterBucketRecord {
                                key: st.clone(),
                                label: st,
                                count: cnt,
                                color: None,
                            });
                        }
                        empty_count = 0;
                    } else {
                        let mut stmt = conn
                            .prepare(&format!(
                                "SELECT TRIM(fc.display_text) AS k, COUNT(*)
                                 FROM formula_cache fc
                                 JOIN entities e ON e.doc_id = fc.doc_id AND e.uuid = fc.entity_uuid AND e.is_row = 1
                                 JOIN docs d ON d.doc_id = e.doc_id
                                 WHERE {s} AND fc.canonical_key = {p_ck} AND fc.kind != 'empty' AND TRIM(fc.display_text) != ''
                                 GROUP BY k"
                            ))
                            .map_err(|e| format!("查询 formula 分桶失败: {e}"))?;
                        let rows = stmt
                            .query_map(params_from_iter(p.values.iter()), |r| {
                                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                            })
                            .map_err(|e| format!("遍历 formula 分桶失败: {e}"))?;
                        let mut non_empty = 0usize;
                        for (k, cnt) in rows.flatten() {
                            non_empty += cnt;
                            buckets.push(ColumnFilterBucketRecord {
                                key: k.clone(),
                                label: k,
                                count: cnt,
                                color: None,
                            });
                        }
                        empty_count = total_rows.saturating_sub(non_empty);
                        buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
                    }
                }
                _ => {
                    let mut stmt = conn
                        .prepare(&format!(
                            "SELECT TRIM(COALESCE(cv.val_text, '')) AS k, COUNT(*)
                             FROM cell_values cv
                             JOIN entities e ON e.doc_id = cv.doc_id AND e.uuid = cv.entity_uuid AND e.is_row = 1
                             JOIN docs d ON d.doc_id = e.doc_id
                             WHERE {s} AND cv.canonical_key = {p_ck} AND TRIM(COALESCE(cv.val_text, '')) != ''
                             GROUP BY k"
                        ))
                        .map_err(|e| format!("查询 text 分桶失败: {e}"))?;
                    let rows = stmt
                        .query_map(params_from_iter(p.values.iter()), |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                        })
                        .map_err(|e| format!("遍历 text 分桶失败: {e}"))?;
                    let mut non_empty = 0usize;
                    for (k, cnt) in rows.flatten() {
                        non_empty += cnt;
                        buckets.push(ColumnFilterBucketRecord {
                            key: k.clone(),
                            label: k,
                            count: cnt,
                            color: None,
                        });
                    }
                    empty_count = total_rows.saturating_sub(non_empty);
                    buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
                }
            }
        }
    }

    if let Some(q) = query.search.as_deref() {
        let trimmed = q.trim().to_lowercase();
        if !trimmed.is_empty() {
            buckets.retain(|b| b.label.to_lowercase().contains(&trimmed));
        }
    }

    let total_buckets = buckets.len();
    let limit = query.limit.clamp(1, 2000);
    buckets.truncate(limit);

    Ok(TableFilterBucketsResult {
        buckets,
        empty_count,
        total_buckets,
    })
}

/// 3. 跨文件分组聚合计数（支持看板分组与全局间隔重复 `待复习 / 未到期 / 已归档` 计数）。
pub fn query_workspace_group_counts(
    conn: &Connection,
    query: &WorkspaceTableGroupCountsQuery,
) -> Result<TableGroupCountsResult, String> {
    let col_map = load_ws_column_meta_map(conn)?;
    let today_key = resolve_today_key(conn, query.today_key.as_deref());

    let is_unfiltered_all = query.scope.kind == "all"
        && query.filters.is_empty()
        && query
            .filter_group
            .as_ref()
            .map(|fg| fg.conditions.is_empty())
            .unwrap_or(true);

    let total_count: usize = if is_unfiltered_all {
        conn.query_row("SELECT COUNT(*) FROM entities WHERE is_row = 1", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| format!("查询跨文件分组总数失败: {e}"))? as usize
    } else {
        let mut total_params = SqlParams::new();
        let base_where = build_ws_where_clause(
            &query.scope,
            &query.filters,
            query.filter_group.as_ref(),
            None,
            &col_map,
            &today_key,
            &mut total_params,
        );
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM entities e JOIN docs d ON d.doc_id = e.doc_id WHERE {base_where}"
            ),
            params_from_iter(total_params.values.iter()),
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| format!("查询跨文件分组总数失败: {e}"))? as usize
    };

    if query.group_by_column_id == "sourceFile" {
        let mut p = SqlParams::new();
        let w = build_ws_where_clause(
            &query.scope,
            &query.filters,
            query.filter_group.as_ref(),
            None,
            &col_map,
            &today_key,
            &mut p,
        );
        let mut stmt = conn
            .prepare(&format!(
                "SELECT d.doc_id, d.title, COUNT(*)
                 FROM entities e JOIN docs d ON d.doc_id = e.doc_id
                 WHERE {w} GROUP BY d.doc_id"
            ))
            .map_err(|e| format!("聚合 sourceFile 分组失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(p.values.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as usize,
                ))
            })
            .map_err(|e| format!("遍历 sourceFile 分组失败: {e}"))?;
        let mut groups = Vec::new();
        let mut grouped = 0usize;
        for (did, title, cnt) in rows.flatten() {
            grouped += cnt;
            groups.push(TableGroupCountItem {
                key: did,
                label: title,
                count: cnt,
                color: None,
            });
        }
        groups.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        return Ok(TableGroupCountsResult {
            total_count,
            ungrouped_count: total_count.saturating_sub(grouped),
            groups,
        });
    }

    if query.group_by_column_id == "sourceFolder" {
        let mut p = SqlParams::new();
        let w = build_ws_where_clause(
            &query.scope,
            &query.filters,
            query.filter_group.as_ref(),
            None,
            &col_map,
            &today_key,
            &mut p,
        );
        let mut stmt = conn
            .prepare(&format!(
                "SELECT TRIM(d.folder_path) AS f, COUNT(*)
                 FROM entities e JOIN docs d ON d.doc_id = e.doc_id
                 WHERE {w} GROUP BY f"
            ))
            .map_err(|e| format!("聚合 sourceFolder 分组失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(p.values.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
            })
            .map_err(|e| format!("遍历 sourceFolder 分组失败: {e}"))?;
        let mut groups = Vec::new();
        let mut grouped = 0usize;
        for (f, cnt) in rows.flatten() {
            if f.is_empty() {
                continue;
            }
            grouped += cnt;
            groups.push(TableGroupCountItem {
                key: f.clone(),
                label: f,
                count: cnt,
                color: None,
            });
        }
        groups.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        return Ok(TableGroupCountsResult {
            total_count,
            ungrouped_count: total_count.saturating_sub(grouped),
            groups,
        });
    }

    if query.group_by_column_id == "outer" {
        let mut p = SqlParams::new();
        let w = build_ws_where_clause(
            &query.scope,
            &query.filters,
            query.filter_group.as_ref(),
            None,
            &col_map,
            &today_key,
            &mut p,
        );
        let mut stmt = conn
            .prepare(&format!(
                "SELECT e.parent_section_uuid, COALESCE(TRIM(e.outer_label), ''), COUNT(*)
                 FROM entities e JOIN docs d ON d.doc_id = e.doc_id
                 WHERE {w} AND e.parent_section_uuid IS NOT NULL
                 GROUP BY e.parent_section_uuid"
            ))
            .map_err(|e| format!("聚合 outer 分组失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(p.values.iter()), |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, i64>(2)? as usize,
                ))
            })
            .map_err(|e| format!("遍历 outer 分组失败: {e}"))?;
        let mut groups = Vec::new();
        let mut grouped = 0usize;
        for (uid, lbl, cnt) in rows.flatten() {
            grouped += cnt;
            groups.push(TableGroupCountItem {
                key: uid.clone(),
                label: if lbl.is_empty() { uid } else { lbl },
                count: cnt,
                color: None,
            });
        }
        groups.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        return Ok(TableGroupCountsResult {
            total_count,
            ungrouped_count: total_count.saturating_sub(grouped),
            groups,
        });
    }

    // 特殊支持 role:sr:dueStatus（直接走 entities.sr_due_status 覆盖索引）
    if query.group_by_column_id == "role:sr:dueStatus" {
        let mut p = SqlParams::new();
        let sql = if is_unfiltered_all {
            "SELECT sr_due_status, COUNT(*) FROM entities WHERE is_row = 1 GROUP BY sr_due_status".to_string()
        } else {
            let w = build_ws_where_clause(
                &query.scope,
                &query.filters,
                query.filter_group.as_ref(),
                None,
                &col_map,
                &today_key,
                &mut p,
            );
            format!(
                "SELECT e.sr_due_status, COUNT(*)
                 FROM entities e
                 JOIN docs d ON d.doc_id = e.doc_id
                 WHERE {w}
                 GROUP BY e.sr_due_status"
            )
        };
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("聚合全局间隔重复状态失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(p.values.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
            })
            .map_err(|e| format!("遍历全局间隔重复状态失败: {e}"))?;
        let mut groups = Vec::new();
        let mut grouped = 0usize;
        for (st, cnt) in rows.flatten() {
            grouped += cnt;
            groups.push(TableGroupCountItem {
                key: st.clone(),
                label: st,
                count: cnt,
                color: None,
            });
        }
        return Ok(TableGroupCountsResult {
            total_count,
            ungrouped_count: total_count.saturating_sub(grouped),
            groups,
        });
    }

    let Some(meta) = col_map.get(&query.group_by_column_id) else {
        return Ok(TableGroupCountsResult {
            total_count,
            ungrouped_count: total_count,
            groups: Vec::new(),
        });
    };

    let mut p = SqlParams::new();
    let w = build_ws_where_clause(
        &query.scope,
        &query.filters,
        query.filter_group.as_ref(),
        None,
        &col_map,
        &today_key,
        &mut p,
    );
    let p_ck = p.bind_str(meta.canonical_key.clone());

    match meta.col_type.as_str() {
        "select" => {
            let mut counts: HashMap<String, usize> = HashMap::new();
            if is_unfiltered_all {
                // 无筛选全工作空间快路径：纯覆盖索引 idx_ws_cells_ck_text 聚合（< 1 ms）
                let mut stmt = conn
                    .prepare(
                        "SELECT cv.val_text, COUNT(*)
                         FROM cell_values cv
                         WHERE cv.canonical_key = ?1 AND cv.val_text IS NOT NULL AND cv.val_text != ''
                         GROUP BY cv.val_text",
                    )
                    .map_err(|e| format!("聚合 select 分组快路径失败: {e}"))?;
                let rows = stmt
                    .query_map(rusqlite::params![&meta.canonical_key], |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                    })
                    .map_err(|e| format!("遍历 select 分组快路径失败: {e}"))?;
                for (name, cnt) in rows.flatten() {
                    counts.insert(name, cnt);
                }
            } else {
                let mut stmt = conn
                    .prepare(&format!(
                        "SELECT cv.val_text, COUNT(*)
                         FROM entities e
                         JOIN docs d ON d.doc_id = e.doc_id
                         JOIN cell_values cv ON cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck}
                         WHERE {w} AND TRIM(COALESCE(cv.val_text, '')) != ''
                         GROUP BY cv.val_text"
                    ))
                    .map_err(|e| format!("聚合 select 分组失败: {e}"))?;
                let rows = stmt
                    .query_map(params_from_iter(p.values.iter()), |r| {
                        Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                    })
                    .map_err(|e| format!("遍历 select 分组失败: {e}"))?;
                for (name, cnt) in rows.flatten() {
                    counts.insert(name, cnt);
                }
            }
            let mut grouped = 0usize;
            let mut groups = Vec::with_capacity(meta.options.len());
            for opt in &meta.options {
                let cnt = counts.get(&opt.name).copied().unwrap_or(0);
                grouped += cnt;
                groups.push(TableGroupCountItem {
                    key: opt.id.clone(),
                    label: opt.name.clone(),
                    count: cnt,
                    color: opt.color.clone(),
                });
            }
            Ok(TableGroupCountsResult {
                total_count,
                ungrouped_count: total_count.saturating_sub(grouped),
                groups,
            })
        }
        "formula" => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT TRIM(fc.display_text) AS k, COUNT(*)
                     FROM entities e
                     JOIN docs d ON d.doc_id = e.doc_id
                     JOIN formula_cache fc ON fc.doc_id = e.doc_id AND fc.entity_uuid = e.uuid AND fc.canonical_key = {p_ck}
                     WHERE {w} AND fc.kind != 'empty' AND TRIM(fc.display_text) != ''
                     GROUP BY k"
                ))
                .map_err(|e| format!("聚合 formula 分组失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(p.values.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                })
                .map_err(|e| format!("遍历 formula 分组失败: {e}"))?;
            let mut grouped = 0usize;
            let mut groups = Vec::new();
            for (k, cnt) in rows.flatten() {
                grouped += cnt;
                groups.push(TableGroupCountItem {
                    key: k.clone(),
                    label: k,
                    count: cnt,
                    color: None,
                });
            }
            groups.sort_by(|a, b| natural_cmp(&a.label, &b.label));
            Ok(TableGroupCountsResult {
                total_count,
                ungrouped_count: total_count.saturating_sub(grouped),
                groups,
            })
        }
        _ => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT TRIM(COALESCE(cv.val_text, '')) AS k, COUNT(*)
                     FROM entities e
                     JOIN docs d ON d.doc_id = e.doc_id
                     JOIN cell_values cv ON cv.doc_id = e.doc_id AND cv.entity_uuid = e.uuid AND cv.canonical_key = {p_ck}
                     WHERE {w} AND TRIM(COALESCE(cv.val_text, '')) != ''
                     GROUP BY k"
                ))
                .map_err(|e| format!("聚合 text 分组失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(p.values.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                })
                .map_err(|e| format!("遍历 text 分组失败: {e}"))?;
            let mut grouped = 0usize;
            let mut groups = Vec::new();
            for (k, cnt) in rows.flatten() {
                grouped += cnt;
                groups.push(TableGroupCountItem {
                    key: k.clone(),
                    label: k,
                    count: cnt,
                    color: None,
                });
            }
            groups.sort_by(|a, b| natural_cmp(&a.label, &b.label));
            Ok(TableGroupCountsResult {
                total_count,
                ungrouped_count: total_count.saturating_sub(grouped),
                groups,
            })
        }
    }
}

/// 4. 跨文件日期区间查询（供日历 / 甘特视图按需加载可视窗记录）。
pub fn query_workspace_date_range(
    conn: &Connection,
    query: &WorkspaceTableDateRangeQuery,
) -> Result<TableDateRangeResult, String> {
    let col_map = load_ws_column_meta_map(conn)?;
    let today_key = resolve_today_key(conn, query.today_key.as_deref());

    let start_meta = col_map.get(&query.start_column_id);
    let end_col_id = query.end_column_id.as_deref().filter(|s| !s.is_empty());
    let end_meta = end_col_id.and_then(|id| col_map.get(id));

    // 单日期列快路径：直接下推 val_date BETWEEN 到 SQLite 覆盖索引 idx_ws_cells_ck_date
    if end_col_id.is_none()
        && !query.include_undated
        && start_meta.map(|m| m.col_type.as_str()) == Some("date")
    {
        let meta = start_meta.unwrap();
        let mut fast_params = SqlParams::new();
        let fast_where = build_ws_where_clause(
            &query.scope,
            &query.filters,
            query.filter_group.as_ref(),
            None,
            &col_map,
            &today_key,
            &mut fast_params,
        );
        let p_ck = fast_params.bind_str(meta.canonical_key.clone());
        let p_min = fast_params.bind_str(query.min_date.clone());
        let p_max = fast_params.bind_str(query.max_date.clone());
        let order_by = build_ws_order_by_clause(query.sort.as_ref(), &col_map, &mut fast_params);

        let range_sql = format!(
            "SELECT e.doc_id, e.uuid, e.kind, e.parent_section_uuid, e.outer_label, e.text,
                    e.images_json, e.parents_json, e.children_json, e.inner_json,
                    e.created_at, e.updated_at, e.sort_order,
                    d.title, d.folder_path, d.rel_path
             FROM cell_values cv_d
             JOIN entities e ON e.doc_id = cv_d.doc_id AND e.uuid = cv_d.entity_uuid
             JOIN docs d ON d.doc_id = e.doc_id
             WHERE cv_d.canonical_key = {p_ck}
               AND cv_d.val_date >= {p_min}
               AND cv_d.val_date <= {p_max}
               AND {fast_where}
             ORDER BY {order_by}"
        );
        let in_range_raw: Vec<RawWsEntityRow> = {
            let mut stmt = conn
                .prepare(&range_sql)
                .map_err(|e| format!("准备跨文件日期快路径查询失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(fast_params.values.iter()), |row| {
                    Ok(RawWsEntityRow {
                        doc_id: row.get(0)?,
                        uuid: row.get(1)?,
                        kind: row.get(2)?,
                        parent_section_uuid: row.get(3)?,
                        outer_label: row.get(4)?,
                        text: row.get(5)?,
                        images_json: row.get(6)?,
                        parents_json: row.get(7)?,
                        children_json: row.get(8)?,
                        inner_json: row.get(9)?,
                        created_at: row.get(10)?,
                        updated_at: row.get(11)?,
                        sort_order: row.get(12)?,
                        source_file: row.get(13)?,
                        source_folder: row.get(14)?,
                        source_rel_path: row.get(15)?,
                    })
                })
                .map_err(|e| format!("执行跨文件日期快路径查询失败: {e}"))?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| format!("解析跨文件日期快路径结果失败: {e}"))?
        };
        let rows = hydrate_ws_page_rows(conn, in_range_raw, &col_map)?;
        let total_filtered_count = rows.len();
        return Ok(TableDateRangeResult {
            rows,
            undated_count: 0,
            undated_rows: Vec::new(),
            total_filtered_count,
        });
    }

    let mut params = SqlParams::new();
    let base_where = build_ws_where_clause(
        &query.scope,
        &query.filters,
        query.filter_group.as_ref(),
        None,
        &col_map,
        &today_key,
        &mut params,
    );
    let start_expr = build_ws_date_key_expr(&query.start_column_id, start_meta, &mut params)
        .unwrap_or_else(|| "NULL".to_string());
    let end_expr = end_col_id
        .and_then(|id| build_ws_date_key_expr(id, end_meta, &mut params))
        .unwrap_or_else(|| "NULL".to_string());
    let order_by = build_ws_order_by_clause(query.sort.as_ref(), &col_map, &mut params);

    let scan_sql = format!(
        "SELECT e.doc_id, e.uuid, e.kind, e.parent_section_uuid, e.outer_label, e.text,
                e.images_json, e.parents_json, e.children_json, e.inner_json,
                e.created_at, e.updated_at, e.sort_order,
                d.title, d.folder_path, d.rel_path,
                {start_expr} AS s_key,
                {end_expr} AS e_key
         FROM entities e
         JOIN docs d ON d.doc_id = e.doc_id
         WHERE {base_where}
         ORDER BY {order_by}"
    );

    let mut in_range_raw = Vec::new();
    let mut undated_raw = Vec::new();
    let mut undated_count = 0usize;
    let mut total_filtered_count = 0usize;
    let undated_cap = query.undated_limit.clamp(0, 2000);

    {
        let mut stmt = conn
            .prepare(&scan_sql)
            .map_err(|e| format!("准备跨文件日期区间查询失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(params.values.iter()), |row| {
                Ok((
                    RawWsEntityRow {
                        doc_id: row.get(0)?,
                        uuid: row.get(1)?,
                        kind: row.get(2)?,
                        parent_section_uuid: row.get(3)?,
                        outer_label: row.get(4)?,
                        text: row.get(5)?,
                        images_json: row.get(6)?,
                        parents_json: row.get(7)?,
                        children_json: row.get(8)?,
                        inner_json: row.get(9)?,
                        created_at: row.get(10)?,
                        updated_at: row.get(11)?,
                        sort_order: row.get(12)?,
                        source_file: row.get(13)?,
                        source_folder: row.get(14)?,
                        source_rel_path: row.get(15)?,
                    },
                    row.get::<_, Option<String>>(16)?,
                    row.get::<_, Option<String>>(17)?,
                ))
            })
            .map_err(|e| format!("执行跨文件日期区间查询失败: {e}"))?;

        for item in rows {
            let (raw, s_opt, e_opt) = item.map_err(|e| format!("解析跨文件日期行失败: {e}"))?;
            total_filtered_count += 1;
            let (eff_start, eff_end) = match (s_opt, e_opt) {
                (None, None) => {
                    undated_count += 1;
                    if query.include_undated && undated_raw.len() < undated_cap {
                        undated_raw.push(raw);
                    }
                    continue;
                }
                (Some(s), None) => (s.clone(), s),
                (None, Some(e)) => (e.clone(), e),
                (Some(s), Some(e)) => {
                    if s <= e { (s, e) } else { (e, s) }
                }
            };
            if eff_start.as_str() <= query.max_date.as_str()
                && eff_end.as_str() >= query.min_date.as_str()
            {
                in_range_raw.push(raw);
            }
        }
    }

    let rows = hydrate_ws_page_rows(conn, in_range_raw, &col_map)?;
    let undated_rows = hydrate_ws_page_rows(conn, undated_raw, &col_map)?;
    Ok(TableDateRangeResult {
        rows,
        undated_count,
        undated_rows,
        total_filtered_count,
    })
}

/// 5. 全工作空间 FTS5 毫秒级检索（附带 CJK 子串兜底，零漏检）。
pub fn search_workspace_fts(
    conn: &Connection,
    query: &WorkspaceSearchFtsQuery,
) -> Result<Vec<WorkspaceSearchFtsHit>, String> {
    let trimmed = query.query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let limit = query.limit.clamp(1, 500);
    let lower_q = trimmed.to_lowercase();
    let scope = query.scope.clone().unwrap_or_default();

    let mut seen: HashSet<(String, String)> = HashSet::new();
    let mut hits: Vec<WorkspaceSearchFtsHit> = Vec::new();

    // 阶段 1：FTS5 极速倒排检索
    let tokens: Vec<String> = trimmed
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    if !tokens.is_empty() {
        let match_expr = tokens.join(" AND ");
        let mut p = SqlParams::new();
        let p_match = p.bind_str(match_expr);
        let s = build_scope_sql(&scope, &mut p);
        p.values.push(SqlValue::Integer(limit as i64));
        let p_lim = format!("?{}", p.values.len());
        let sql = format!(
            "SELECT e.doc_id, d.rel_path, d.folder_path, d.title, e.uuid, e.kind, e.text, e.details_plain
             FROM entities_fts f
             JOIN entities e ON e.doc_id = f.doc_id AND e.uuid = f.uuid
             JOIN docs d ON d.doc_id = e.doc_id
             WHERE entities_fts MATCH {p_match} AND {s}
             ORDER BY bm25(entities_fts) ASC, e.updated_at DESC
             LIMIT {p_lim}"
        );
        if let Ok(mut stmt) = conn.prepare(&sql) {
            if let Ok(rows) = stmt.query_map(params_from_iter(p.values.iter()), |r| {
                Ok(WorkspaceSearchFtsHit {
                    doc_id: r.get(0)?,
                    rel_path: r.get(1)?,
                    folder_path: r.get(2)?,
                    title: r.get(3)?,
                    uuid: r.get(4)?,
                    kind: r.get(5)?,
                    text: r.get(6)?,
                    details_plain: r.get(7)?,
                })
            }) {
                for hit in rows.flatten() {
                    if seen.insert((hit.doc_id.clone(), hit.uuid.clone())) {
                        hits.push(hit);
                    }
                }
            }
        }
    }

    // 阶段 2：CJK 无空格子串兜底
    if hits.len() < limit {
        let remaining = (limit - hits.len()) as i64;
        let mut p = SqlParams::new();
        let pq = p.bind_str(lower_q);
        let s = build_scope_sql(&scope, &mut p);
        p.values.push(SqlValue::Integer(remaining));
        let p_rem = format!("?{}", p.values.len());
        let sql = format!(
            "SELECT e.doc_id, d.rel_path, d.folder_path, d.title, e.uuid, e.kind, e.text, e.details_plain
             FROM entities e
             JOIN docs d ON d.doc_id = e.doc_id
             WHERE {s} AND (INSTR(lower(e.text), {pq}) > 0 OR INSTR(lower(e.details_plain), {pq}) > 0)
             ORDER BY e.updated_at DESC
             LIMIT {p_rem}"
        );
        if let Ok(mut stmt) = conn.prepare(&sql) {
            if let Ok(rows) = stmt.query_map(params_from_iter(p.values.iter()), |r| {
                Ok(WorkspaceSearchFtsHit {
                    doc_id: r.get(0)?,
                    rel_path: r.get(1)?,
                    folder_path: r.get(2)?,
                    title: r.get(3)?,
                    uuid: r.get(4)?,
                    kind: r.get(5)?,
                    text: r.get(6)?,
                    details_plain: r.get(7)?,
                })
            }) {
                for hit in rows.flatten() {
                    if seen.insert((hit.doc_id.clone(), hit.uuid.clone())) {
                        hits.push(hit);
                    }
                }
            }
        }
    }

    Ok(hits)
}
