use crate::sqlite_engine::document_actor::V3CellValueRecord;
use rusqlite::types::Value as SqlValue;
use rusqlite::{params_from_iter, Connection};
use serde::{Deserialize, Serialize};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

const SYSTEM_COLUMNS: &[&str] = &[
    "name",
    "images",
    "createdAt",
    "updatedAt",
    "parents",
    "children",
    "outer",
    "inner",
];

/// 自然排序比较器，与前端 `Intl.Collator(undefined, { numeric: true, sensitivity: "base" })` 保持一致。
pub fn natural_cmp(a: &str, b: &str) -> Ordering {
    let ab = a.as_bytes();
    let bb = b.as_bytes();
    let mut ai = 0usize;
    let mut bi = 0usize;

    while ai < ab.len() && bi < bb.len() {
        let a_digit = ab[ai].is_ascii_digit();
        let b_digit = bb[bi].is_ascii_digit();

        if a_digit && b_digit {
            let a_start = ai;
            while ai < ab.len() && ab[ai].is_ascii_digit() {
                ai += 1;
            }
            let b_start = bi;
            while bi < bb.len() && bb[bi].is_ascii_digit() {
                bi += 1;
            }

            let a_slice = &ab[a_start..ai];
            let b_slice = &bb[b_start..bi];
            let a_trim = trim_leading_zeros(a_slice);
            let b_trim = trim_leading_zeros(b_slice);

            let cmp = a_trim.len().cmp(&b_trim.len()).then_with(|| a_trim.cmp(b_trim));
            if cmp != Ordering::Equal {
                return cmp;
            }
            let len_cmp = a_slice.len().cmp(&b_slice.len());
            if len_cmp != Ordering::Equal {
                return len_cmp;
            }
            continue;
        }

        let a_ch = a[ai..].chars().next().unwrap();
        let b_ch = b[bi..].chars().next().unwrap();
        ai += a_ch.len_utf8();
        bi += b_ch.len_utf8();

        let cmp = compare_chars_case_insensitive(a_ch, b_ch);
        if cmp != Ordering::Equal {
            return cmp;
        }
    }

    (ab.len() - ai).cmp(&(bb.len() - bi))
}

fn trim_leading_zeros(slice: &[u8]) -> &[u8] {
    let mut i = 0;
    while i + 1 < slice.len() && slice[i] == b'0' {
        i += 1;
    }
    &slice[i..]
}

fn compare_chars_case_insensitive(a: char, b: char) -> Ordering {
    let mut al = a.to_lowercase();
    let mut bl = b.to_lowercase();
    loop {
        match (al.next(), bl.next()) {
            (Some(ac), Some(bc)) => {
                let c = ac.cmp(&bc);
                if c != Ordering::Equal {
                    return c;
                }
            }
            (None, None) => return Ordering::Equal,
            (None, Some(_)) => return Ordering::Less,
            (Some(_), None) => return Ordering::Greater,
        }
    }
}

/// 在 SQLite 连接上注册自定义 `NATURAL` 排序规则。
pub fn register_natural_collation(conn: &Connection) -> Result<(), String> {
    conn.create_collation("NATURAL", natural_cmp)
        .map_err(|e| format!("注册 SQLite NATURAL 排序规则失败: {e}"))
}

// ============================================================================
// 日历日期纯算术（无外部依赖，与 JS `toLocalDateKey` / `resolveDateFilterPresetRange` 一致）
// ============================================================================

pub(crate) fn parse_date_key(raw: &str) -> Option<(i32, u32, u32)> {
    let s = raw.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 10 || !bytes[..10].is_ascii() || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let y: i32 = s.get(0..4)?.parse().ok()?;
    let m: u32 = s.get(5..7)?.parse().ok()?;
    let d: u32 = s.get(8..10)?.parse().ok()?;
    if !(1..=12).contains(&m) || d < 1 || d > days_in_month(y, m) {
        return None;
    }
    Some((y, m, d))
}

fn is_leap_year(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0)
}

fn days_in_month(y: i32, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            if is_leap_year(y) {
                29
            } else {
                28
            }
        }
        _ => 30,
    }
}

/// Howard Hinnant civil-from/to-days 算法（相对 1970-01-01 的天数）。
pub(crate) fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = y as i64 - if m <= 2 { 1 } else { 0 };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = (y - era * 400) as u64;
    let m = m as u64;
    let d = d as u64;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

pub(crate) fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = y + if m <= 2 { 1 } else { 0 };
    (year as i32, m as u32, d as u32)
}

pub(crate) fn format_date_key(y: i32, m: u32, d: u32) -> String {
    format!("{y:04}-{m:02}-{d:02}")
}

pub(crate) fn add_days_to_date_key(key: &str, delta: i64) -> String {
    if let Some((y, m, d)) = parse_date_key(key) {
        let (ny, nm, nd) = civil_from_days(days_from_civil(y, m, d) + delta);
        format_date_key(ny, nm, nd)
    } else {
        key.to_string()
    }
}

pub(crate) fn resolve_today_key(conn: &Connection, provided: Option<&str>) -> String {
    if let Some(p) = provided {
        if let Some((y, m, d)) = parse_date_key(p) {
            return format_date_key(y, m, d);
        }
    }
    conn.query_row("SELECT strftime('%Y-%m-%d', 'now', 'localtime')", [], |r| {
        r.get::<_, String>(0)
    })
    .unwrap_or_else(|_| "1970-01-01".to_string())
}

pub(crate) fn resolve_date_preset_range(preset: &str, today_key: &str) -> Option<(String, String)> {
    let (y, m, d) = parse_date_key(today_key)?;
    let today_days = days_from_civil(y, m, d);
    match preset {
        "today" => Some((today_key.to_string(), today_key.to_string())),
        "yesterday" => {
            let k = add_days_to_date_key(today_key, -1);
            Some((k.clone(), k))
        }
        "tomorrow" => {
            let k = add_days_to_date_key(today_key, 1);
            Some((k.clone(), k))
        }
        "past_7_days" => Some((add_days_to_date_key(today_key, -6), today_key.to_string())),
        "past_30_days" => Some((add_days_to_date_key(today_key, -29), today_key.to_string())),
        "this_week" => {
            // 1970-01-01 为周四 (weekday_sun0 = 4)
            let weekday_sun0 = (today_days + 4).rem_euclid(7);
            let days_since_monday = (weekday_sun0 + 6).rem_euclid(7);
            let start = add_days_to_date_key(today_key, -days_since_monday);
            let end = add_days_to_date_key(&start, 6);
            Some((start, end))
        }
        "this_month" => {
            let last_day = days_in_month(y, m);
            Some((format_date_key(y, m, 1), format_date_key(y, m, last_day)))
        }
        "this_year" => Some((format_date_key(y, 1, 1), format_date_key(y, 12, 31))),
        _ => None,
    }
}

// ============================================================================
// 请求与响应类型定义（前后端 Tauri IPC 契约）
// ============================================================================

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableColumnFilterInput {
    pub column_id: String,
    #[serde(default)]
    pub values: Vec<String>,
    #[serde(default)]
    pub include_empty: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFilterConditionInput {
    #[serde(default)]
    pub id: String,
    pub column_id: String,
    pub operator: String,
    pub value: Option<String>,
    pub values: Option<Vec<String>>,
    pub date_preset: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFilterGroupInput {
    pub conjunction: String, // "and" | "or"
    #[serde(default)]
    pub conditions: Vec<TableFilterConditionInput>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSortInput {
    pub column_id: String,
    pub direction: String, // "asc" | "desc"
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableExtraGroupFilter {
    pub column_id: String,
    /// `None` 表示筛选未分组/空值；`Some(key)` 表示筛选特定组键（选项 ID、外节点 UUID、文本值或公式文本）
    pub group_key: Option<String>,
    /// 即使分组值已变更，也强制保留在结果中的行 UUID（如间隔重复当次已作答卡片）
    #[serde(default)]
    pub pinned_uuids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePageQuery {
    pub doc_id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3RelationItemRecord {
    pub uuid: String,
    pub label: String,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3ImageItemRecord {
    pub uuid: String,
    pub attachment_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3FormulaCellRecord {
    pub kind: String,
    pub display_text: String,
    pub numeric_value: Option<f64>,
    pub date_ms: Option<i64>,
    pub date_has_time: Option<bool>,
    pub boolean_value: Option<bool>,
    pub list_items: Option<Vec<String>>,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3TableRowRecord {
    pub doc_id: String,
    pub uuid: String,
    pub kind: String,
    pub primary_text: String,
    pub editable_text: bool,
    pub images: Vec<V3ImageItemRecord>,
    pub can_edit_images: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub parents: Vec<V3RelationItemRecord>,
    pub children: Vec<V3RelationItemRecord>,
    pub outer: Option<V3RelationItemRecord>,
    pub inner: Vec<V3RelationItemRecord>,
    pub can_edit_inner: bool,
    pub cell_values: Vec<V3CellValueRecord>,
    pub formula_values: HashMap<String, V3FormulaCellRecord>,
    pub sort_order: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_file: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_folder: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_rel_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePageResult {
    pub total_count: usize,
    pub unfiltered_total_count: usize,
    pub offset: usize,
    pub limit: usize,
    pub rows: Vec<V3TableRowRecord>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFilterBucketsQuery {
    pub doc_id: String,
    pub column_id: String,
    pub search: Option<String>,
    #[serde(default = "default_buckets_limit")]
    pub limit: usize,
}

fn default_buckets_limit() -> usize {
    300
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnFilterBucketRecord {
    pub key: String,
    pub label: String,
    pub count: usize,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableFilterBucketsResult {
    pub buckets: Vec<ColumnFilterBucketRecord>,
    pub empty_count: usize,
    pub total_buckets: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRelationCandidatesQuery {
    pub doc_id: String,
    pub row_uuid: String,
    pub relation_kind: String, // "parents" | "children" | "outer" | "inner"
    pub search: Option<String>,
    #[serde(default = "default_relation_limit")]
    pub limit: usize,
}

fn default_relation_limit() -> usize {
    50
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableRelationCandidatesResult {
    pub candidates: Vec<V3RelationItemRecord>,
    pub total_count: usize,
    pub has_more: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableGroupCountsQuery {
    pub doc_id: String,
    pub group_by_column_id: String,
    #[serde(default)]
    pub filters: Vec<TableColumnFilterInput>,
    pub filter_group: Option<TableFilterGroupInput>,
    pub today_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableGroupCountItem {
    pub key: String,
    pub label: String,
    pub count: usize,
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableGroupCountsResult {
    pub total_count: usize,
    pub ungrouped_count: usize,
    pub groups: Vec<TableGroupCountItem>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDateRangeQuery {
    pub doc_id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableDateRangeResult {
    pub rows: Vec<V3TableRowRecord>,
    pub undated_count: usize,
    pub undated_rows: Vec<V3TableRowRecord>,
    pub total_filtered_count: usize,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSearchFtsQuery {
    pub doc_id: String,
    pub query: String,
    #[serde(default = "default_fts_limit")]
    pub limit: usize,
}

fn default_fts_limit() -> usize {
    500
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocSearchFtsHit {
    pub uuid: String,
    pub object_kind: String, // "entity" | "edge"
    pub text: String,
    pub details_plain: String,
}

// ============================================================================
// 内部列元信息与 SQL 参数化构造器
// ============================================================================

#[derive(Debug, Clone)]
struct SelectOptionMeta {
    id: String,
    name: String,
    color: Option<String>,
}

#[derive(Debug, Clone)]
struct ColumnMeta {
    id: String,
    col_type: String,
    options: Vec<SelectOptionMeta>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FilterKind {
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
        let mut placeholders = Vec::with_capacity(items.len());
        for item in items {
            placeholders.push(self.bind_str(item.clone()));
        }
        placeholders.join(", ")
    }
}

fn is_system_col(col_id: &str) -> bool {
    SYSTEM_COLUMNS.contains(&col_id)
}

fn load_column_meta_map(conn: &Connection) -> Result<HashMap<String, ColumnMeta>, String> {
    let mut stmt = conn
        .prepare("SELECT id, type, config_json FROM table_columns ORDER BY position ASC, rowid ASC")
        .map_err(|e| format!("查询 table_columns 失败: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| format!("读取 table_columns 失败: {e}"))?;

    let mut map = HashMap::new();
    for item in rows {
        let (id, col_type, config_json) =
            item.map_err(|e| format!("解析 table_columns 行失败: {e}"))?;
        let mut options = Vec::new();
        if let Ok(cfg) = serde_json::from_str::<serde_json::Value>(&config_json) {
            if let Some(arr) = cfg.get("options").and_then(|v| v.as_array()) {
                for opt in arr {
                    let opt_id = opt.get("id").and_then(|v| v.as_str()).unwrap_or("");
                    let opt_name = opt.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    if !opt_id.is_empty() {
                        options.push(SelectOptionMeta {
                            id: opt_id.to_string(),
                            name: opt_name.to_string(),
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
            id.clone(),
            ColumnMeta {
                id,
                col_type,
                options,
            },
        );
    }
    Ok(map)
}

fn get_filter_kind(col_id: &str, col_meta: Option<&ColumnMeta>) -> FilterKind {
    match col_id {
        "images" => FilterKind::Images,
        "createdAt" | "updatedAt" => FilterKind::Date,
        "parents" | "children" | "outer" | "inner" => FilterKind::Relation,
        "name" => FilterKind::Text,
        _ => match col_meta.map(|c| c.col_type.as_str()) {
            Some("number") => FilterKind::Number,
            Some("date") => FilterKind::Date,
            Some("select") | Some("multi_select") => FilterKind::Select,
            _ => FilterKind::Text,
        },
    }
}

fn is_valid_operator(kind: FilterKind, op: &str) -> bool {
    match kind {
        FilterKind::Images => matches!(op, "is_empty" | "is_not_empty"),
        FilterKind::Number | FilterKind::Date => matches!(
            op,
            "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "is_empty" | "is_not_empty"
        ),
        FilterKind::Select | FilterKind::Relation | FilterKind::Text => matches!(
            op,
            "contains" | "not_contains" | "eq" | "neq" | "is_empty" | "is_not_empty"
        ),
    }
}

pub(crate) fn resolve_primary_text_from_row(kind: &str, text: &str, props_json: &str) -> String {
    if !text.is_empty() || kind != "extension" {
        return text.to_string();
    }
    if let Ok(props) = serde_json::from_str::<serde_json::Value>(props_json) {
        if let Some(tn) = props.get("typeName").and_then(|v| v.as_str()) {
            if !tn.is_empty() {
                return tn.to_string();
            }
        }
        if let Some(eid) = props.get("extensionId").and_then(|v| v.as_str()) {
            return eid.to_string();
        }
    }
    String::new()
}

pub(crate) fn is_editable_text_kind(kind: &str) -> bool {
    matches!(kind, "text" | "section" | "url" | "media" | "latex")
}

pub(crate) fn is_editable_container_kind(kind: &str) -> bool {
    matches!(kind, "text" | "section")
}

/// 返回 SQL 表达式，计算某实体在指定日期列上的 `'YYYY-MM-DD'` 本地日期字符串（无效或空则返回 `NULL`）。
fn build_row_date_key_expr(
    col_id: &str,
    col_meta: Option<&ColumnMeta>,
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
            let p_col = params.bind_str(meta.id.clone());
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
                      WHERE fc.entity_uuid = e.uuid AND fc.col_id = {p_col})"
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
                      WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col})"
                ))
            }
        }
    }
}

const IMAGE_COUNT_SUBQUERY: &str = "(SELECT COUNT(*) FROM entities img WHERE img.parent_section_uuid = e.uuid AND img.kind = 'image' AND COALESCE(json_extract(img.props_json, '$.isBackground'), 0) = 0)";

/// 构造单条列值勾选筛选条件（对应 `TableColumnFilter`）。
fn build_column_filter_sql(
    flt: &TableColumnFilterInput,
    col_map: &HashMap<String, ColumnMeta>,
    params: &mut SqlParams,
) -> Option<String> {
    let col_meta = col_map.get(&flt.column_id);
    if !is_system_col(&flt.column_id) && col_meta.is_none() {
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
        "images" => {
            let is_empty = format!("{IMAGE_COUNT_SUBQUERY} = 0");
            let num_vals: Vec<String> = values
                .iter()
                .filter(|v| v.parse::<i64>().is_ok())
                .cloned()
                .collect();
            let has_match = if num_vals.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(&num_vals);
                format!("CAST({IMAGE_COUNT_SUBQUERY} AS TEXT) IN ({list})")
            };
            Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
        }
        "createdAt" | "updatedAt" => {
            let date_expr = build_row_date_key_expr(&flt.column_id, None, params)?;
            let is_empty = format!("{date_expr} IS NULL");
            let has_match = if values.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(values);
                format!("{date_expr} IN ({list})")
            };
            Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
        }
        "parents" => {
            let is_empty = "NOT EXISTS (SELECT 1 FROM edges ed JOIN entities pe ON pe.uuid = ed.source_uuid AND pe.is_row = 1 WHERE ed.target_uuid = e.uuid AND ed.source_uuid != e.uuid)";
            let has_match = if values.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(values);
                format!("EXISTS (SELECT 1 FROM edges ed JOIN entities pe ON pe.uuid = ed.source_uuid AND pe.is_row = 1 WHERE ed.target_uuid = e.uuid AND ed.source_uuid != e.uuid AND ed.source_uuid IN ({list}))")
            };
            Some(combine_empty_and_match(is_empty, &has_match, include_empty))
        }
        "children" => {
            let is_empty = "NOT EXISTS (SELECT 1 FROM edges ed JOIN entities ce ON ce.uuid = ed.target_uuid AND ce.is_row = 1 WHERE ed.source_uuid = e.uuid AND ed.target_uuid != e.uuid)";
            let has_match = if values.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(values);
                format!("EXISTS (SELECT 1 FROM edges ed JOIN entities ce ON ce.uuid = ed.target_uuid AND ce.is_row = 1 WHERE ed.source_uuid = e.uuid AND ed.target_uuid != e.uuid AND ed.target_uuid IN ({list}))")
            };
            Some(combine_empty_and_match(is_empty, &has_match, include_empty))
        }
        "outer" => {
            let is_empty = "(e.parent_section_uuid IS NULL OR NOT EXISTS (SELECT 1 FROM entities oe WHERE oe.uuid = e.parent_section_uuid AND oe.is_row = 1))";
            let has_match = if values.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(values);
                format!("(e.parent_section_uuid IN ({list}) AND EXISTS (SELECT 1 FROM entities oe WHERE oe.uuid = e.parent_section_uuid AND oe.is_row = 1))")
            };
            Some(combine_empty_and_match(is_empty, &has_match, include_empty))
        }
        "inner" => {
            let is_empty = "(e.kind != 'section' OR NOT EXISTS (SELECT 1 FROM entities ie WHERE ie.parent_section_uuid = e.uuid AND ie.is_row = 1))";
            let has_match = if values.is_empty() {
                "0".to_string()
            } else {
                let list = params.bind_list_str(values);
                format!("(e.kind = 'section' AND EXISTS (SELECT 1 FROM entities ie WHERE ie.parent_section_uuid = e.uuid AND ie.is_row = 1 AND ie.uuid IN ({list})))")
            };
            Some(combine_empty_and_match(is_empty, &has_match, include_empty))
        }
        _ => {
            let meta = col_meta?;
            match meta.col_type.as_str() {
                "number" => {
                    let p_col1 = params.bind_str(meta.id.clone());
                    let is_empty = format!(
                        "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col1} AND cv.val_num IS NOT NULL)"
                    );
                    let parsed_nums: Vec<f64> = values
                        .iter()
                        .filter_map(|s| s.trim().parse::<f64>().ok().filter(|n| n.is_finite()))
                        .collect();
                    let has_match = if parsed_nums.is_empty() {
                        "0".to_string()
                    } else {
                        let p_col2 = params.bind_str(meta.id.clone());
                        let mut phs = Vec::with_capacity(parsed_nums.len());
                        for n in parsed_nums {
                            phs.push(params.bind_f64(n));
                        }
                        format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col2} AND cv.val_num IN ({}))",
                            phs.join(", ")
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
                "select" => {
                    let valid_opt_ids: Vec<String> =
                        meta.options.iter().map(|o| o.id.clone()).collect();
                    let is_empty = if valid_opt_ids.is_empty() {
                        "1".to_string()
                    } else {
                        let p_col = params.bind_str(meta.id.clone());
                        let valid_list = params.bind_list_str(&valid_opt_ids);
                        format!(
                            "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col} AND cv.val_text IN ({valid_list}))"
                        )
                    };
                    let allowed: Vec<String> = values
                        .iter()
                        .filter(|v| valid_opt_ids.contains(v))
                        .cloned()
                        .collect();
                    let has_match = if allowed.is_empty() {
                        "0".to_string()
                    } else {
                        let p_col = params.bind_str(meta.id.clone());
                        let list = params.bind_list_str(&allowed);
                        format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col} AND cv.val_text IN ({list}))"
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
                "multi_select" => {
                    let valid_opt_ids: Vec<String> =
                        meta.options.iter().map(|o| o.id.clone()).collect();
                    let is_empty = if valid_opt_ids.is_empty() {
                        "1".to_string()
                    } else {
                        let p_col = params.bind_str(meta.id.clone());
                        let valid_list = params.bind_list_str(&valid_opt_ids);
                        format!(
                            "NOT EXISTS (SELECT 1 FROM cell_multi_options cm WHERE cm.entity_uuid = e.uuid AND cm.col_id = {p_col} AND cm.option_id IN ({valid_list}))"
                        )
                    };
                    let allowed: Vec<String> = values
                        .iter()
                        .filter(|v| valid_opt_ids.contains(v))
                        .cloned()
                        .collect();
                    let has_match = if allowed.is_empty() {
                        "0".to_string()
                    } else {
                        let p_col = params.bind_str(meta.id.clone());
                        let list = params.bind_list_str(&allowed);
                        format!(
                            "EXISTS (SELECT 1 FROM cell_multi_options cm WHERE cm.entity_uuid = e.uuid AND cm.col_id = {p_col} AND cm.option_id IN ({list}))"
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
                "date" => {
                    let p_col1 = params.bind_str(meta.id.clone());
                    let is_empty = format!(
                        "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col1} AND TRIM(COALESCE(cv.val_date, cv.val_text, '')) != '')"
                    );
                    let has_match = if values.is_empty() {
                        "0".to_string()
                    } else {
                        let p_col2 = params.bind_str(meta.id.clone());
                        let list = params.bind_list_str(values);
                        format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col2} AND TRIM(COALESCE(cv.val_date, cv.val_text, '')) IN ({list}))"
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
                "formula" => {
                    let p_col1 = params.bind_str(meta.id.clone());
                    let is_empty = format!(
                        "NOT EXISTS (SELECT 1 FROM formula_cache fc WHERE fc.entity_uuid = e.uuid AND fc.col_id = {p_col1} AND fc.kind != 'empty' AND (
                            (fc.kind = 'date' AND fc.val_date_ms IS NOT NULL AND fc.val_date_ms > 0)
                            OR (fc.kind = 'list' AND fc.val_json IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(fc.val_json, '$.listItems') je WHERE TRIM(CAST(je.value AS TEXT)) != ''))
                            OR (fc.kind NOT IN ('date', 'list') AND TRIM(fc.display_text) != '')
                        ))"
                    );
                    let has_match = if values.is_empty() {
                        "0".to_string()
                    } else {
                        let p_col2 = params.bind_str(meta.id.clone());
                        let list1 = params.bind_list_str(values);
                        let list2 = params.bind_list_str(values);
                        let list3 = params.bind_list_str(values);
                        format!(
                            "EXISTS (SELECT 1 FROM formula_cache fc WHERE fc.entity_uuid = e.uuid AND fc.col_id = {p_col2} AND fc.kind != 'empty' AND (
                                (fc.kind = 'date' AND fc.val_date_ms IS NOT NULL AND strftime('%Y-%m-%d', fc.val_date_ms / 1000, 'unixepoch', 'localtime') IN ({list1}))
                                OR (fc.kind = 'list' AND fc.val_json IS NOT NULL AND EXISTS (SELECT 1 FROM json_each(fc.val_json, '$.listItems') je WHERE TRIM(CAST(je.value AS TEXT)) IN ({list2})))
                                OR (fc.kind NOT IN ('date', 'list') AND TRIM(fc.display_text) IN ({list3}))
                            ))"
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
                _ => {
                    // text
                    let p_col1 = params.bind_str(meta.id.clone());
                    let is_empty = format!(
                        "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col1} AND TRIM(COALESCE(cv.val_text, '')) != '')"
                    );
                    let has_match = if values.is_empty() {
                        "0".to_string()
                    } else {
                        let p_col2 = params.bind_str(meta.id.clone());
                        let list = params.bind_list_str(values);
                        format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col2} AND TRIM(COALESCE(cv.val_text, '')) IN ({list}))"
                        )
                    };
                    Some(combine_empty_and_match(&is_empty, &has_match, include_empty))
                }
            }
        }
    }
}

pub(crate) fn combine_empty_and_match(is_empty: &str, has_match: &str, include_empty: bool) -> String {
    if include_empty {
        format!("(({is_empty}) OR ({has_match}))")
    } else {
        format!("((NOT ({is_empty})) AND ({has_match}))")
    }
}

/// 构造单条 `TableFilterCondition` SQL 谓词（精确对齐 `matchesFilterCondition`）。
fn build_filter_condition_sql(
    cond: &TableFilterConditionInput,
    col_map: &HashMap<String, ColumnMeta>,
    today_key: &str,
    params: &mut SqlParams,
) -> Option<String> {
    let col_meta = col_map.get(&cond.column_id);
    if !is_system_col(&cond.column_id) && col_meta.is_none() {
        return None;
    }
    let kind = get_filter_kind(&cond.column_id, col_meta);
    let op = cond.operator.as_str();
    if !is_valid_operator(kind, op) {
        return None;
    }

    match kind {
        FilterKind::Images => {
            if op == "is_empty" {
                Some(format!("{IMAGE_COUNT_SUBQUERY} = 0"))
            } else {
                Some(format!("{IMAGE_COUNT_SUBQUERY} > 0"))
            }
        }
        FilterKind::Number => {
            let meta = col_meta?;
            let p_col = params.bind_str(meta.id.clone());
            let val_expr = format!(
                "(SELECT cv.val_num FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col})"
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
        FilterKind::Date => {
            let date_expr = build_row_date_key_expr(&cond.column_id, col_meta, params)?;
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
                            let p_s = params.bind_str(start_key);
                            let p_e = params.bind_str(end_key);
                            Some(format!(
                                "({date_expr} IS NOT NULL AND {date_expr} >= {p_s} AND {date_expr} <= {p_e})"
                            ))
                        }
                        "neq" => {
                            let p_s = params.bind_str(start_key);
                            let p_e = params.bind_str(end_key);
                            Some(format!(
                                "({date_expr} IS NULL OR {date_expr} < {p_s} OR {date_expr} > {p_e})"
                            ))
                        }
                        "gt" => {
                            let p_e = params.bind_str(end_key);
                            Some(format!("({date_expr} IS NOT NULL AND {date_expr} > {p_e})"))
                        }
                        "gte" => {
                            let p_s = params.bind_str(start_key);
                            Some(format!("({date_expr} IS NOT NULL AND {date_expr} >= {p_s})"))
                        }
                        "lt" => {
                            let p_s = params.bind_str(start_key);
                            Some(format!("({date_expr} IS NOT NULL AND {date_expr} < {p_s})"))
                        }
                        "lte" => {
                            let p_e = params.bind_str(end_key);
                            Some(format!("({date_expr} IS NOT NULL AND {date_expr} <= {p_e})"))
                        }
                        _ => None,
                    }
                }
            }
        }
        FilterKind::Select | FilterKind::Relation => {
            build_set_condition_sql(&cond.column_id, col_meta, op, cond.values.as_deref(), params)
        }
        FilterKind::Text => {
            let text_expr = if cond.column_id == "name" {
                "TRIM(e.text)".to_string()
            } else if let Some(meta) = col_meta {
                let p_col = params.bind_str(meta.id.clone());
                if meta.col_type == "formula" {
                    format!(
                        "COALESCE((SELECT CASE WHEN fc.kind = 'empty' THEN '' ELSE TRIM(fc.display_text) END FROM formula_cache fc WHERE fc.entity_uuid = e.uuid AND fc.col_id = {p_col}), '')"
                    )
                } else {
                    format!(
                        "COALESCE((SELECT TRIM(COALESCE(cv.val_text, '')) FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col}), '')"
                    )
                }
            } else {
                return None;
            };
            match op {
                "is_empty" => Some(format!("{text_expr} = ''")),
                "is_not_empty" => Some(format!("{text_expr} != ''")),
                _ => {
                    let target = cond.value.as_deref()?.trim();
                    if target.is_empty() {
                        return None;
                    }
                    let p_target = params.bind_str(target.to_lowercase());
                    match op {
                        "contains" => Some(format!("INSTR(lower({text_expr}), {p_target}) > 0")),
                        "not_contains" => {
                            Some(format!("INSTR(lower({text_expr}), {p_target}) = 0"))
                        }
                        "eq" => Some(format!("lower({text_expr}) = {p_target}")),
                        "neq" => Some(format!("lower({text_expr}) != {p_target}")),
                        _ => None,
                    }
                }
            }
        }
    }
}

/// 构造 `select` / `multi_select` / `relation` 列的集合操作符谓词（`contains` / `not_contains` / `eq` / `neq` / `is_empty` / `is_not_empty`）。
fn build_set_condition_sql(
    col_id: &str,
    col_meta: Option<&ColumnMeta>,
    op: &str,
    values: Option<&[String]>,
    params: &mut SqlParams,
) -> Option<String> {
    let requires_val = !matches!(op, "is_empty" | "is_not_empty");
    let mut selected_unique: Vec<String> = Vec::new();
    if requires_val {
        let raw_vals = values?;
        if raw_vals.is_empty() {
            return None;
        }
        let mut seen = HashSet::new();
        for v in raw_vals {
            if seen.insert(v.clone()) {
                selected_unique.push(v.clone());
            }
        }
    }

    // 构造一个子查询模板，返回该行在该列上所有有效 token key
    let make_tokens_subquery = |params: &mut SqlParams| -> Option<String> {
        match col_id {
            "parents" => Some(
                "SELECT DISTINCT ed.source_uuid AS tok FROM edges ed JOIN entities pe ON pe.uuid = ed.source_uuid AND pe.is_row = 1 WHERE ed.target_uuid = e.uuid AND ed.source_uuid != e.uuid".to_string(),
            ),
            "children" => Some(
                "SELECT DISTINCT ed.target_uuid AS tok FROM edges ed JOIN entities ce ON ce.uuid = ed.target_uuid AND ce.is_row = 1 WHERE ed.source_uuid = e.uuid AND ed.target_uuid != e.uuid".to_string(),
            ),
            "outer" => Some(
                "SELECT e.parent_section_uuid AS tok FROM entities oe WHERE oe.uuid = e.parent_section_uuid AND oe.is_row = 1".to_string(),
            ),
            "inner" => Some(
                "SELECT ie.uuid AS tok FROM entities ie WHERE e.kind = 'section' AND ie.parent_section_uuid = e.uuid AND ie.is_row = 1".to_string(),
            ),
            _ => {
                let meta = col_meta?;
                let valid_opt_ids: Vec<String> =
                    meta.options.iter().map(|o| o.id.clone()).collect();
                if valid_opt_ids.is_empty() {
                    return Some("SELECT NULL AS tok WHERE 0".to_string());
                }
                let p_col = params.bind_str(meta.id.clone());
                let valid_list = params.bind_list_str(&valid_opt_ids);
                if meta.col_type == "multi_select" {
                    Some(format!(
                        "SELECT DISTINCT cm.option_id AS tok FROM cell_multi_options cm WHERE cm.entity_uuid = e.uuid AND cm.col_id = {p_col} AND cm.option_id IN ({valid_list})"
                    ))
                } else {
                    Some(format!(
                        "SELECT cv.val_text AS tok FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col} AND cv.val_text IN ({valid_list})"
                    ))
                }
            }
        }
    };

    match op {
        "is_empty" => {
            let sub = make_tokens_subquery(params)?;
            Some(format!("NOT EXISTS ({sub})"))
        }
        "is_not_empty" => {
            let sub = make_tokens_subquery(params)?;
            Some(format!("EXISTS ({sub})"))
        }
        "contains" => {
            let sub = make_tokens_subquery(params)?;
            let list = params.bind_list_str(&selected_unique);
            Some(format!("EXISTS (SELECT 1 FROM ({sub}) t WHERE t.tok IN ({list}))"))
        }
        "not_contains" => {
            let sub = make_tokens_subquery(params)?;
            let list = params.bind_list_str(&selected_unique);
            Some(format!(
                "NOT EXISTS (SELECT 1 FROM ({sub}) t WHERE t.tok IN ({list}))"
            ))
        }
        "eq" | "neq" => {
            let sub1 = make_tokens_subquery(params)?;
            let sub2 = make_tokens_subquery(params)?;
            let list = params.bind_list_str(&selected_unique);
            let target_len = selected_unique.len();
            let exact_match = format!(
                "((SELECT COUNT(*) FROM ({sub1})) = {target_len} AND (SELECT COUNT(*) FROM ({sub2}) t WHERE t.tok IN ({list})) = {target_len})"
            );
            if op == "eq" {
                Some(exact_match)
            } else {
                Some(format!("NOT {exact_match}"))
            }
        }
        _ => None,
    }
}

/// 构造 `extra_group_filter` 谓词（用于间隔重复队列分页或看板单列分页）。
fn build_extra_group_filter_sql(
    extra: &TableExtraGroupFilter,
    col_map: &HashMap<String, ColumnMeta>,
    params: &mut SqlParams,
) -> Option<String> {
    let col_meta = col_map.get(&extra.column_id);
    if !is_system_col(&extra.column_id) && col_meta.is_none() {
        return None;
    }

    let core = match extra.column_id.as_str() {
        "outer" => match &extra.group_key {
            None => "(e.parent_section_uuid IS NULL OR NOT EXISTS (SELECT 1 FROM entities oe WHERE oe.uuid = e.parent_section_uuid AND oe.is_row = 1))".to_string(),
            Some(k) => {
                let p = params.bind_str(k.clone());
                format!("e.parent_section_uuid = {p}")
            }
        },
        _ => {
            let meta = col_meta?;
            let p_col = params.bind_str(meta.id.clone());
            match meta.col_type.as_str() {
                "select" => match &extra.group_key {
                    None => {
                        let valid_ids: Vec<String> =
                            meta.options.iter().map(|o| o.id.clone()).collect();
                        if valid_ids.is_empty() {
                            "1".to_string()
                        } else {
                            let list = params.bind_list_str(&valid_ids);
                            format!("NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col} AND cv.val_text IN ({list}))")
                        }
                    }
                    Some(k) => {
                        let pk = params.bind_str(k.clone());
                        format!("EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col} AND cv.val_text = {pk})")
                    }
                },
                "formula" => match &extra.group_key {
                    None => format!(
                        "NOT EXISTS (SELECT 1 FROM formula_cache fc WHERE fc.entity_uuid = e.uuid AND fc.col_id = {p_col} AND fc.kind != 'empty' AND TRIM(fc.display_text) != '')"
                    ),
                    Some(k) => {
                        let pk = params.bind_str(k.clone());
                        format!(
                            "EXISTS (SELECT 1 FROM formula_cache fc WHERE fc.entity_uuid = e.uuid AND fc.col_id = {p_col} AND fc.kind != 'empty' AND TRIM(fc.display_text) = {pk})"
                        )
                    }
                },
                _ => match &extra.group_key {
                    None => format!(
                        "NOT EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col} AND TRIM(COALESCE(cv.val_text, '')) != '')"
                    ),
                    Some(k) => {
                        let pk = params.bind_str(k.clone());
                        format!(
                            "EXISTS (SELECT 1 FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col} AND TRIM(COALESCE(cv.val_text, '')) = {pk})"
                        )
                    }
                },
            }
        }
    };

    if extra.pinned_uuids.is_empty() {
        Some(core)
    } else {
        let pinned_list = params.bind_list_str(&extra.pinned_uuids);
        Some(format!("(({core}) OR e.uuid IN ({pinned_list}))"))
    }
}

/// 组装完整 WHERE 子句（不含 `WHERE` 关键字）。
fn build_where_clause(
    filters: &[TableColumnFilterInput],
    filter_group: Option<&TableFilterGroupInput>,
    extra_group_filter: Option<&TableExtraGroupFilter>,
    col_map: &HashMap<String, ColumnMeta>,
    today_key: &str,
    params: &mut SqlParams,
) -> String {
    let mut clauses = vec!["e.is_row = 1".to_string()];

    for flt in filters {
        if let Some(sql) = build_column_filter_sql(flt, col_map, params) {
            clauses.push(sql);
        }
    }

    if let Some(grp) = filter_group {
        let mut cond_sqls = Vec::new();
        for cond in &grp.conditions {
            if let Some(sql) = build_filter_condition_sql(cond, col_map, today_key, params) {
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
        if let Some(sql) = build_extra_group_filter_sql(extra, col_map, params) {
            clauses.push(sql);
        }
    }

    clauses.join(" AND ")
}

/// 组装 ORDER BY 子句（空值永远置底，文本使用 `COLLATE \"NATURAL\"`，末尾以 `e.sort_order ASC, e.rowid ASC` 稳定破平）。
fn build_order_by_clause(
    sort: Option<&TableSortInput>,
    col_map: &HashMap<String, ColumnMeta>,
    params: &mut SqlParams,
) -> String {
    let Some(sort) = sort else {
        return "e.sort_order ASC, e.rowid ASC".to_string();
    };
    let dir = if sort.direction == "desc" {
        "DESC"
    } else {
        "ASC"
    };

    match sort.column_id.as_str() {
        "name" => format!(
            "CASE WHEN TRIM(e.text) = '' THEN 1 ELSE 0 END ASC, TRIM(e.text) COLLATE \"NATURAL\" {dir}, e.sort_order ASC, e.rowid ASC"
        ),
        "images" => format!("{IMAGE_COUNT_SUBQUERY} {dir}, e.sort_order ASC, e.rowid ASC"),
        "createdAt" => format!(
            "CASE WHEN e.created_at <= 0 THEN 1 ELSE 0 END ASC, e.created_at {dir}, e.sort_order ASC, e.rowid ASC"
        ),
        "updatedAt" => format!(
            "CASE WHEN e.updated_at <= 0 THEN 1 ELSE 0 END ASC, e.updated_at {dir}, e.sort_order ASC, e.rowid ASC"
        ),
        "parents" => format!(
            "(CASE WHEN COALESCE((SELECT group_concat(lbl, ', ') FROM (SELECT TRIM(pe.text) AS lbl FROM edges ed JOIN entities pe ON pe.uuid = ed.source_uuid AND pe.is_row = 1 WHERE ed.target_uuid = e.uuid AND ed.source_uuid != e.uuid AND TRIM(pe.text) != '' GROUP BY pe.uuid ORDER BY TRIM(pe.text) COLLATE \"NATURAL\" ASC)), '') = '' THEN 1 ELSE 0 END) ASC,
             COALESCE((SELECT group_concat(lbl, ', ') FROM (SELECT TRIM(pe.text) AS lbl FROM edges ed JOIN entities pe ON pe.uuid = ed.source_uuid AND pe.is_row = 1 WHERE ed.target_uuid = e.uuid AND ed.source_uuid != e.uuid AND TRIM(pe.text) != '' GROUP BY pe.uuid ORDER BY TRIM(pe.text) COLLATE \"NATURAL\" ASC)), '') COLLATE \"NATURAL\" {dir},
             e.sort_order ASC, e.rowid ASC"
        ),
        "children" => format!(
            "(CASE WHEN COALESCE((SELECT group_concat(lbl, ', ') FROM (SELECT TRIM(ce.text) AS lbl FROM edges ed JOIN entities ce ON ce.uuid = ed.target_uuid AND ce.is_row = 1 WHERE ed.source_uuid = e.uuid AND ed.target_uuid != e.uuid AND TRIM(ce.text) != '' GROUP BY ce.uuid ORDER BY TRIM(ce.text) COLLATE \"NATURAL\" ASC)), '') = '' THEN 1 ELSE 0 END) ASC,
             COALESCE((SELECT group_concat(lbl, ', ') FROM (SELECT TRIM(ce.text) AS lbl FROM edges ed JOIN entities ce ON ce.uuid = ed.target_uuid AND ce.is_row = 1 WHERE ed.source_uuid = e.uuid AND ed.target_uuid != e.uuid AND TRIM(ce.text) != '' GROUP BY ce.uuid ORDER BY TRIM(ce.text) COLLATE \"NATURAL\" ASC)), '') COLLATE \"NATURAL\" {dir},
             e.sort_order ASC, e.rowid ASC"
        ),
        "outer" => format!(
            "CASE WHEN COALESCE((SELECT TRIM(oe.text) FROM entities oe WHERE oe.uuid = e.parent_section_uuid AND oe.is_row = 1), '') = '' THEN 1 ELSE 0 END ASC,
             COALESCE((SELECT TRIM(oe.text) FROM entities oe WHERE oe.uuid = e.parent_section_uuid AND oe.is_row = 1), '') COLLATE \"NATURAL\" {dir},
             e.sort_order ASC, e.rowid ASC"
        ),
        "inner" => format!(
            "(CASE WHEN e.kind != 'section' OR COALESCE((SELECT group_concat(lbl, ', ') FROM (SELECT TRIM(ie.text) AS lbl FROM entities ie WHERE ie.parent_section_uuid = e.uuid AND ie.is_row = 1 AND TRIM(ie.text) != '' ORDER BY TRIM(ie.text) COLLATE \"NATURAL\" ASC)), '') = '' THEN 1 ELSE 0 END) ASC,
             COALESCE((SELECT group_concat(lbl, ', ') FROM (SELECT TRIM(ie.text) AS lbl FROM entities ie WHERE ie.parent_section_uuid = e.uuid AND ie.is_row = 1 AND TRIM(ie.text) != '' ORDER BY TRIM(ie.text) COLLATE \"NATURAL\" ASC)), '') COLLATE \"NATURAL\" {dir},
             e.sort_order ASC, e.rowid ASC"
        ),
        _ => {
            let Some(meta) = col_map.get(&sort.column_id) else {
                return "e.sort_order ASC, e.rowid ASC".to_string();
            };
            match meta.col_type.as_str() {
                "number" => {
                    let p1 = params.bind_str(meta.id.clone());
                    let p2 = params.bind_str(meta.id.clone());
                    format!(
                        "CASE WHEN (SELECT cv.val_num FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p1}) IS NULL THEN 1 ELSE 0 END ASC,
                         (SELECT cv.val_num FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p2}) {dir},
                         e.sort_order ASC, e.rowid ASC"
                    )
                }
                "date" => {
                    let p1 = params.bind_str(meta.id.clone());
                    let p2 = params.bind_str(meta.id.clone());
                    format!(
                        "CASE WHEN COALESCE((SELECT TRIM(COALESCE(cv.val_date, cv.val_text, '')) FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p1}), '') = '' THEN 1 ELSE 0 END ASC,
                         COALESCE((SELECT TRIM(COALESCE(cv.val_date, cv.val_text, '')) FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p2}), '') COLLATE \"NATURAL\" {dir},
                         e.sort_order ASC, e.rowid ASC"
                    )
                }
                "select" => {
                    // 按选项展示名称排序（与 getRowSortKey 一致）
                    let mut case_parts = Vec::new();
                    for opt in &meta.options {
                        let pid = params.bind_str(opt.id.clone());
                        let pname = params.bind_str(opt.name.clone());
                        case_parts.push(format!("WHEN {pid} THEN {pname}"));
                    }
                    let p_col = params.bind_str(meta.id.clone());
                    let label_expr = if case_parts.is_empty() {
                        "''".to_string()
                    } else {
                        format!(
                            "COALESCE((SELECT CASE cv.val_text {} ELSE '' END FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p_col}), '')",
                            case_parts.join(" ")
                        )
                    };
                    format!(
                        "CASE WHEN {label_expr} = '' THEN 1 ELSE 0 END ASC, {label_expr} COLLATE \"NATURAL\" {dir}, e.sort_order ASC, e.rowid ASC"
                    )
                }
                "multi_select" => {
                    let p1 = params.bind_str(meta.id.clone());
                    let p2 = params.bind_str(meta.id.clone());
                    format!(
                        "CASE WHEN COALESCE((SELECT group_concat(cm.option_name, ', ') FROM cell_multi_options cm WHERE cm.entity_uuid = e.uuid AND cm.col_id = {p1}), '') = '' THEN 1 ELSE 0 END ASC,
                         COALESCE((SELECT group_concat(cm.option_name, ', ') FROM cell_multi_options cm WHERE cm.entity_uuid = e.uuid AND cm.col_id = {p2}), '') COLLATE \"NATURAL\" {dir},
                         e.sort_order ASC, e.rowid ASC"
                    )
                }
                "formula" => {
                    let p1 = params.bind_str(meta.id.clone());
                    let p2 = params.bind_str(meta.id.clone());
                    let p3 = params.bind_str(meta.id.clone());
                    format!(
                        "CASE WHEN COALESCE((SELECT CASE WHEN fc.kind = 'empty' THEN 1 WHEN fc.kind IN ('number', 'date', 'boolean') THEN 0 WHEN TRIM(fc.display_text) = '' THEN 1 ELSE 0 END FROM formula_cache fc WHERE fc.entity_uuid = e.uuid AND fc.col_id = {p1}), 1) = 1 THEN 1 ELSE 0 END ASC,
                         (SELECT CASE
                            WHEN fc.kind = 'number' THEN fc.val_num
                            WHEN fc.kind = 'date' THEN CAST(fc.val_date_ms AS REAL)
                            WHEN fc.kind = 'boolean' THEN CASE WHEN UPPER(fc.display_text) = 'TRUE' THEN 1.0 ELSE 0.0 END
                            ELSE NULL
                          END FROM formula_cache fc WHERE fc.entity_uuid = e.uuid AND fc.col_id = {p2}) {dir},
                         COALESCE((SELECT TRIM(fc.display_text) FROM formula_cache fc WHERE fc.entity_uuid = e.uuid AND fc.col_id = {p3}), '') COLLATE \"NATURAL\" {dir},
                         e.sort_order ASC, e.rowid ASC"
                    )
                }
                _ => {
                    let p1 = params.bind_str(meta.id.clone());
                    let p2 = params.bind_str(meta.id.clone());
                    format!(
                        "CASE WHEN COALESCE((SELECT TRIM(COALESCE(cv.val_text, '')) FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p1}), '') = '' THEN 1 ELSE 0 END ASC,
                         COALESCE((SELECT TRIM(COALESCE(cv.val_text, '')) FROM cell_values cv WHERE cv.entity_uuid = e.uuid AND cv.col_id = {p2}), '') COLLATE \"NATURAL\" {dir},
                         e.sort_order ASC, e.rowid ASC"
                    )
                }
            }
        }
    }
}

// ============================================================================
// 当前页批量组装（仅针对当前页 O(page_size) 行，零全表扫描）
// ============================================================================

struct RawEntityRow {
    uuid: String,
    kind: String,
    parent_section_uuid: Option<String>,
    text: String,
    props_json: String,
    created_at: i64,
    updated_at: i64,
    sort_order: i64,
}

fn hydrate_page_rows(
    conn: &Connection,
    doc_id: &str,
    raw_rows: Vec<RawEntityRow>,
) -> Result<Vec<V3TableRowRecord>, String> {
    if raw_rows.is_empty() {
        return Ok(Vec::new());
    }

    let page_uuids: Vec<String> = raw_rows.iter().map(|r| r.uuid.clone()).collect();
    let placeholders: String = (1..=page_uuids.len())
        .map(|i| format!("?{i}"))
        .collect::<Vec<_>>()
        .join(", ");
    let page_sql_vals: Vec<SqlValue> = page_uuids.iter().cloned().map(SqlValue::Text).collect();

    // 1. 批量加载当前页实体内的非背景图片
    let mut images_by_parent: HashMap<String, Vec<V3ImageItemRecord>> = HashMap::new();
    {
        let sql = format!(
            "SELECT parent_section_uuid, uuid, COALESCE(json_extract(props_json, '$.attachmentId'), '')
             FROM entities
             WHERE parent_section_uuid IN ({placeholders})
               AND kind = 'image'
               AND COALESCE(json_extract(props_json, '$.isBackground'), 0) = 0
             ORDER BY sort_order ASC, rowid ASC"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("批量查询页内图片失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(page_sql_vals.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| format!("读取页内图片失败: {e}"))?;
        for r in rows {
            let (parent_uuid, img_uuid, att_id) =
                r.map_err(|e| format!("解析页内图片失败: {e}"))?;
            images_by_parent
                .entry(parent_uuid)
                .or_default()
                .push(V3ImageItemRecord {
                    uuid: img_uuid,
                    attachment_id: att_id,
                });
        }
    }

    // 2. 批量加载当前页实体的 1-hop 父节点（incoming edges）与子节点（outgoing edges）
    let mut parents_by_uuid: HashMap<String, Vec<V3RelationItemRecord>> = HashMap::new();
    let mut parents_seen: HashMap<String, HashSet<String>> = HashMap::new();
    {
        let sql = format!(
            "SELECT ed.target_uuid, pe.uuid, pe.kind, pe.text, pe.props_json
             FROM edges ed
             JOIN entities pe ON pe.uuid = ed.source_uuid AND pe.is_row = 1
             WHERE ed.target_uuid IN ({placeholders})
               AND ed.source_uuid != ed.target_uuid
             ORDER BY ed.sort_order ASC, ed.rowid ASC"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("批量查询页内父节点失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(page_sql_vals.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| format!("读取页内父节点失败: {e}"))?;
        for r in rows {
            let (target_uuid, src_uuid, kind, text, props_json) =
                r.map_err(|e| format!("解析页内父节点失败: {e}"))?;
            if parents_seen
                .entry(target_uuid.clone())
                .or_default()
                .insert(src_uuid.clone())
            {
                let label = resolve_primary_text_from_row(&kind, &text, &props_json);
                parents_by_uuid
                    .entry(target_uuid)
                    .or_default()
                    .push(V3RelationItemRecord {
                        uuid: src_uuid,
                        label,
                        kind,
                    });
            }
        }
    }

    let mut children_by_uuid: HashMap<String, Vec<V3RelationItemRecord>> = HashMap::new();
    let mut children_seen: HashMap<String, HashSet<String>> = HashMap::new();
    {
        let sql = format!(
            "SELECT ed.source_uuid, ce.uuid, ce.kind, ce.text, ce.props_json
             FROM edges ed
             JOIN entities ce ON ce.uuid = ed.target_uuid AND ce.is_row = 1
             WHERE ed.source_uuid IN ({placeholders})
               AND ed.source_uuid != ed.target_uuid
             ORDER BY ed.sort_order ASC, ed.rowid ASC"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("批量查询页内子节点失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(page_sql_vals.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| format!("读取页内子节点失败: {e}"))?;
        for r in rows {
            let (src_uuid, target_uuid, kind, text, props_json) =
                r.map_err(|e| format!("解析页内子节点失败: {e}"))?;
            if children_seen
                .entry(src_uuid.clone())
                .or_default()
                .insert(target_uuid.clone())
            {
                let label = resolve_primary_text_from_row(&kind, &text, &props_json);
                children_by_uuid
                    .entry(src_uuid)
                    .or_default()
                    .push(V3RelationItemRecord {
                        uuid: target_uuid,
                        label,
                        kind,
                    });
            }
        }
    }

    // 3. 批量加载当前页实体的外节点（outer）与内节点（inner）
    let mut outer_map: HashMap<String, V3RelationItemRecord> = HashMap::new();
    {
        let mut parent_ids: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        for r in &raw_rows {
            if let Some(p) = &r.parent_section_uuid {
                if seen.insert(p.clone()) {
                    parent_ids.push(p.clone());
                }
            }
        }
        if !parent_ids.is_empty() {
            let p_ph: String = (1..=parent_ids.len())
                .map(|i| format!("?{i}"))
                .collect::<Vec<_>>()
                .join(", ");
            let p_vals: Vec<SqlValue> = parent_ids.into_iter().map(SqlValue::Text).collect();
            let sql = format!(
                "SELECT uuid, kind, text, props_json FROM entities WHERE uuid IN ({p_ph}) AND is_row = 1"
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("批量查询外节点失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(p_vals.iter()), |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| format!("读取外节点失败: {e}"))?;
            for r in rows {
                let (uuid, kind, text, props_json) =
                    r.map_err(|e| format!("解析外节点失败: {e}"))?;
                let label = resolve_primary_text_from_row(&kind, &text, &props_json);
                outer_map.insert(uuid.clone(), V3RelationItemRecord { uuid, label, kind });
            }
        }
    }

    let mut inner_by_section: HashMap<String, Vec<V3RelationItemRecord>> = HashMap::new();
    {
        let sql = format!(
            "SELECT parent_section_uuid, uuid, kind, text, props_json
             FROM entities
             WHERE parent_section_uuid IN ({placeholders})
               AND is_row = 1
             ORDER BY sort_order ASC, rowid ASC"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("批量查询内节点失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(page_sql_vals.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| format!("读取内节点失败: {e}"))?;
        for r in rows {
            let (sec_uuid, child_uuid, kind, text, props_json) =
                r.map_err(|e| format!("解析内节点失败: {e}"))?;
            let label = resolve_primary_text_from_row(&kind, &text, &props_json);
            inner_by_section
                .entry(sec_uuid)
                .or_default()
                .push(V3RelationItemRecord {
                    uuid: child_uuid,
                    label,
                    kind,
                });
        }
    }

    // 4. 批量加载当前页单元格值与公式缓存
    let mut cells_by_uuid: HashMap<String, Vec<V3CellValueRecord>> = HashMap::new();
    {
        let sql = format!(
            "SELECT entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json
             FROM cell_values
             WHERE entity_uuid IN ({placeholders})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("批量查询页内 cell_values 失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(page_sql_vals.iter()), |row| {
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
            .map_err(|e| format!("读取页内 cell_values 失败: {e}"))?;
        for r in rows {
            let rec = r.map_err(|e| format!("解析页内 cell_values 失败: {e}"))?;
            cells_by_uuid
                .entry(rec.entity_uuid.clone())
                .or_default()
                .push(rec);
        }
    }

    let mut formulas_by_uuid: HashMap<String, HashMap<String, V3FormulaCellRecord>> =
        HashMap::new();
    {
        let sql = format!(
            "SELECT entity_uuid, col_id, kind, display_text, val_num, val_date_ms, val_json
             FROM formula_cache
             WHERE entity_uuid IN ({placeholders})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| format!("批量查询页内 formula_cache 失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(page_sql_vals.iter()), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<f64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(|e| format!("读取页内 formula_cache 失败: {e}"))?;
        for r in rows {
            let (entity_uuid, col_id, kind, display_text, val_num, val_date_ms, val_json) =
                r.map_err(|e| format!("解析页内 formula_cache 失败: {e}"))?;
            let meta_val: Option<serde_json::Value> = val_json
                .as_deref()
                .and_then(|s| serde_json::from_str(s).ok());
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

            formulas_by_uuid
                .entry(entity_uuid)
                .or_default()
                .insert(
                    col_id,
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

    // 5. 按原始分页顺序组装
    let mut out = Vec::with_capacity(raw_rows.len());
    for raw in raw_rows {
        let primary_text = resolve_primary_text_from_row(&raw.kind, &raw.text, &raw.props_json);
        let is_container = is_editable_container_kind(&raw.kind);
        let outer = raw
            .parent_section_uuid
            .as_ref()
            .and_then(|pid| outer_map.get(pid).cloned());
        let inner = if raw.kind == "section" {
            inner_by_section.remove(&raw.uuid).unwrap_or_default()
        } else {
            Vec::new()
        };
        let images = if raw.kind == "section" {
            images_by_parent.remove(&raw.uuid).unwrap_or_default()
        } else {
            Vec::new()
        };

        out.push(V3TableRowRecord {
            doc_id: doc_id.to_string(),
            editable_text: is_editable_text_kind(&raw.kind),
            can_edit_images: is_container,
            can_edit_inner: is_container,
            primary_text,
            images,
            created_at: raw.created_at,
            updated_at: raw.updated_at,
            parents: parents_by_uuid.remove(&raw.uuid).unwrap_or_default(),
            children: children_by_uuid.remove(&raw.uuid).unwrap_or_default(),
            outer,
            inner,
            cell_values: cells_by_uuid.remove(&raw.uuid).unwrap_or_default(),
            formula_values: formulas_by_uuid.remove(&raw.uuid).unwrap_or_default(),
            sort_order: raw.sort_order,
            uuid: raw.uuid,
            kind: raw.kind,
            source_file: None,
            source_folder: None,
            source_rel_path: None,
        });
    }
    Ok(out)
}

// ============================================================================
// 6 大公共查询入口
// ============================================================================

/// 1. 分页查询表格行（支持筛选、筛选组、自然排序、分页与 1-hop 关系/图片/公式批量拼装）。
pub fn query_table_page(conn: &Connection, query: &TablePageQuery) -> Result<TablePageResult, String> {
    let col_map = load_column_meta_map(conn)?;
    let today_key = resolve_today_key(conn, query.today_key.as_deref());

    let unfiltered_total_count: usize = conn
        .query_row("SELECT COUNT(*) FROM entities WHERE is_row = 1", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| format!("查询总行数失败: {e}"))? as usize;

    let mut count_params = SqlParams::new();
    let count_where = build_where_clause(
        &query.filters,
        query.filter_group.as_ref(),
        query.extra_group_filter.as_ref(),
        &col_map,
        &today_key,
        &mut count_params,
    );
    let count_sql = format!("SELECT COUNT(*) FROM entities e WHERE {count_where}");
    let total_count: usize = conn
        .query_row(&count_sql, params_from_iter(count_params.values.iter()), |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| format!("查询筛选后行数失败: {e}"))? as usize;

    let effective_limit = query.limit.clamp(1, 5000);
    let mut page_params = SqlParams::new();
    let page_where = build_where_clause(
        &query.filters,
        query.filter_group.as_ref(),
        query.extra_group_filter.as_ref(),
        &col_map,
        &today_key,
        &mut page_params,
    );
    let order_by = build_order_by_clause(query.sort.as_ref(), &col_map, &mut page_params);
    page_params.values.push(SqlValue::Integer(effective_limit as i64));
    let p_limit = format!("?{}", page_params.values.len());
    page_params.values.push(SqlValue::Integer(query.offset as i64));
    let p_offset = format!("?{}", page_params.values.len());

    let page_sql = format!(
        "SELECT e.uuid, e.kind, e.parent_section_uuid, e.text, e.props_json, e.created_at, e.updated_at, e.sort_order
         FROM entities e
         WHERE {page_where}
         ORDER BY {order_by}
         LIMIT {p_limit} OFFSET {p_offset}"
    );

    let raw_rows = {
        let mut stmt = conn
            .prepare(&page_sql)
            .map_err(|e| format!("准备分页查询失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(page_params.values.iter()), |row| {
                Ok(RawEntityRow {
                    uuid: row.get(0)?,
                    kind: row.get(1)?,
                    parent_section_uuid: row.get(2)?,
                    text: row.get(3)?,
                    props_json: row.get(4)?,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    sort_order: row.get(7)?,
                })
            })
            .map_err(|e| format!("执行分页查询失败: {e}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("解析分页结果失败: {e}"))?
    };

    let hydrated = hydrate_page_rows(conn, &query.doc_id, raw_rows)?;

    Ok(TablePageResult {
        total_count,
        unfiltered_total_count,
        offset: query.offset,
        limit: effective_limit,
        rows: hydrated,
    })
}

/// 2. 列值筛选分桶聚合（SQL `GROUP BY` 返回去重分桶计数与空值数）。
pub fn query_filter_buckets(
    conn: &Connection,
    query: &TableFilterBucketsQuery,
) -> Result<TableFilterBucketsResult, String> {
    let col_map = load_column_meta_map(conn)?;
    let col_meta = col_map.get(&query.column_id);
    if !is_system_col(&query.column_id) && col_meta.is_none() {
        return Ok(TableFilterBucketsResult {
            buckets: Vec::new(),
            empty_count: 0,
            total_buckets: 0,
        });
    }

    let total_rows: usize = conn
        .query_row("SELECT COUNT(*) FROM entities WHERE is_row = 1", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| format!("统计总行数失败: {e}"))? as usize;

    let mut buckets: Vec<ColumnFilterBucketRecord> = Vec::new();
    let empty_count: usize;

    match query.column_id.as_str() {
        "name" => {
            let mut stmt = conn
                .prepare(
                    "SELECT TRIM(text) AS k, COUNT(*) FROM entities
                     WHERE is_row = 1 AND TRIM(text) != ''
                     GROUP BY TRIM(text)",
                )
                .map_err(|e| format!("查询 name 分桶失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize)))
                .map_err(|e| format!("读取 name 分桶失败: {e}"))?;
            let mut non_empty = 0usize;
            for r in rows {
                let (k, cnt) = r.map_err(|e| format!("解析 name 分桶失败: {e}"))?;
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
        "images" => {
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT cnt, COUNT(*) FROM (
                        SELECT {IMAGE_COUNT_SUBQUERY} AS cnt FROM entities e WHERE e.is_row = 1
                     ) GROUP BY cnt"
                ))
                .map_err(|e| format!("查询 images 分桶失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? as usize)))
                .map_err(|e| format!("读取 images 分桶失败: {e}"))?;
            let mut ec = 0usize;
            for r in rows {
                let (cnt_val, row_cnt) = r.map_err(|e| format!("解析 images 分桶失败: {e}"))?;
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
                "created_at"
            } else {
                "updated_at"
            };
            let mut stmt = conn
                .prepare(&format!(
                    "SELECT CASE WHEN {col_sql} > 0 THEN strftime('%Y-%m-%d', {col_sql} / 1000, 'unixepoch', 'localtime') ELSE '' END AS d, COUNT(*)
                     FROM entities WHERE is_row = 1 GROUP BY d"
                ))
                .map_err(|e| format!("查询时间分桶失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize)))
                .map_err(|e| format!("读取时间分桶失败: {e}"))?;
            let mut ec = 0usize;
            for r in rows {
                let (d, cnt) = r.map_err(|e| format!("解析时间分桶失败: {e}"))?;
                if d.is_empty() {
                    ec += cnt;
                } else {
                    buckets.push(ColumnFilterBucketRecord {
                        key: d.clone(),
                        label: d,
                        count: cnt,
                        color: None,
                    });
                }
            }
            empty_count = ec;
            buckets.sort_by(|a, b| b.key.cmp(&a.key));
        }
        "parents" => {
            let mut stmt = conn
                .prepare(
                    "SELECT pe.uuid, pe.kind, pe.text, pe.props_json, COUNT(DISTINCT ed.target_uuid)
                     FROM edges ed
                     JOIN entities te ON te.uuid = ed.target_uuid AND te.is_row = 1
                     JOIN entities pe ON pe.uuid = ed.source_uuid AND pe.is_row = 1
                     WHERE ed.source_uuid != ed.target_uuid
                     GROUP BY pe.uuid",
                )
                .map_err(|e| format!("查询 parents 分桶失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)? as usize,
                    ))
                })
                .map_err(|e| format!("读取 parents 分桶失败: {e}"))?;
            for r in rows {
                let (uuid, kind, text, props, cnt) =
                    r.map_err(|e| format!("解析 parents 分桶失败: {e}"))?;
                let label = resolve_primary_text_from_row(&kind, &text, &props);
                let trimmed = label.trim().to_string();
                buckets.push(ColumnFilterBucketRecord {
                    label: if trimmed.is_empty() { uuid.clone() } else { trimmed },
                    key: uuid,
                    count: cnt,
                    color: None,
                });
            }
            let non_empty_rows: usize = conn
                .query_row(
                    "SELECT COUNT(DISTINCT ed.target_uuid)
                     FROM edges ed
                     JOIN entities te ON te.uuid = ed.target_uuid AND te.is_row = 1
                     JOIN entities pe ON pe.uuid = ed.source_uuid AND pe.is_row = 1
                     WHERE ed.source_uuid != ed.target_uuid",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(|e| format!("统计 parents 非空行失败: {e}"))? as usize;
            empty_count = total_rows.saturating_sub(non_empty_rows);
            buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        }
        "children" => {
            let mut stmt = conn
                .prepare(
                    "SELECT ce.uuid, ce.kind, ce.text, ce.props_json, COUNT(DISTINCT ed.source_uuid)
                     FROM edges ed
                     JOIN entities se ON se.uuid = ed.source_uuid AND se.is_row = 1
                     JOIN entities ce ON ce.uuid = ed.target_uuid AND ce.is_row = 1
                     WHERE ed.source_uuid != ed.target_uuid
                     GROUP BY ce.uuid",
                )
                .map_err(|e| format!("查询 children 分桶失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)? as usize,
                    ))
                })
                .map_err(|e| format!("读取 children 分桶失败: {e}"))?;
            for r in rows {
                let (uuid, kind, text, props, cnt) =
                    r.map_err(|e| format!("解析 children 分桶失败: {e}"))?;
                let label = resolve_primary_text_from_row(&kind, &text, &props);
                let trimmed = label.trim().to_string();
                buckets.push(ColumnFilterBucketRecord {
                    label: if trimmed.is_empty() { uuid.clone() } else { trimmed },
                    key: uuid,
                    count: cnt,
                    color: None,
                });
            }
            let non_empty_rows: usize = conn
                .query_row(
                    "SELECT COUNT(DISTINCT ed.source_uuid)
                     FROM edges ed
                     JOIN entities se ON se.uuid = ed.source_uuid AND se.is_row = 1
                     JOIN entities ce ON ce.uuid = ed.target_uuid AND ce.is_row = 1
                     WHERE ed.source_uuid != ed.target_uuid",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(|e| format!("统计 children 非空行失败: {e}"))? as usize;
            empty_count = total_rows.saturating_sub(non_empty_rows);
            buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        }
        "outer" => {
            let mut stmt = conn
                .prepare(
                    "SELECT oe.uuid, oe.kind, oe.text, oe.props_json, COUNT(*)
                     FROM entities e
                     JOIN entities oe ON oe.uuid = e.parent_section_uuid AND oe.is_row = 1
                     WHERE e.is_row = 1
                     GROUP BY oe.uuid",
                )
                .map_err(|e| format!("查询 outer 分桶失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)? as usize,
                    ))
                })
                .map_err(|e| format!("读取 outer 分桶失败: {e}"))?;
            let mut non_empty = 0usize;
            for r in rows {
                let (uuid, kind, text, props, cnt) =
                    r.map_err(|e| format!("解析 outer 分桶失败: {e}"))?;
                non_empty += cnt;
                let label = resolve_primary_text_from_row(&kind, &text, &props);
                let trimmed = label.trim().to_string();
                buckets.push(ColumnFilterBucketRecord {
                    label: if trimmed.is_empty() { uuid.clone() } else { trimmed },
                    key: uuid,
                    count: cnt,
                    color: None,
                });
            }
            empty_count = total_rows.saturating_sub(non_empty);
            buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        }
        "inner" => {
            let mut stmt = conn
                .prepare(
                    "SELECT ie.uuid, ie.kind, ie.text, ie.props_json, COUNT(DISTINCT pe.uuid)
                     FROM entities ie
                     JOIN entities pe ON pe.uuid = ie.parent_section_uuid AND pe.is_row = 1 AND pe.kind = 'section'
                     WHERE ie.is_row = 1
                     GROUP BY ie.uuid",
                )
                .map_err(|e| format!("查询 inner 分桶失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)? as usize,
                    ))
                })
                .map_err(|e| format!("读取 inner 分桶失败: {e}"))?;
            for r in rows {
                let (uuid, kind, text, props, cnt) =
                    r.map_err(|e| format!("解析 inner 分桶失败: {e}"))?;
                let label = resolve_primary_text_from_row(&kind, &text, &props);
                let trimmed = label.trim().to_string();
                buckets.push(ColumnFilterBucketRecord {
                    label: if trimmed.is_empty() { uuid.clone() } else { trimmed },
                    key: uuid,
                    count: cnt,
                    color: None,
                });
            }
            let non_empty_rows: usize = conn
                .query_row(
                    "SELECT COUNT(DISTINCT pe.uuid)
                     FROM entities ie
                     JOIN entities pe ON pe.uuid = ie.parent_section_uuid AND pe.is_row = 1 AND pe.kind = 'section'
                     WHERE ie.is_row = 1",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .map_err(|e| format!("统计 inner 非空行失败: {e}"))? as usize;
            empty_count = total_rows.saturating_sub(non_empty_rows);
            buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
        }
        _ => {
            let meta = col_meta.unwrap();
            match meta.col_type.as_str() {
                "number" => {
                    let mut stmt = conn
                        .prepare(
                            "SELECT cv.val_num, COUNT(*)
                             FROM cell_values cv
                             JOIN entities e ON e.uuid = cv.entity_uuid AND e.is_row = 1
                             WHERE cv.col_id = ?1 AND cv.val_num IS NOT NULL
                             GROUP BY cv.val_num
                             ORDER BY cv.val_num ASC",
                        )
                        .map_err(|e| format!("查询 number 分桶失败: {e}"))?;
                    let rows = stmt
                        .query_map([&meta.id], |r| {
                            Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)? as usize))
                        })
                        .map_err(|e| format!("读取 number 分桶失败: {e}"))?;
                    let mut non_empty = 0usize;
                    for r in rows {
                        let (num, cnt) = r.map_err(|e| format!("解析 number 分桶失败: {e}"))?;
                        non_empty += cnt;
                        let s = format_js_number(num);
                        buckets.push(ColumnFilterBucketRecord {
                            key: s.clone(),
                            label: s,
                            count: cnt,
                            color: None,
                        });
                    }
                    empty_count = total_rows.saturating_sub(non_empty);
                }
                "date" => {
                    let mut stmt = conn
                        .prepare(
                            "SELECT TRIM(COALESCE(cv.val_date, cv.val_text, '')) AS k, COUNT(*)
                             FROM cell_values cv
                             JOIN entities e ON e.uuid = cv.entity_uuid AND e.is_row = 1
                             WHERE cv.col_id = ?1 AND TRIM(COALESCE(cv.val_date, cv.val_text, '')) != ''
                             GROUP BY k
                             ORDER BY k DESC",
                        )
                        .map_err(|e| format!("查询 date 分桶失败: {e}"))?;
                    let rows = stmt
                        .query_map([&meta.id], |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                        })
                        .map_err(|e| format!("读取 date 分桶失败: {e}"))?;
                    let mut non_empty = 0usize;
                    for r in rows {
                        let (k, cnt) = r.map_err(|e| format!("解析 date 分桶失败: {e}"))?;
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
                        .prepare(
                            "SELECT cv.val_text, COUNT(*)
                             FROM cell_values cv
                             JOIN entities e ON e.uuid = cv.entity_uuid AND e.is_row = 1
                             WHERE cv.col_id = ?1 AND cv.val_text IS NOT NULL
                             GROUP BY cv.val_text",
                        )
                        .map_err(|e| format!("查询 select 分桶失败: {e}"))?;
                    let rows = stmt
                        .query_map([&meta.id], |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                        })
                        .map_err(|e| format!("读取 select 分桶失败: {e}"))?;
                    for r in rows {
                        let (k, cnt) = r.map_err(|e| format!("解析 select 分桶失败: {e}"))?;
                        counts.insert(k, cnt);
                    }
                    let mut non_empty = 0usize;
                    for opt in &meta.options {
                        if let Some(&cnt) = counts.get(&opt.id) {
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
                        .prepare(
                            "SELECT cm.option_id, COUNT(DISTINCT cm.entity_uuid)
                             FROM cell_multi_options cm
                             JOIN entities e ON e.uuid = cm.entity_uuid AND e.is_row = 1
                             WHERE cm.col_id = ?1
                             GROUP BY cm.option_id",
                        )
                        .map_err(|e| format!("查询 multi_select 分桶失败: {e}"))?;
                    let rows = stmt
                        .query_map([&meta.id], |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                        })
                        .map_err(|e| format!("读取 multi_select 分桶失败: {e}"))?;
                    for r in rows {
                        let (k, cnt) = r.map_err(|e| format!("解析 multi_select 分桶失败: {e}"))?;
                        counts.insert(k, cnt);
                    }
                    let valid_ids: Vec<String> =
                        meta.options.iter().map(|o| o.id.clone()).collect();
                    for opt in &meta.options {
                        if let Some(&cnt) = counts.get(&opt.id) {
                            buckets.push(ColumnFilterBucketRecord {
                                key: opt.id.clone(),
                                label: opt.name.clone(),
                                count: cnt,
                                color: opt.color.clone(),
                            });
                        }
                    }
                    let non_empty_rows: usize = if valid_ids.is_empty() {
                        0
                    } else {
                        let mut p = SqlParams::new();
                        let p_col = p.bind_str(meta.id.clone());
                        let list = p.bind_list_str(&valid_ids);
                        conn.query_row(
                            &format!(
                                "SELECT COUNT(DISTINCT cm.entity_uuid)
                                 FROM cell_multi_options cm
                                 JOIN entities e ON e.uuid = cm.entity_uuid AND e.is_row = 1
                                 WHERE cm.col_id = {p_col} AND cm.option_id IN ({list})"
                            ),
                            params_from_iter(p.values.iter()),
                            |r| r.get::<_, i64>(0),
                        )
                        .map_err(|e| format!("统计 multi_select 非空行失败: {e}"))?
                            as usize
                    };
                    empty_count = total_rows.saturating_sub(non_empty_rows);
                }
                "formula" => {
                    let mut stmt = conn
                        .prepare(
                            "SELECT fc.kind, fc.display_text, fc.val_date_ms, fc.val_json
                             FROM formula_cache fc
                             JOIN entities e ON e.uuid = fc.entity_uuid AND e.is_row = 1
                             WHERE fc.col_id = ?1 AND fc.kind != 'empty'",
                        )
                        .map_err(|e| format!("查询 formula 分桶失败: {e}"))?;
                    let rows = stmt
                        .query_map([&meta.id], |r| {
                            Ok((
                                r.get::<_, String>(0)?,
                                r.get::<_, String>(1)?,
                                r.get::<_, Option<i64>>(2)?,
                                r.get::<_, Option<String>>(3)?,
                            ))
                        })
                        .map_err(|e| format!("读取 formula 分桶失败: {e}"))?;
                    let mut bucket_map: HashMap<String, usize> = HashMap::new();
                    let mut non_empty = 0usize;
                    for r in rows {
                        let (kind, display_text, val_date_ms, val_json) =
                            r.map_err(|e| format!("解析 formula 分桶失败: {e}"))?;
                        let mut row_tokens: Vec<String> = Vec::new();
                        if kind == "date" {
                            if let Some(ms) = val_date_ms {
                                if ms > 0 {
                                    if let Ok(day) = conn.query_row(
                                        "SELECT strftime('%Y-%m-%d', ?1 / 1000, 'unixepoch', 'localtime')",
                                        [ms],
                                        |rr| rr.get::<_, String>(0),
                                    ) {
                                        if !day.is_empty() {
                                            row_tokens.push(day);
                                        }
                                    }
                                }
                            }
                        } else if kind == "list" {
                            if let Some(raw_json) = val_json {
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw_json)
                                {
                                    if let Some(arr) =
                                        v.get("listItems").and_then(|x| x.as_array())
                                    {
                                        for item in arr {
                                            if let Some(s) = item.as_str() {
                                                let t = s.trim();
                                                if !t.is_empty() {
                                                    row_tokens.push(t.to_string());
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        } else {
                            let t = display_text.trim();
                            if !t.is_empty() {
                                row_tokens.push(t.to_string());
                            }
                        }
                        if !row_tokens.is_empty() {
                            non_empty += 1;
                            let mut seen_in_row = HashSet::new();
                            for tok in row_tokens {
                                if seen_in_row.insert(tok.clone()) {
                                    *bucket_map.entry(tok).or_insert(0) += 1;
                                }
                            }
                        }
                    }
                    empty_count = total_rows.saturating_sub(non_empty);
                    for (k, cnt) in bucket_map {
                        buckets.push(ColumnFilterBucketRecord {
                            key: k.clone(),
                            label: k,
                            count: cnt,
                            color: None,
                        });
                    }
                    if !buckets.is_empty()
                        && buckets
                            .iter()
                            .all(|b| !b.key.is_empty() && b.key.parse::<f64>().is_ok())
                    {
                        buckets.sort_by(|a, b| {
                            a.key
                                .parse::<f64>()
                                .unwrap_or(0.0)
                                .total_cmp(&b.key.parse::<f64>().unwrap_or(0.0))
                        });
                    } else if !buckets.is_empty()
                        && buckets.iter().all(|b| parse_date_key(&b.key).is_some())
                    {
                        buckets.sort_by(|a, b| b.key.cmp(&a.key));
                    } else {
                        buckets.sort_by(|a, b| natural_cmp(&a.label, &b.label));
                    }
                }
                _ => {
                    let mut stmt = conn
                        .prepare(
                            "SELECT TRIM(COALESCE(cv.val_text, '')) AS k, COUNT(*)
                             FROM cell_values cv
                             JOIN entities e ON e.uuid = cv.entity_uuid AND e.is_row = 1
                             WHERE cv.col_id = ?1 AND TRIM(COALESCE(cv.val_text, '')) != ''
                             GROUP BY k",
                        )
                        .map_err(|e| format!("查询 text 分桶失败: {e}"))?;
                    let rows = stmt
                        .query_map([&meta.id], |r| {
                            Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                        })
                        .map_err(|e| format!("读取 text 分桶失败: {e}"))?;
                    let mut non_empty = 0usize;
                    for r in rows {
                        let (k, cnt) = r.map_err(|e| format!("解析 text 分桶失败: {e}"))?;
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

    let search_q = query.search.as_deref().unwrap_or("").trim().to_lowercase();
    if !search_q.is_empty() {
        buckets.retain(|b| b.label.to_lowercase().contains(&search_q));
    }

    let total_buckets = buckets.len();
    let limit = query.limit.clamp(1, 5000);
    if buckets.len() > limit {
        buckets.truncate(limit);
    }

    Ok(TableFilterBucketsResult {
        buckets,
        empty_count,
        total_buckets,
    })
}

pub(crate) fn format_js_number(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        n.to_string()
    }
}

/// 3. 关系列候选按需检索（`outer`/`inner` 内置递归 CTE 排除后代/祖先防循环嵌套）。
pub fn query_relation_candidates(
    conn: &Connection,
    query: &TableRelationCandidatesQuery,
) -> Result<TableRelationCandidatesResult, String> {
    let search = query.search.as_deref().unwrap_or("").trim().to_lowercase();
    let limit = query.limit.clamp(1, 500);
    let fetch_limit = (limit + 1) as i64;

    let (count_sql, list_sql) = match query.relation_kind.as_str() {
        "outer" => (
            "WITH RECURSIVE descendants(uuid) AS (
                SELECT ?1
                UNION ALL
                SELECT e.uuid FROM entities e JOIN descendants d ON e.parent_section_uuid = d.uuid
             )
             SELECT COUNT(*)
             FROM entities e
             WHERE e.is_row = 1
               AND e.kind IN ('text', 'section')
               AND e.uuid NOT IN (SELECT uuid FROM descendants)
               AND (?2 = '' OR INSTR(lower(e.text), ?2) > 0)",
            "WITH RECURSIVE descendants(uuid) AS (
                SELECT ?1
                UNION ALL
                SELECT e.uuid FROM entities e JOIN descendants d ON e.parent_section_uuid = d.uuid
             )
             SELECT e.uuid, e.kind, e.text, e.props_json
             FROM entities e
             WHERE e.is_row = 1
               AND e.kind IN ('text', 'section')
               AND e.uuid NOT IN (SELECT uuid FROM descendants)
               AND (?2 = '' OR INSTR(lower(e.text), ?2) > 0)
             ORDER BY e.sort_order ASC, e.rowid ASC
             LIMIT ?3",
        ),
        "inner" => (
            "WITH RECURSIVE ancestors(uuid) AS (
                SELECT ?1
                UNION ALL
                SELECT e.parent_section_uuid FROM entities e JOIN ancestors a ON e.uuid = a.uuid
                WHERE e.parent_section_uuid IS NOT NULL
             )
             SELECT COUNT(*)
             FROM entities e
             WHERE e.is_row = 1
               AND e.uuid NOT IN (SELECT uuid FROM ancestors)
               AND (?2 = '' OR INSTR(lower(e.text), ?2) > 0)",
            "WITH RECURSIVE ancestors(uuid) AS (
                SELECT ?1
                UNION ALL
                SELECT e.parent_section_uuid FROM entities e JOIN ancestors a ON e.uuid = a.uuid
                WHERE e.parent_section_uuid IS NOT NULL
             )
             SELECT e.uuid, e.kind, e.text, e.props_json
             FROM entities e
             WHERE e.is_row = 1
               AND e.uuid NOT IN (SELECT uuid FROM ancestors)
               AND (?2 = '' OR INSTR(lower(e.text), ?2) > 0)
             ORDER BY e.sort_order ASC, e.rowid ASC
             LIMIT ?3",
        ),
        "parents" | "children" => (
            "SELECT COUNT(*)
             FROM entities e
             WHERE e.is_row = 1
               AND e.uuid != ?1
               AND (?2 = '' OR INSTR(lower(e.text), ?2) > 0)",
            "SELECT e.uuid, e.kind, e.text, e.props_json
             FROM entities e
             WHERE e.is_row = 1
               AND e.uuid != ?1
               AND (?2 = '' OR INSTR(lower(e.text), ?2) > 0)
             ORDER BY e.sort_order ASC, e.rowid ASC
             LIMIT ?3",
        ),
        other => {
            return Err(format!("不支持的关系类型: {other}"));
        }
    };

    let total_count: usize = conn
        .query_row(count_sql, rusqlite::params![&query.row_uuid, &search], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| format!("查询关系候选总数失败: {e}"))? as usize;

    let mut stmt = conn
        .prepare(list_sql)
        .map_err(|e| format!("准备关系候选查询失败: {e}"))?;
    let rows = stmt
        .query_map(
            rusqlite::params![&query.row_uuid, &search, fetch_limit],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .map_err(|e| format!("执行关系候选查询失败: {e}"))?;

    let mut candidates = Vec::new();
    for r in rows {
        let (uuid, kind, text, props_json) =
            r.map_err(|e| format!("解析关系候选失败: {e}"))?;
        let label = resolve_primary_text_from_row(&kind, &text, &props_json);
        candidates.push(V3RelationItemRecord { uuid, label, kind });
    }

    let has_more = candidates.len() > limit;
    if has_more {
        candidates.truncate(limit);
    }

    Ok(TableGroupCandidatesHelper {
        candidates,
        total_count,
        has_more,
    }
    .into_result())
}

struct TableGroupCandidatesHelper {
    candidates: Vec<V3RelationItemRecord>,
    total_count: usize,
    has_more: bool,
}

impl TableGroupCandidatesHelper {
    fn into_result(self) -> TableRelationCandidatesResult {
        TableRelationCandidatesResult {
            candidates: self.candidates,
            total_count: self.total_count,
            has_more: self.has_more,
        }
    }
}

/// 4. 分组计数聚合（供看板分组计数、间隔重复 `待复习/未到期/已归档/全部` 计数）。
pub fn query_group_counts(
    conn: &Connection,
    query: &TableGroupCountsQuery,
) -> Result<TableGroupCountsResult, String> {
    let col_map = load_column_meta_map(conn)?;
    let today_key = resolve_today_key(conn, query.today_key.as_deref());

    let mut base_params = SqlParams::new();
    let where_sql = build_where_clause(
        &query.filters,
        query.filter_group.as_ref(),
        None,
        &col_map,
        &today_key,
        &mut base_params,
    );

    let total_count: usize = conn
        .query_row(
            &format!("SELECT COUNT(*) FROM entities e WHERE {where_sql}"),
            params_from_iter(base_params.values.iter()),
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| format!("统计分组总数失败: {e}"))? as usize;

    if query.group_by_column_id == "outer" {
        // 先列出所有 section 实体（保持空分组框也可见）
        let mut section_order: Vec<(String, String)> = Vec::new();
        {
            let mut stmt = conn
                .prepare(
                    "SELECT uuid, text, props_json FROM entities WHERE is_row = 1 AND kind = 'section' ORDER BY sort_order ASC, rowid ASC",
                )
                .map_err(|e| format!("查询分组框列表失败: {e}"))?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                    ))
                })
                .map_err(|e| format!("读取分组框列表失败: {e}"))?;
            for r in rows {
                let (uuid, text, props) = r.map_err(|e| format!("解析分组框失败: {e}"))?;
                let label = resolve_primary_text_from_row("section", &text, &props);
                section_order.push((uuid, label));
            }
        }

        let mut counts_by_outer: HashMap<String, usize> = HashMap::new();
        {
            let sql = format!(
                "SELECT oe.uuid, COUNT(*)
                 FROM entities e
                 JOIN entities oe ON oe.uuid = e.parent_section_uuid AND oe.is_row = 1
                 WHERE {where_sql}
                 GROUP BY oe.uuid"
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("聚合 outer 分组计数失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(base_params.values.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                })
                .map_err(|e| format!("读取 outer 分组计数失败: {e}"))?;
            for r in rows {
                let (k, cnt) = r.map_err(|e| format!("解析 outer 分组计数失败: {e}"))?;
                counts_by_outer.insert(k, cnt);
            }
        }

        let mut grouped_sum = 0usize;
        let mut groups = Vec::new();
        for (uuid, label) in section_order {
            let cnt = counts_by_outer.remove(&uuid).unwrap_or(0);
            grouped_sum += cnt;
            groups.push(TableGroupCountItem {
                key: uuid,
                label,
                count: cnt,
                color: None,
            });
        }
        // 兼容非 section 的极端情况
        for (uuid, cnt) in counts_by_outer {
            grouped_sum += cnt;
            groups.push(TableGroupCountItem {
                label: uuid.clone(),
                key: uuid,
                count: cnt,
                color: None,
            });
        }
        return Ok(TableGroupCountsResult {
            total_count,
            ungrouped_count: total_count.saturating_sub(grouped_sum),
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

    match meta.col_type.as_str() {
        "select" => {
            let mut q_params = SqlParams::new();
            let q_where = build_where_clause(
                &query.filters,
                query.filter_group.as_ref(),
                None,
                &col_map,
                &today_key,
                &mut q_params,
            );
            let p_col = q_params.bind_str(meta.id.clone());
            let sql = format!(
                "SELECT cv.val_text, COUNT(*)
                 FROM entities e
                 JOIN cell_values cv ON cv.entity_uuid = e.uuid AND cv.col_id = {p_col}
                 WHERE {q_where} AND cv.val_text IS NOT NULL
                 GROUP BY cv.val_text"
            );
            let mut counts: HashMap<String, usize> = HashMap::new();
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("聚合 select 分组计数失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(q_params.values.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                })
                .map_err(|e| format!("读取 select 分组计数失败: {e}"))?;
            for r in rows {
                let (k, cnt) = r.map_err(|e| format!("解析 select 分组计数失败: {e}"))?;
                counts.insert(k, cnt);
            }

            let mut grouped_sum = 0usize;
            let mut groups = Vec::with_capacity(meta.options.len());
            for opt in &meta.options {
                let cnt = counts.get(&opt.id).copied().unwrap_or(0);
                grouped_sum += cnt;
                groups.push(TableGroupCountItem {
                    key: opt.id.clone(),
                    label: opt.name.clone(),
                    count: cnt,
                    color: opt.color.clone(),
                });
            }
            Ok(TableGroupCountsResult {
                total_count,
                ungrouped_count: total_count.saturating_sub(grouped_sum),
                groups,
            })
        }
        "formula" => {
            let mut q_params = SqlParams::new();
            let q_where = build_where_clause(
                &query.filters,
                query.filter_group.as_ref(),
                None,
                &col_map,
                &today_key,
                &mut q_params,
            );
            let p_col = q_params.bind_str(meta.id.clone());
            let sql = format!(
                "SELECT TRIM(fc.display_text) AS k, COUNT(*)
                 FROM entities e
                 JOIN formula_cache fc ON fc.entity_uuid = e.uuid AND fc.col_id = {p_col}
                 WHERE {q_where} AND fc.kind != 'empty' AND TRIM(fc.display_text) != ''
                 GROUP BY k"
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("聚合 formula 分组计数失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(q_params.values.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                })
                .map_err(|e| format!("读取 formula 分组计数失败: {e}"))?;
            let mut grouped_sum = 0usize;
            let mut groups = Vec::new();
            for r in rows {
                let (k, cnt) = r.map_err(|e| format!("解析 formula 分组计数失败: {e}"))?;
                grouped_sum += cnt;
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
                ungrouped_count: total_count.saturating_sub(grouped_sum),
                groups,
            })
        }
        _ => {
            let mut q_params = SqlParams::new();
            let q_where = build_where_clause(
                &query.filters,
                query.filter_group.as_ref(),
                None,
                &col_map,
                &today_key,
                &mut q_params,
            );
            let p_col = q_params.bind_str(meta.id.clone());
            let sql = format!(
                "SELECT TRIM(COALESCE(cv.val_text, '')) AS k, COUNT(*)
                 FROM entities e
                 JOIN cell_values cv ON cv.entity_uuid = e.uuid AND cv.col_id = {p_col}
                 WHERE {q_where} AND TRIM(COALESCE(cv.val_text, '')) != ''
                 GROUP BY k"
            );
            let mut stmt = conn
                .prepare(&sql)
                .map_err(|e| format!("聚合 text 分组计数失败: {e}"))?;
            let rows = stmt
                .query_map(params_from_iter(q_params.values.iter()), |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as usize))
                })
                .map_err(|e| format!("读取 text 分组计数失败: {e}"))?;
            let mut grouped_sum = 0usize;
            let mut groups = Vec::new();
            for r in rows {
                let (k, cnt) = r.map_err(|e| format!("解析 text 分组计数失败: {e}"))?;
                grouped_sum += cnt;
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
                ungrouped_count: total_count.saturating_sub(grouped_sum),
                groups,
            })
        }
    }
}

/// 5. 按日期区间查询可视窗口内的记录（供日历 / 甘特视图按需加载）。
pub fn query_date_range(
    conn: &Connection,
    query: &TableDateRangeQuery,
) -> Result<TableDateRangeResult, String> {
    let col_map = load_column_meta_map(conn)?;
    let today_key = resolve_today_key(conn, query.today_key.as_deref());

    let start_meta = col_map.get(&query.start_column_id);
    let end_col_id = query.end_column_id.as_deref().filter(|s| !s.is_empty());
    let end_meta = end_col_id.and_then(|id| col_map.get(id));

    let mut params = SqlParams::new();
    let base_where = build_where_clause(
        &query.filters,
        query.filter_group.as_ref(),
        None,
        &col_map,
        &today_key,
        &mut params,
    );

    let start_expr = build_row_date_key_expr(&query.start_column_id, start_meta, &mut params)
        .unwrap_or_else(|| "NULL".to_string());
    let end_expr = end_col_id
        .and_then(|id| build_row_date_key_expr(id, end_meta, &mut params))
        .unwrap_or_else(|| "NULL".to_string());

    let order_by = build_order_by_clause(query.sort.as_ref(), &col_map, &mut params);

    // 扫描筛选后的行日期键与排序位置（纯标量读取，不拉取大字段/关系，5000 行 < 2ms）
    let scan_sql = format!(
        "SELECT e.uuid, e.kind, e.parent_section_uuid, e.text, e.props_json, e.created_at, e.updated_at, e.sort_order,
                {start_expr} AS s_key,
                {end_expr} AS e_key
         FROM entities e
         WHERE {base_where}
         ORDER BY {order_by}"
    );

    let mut in_range_raw: Vec<RawEntityRow> = Vec::new();
    let mut undated_raw: Vec<RawEntityRow> = Vec::new();
    let mut undated_count = 0usize;
    let mut total_filtered_count = 0usize;
    let undated_cap = query.undated_limit.clamp(0, 2000);

    {
        let mut stmt = conn
            .prepare(&scan_sql)
            .map_err(|e| format!("准备日期区间查询失败: {e}"))?;
        let rows = stmt
            .query_map(params_from_iter(params.values.iter()), |row| {
                Ok((
                    RawEntityRow {
                        uuid: row.get(0)?,
                        kind: row.get(1)?,
                        parent_section_uuid: row.get(2)?,
                        text: row.get(3)?,
                        props_json: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                        sort_order: row.get(7)?,
                    },
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                ))
            })
            .map_err(|e| format!("执行日期区间查询失败: {e}"))?;

        for item in rows {
            let (raw, s_opt, e_opt) = item.map_err(|e| format!("解析日期区间行失败: {e}"))?;
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
                    if s <= e {
                        (s, e)
                    } else {
                        (e, s)
                    }
                }
            };
            if eff_start.as_str() <= query.max_date.as_str()
                && eff_end.as_str() >= query.min_date.as_str()
            {
                in_range_raw.push(raw);
            }
        }
    }

    let rows = hydrate_page_rows(conn, &query.doc_id, in_range_raw)?;
    let undated_rows = hydrate_page_rows(conn, &query.doc_id, undated_raw)?;

    Ok(TableDateRangeResult {
        rows,
        undated_count,
        undated_rows,
        total_filtered_count,
    })
}

/// 6. 文档内全文检索（优先 FTS5，同步覆盖 CJK 子串、UrlNode URL 与连线文本，零漏检且毫秒级）。
pub fn search_doc_fts(
    conn: &Connection,
    query: &DocSearchFtsQuery,
) -> Result<Vec<DocSearchFtsHit>, String> {
    let trimmed = query.query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let limit = query.limit.clamp(1, 2000);
    let lower_q = trimmed.to_lowercase();

    let mut seen_uuids: HashSet<String> = HashSet::new();
    let mut hits: Vec<DocSearchFtsHit> = Vec::new();

    // 阶段 1：利用 FTS5 倒排索引极速召回（安全转义所有双引号）
    let tokens: Vec<String> = trimmed
        .split_whitespace()
        .filter(|t| !t.is_empty())
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect();
    if !tokens.is_empty() {
        let match_expr = tokens.join(" AND ");
        if let Ok(mut stmt) = conn.prepare(
            "SELECT e.uuid, e.text, e.details_plain
             FROM entities_fts f
             JOIN entities e ON e.uuid = f.uuid
             WHERE entities_fts MATCH ?1
             ORDER BY bm25(entities_fts) ASC, e.sort_order ASC
             LIMIT ?2",
        ) {
            if let Ok(rows) = stmt.query_map(rusqlite::params![&match_expr, limit as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            }) {
                for r in rows.flatten() {
                    if seen_uuids.insert(r.0.clone()) {
                        hits.push(DocSearchFtsHit {
                            uuid: r.0,
                            object_kind: "entity".to_string(),
                            text: r.1,
                            details_plain: r.2,
                        });
                    }
                }
            }
        }
    }

    // 阶段 2：补充 CJK 无空格子串 / UrlNode URL / 符号字面量匹配，确保与 ContentSearch 零漏检一致
    if hits.len() < limit {
        let remaining = (limit - hits.len()) as i64;
        let mut stmt = conn
            .prepare(
                "SELECT uuid, text, details_plain
                 FROM entities
                 WHERE INSTR(lower(text), ?1) > 0
                    OR INSTR(lower(details_plain), ?1) > 0
                    OR (kind = 'url' AND INSTR(lower(COALESCE(json_extract(props_json, '$.url'), '')), ?1) > 0)
                 ORDER BY sort_order ASC, rowid ASC
                 LIMIT ?2",
            )
            .map_err(|e| format!("查询实体子串匹配失败: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![&lower_q, remaining + hits.len() as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| format!("读取实体子串匹配失败: {e}"))?;
        for r in rows {
            let (uuid, text, details_plain) =
                r.map_err(|e| format!("解析实体子串匹配失败: {e}"))?;
            if hits.len() >= limit {
                break;
            }
            if seen_uuids.insert(uuid.clone()) {
                hits.push(DocSearchFtsHit {
                    uuid,
                    object_kind: "entity".to_string(),
                    text,
                    details_plain,
                });
            }
        }
    }

    // 阶段 3：连线文本命中
    if hits.len() < limit {
        let remaining = (limit - hits.len()) as i64;
        let mut stmt = conn
            .prepare(
                "SELECT uuid, text FROM edges
                 WHERE text != '' AND INSTR(lower(text), ?1) > 0
                 ORDER BY sort_order ASC, rowid ASC
                 LIMIT ?2",
            )
            .map_err(|e| format!("查询连线文本失败: {e}"))?;
        let rows = stmt
            .query_map(rusqlite::params![&lower_q, remaining], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })
            .map_err(|e| format!("读取连线文本失败: {e}"))?;
        for r in rows {
            let (uuid, text) = r.map_err(|e| format!("解析连线文本失败: {e}"))?;
            if hits.len() >= limit {
                break;
            }
            if seen_uuids.insert(uuid.clone()) {
                hits.push(DocSearchFtsHit {
                    uuid,
                    object_kind: "edge".to_string(),
                    text,
                    details_plain: String::new(),
                });
            }
        }
    }

    Ok(hits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sqlite_engine::commands::{
        execute_commands_in_tx, DocCommand, FormulaCacheEntry,
    };
    use crate::sqlite_engine::document_actor::{
        V3EdgeRecord, V3EntityRecord, V3MultiOptionEntry, V3TableColumnRecord,
    };
    use crate::sqlite_engine::schema::initialize_v3_schema;
    use std::time::Instant;

    fn make_entity(
        uuid: &str,
        kind: &str,
        text: &str,
        parent: Option<&str>,
        sort_order: i64,
    ) -> V3EntityRecord {
        V3EntityRecord {
            uuid: uuid.to_string(),
            kind: kind.to_string(),
            parent_section_uuid: parent.map(|s| s.to_string()),
            text: text.to_string(),
            details_json: "[]".to_string(),
            details_plain: format!("详情 {text}"),
            x: 0.0,
            y: 0.0,
            w: 100.0,
            h: 50.0,
            props_json: "{}".to_string(),
            created_at: 1_700_000_000_000 + sort_order * 86_400_000,
            updated_at: 1_700_000_000_000 + sort_order * 86_400_000,
            is_row: kind != "image" && kind != "connect_point" && kind != "pen_stroke",
            sort_order,
        }
    }

    fn setup_sample_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        initialize_v3_schema(&conn).unwrap();

        let tx = conn.unchecked_transaction().unwrap();
        let cmds = vec![
            DocCommand::UpsertColumn {
                column: V3TableColumnRecord {
                    id: "col_score".to_string(),
                    canonical_key: "auto:number:score".to_string(),
                    name: "分数".to_string(),
                    r#type: "number".to_string(),
                    position: 0,
                    config_json: "{}".to_string(),
                },
            },
            DocCommand::UpsertColumn {
                column: V3TableColumnRecord {
                    id: "col_status".to_string(),
                    canonical_key: "auto:select:status".to_string(),
                    name: "状态".to_string(),
                    r#type: "select".to_string(),
                    position: 1,
                    config_json: r#"{"options":[{"id":"opt_todo","name":"待办","color":"gray"},{"id":"opt_done","name":"完成","color":"green"}]}"#.to_string(),
                },
            },
            DocCommand::UpsertColumn {
                column: V3TableColumnRecord {
                    id: "col_tags".to_string(),
                    canonical_key: "auto:multi_select:tags".to_string(),
                    name: "标签".to_string(),
                    r#type: "multi_select".to_string(),
                    position: 2,
                    config_json: r#"{"options":[{"id":"opt_a","name":"物理","color":"blue"},{"id":"opt_b","name":"数学","color":"purple"}]}"#.to_string(),
                },
            },
            DocCommand::UpsertColumn {
                column: V3TableColumnRecord {
                    id: "col_due".to_string(),
                    canonical_key: "auto:date:due".to_string(),
                    name: "截止日".to_string(),
                    r#type: "date".to_string(),
                    position: 3,
                    config_json: "{}".to_string(),
                },
            },
            DocCommand::UpsertColumn {
                column: V3TableColumnRecord {
                    id: "col_sr_due_status".to_string(),
                    canonical_key: "role:sr:dueStatus".to_string(),
                    name: "是否到期".to_string(),
                    r#type: "formula".to_string(),
                    position: 4,
                    config_json: r#"{"protectedRole":"dueStatus"}"#.to_string(),
                },
            },
            DocCommand::CreateEntities {
                entities: vec![
                    make_entity("sec_root", "section", "章节 10", None, 0),
                    make_entity("sec_sub", "section", "章节 2", Some("sec_root"), 1),
                    make_entity("n1", "text", "节点 1", Some("sec_sub"), 2),
                    make_entity("n2", "text", "节点 10", Some("sec_root"), 3),
                    make_entity("n3", "text", "节点 2", None, 4),
                    V3EntityRecord {
                        props_json: r#"{"attachmentId":"att-1","isBackground":false}"#.to_string(),
                        ..make_entity("img_1", "image", "", Some("sec_root"), 5)
                    },
                ],
                section_child_orders: vec![],
                section_bounds: vec![],
            },
            DocCommand::CreateEdges {
                edges: vec![V3EdgeRecord {
                    uuid: "e1".to_string(),
                    kind: "line".to_string(),
                    source_uuid: "n1".to_string(),
                    target_uuid: "n2".to_string(),
                    text: "推导关系".to_string(),
                    props_json: "{}".to_string(),
                    sort_order: 0,
                }],
            },
            DocCommand::UpdateCells {
                updates: vec![
                    crate::sqlite_engine::commands::CellMutationItem {
                        entity_uuid: "n1".to_string(),
                        col_id: "col_score".to_string(),
                        value: Some(V3CellValueRecord {
                            entity_uuid: "n1".to_string(),
                            col_id: "col_score".to_string(),
                            canonical_key: "auto:number:score".to_string(),
                            val_type: "number".to_string(),
                            val_text: Some("95".to_string()),
                            val_num: Some(95.0),
                            val_date: None,
                            val_json: None,
                            multi_options: vec![],
                        }),
                    },
                    crate::sqlite_engine::commands::CellMutationItem {
                        entity_uuid: "n2".to_string(),
                        col_id: "col_score".to_string(),
                        value: Some(V3CellValueRecord {
                            entity_uuid: "n2".to_string(),
                            col_id: "col_score".to_string(),
                            canonical_key: "auto:number:score".to_string(),
                            val_type: "number".to_string(),
                            val_text: Some("60".to_string()),
                            val_num: Some(60.0),
                            val_date: None,
                            val_json: None,
                            multi_options: vec![],
                        }),
                    },
                    crate::sqlite_engine::commands::CellMutationItem {
                        entity_uuid: "n1".to_string(),
                        col_id: "col_status".to_string(),
                        value: Some(V3CellValueRecord {
                            entity_uuid: "n1".to_string(),
                            col_id: "col_status".to_string(),
                            canonical_key: "auto:select:status".to_string(),
                            val_type: "select".to_string(),
                            val_text: Some("opt_done".to_string()),
                            val_num: None,
                            val_date: None,
                            val_json: None,
                            multi_options: vec![],
                        }),
                    },
                    crate::sqlite_engine::commands::CellMutationItem {
                        entity_uuid: "n1".to_string(),
                        col_id: "col_tags".to_string(),
                        value: Some(V3CellValueRecord {
                            entity_uuid: "n1".to_string(),
                            col_id: "col_tags".to_string(),
                            canonical_key: "auto:multi_select:tags".to_string(),
                            val_type: "multi_select".to_string(),
                            val_text: Some("物理,数学".to_string()),
                            val_num: None,
                            val_date: None,
                            val_json: Some(r#"["opt_a","opt_b"]"#.to_string()),
                            multi_options: vec![
                                V3MultiOptionEntry {
                                    option_id: "opt_a".to_string(),
                                    option_name: "物理".to_string(),
                                },
                                V3MultiOptionEntry {
                                    option_id: "opt_b".to_string(),
                                    option_name: "数学".to_string(),
                                },
                            ],
                        }),
                    },
                    crate::sqlite_engine::commands::CellMutationItem {
                        entity_uuid: "n1".to_string(),
                        col_id: "col_due".to_string(),
                        value: Some(V3CellValueRecord {
                            entity_uuid: "n1".to_string(),
                            col_id: "col_due".to_string(),
                            canonical_key: "auto:date:due".to_string(),
                            val_type: "date".to_string(),
                            val_text: Some("2026-11-28".to_string()),
                            val_num: None,
                            val_date: Some("2026-11-28".to_string()),
                            val_json: None,
                            multi_options: vec![],
                        }),
                    },
                    crate::sqlite_engine::commands::CellMutationItem {
                        entity_uuid: "n2".to_string(),
                        col_id: "col_due".to_string(),
                        value: Some(V3CellValueRecord {
                            entity_uuid: "n2".to_string(),
                            col_id: "col_due".to_string(),
                            canonical_key: "auto:date:due".to_string(),
                            val_type: "date".to_string(),
                            val_text: Some("2026-12-05".to_string()),
                            val_num: None,
                            val_date: Some("2026-12-05".to_string()),
                            val_json: None,
                            multi_options: vec![],
                        }),
                    },
                ],
                touch_updated_at: false,
            },
            DocCommand::UpdateFormulaCacheBatch {
                entries: vec![
                    FormulaCacheEntry {
                        entity_uuid: "n1".to_string(),
                        col_id: "col_sr_due_status".to_string(),
                        canonical_key: "role:sr:dueStatus".to_string(),
                        kind: "string".to_string(),
                        display_text: "待复习".to_string(),
                        val_num: None,
                        val_date_ms: None,
                        val_json: None,
                        is_volatile: true,
                        computed_day: Some("2026-11-28".to_string()),
                    },
                    FormulaCacheEntry {
                        entity_uuid: "n2".to_string(),
                        col_id: "col_sr_due_status".to_string(),
                        canonical_key: "role:sr:dueStatus".to_string(),
                        kind: "string".to_string(),
                        display_text: "未到期".to_string(),
                        val_num: None,
                        val_date_ms: None,
                        val_json: None,
                        is_volatile: true,
                        computed_day: Some("2026-11-28".to_string()),
                    },
                    FormulaCacheEntry {
                        entity_uuid: "n3".to_string(),
                        col_id: "col_sr_due_status".to_string(),
                        canonical_key: "role:sr:dueStatus".to_string(),
                        kind: "string".to_string(),
                        display_text: "已归档".to_string(),
                        val_num: None,
                        val_date_ms: None,
                        val_json: None,
                        is_volatile: true,
                        computed_day: Some("2026-11-28".to_string()),
                    },
                ],
            },
        ];
        execute_commands_in_tx(&tx, "doc1", "test.prg", 1, 0, &cmds, "seed", false, None, None, "main")
            .unwrap();
        tx.commit().unwrap();
        conn
    }

    #[test]
    fn sorts_naturally_and_hydrates_relations_images_and_formulas() {
        let conn = setup_sample_db();
        let res = query_table_page(
            &conn,
            &TablePageQuery {
                doc_id: "doc1".to_string(),
                offset: 0,
                limit: 10,
                filters: vec![],
                filter_group: None,
                sort: Some(TableSortInput {
                    column_id: "name".to_string(),
                    direction: "asc".to_string(),
                }),
                today_key: Some("2026-11-28".to_string()),
                extra_group_filter: None,
            },
        )
        .unwrap();

        assert_eq!(res.unfiltered_total_count, 5);
        assert_eq!(res.total_count, 5);
        let names: Vec<&str> = res.rows.iter().map(|r| r.primary_text.as_str()).collect();
        // 自然排序：章节 2 < 章节 10；节点 1 < 节点 2 < 节点 10
        assert_eq!(names, vec!["章节 2", "章节 10", "节点 1", "节点 2", "节点 10"]);

        let sec_root = res.rows.iter().find(|r| r.uuid == "sec_root").unwrap();
        assert_eq!(sec_root.images.len(), 1);
        assert_eq!(sec_root.images[0].attachment_id, "att-1");
        assert_eq!(sec_root.inner.len(), 2);

        let n1 = res.rows.iter().find(|r| r.uuid == "n1").unwrap();
        assert_eq!(n1.children.len(), 1);
        assert_eq!(n1.children[0].uuid, "n2");
        assert_eq!(n1.outer.as_ref().unwrap().uuid, "sec_sub");
        assert_eq!(
            n1.formula_values.get("col_sr_due_status").unwrap().display_text,
            "待复习"
        );
    }

    #[test]
    fn filters_by_date_preset_multi_select_and_group_counts() {
        let conn = setup_sample_db();
        // 1. 日期预设 today 命中 n1 (2026-11-28)
        let res_today = query_table_page(
            &conn,
            &TablePageQuery {
                doc_id: "doc1".to_string(),
                offset: 0,
                limit: 10,
                filters: vec![],
                filter_group: Some(TableFilterGroupInput {
                    conjunction: "and".to_string(),
                    conditions: vec![TableFilterConditionInput {
                        id: "c1".to_string(),
                        column_id: "col_due".to_string(),
                        operator: "eq".to_string(),
                        value: None,
                        values: None,
                        date_preset: Some("today".to_string()),
                    }],
                }),
                sort: None,
                today_key: Some("2026-11-28".to_string()),
                extra_group_filter: None,
            },
        )
        .unwrap();
        assert_eq!(res_today.total_count, 1);
        assert_eq!(res_today.rows[0].uuid, "n1");

        // 2. 多选精确匹配 eq(["opt_a", "opt_b"]) 仅命中 n1，而 eq(["opt_a"]) 不命中
        let res_exact = query_table_page(
            &conn,
            &TablePageQuery {
                doc_id: "doc1".to_string(),
                offset: 0,
                limit: 10,
                filters: vec![],
                filter_group: Some(TableFilterGroupInput {
                    conjunction: "and".to_string(),
                    conditions: vec![TableFilterConditionInput {
                        id: "c2".to_string(),
                        column_id: "col_tags".to_string(),
                        operator: "eq".to_string(),
                        value: None,
                        values: Some(vec!["opt_a".to_string(), "opt_b".to_string()]),
                        date_preset: None,
                    }],
                }),
                sort: None,
                today_key: Some("2026-11-28".to_string()),
                extra_group_filter: None,
            },
        )
        .unwrap();
        assert_eq!(res_exact.total_count, 1);
        assert_eq!(res_exact.rows[0].uuid, "n1");

        // 3. 分组计数（间隔重复 formula_cache）
        let sr_counts = query_group_counts(
            &conn,
            &TableGroupCountsQuery {
                doc_id: "doc1".to_string(),
                group_by_column_id: "col_sr_due_status".to_string(),
                filters: vec![],
                filter_group: None,
                today_key: Some("2026-11-28".to_string()),
            },
        )
        .unwrap();
        assert_eq!(sr_counts.total_count, 5);
        assert_eq!(
            sr_counts.groups.iter().find(|g| g.key == "待复习").unwrap().count,
            1
        );
        assert_eq!(
            sr_counts.groups.iter().find(|g| g.key == "未到期").unwrap().count,
            1
        );
        assert_eq!(
            sr_counts.groups.iter().find(|g| g.key == "已归档").unwrap().count,
            1
        );

        // 4. 筛选分桶
        let buckets = query_filter_buckets(
            &conn,
            &TableFilterBucketsQuery {
                doc_id: "doc1".to_string(),
                column_id: "col_status".to_string(),
                search: None,
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(buckets.buckets.len(), 1);
        assert_eq!(buckets.buckets[0].key, "opt_done");
        assert_eq!(buckets.empty_count, 4);
    }

    #[test]
    fn relation_candidates_prevent_cycles_with_recursive_cte() {
        let conn = setup_sample_db();
        // sec_root 的后代为 sec_sub, n1, n2，因此 sec_root 选 outer 时不能选自己或 sec_sub / n1 / n2，只能选 n3
        let outer_cands = query_relation_candidates(
            &conn,
            &TableRelationCandidatesQuery {
                doc_id: "doc1".to_string(),
                row_uuid: "sec_root".to_string(),
                relation_kind: "outer".to_string(),
                search: None,
                limit: 50,
            },
        )
        .unwrap();
        let ids: Vec<&str> = outer_cands.candidates.iter().map(|c| c.uuid.as_str()).collect();
        assert_eq!(ids, vec!["n3"]);

        // n1 的祖先是 sec_sub, sec_root，因此 n1 选 inner 时必须排除自身、sec_sub、sec_root
        let inner_cands = query_relation_candidates(
            &conn,
            &TableRelationCandidatesQuery {
                doc_id: "doc1".to_string(),
                row_uuid: "n1".to_string(),
                relation_kind: "inner".to_string(),
                search: None,
                limit: 50,
            },
        )
        .unwrap();
        let inner_ids: Vec<&str> = inner_cands.candidates.iter().map(|c| c.uuid.as_str()).collect();
        assert_eq!(inner_ids, vec!["n2", "n3"]);
    }

    #[test]
    fn date_range_and_fts_search_work_accurately() {
        let conn = setup_sample_db();
        let range = query_date_range(
            &conn,
            &TableDateRangeQuery {
                doc_id: "doc1".to_string(),
                start_column_id: "col_due".to_string(),
                end_column_id: None,
                min_date: "2026-11-01".to_string(),
                max_date: "2026-11-30".to_string(),
                filters: vec![],
                filter_group: None,
                sort: None,
                today_key: Some("2026-11-28".to_string()),
                include_undated: true,
                undated_limit: 50,
            },
        )
        .unwrap();
        assert_eq!(range.rows.len(), 1);
        assert_eq!(range.rows[0].uuid, "n1");
        assert_eq!(range.undated_count, 3);
        assert_eq!(range.undated_rows.len(), 3);

        // CJK 子串与连线文本搜索均能命中
        let hits_cjk = search_doc_fts(
            &conn,
            &DocSearchFtsQuery {
                doc_id: "doc1".to_string(),
                query: "推导".to_string(),
                limit: 50,
            },
        )
        .unwrap();
        assert_eq!(hits_cjk.len(), 1);
        assert_eq!(hits_cjk[0].uuid, "e1");
        assert_eq!(hits_cjk[0].object_kind, "edge");

        let hits_node = search_doc_fts(
            &conn,
            &DocSearchFtsQuery {
                doc_id: "doc1".to_string(),
                query: "章节 10".to_string(),
                limit: 50,
            },
        )
        .unwrap();
        assert!(hits_node.iter().any(|h| h.uuid == "sec_root"));
    }

    #[test]
    fn queries_5000_rows_with_relations_and_formulas_in_milliseconds() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_v3_schema(&conn).unwrap();

        let tx = conn.unchecked_transaction().unwrap();
        tx.execute(
            "INSERT INTO table_columns (id, canonical_key, name, type, position, config_json)
             VALUES ('col_sr_due', 'role:sr:dueStatus', '是否到期', 'formula', 0, '{\"protectedRole\":\"dueStatus\"}')",
            [],
        )
        .unwrap();
        {
            let mut ent = tx
                .prepare(
                    "INSERT INTO entities (uuid, kind, parent_section_uuid, text, details_json, details_plain, x, y, w, h, props_json, created_at, updated_at, is_row, sort_order)
                     VALUES (?1, 'text', NULL, ?2, '[]', '', 0, 0, 100, 50, '{}', 1700000000000, 1700000000000, 1, ?3)",
                )
                .unwrap();
            let mut edge = tx
                .prepare(
                    "INSERT INTO edges (uuid, kind, source_uuid, target_uuid, text, props_json, sort_order)
                     VALUES (?1, 'line', ?2, ?3, '', '{}', ?4)",
                )
                .unwrap();
            let mut fc = tx
                .prepare(
                    "INSERT INTO formula_cache (entity_uuid, col_id, canonical_key, kind, display_text, is_volatile, computed_day)
                     VALUES (?1, 'col_sr_due', 'role:sr:dueStatus', 'string', ?2, 1, '2026-11-28')",
                )
                .unwrap();
            for i in 0..5000i64 {
                let id = format!("row-{i}");
                ent.execute(rusqlite::params![&id, format!("知识点 {i}"), i])
                    .unwrap();
                if i > 0 {
                    edge.execute(rusqlite::params![
                        format!("edge-{i}"),
                        format!("row-{}", i - 1),
                        &id,
                        i
                    ])
                    .unwrap();
                }
                let status = if i % 3 == 0 {
                    "待复习"
                } else if i % 3 == 1 {
                    "未到期"
                } else {
                    "已归档"
                };
                fc.execute(rusqlite::params![&id, status]).unwrap();
            }
        }
        tx.commit().unwrap();

        let t0 = Instant::now();
        let page = query_table_page(
            &conn,
            &TablePageQuery {
                doc_id: "bench".to_string(),
                offset: 0,
                limit: 100,
                filters: vec![],
                filter_group: None,
                sort: Some(TableSortInput {
                    column_id: "name".to_string(),
                    direction: "asc".to_string(),
                }),
                today_key: Some("2026-11-28".to_string()),
                extra_group_filter: None,
            },
        )
        .unwrap();
        let elapsed_ms = t0.elapsed().as_millis();
        assert_eq!(page.total_count, 5000);
        assert_eq!(page.rows.len(), 100);
        assert_eq!(page.rows[0].primary_text, "知识点 0");
        assert_eq!(page.rows[1].primary_text, "知识点 1");
        assert_eq!(page.rows[2].primary_text, "知识点 2");
        assert!(
            elapsed_ms < 250,
            "5000 行自然排序分页查询耗时过高: {elapsed_ms}ms"
        );

        let t1 = Instant::now();
        let counts = query_group_counts(
            &conn,
            &TableGroupCountsQuery {
                doc_id: "bench".to_string(),
                group_by_column_id: "col_sr_due".to_string(),
                filters: vec![],
                filter_group: None,
                today_key: Some("2026-11-28".to_string()),
            },
        )
        .unwrap();
        let count_ms = t1.elapsed().as_millis();
        assert_eq!(counts.total_count, 5000);
        assert!(count_ms < 100, "5000 行分组聚合耗时过高: {count_ms}ms");
    }
}
