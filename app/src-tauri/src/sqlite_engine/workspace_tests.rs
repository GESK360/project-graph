use crate::sqlite_engine::document_actor::DocumentActorPool;
use crate::sqlite_engine::media_protocol::handle_flux_media_request_with_workspace;
use crate::sqlite_engine::schema;
use crate::sqlite_engine::table_query::{
    TableFilterConditionInput, TableFilterGroupInput, TableSortInput,
};
use crate::sqlite_engine::workspace_engine::{WorkspaceEngine, WorkspaceScope};
use crate::sqlite_engine::workspace_query::{
    query_workspace_date_range, query_workspace_group_counts, query_workspace_table_page,
    search_workspace_fts, WorkspaceSearchFtsQuery, WorkspaceTableDateRangeQuery,
    WorkspaceTableGroupCountsQuery, WorkspaceTablePageQuery,
};
use rusqlite::{params, Connection};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

struct TempDirGuard {
    path: PathBuf,
}

impl TempDirGuard {
    fn new(prefix: &str) -> Self {
        let dir = std::env::temp_dir().join(format!("fg_m4_{}_{}", prefix, uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("create temp test dir");
        Self { path: dir }
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

fn create_v3_prg_file(
    path: &Path,
    doc_id: &str,
    build: impl FnOnce(&Connection),
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create parent dir: {e}"))?;
    }
    let conn = Connection::open(path).map_err(|e| format!("open sqlite: {e}"))?;
    schema::initialize_v3_schema(&conn)?;
    conn.execute_batch("PRAGMA synchronous = OFF;")
        .map_err(|e| format!("pragma sync off: {e}"))?;

    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('docId', ?1)",
        params![doc_id],
    )
    .map_err(|e| format!("insert doc_id: {e}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('format_version', '3.0.0')",
        [],
    )
    .map_err(|e| format!("insert format_version: {e}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('schema_version', '3')",
        [],
    )
    .map_err(|e| format!("insert schema_version: {e}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('revision', '1')",
        [],
    )
    .map_err(|e| format!("insert revision: {e}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('tags_json', '[]')",
        [],
    )
    .map_err(|e| format!("insert tags: {e}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('references_json', '{\"sections\":{},\"files\":[]}')",
        [],
    )
    .map_err(|e| format!("insert refs: {e}"))?;
    conn.execute(
        "INSERT OR REPLACE INTO metadata (key, value) VALUES ('table_meta_json', '{}')",
        [],
    )
    .map_err(|e| format!("insert table_meta: {e}"))?;

    build(&conn);
    let _ = schema::wal_checkpoint_truncate(&conn);
    Ok(())
}

#[test]
fn m4_workspace_100_files_10k_rows_benchmark_and_cross_file_sr_writeback() {
    let tmp = TempDirGuard::new("bench_10k");
    let folders = ["alpha", "beta", "gamma", "delta", "epsilon"];
    let statuses = [
        ("opt_todo", "待办", "blue"),
        ("opt_doing", "进行中", "amber"),
        ("opt_done", "完成", "green"),
    ];
    let status_cfg = serde_json::json!({
        "canonicalKey": "ws:status-shared",
        "options": [
            { "id": "opt_todo", "name": "待办", "color": "blue" },
            { "id": "opt_doing", "name": "进行中", "color": "amber" },
            { "id": "opt_done", "name": "完成", "color": "green" }
        ]
    })
    .to_string();

    let today_key: String = {
        let mem = Connection::open_in_memory().unwrap();
        mem.query_row("SELECT strftime('%Y-%m-%d', 'now', 'localtime')", [], |r| r.get(0))
            .unwrap()
    };

    let mut file_paths: Vec<PathBuf> = Vec::with_capacity(100);
    let mut doc_ids: Vec<String> = Vec::with_capacity(100);

    for file_idx in 0..100usize {
        let folder = folders[file_idx % folders.len()];
        let doc_id = format!("doc-{file_idx:03}");
        let file_path = tmp.path.join(folder).join(format!("canvas_{file_idx:03}.prg"));
        let has_sr_cols = file_idx < 50;
        let today_ref = today_key.as_str();

        create_v3_prg_file(&file_path, &doc_id, |conn| {
            let tx = conn.unchecked_transaction().expect("begin fixture tx");

            // 共享状态列 + 同名截止日期列
            tx.execute(
                "INSERT INTO table_columns (id, canonical_key, name, type, position, config_json)
                 VALUES ('col_status', 'ws:status-shared', '状态', 'select', 0, ?1)",
                params![&status_cfg],
            )
            .unwrap();
            tx.execute(
                "INSERT INTO table_columns (id, canonical_key, name, type, position, config_json)
                 VALUES ('col_due', 'auto:截止日期', '截止日期', 'date', 1, '{}')",
                [],
            )
            .unwrap();

            if has_sr_cols {
                tx.execute(
                    "INSERT INTO table_columns (id, canonical_key, name, type, position, config_json)
                     VALUES ('col_sr_correct', 'role:sr:correctCount', '答对次数', 'number', 2, '{\"systemRole\":\"sr_correct_count\"}')",
                    [],
                )
                .unwrap();
                tx.execute(
                    "INSERT INTO table_columns (id, canonical_key, name, type, position, config_json)
                     VALUES ('col_sr_answer', 'role:sr:answerDate', '作答日期', 'date', 3, '{\"systemRole\":\"sr_answer_date\"}')",
                    [],
                )
                .unwrap();
                tx.execute(
                    "INSERT INTO table_columns (id, canonical_key, name, type, position, config_json)
                     VALUES ('col_sr_due', 'role:sr:dueStatus', '是否到期', 'formula', 4, '{\"systemRole\":\"sr_due_status\"}')",
                    [],
                )
                .unwrap();
            }

            {
                let mut ent_stmt = tx
                    .prepare(
                        "INSERT INTO entities
                         (uuid, kind, parent_section_uuid, text, details_json, details_plain,
                          x, y, w, h, props_json, created_at, updated_at, is_row, sort_order)
                         VALUES (?1, 'text', NULL, ?2, '[]', ?3, ?4, ?5, 160, 60, '{}', ?6, ?7, 1, ?8)",
                    )
                    .unwrap();
                let mut cell_stmt = tx
                    .prepare(
                        "INSERT INTO cell_values
                         (entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL)",
                    )
                    .unwrap();
                let mut fc_stmt = tx
                    .prepare(
                        "INSERT INTO formula_cache
                         (entity_uuid, col_id, canonical_key, kind, display_text, val_num, val_date_ms, val_json, is_volatile, computed_day)
                         VALUES (?1, 'col_sr_due', 'role:sr:dueStatus', 'string', ?2, NULL, NULL, NULL, 1, ?3)",
                    )
                    .unwrap();

                for row_idx in 0..100usize {
                    let row_uuid = format!("row-{file_idx:03}-{row_idx:03}");
                    let title = if file_idx == 42 && row_idx == 7 {
                        "量子计算核心定理 QuantumTheorem".to_string()
                    } else {
                        format!("卡片 {file_idx:03}-{row_idx:03}")
                    };
                    let details = if file_idx == 42 && row_idx == 7 {
                        "跨文件全文检索命中测试详情".to_string()
                    } else {
                        String::new()
                    };
                    let ts = 1_700_000_000_000i64 + (file_idx * 1000 + row_idx) as i64;
                    ent_stmt
                        .execute(params![
                            &row_uuid,
                            &title,
                            &details,
                            (row_idx % 10) as f64 * 200.0,
                            (row_idx / 10) as f64 * 120.0,
                            ts,
                            ts,
                            row_idx as i64
                        ])
                        .unwrap();

                    let (opt_id, _opt_name, _) = statuses[(file_idx + row_idx) % statuses.len()];
                    cell_stmt
                        .execute(params![
                            &row_uuid,
                            "col_status",
                            "ws:status-shared",
                            "select",
                            opt_id,
                            Option::<f64>::None,
                            Option::<String>::None
                        ])
                        .unwrap();

                    // 均匀分布到全年 12 个月，更贴近真实工作空间日历/甘特视图分布
                    let month = (row_idx % 12) + 1;
                    let day = ((row_idx * 7 + file_idx) % 28) + 1;
                    let date_key = format!("2026-{month:02}-{day:02}");
                    cell_stmt
                        .execute(params![
                            &row_uuid,
                            "col_due",
                            "auto:截止日期",
                            "date",
                            Option::<String>::None,
                            Option::<f64>::None,
                            &date_key
                        ])
                        .unwrap();

                    if has_sr_cols {
                        // 偶数行待复习，奇数行今天已答对 3 次（间隔 7 天 -> 未到期）
                        let due_label = if row_idx % 2 == 0 {
                            "待复习"
                        } else {
                            cell_stmt
                                .execute(params![
                                    &row_uuid,
                                    "col_sr_correct",
                                    "role:sr:correctCount",
                                    "number",
                                    Option::<String>::None,
                                    Some(3.0f64),
                                    Option::<String>::None
                                ])
                                .unwrap();
                            cell_stmt
                                .execute(params![
                                    &row_uuid,
                                    "col_sr_answer",
                                    "role:sr:answerDate",
                                    "date",
                                    Option::<String>::None,
                                    Option::<f64>::None,
                                    today_ref
                                ])
                                .unwrap();
                            "未到期"
                        };
                        fc_stmt.execute(params![&row_uuid, due_label, today_ref]).unwrap();
                    }
                }
            }
            tx.commit().expect("commit fixture tx");
        })
        .expect("create fixture prg");

        file_paths.push(file_path);
        doc_ids.push(doc_id);
    }

    let pool = Arc::new(DocumentActorPool::new(16));
    let ws = WorkspaceEngine::new(pool.clone());

    let t_open = Instant::now();
    let open_res = ws.open_workspace(&tmp.path).expect("open_workspace");
    let open_ms = t_open.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(open_res.docs.len(), 100);
    assert_eq!(open_res.sync_stats.indexed_docs, 100);

    // 1. 增量 stat 扫描（无改动应全跳过）
    let t_inc = Instant::now();
    let inc_stats = ws.sync_incremental(0).expect("sync_incremental");
    let inc_ms = t_inc.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(inc_stats.total_docs, 100);
    assert_eq!(inc_stats.indexed_docs, 0);
    assert_eq!(inc_stats.skipped_docs, 100);

    // 解析出共享状态列中 "待办" 的工作空间 option id
    let ws_cols = ws.list_columns().expect("list_columns");
    let status_col = ws_cols
        .iter()
        .find(|c| c.canonical_key == "ws:status-shared")
        .expect("ws:status-shared column exists");
    assert!(status_col.is_shared);
    assert_eq!(status_col.doc_count, 100);
    let status_cfg_val: serde_json::Value = serde_json::from_str(&status_col.config_json).unwrap();
    let todo_opt_id = status_cfg_val["options"]
        .as_array()
        .unwrap()
        .iter()
        .find(|o| o["name"].as_str() == Some("待办"))
        .and_then(|o| o["id"].as_str())
        .expect("待办 option id")
        .to_string();

    // 2. 跨文件多条件筛选 + 排序
    let t_filter = Instant::now();
    let filter_res = ws
        .with_index_conn(|conn, _root| {
            query_workspace_table_page(
                conn,
                &WorkspaceTablePageQuery {
                    scope: WorkspaceScope {
                        kind: "all".to_string(),
                        paths: Vec::new(),
                    },
                    offset: 0,
                    limit: 50,
                    filters: Vec::new(),
                    filter_group: Some(TableFilterGroupInput {
                        conjunction: "and".to_string(),
                        conditions: vec![
                            TableFilterConditionInput {
                                id: "c1".to_string(),
                                column_id: "ws:status-shared".to_string(),
                                operator: "eq".to_string(),
                                value: None,
                                values: Some(vec![todo_opt_id.clone()]),
                                date_preset: None,
                            },
                            TableFilterConditionInput {
                                id: "c2".to_string(),
                                column_id: "sourceFolder".to_string(),
                                operator: "eq".to_string(),
                                value: Some("alpha".to_string()),
                                values: None,
                                date_preset: None,
                            },
                        ],
                    }),
                    sort: Some(TableSortInput {
                        column_id: "updatedAt".to_string(),
                        direction: "desc".to_string(),
                    }),
                    today_key: Some("2026-06-15".to_string()),
                    extra_group_filter: None,
                },
            )
        })
        .expect("query_workspace_table_page filter");
    let filter_ms = t_filter.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(filter_res.unfiltered_total_count, 10_000);
    assert!(filter_res.total_count > 600 && filter_res.total_count < 700);
    assert_eq!(filter_res.rows.len(), 50);
    assert_eq!(filter_res.rows[0].source_folder.as_deref(), Some("alpha"));

    // 3. 看板跨文件分组计数
    let t_group = Instant::now();
    let group_res = ws
        .with_index_conn(|conn, _root| {
            query_workspace_group_counts(
                conn,
                &WorkspaceTableGroupCountsQuery {
                    scope: WorkspaceScope::default(),
                    group_by_column_id: "ws:status-shared".to_string(),
                    filters: Vec::new(),
                    filter_group: None,
                    today_key: Some("2026-06-15".to_string()),
                },
            )
        })
        .expect("query_workspace_group_counts");
    let group_ms = t_group.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(group_res.total_count, 10_000);
    let sum_groups: usize = group_res.groups.iter().map(|g| g.count).sum();
    assert_eq!(sum_groups, 10_000);

    // 按 sourceFolder 分组验证
    let folder_group_res = ws
        .with_index_conn(|conn, _root| {
            query_workspace_group_counts(
                conn,
                &WorkspaceTableGroupCountsQuery {
                    scope: WorkspaceScope::default(),
                    group_by_column_id: "sourceFolder".to_string(),
                    filters: Vec::new(),
                    filter_group: None,
                    today_key: Some("2026-06-15".to_string()),
                },
            )
        })
        .expect("query_workspace_group_counts sourceFolder");
    assert_eq!(folder_group_res.groups.len(), 5);
    assert!(folder_group_res.groups.iter().all(|g| g.count == 2_000));

    // 4. 日历/甘特日期区间查询（6 月 1 周可视窗，约 200 张卡片）
    let t_date = Instant::now();
    let date_res = ws
        .with_index_conn(|conn, _root| {
            query_workspace_date_range(
                conn,
                &WorkspaceTableDateRangeQuery {
                    scope: WorkspaceScope::default(),
                    start_column_id: "auto:截止日期".to_string(),
                    end_column_id: None,
                    min_date: "2026-06-01".to_string(),
                    max_date: "2026-06-07".to_string(),
                    filters: Vec::new(),
                    filter_group: None,
                    sort: None,
                    today_key: Some("2026-06-15".to_string()),
                    include_undated: false,
                    undated_limit: 50,
                },
            )
        })
        .expect("query_workspace_date_range");
    let date_ms = t_date.elapsed().as_secs_f64() * 1000.0;
    assert!(date_res.rows.len() > 150 && date_res.rows.len() < 300);
    assert_eq!(date_res.undated_count, 0);

    // 5. 全局间隔重复待复习队列（50 文件各 50 待复习 + 50 未初始化 SR 列文件共 5,000 行默认待复习 = 7,500）
    let t_sr_q = Instant::now();
    let sr_res = ws
        .with_index_conn(|conn, _root| {
            query_workspace_table_page(
                conn,
                &WorkspaceTablePageQuery {
                    scope: WorkspaceScope::default(),
                    offset: 0,
                    limit: 50,
                    filters: Vec::new(),
                    filter_group: Some(TableFilterGroupInput {
                        conjunction: "and".to_string(),
                        conditions: vec![TableFilterConditionInput {
                            id: "sr1".to_string(),
                            column_id: "role:sr:dueStatus".to_string(),
                            operator: "eq".to_string(),
                            value: Some("待复习".to_string()),
                            values: None,
                            date_preset: None,
                        }],
                    }),
                    sort: None,
                    today_key: Some("2026-06-15".to_string()),
                    extra_group_filter: None,
                },
            )
        })
        .expect("query global SR due queue");
    let sr_q_ms = t_sr_q.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(sr_res.total_count, 7_500);

    // 6. 全局 FTS5 全文检索（英文 + 中文）
    let t_fts = Instant::now();
    let fts_en = ws
        .with_index_conn(|conn, _root| {
            search_workspace_fts(
                conn,
                &WorkspaceSearchFtsQuery {
                    query: "QuantumTheorem".to_string(),
                    scope: None,
                    limit: 20,
                },
            )
        })
        .expect("search_workspace_fts en");
    let fts_zh = ws
        .with_index_conn(|conn, _root| {
            search_workspace_fts(
                conn,
                &WorkspaceSearchFtsQuery {
                    query: "量子计算".to_string(),
                    scope: None,
                    limit: 20,
                },
            )
        })
        .expect("search_workspace_fts zh");
    let fts_ms = t_fts.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(fts_en.len(), 1);
    assert_eq!(fts_en[0].uuid, "row-042-007");
    assert_eq!(fts_zh.len(), 1);
    assert_eq!(fts_zh[0].uuid, "row-042-007");

    // 7. 跨文件间隔重复刷卡回写 —— 未打开文件（file #99 首次自动补齐 SR 列 + file #49 稳态未打开文件）
    let closed_doc_id = &doc_ids[99];
    let closed_row_uuid = "row-099-000";
    let before_updated_at: i64 = {
        let conn = schema::open_readonly(&file_paths[99]).unwrap();
        conn.query_row(
            "SELECT updated_at FROM entities WHERE uuid = ?1",
            params![closed_row_uuid],
            |r| r.get(0),
        )
        .unwrap()
    };

    let t_sr_closed_init = Instant::now();
    let closed_sr_res = ws
        .answer_spaced_repetition(
            closed_doc_id,
            closed_row_uuid,
            "correct_closed",
            Some(&today_key),
            None,
            "test-win",
        )
        .expect("answer_spaced_repetition closed doc (first-time SR init)");
    let sr_closed_init_ms = t_sr_closed_init.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(closed_sr_res.changeset.doc_id, *closed_doc_id);

    // 稳态未打开文件回写（file #99 第二张卡，SR 列已就绪，走 O(1) 单行索引快路径）
    let t_sr_closed = Instant::now();
    ws.answer_spaced_repetition(
        closed_doc_id,
        "row-099-002",
        "correct_closed",
        Some(&today_key),
        None,
        "test-win",
    )
    .expect("answer_spaced_repetition closed doc steady");
    let sr_closed_ms = t_sr_closed.elapsed().as_secs_f64() * 1000.0;

    // 验证源 .prg 磁盘上的 updated_at 未被污染且 dueStatus 已落盘为 "未到期"
    {
        let conn = schema::open_readonly(&file_paths[99]).unwrap();
        let after_updated_at: i64 = conn
            .query_row(
                "SELECT updated_at FROM entities WHERE uuid = ?1",
                params![closed_row_uuid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(after_updated_at, before_updated_at);
        let due_status: String = conn
            .query_row(
                "SELECT display_text FROM formula_cache WHERE entity_uuid = ?1 AND canonical_key = 'role:sr:dueStatus'",
                params![closed_row_uuid],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(due_status, "未到期");
    }

    // 8. 跨文件间隔重复刷卡回写 —— 已打开文件（file #0：首次补全全部 11 SR 列，第二张卡测稳态热同步）
    let _open_actor = pool
        .open_document(&file_paths[0])
        .expect("open file #0 in active pool");
    let _ = ws
        .answer_spaced_repetition(
            &doc_ids[0],
            "row-000-000",
            "correct_open",
            Some(&today_key),
            None,
            "test-win",
        )
        .expect("answer_spaced_repetition open doc warmup");
    let t_sr_open = Instant::now();
    let open_sr_res = ws
        .answer_spaced_repetition(
            &doc_ids[0],
            "row-000-002",
            "correct_open",
            Some(&today_key),
            None,
            "test-win",
        )
        .expect("answer_spaced_repetition open doc");
    let sr_open_ms = t_sr_open.elapsed().as_secs_f64() * 1000.0;
    assert_eq!(open_sr_res.changeset.doc_id, doc_ids[0]);

    // 确认 index.sqlite 待复习总数从 7,500 精准降为 7,496（4 张卡已答对）
    let sr_after = ws
        .with_index_conn(|conn, _root| {
            query_workspace_table_page(
                conn,
                &WorkspaceTablePageQuery {
                    scope: WorkspaceScope::default(),
                    offset: 0,
                    limit: 10,
                    filters: Vec::new(),
                    filter_group: Some(TableFilterGroupInput {
                        conjunction: "and".to_string(),
                        conditions: vec![TableFilterConditionInput {
                            id: "sr2".to_string(),
                            column_id: "role:sr:dueStatus".to_string(),
                            operator: "eq".to_string(),
                            value: Some("待复习".to_string()),
                            values: None,
                            date_preset: None,
                        }],
                    }),
                    sort: None,
                    today_key: Some("2026-06-15".to_string()),
                    extra_group_filter: None,
                },
            )
        })
        .expect("query global SR after writeback");
    assert_eq!(sr_after.total_count, 7_496);

    println!(
        "[M4 Benchmark 100 files / 10,000 rows] cold_open={open_ms:.2}ms | inc_stat_sync={inc_ms:.2}ms | multi_filter={filter_ms:.2}ms | kanban_group={group_ms:.2}ms | date_range={date_ms:.2}ms | global_sr_queue={sr_q_ms:.2}ms | fts_en+zh={fts_ms:.2}ms | sr_write_closed_init={sr_closed_init_ms:.2}ms | sr_write_closed={sr_closed_ms:.2}ms | sr_write_open={sr_open_ms:.2}ms"
    );
}

#[test]
fn m4_workspace_file_ops_cross_doc_ref_repair_copy_reissue_and_delete() {
    let tmp = TempDirGuard::new("file_ops");
    let target_path = tmp.path.join("target.prg");
    let referrer_path = tmp.path.join("referrer.prg");

    create_v3_prg_file(&target_path, "doc-target", |conn| {
        conn.execute(
            "INSERT INTO entities
             (uuid, kind, parent_section_uuid, text, details_json, details_plain,
              x, y, w, h, props_json, created_at, updated_at, is_row, sort_order)
             VALUES ('sec-1', 'section', NULL, '章节A', '[]', '', 0, 0, 300, 200, '{}', 1000, 1000, 1, 0)",
            [],
        )
        .unwrap();
    })
    .unwrap();

    create_v3_prg_file(&referrer_path, "doc-referrer", |conn| {
        conn.execute(
            "INSERT INTO entities
             (uuid, kind, parent_section_uuid, text, details_json, details_plain,
              x, y, w, h, props_json, created_at, updated_at, is_row, sort_order)
             VALUES ('ref-1', 'reference', NULL, '引用块', '[]', '', 0, 0, 200, 80,
                     '{\"fileName\":\"target\",\"sectionName\":\"章节A\"}', 1000, 1000, 1, 0)",
            [],
        )
        .unwrap();
    })
    .unwrap();

    let pool = Arc::new(DocumentActorPool::new(16));
    let ws = WorkspaceEngine::new(pool.clone());
    ws.open_workspace(&tmp.path).expect("open_workspace");

    // 1. 验证初始反向引用
    let backlinks = ws.list_backlinks("doc-target").expect("list_backlinks");
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].source_doc_id, "doc-referrer");
    assert_eq!(backlinks[0].source_uuid, "ref-1");
    assert_eq!(backlinks[0].target_section_name, "章节A");

    // 2. 重命名并移动 target.prg -> sub/renamed.prg，验证 rel_path 更新与 ReferenceBlockNode 断链修复
    let renamed_path = tmp.path.join("sub").join("renamed.prg");
    fs::create_dir_all(renamed_path.parent().unwrap()).unwrap();
    fs::rename(&target_path, &renamed_path).unwrap();

    let rename_res = ws
        .notify_path_renamed(&target_path, &renamed_path, false, "test-win")
        .expect("notify_path_renamed");
    assert_eq!(rename_res.updated_docs, 1);
    assert_eq!(rename_res.updated_ref_docs.len(), 1);

    let docs = ws.list_docs().expect("list_docs after rename");
    assert_eq!(docs.len(), 2);
    let renamed_doc = docs.iter().find(|d| d.doc_id == "doc-target").unwrap();
    assert_eq!(renamed_doc.rel_path, "sub/renamed.prg");
    assert_eq!(renamed_doc.folder_path, "sub");
    assert_eq!(renamed_doc.title, "renamed");

    // 检查 referrer.prg 磁盘上的 ReferenceBlockNode.fileName 已自动修复为 "renamed"
    {
        let conn = schema::open_readonly(&referrer_path).unwrap();
        let props_json: String = conn
            .query_row(
                "SELECT props_json FROM entities WHERE uuid = 'ref-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let props: serde_json::Value = serde_json::from_str(&props_json).unwrap();
        assert_eq!(props["fileName"].as_str(), Some("renamed"));
        assert_eq!(props["sectionName"].as_str(), Some("章节A"));
    }

    // 3. 跨文件修改 Section 名称 "章节A" -> "章节B"，验证 ReferenceBlockNode.sectionName 自动联动
    ws.update_row_text("doc-target", "sec-1", "章节B", "test-win")
        .expect("update_row_text section rename");
    {
        let conn = schema::open_readonly(&referrer_path).unwrap();
        let props_json: String = conn
            .query_row(
                "SELECT props_json FROM entities WHERE uuid = 'ref-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let props: serde_json::Value = serde_json::from_str(&props_json).unwrap();
        assert_eq!(props["sectionName"].as_str(), Some("章节B"));
    }

    // 4. 复制文件并重签 doc_id，确保不与原文件冲突
    let copy_path = tmp.path.join("copy.prg");
    fs::copy(&renamed_path, &copy_path).unwrap();
    let reissued = ws
        .reissue_copied_doc_ids(&copy_path, false)
        .expect("reissue_copied_doc_ids");
    assert_eq!(reissued.len(), 1);
    assert_ne!(reissued[0], "doc-target");

    let docs_after_copy = ws.list_docs().expect("list_docs after copy");
    assert_eq!(docs_after_copy.len(), 3);

    // 5. 删除副本文件，验证 docs 与 entities 清理干净
    fs::remove_file(&copy_path).unwrap();
    let deleted = ws
        .notify_path_deleted(&copy_path, false)
        .expect("notify_path_deleted");
    assert_eq!(deleted, 1);
    let docs_after_del = ws.list_docs().expect("list_docs after delete");
    assert_eq!(docs_after_del.len(), 2);
}

#[test]
fn m4_closed_prg_flux_media_fallback_and_shared_column_promote_merge() {
    let tmp = TempDirGuard::new("media_and_cols");
    let doc_a = tmp.path.join("a.prg");
    let doc_b = tmp.path.join("b.prg");

    create_v3_prg_file(&doc_a, "doc-a", |conn| {
        conn.execute(
            "INSERT INTO entities
             (uuid, kind, parent_section_uuid, text, details_json, details_plain,
              x, y, w, h, props_json, created_at, updated_at, is_row, sort_order)
             VALUES ('ent-a', 'text', NULL, '节点A', '[]', '', 0, 0, 100, 50, '{}', 1000, 1000, 1, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO table_columns (id, canonical_key, name, type, position, config_json)
             VALUES ('c_tag', 'auto:标签', '标签', 'text', 0, '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cell_values (entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json)
             VALUES ('ent-a', 'c_tag', 'auto:标签', 'text', 'alpha', NULL, NULL, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO attachments (id, mime, width, height, size_bytes, thumb_blob, data_blob)
             VALUES ('att-1', 'image/png', 100, 80, 14, ?1, ?2)",
            params![b"THUMB_BYTES".as_slice(), b"FULL_PNG_BYTES".as_slice()],
        )
        .unwrap();
    })
    .unwrap();

    create_v3_prg_file(&doc_b, "doc-b", |conn| {
        conn.execute(
            "INSERT INTO entities
             (uuid, kind, parent_section_uuid, text, details_json, details_plain,
              x, y, w, h, props_json, created_at, updated_at, is_row, sort_order)
             VALUES ('ent-b', 'text', NULL, '节点B', '[]', '', 0, 0, 100, 50, '{}', 1000, 1000, 1, 0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO table_columns (id, canonical_key, name, type, position, config_json)
             VALUES ('c_cat', 'auto:分类', '分类', 'text', 0, '{}')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO cell_values (entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json)
             VALUES ('ent-b', 'c_cat', 'auto:分类', 'text', 'beta', NULL, NULL, NULL)",
            [],
        )
        .unwrap();
    })
    .unwrap();

    let pool = Arc::new(DocumentActorPool::new(16));
    let ws = Arc::new(WorkspaceEngine::new(pool.clone()));
    ws.open_workspace(&tmp.path).expect("open_workspace");

    // 1. 确保 doc-a 未在活跃连接池打开，测试 flux-media:// 经 WorkspaceEngine 懒加载读取缩略图与原图
    assert!(pool.get_by_doc_id("doc-a").unwrap().is_none());

    let thumb_req = tauri::http::Request::builder()
        .uri("flux-media://doc/doc-a/att-1?thumb=1")
        .body(Vec::new())
        .unwrap();
    let thumb_resp = handle_flux_media_request_with_workspace(&pool, Some(&ws), thumb_req);
    assert_eq!(thumb_resp.status(), tauri::http::StatusCode::OK);
    assert_eq!(thumb_resp.body().as_slice(), b"THUMB_BYTES");

    let full_req = tauri::http::Request::builder()
        .uri("flux-media://doc/doc-a/att-1")
        .body(Vec::new())
        .unwrap();
    let full_resp = handle_flux_media_request_with_workspace(&pool, Some(&ws), full_req);
    assert_eq!(full_resp.status(), tauri::http::StatusCode::OK);
    assert_eq!(full_resp.body().as_slice(), b"FULL_PNG_BYTES");

    // 2. 将 auto:标签 提升为共享字段 ws:<uuid>，再把 auto:分类 合并入该共享字段
    let (promoted, _) = ws
        .promote_column_to_shared("auto:标签", Some("统一标签"), "test-win")
        .expect("promote_column_to_shared");
    assert!(promoted.canonical_key.starts_with("ws:"));
    assert!(promoted.is_shared);
    assert_eq!(promoted.name, "统一标签");

    let (merged, _) = ws
        .merge_columns(&["auto:分类".to_string()], &promoted.canonical_key, "test-win")
        .expect("merge_columns");
    assert_eq!(merged.canonical_key, promoted.canonical_key);
    assert_eq!(merged.doc_count, 2);

    // 验证跨文件查询下两行都能在统一共享列中读到对应值
    let page = ws
        .with_index_conn(|conn, _root| {
            query_workspace_table_page(
                conn,
                &WorkspaceTablePageQuery {
                    scope: WorkspaceScope::default(),
                    offset: 0,
                    limit: 10,
                    filters: Vec::new(),
                    filter_group: None,
                    sort: None,
                    today_key: Some("2026-06-15".to_string()),
                    extra_group_filter: None,
                },
            )
        })
        .expect("query_workspace_table_page after merge");
    assert_eq!(page.total_count, 2);
    let row_a = page.rows.iter().find(|r| r.uuid == "ent-a").unwrap();
    let row_b = page.rows.iter().find(|r| r.uuid == "ent-b").unwrap();
    assert_eq!(
        row_a
            .cell_values
            .iter()
            .find(|c| c.canonical_key == promoted.canonical_key || c.col_id == promoted.canonical_key)
            .and_then(|c| c.val_text.as_deref()),
        Some("alpha")
    );
    assert_eq!(
        row_b
            .cell_values
            .iter()
            .find(|c| c.canonical_key == promoted.canonical_key || c.col_id == promoted.canonical_key)
            .and_then(|c| c.val_text.as_deref()),
        Some("beta")
    );
}

#[test]
fn utf8_cjk_filenames_dir_renames_and_date_keys_never_panic() {
    use crate::sqlite_engine::table_query::parse_date_key;
    use crate::sqlite_engine::workspace_engine::{is_prg_file_name, split_rel_path_meta};

    // 多字节 UTF-8（中文/Emoji）文件名绝不可触发切片非字符边界 panic
    for non_prg in [
        "",
        "a",
        ".prg",
        "中",
        "中文",
        "生图",
        "中文目录",
        "新建文件夹",
        "历史笔记",
        "笔记.md",
        "测试.tmp",
        "😀😀",
    ] {
        assert!(!is_prg_file_name(non_prg), "should not match: {non_prg}");
        let _ = split_rel_path_meta(non_prg);
        let _ = split_rel_path_meta(&format!("中文目录/{non_prg}"));
    }

    for prg in ["a.prg", "中文.prg", "笔记.PRG", "😀.prg"] {
        assert!(is_prg_file_name(prg), "should match: {prg}");
    }
    assert_eq!(
        split_rel_path_meta("中文目录/测试笔记.PRG"),
        ("中文目录".to_string(), "测试笔记".to_string())
    );
    assert_eq!(
        split_rel_path_meta("中文目录/无后缀中文"),
        ("中文目录".to_string(), "无后缀中文".to_string())
    );

    // parse_date_key 遇到含多字节 UTF-8 的非法日期绝不可 panic
    assert_eq!(parse_date_key("2024-01-中"), None);
    assert_eq!(parse_date_key("中-01-02"), None);
    assert_eq!(parse_date_key("2024-中-02"), None);
    assert_eq!(parse_date_key("2024-01-05"), Some((2024, 1, 5)));
    assert_eq!(parse_date_key("2024-01-05T12:00:00Z"), Some((2024, 1, 5)));

    // 真实工作空间含中文目录、非 .prg 中文文件与带通配符中文目录重命名
    let tmp = TempDirGuard::new("utf8_cjk");
    let cjk_dir = tmp.path.join("学习_笔记%1");
    fs::create_dir_all(&cjk_dir).unwrap();
    fs::write(cjk_dir.join("说明.md"), b"hello").unwrap();
    fs::write(cjk_dir.join("历史记录"), b"not prg").unwrap();
    let prg_path = cjk_dir.join("导图一.prg");
    create_v3_prg_file(&prg_path, "doc-cjk-1", |conn| {
        conn.execute(
            "INSERT INTO entities
             (uuid, kind, parent_section_uuid, text, details_json, details_plain,
              x, y, w, h, props_json, created_at, updated_at, is_row, sort_order)
             VALUES ('e-cjk', 'text', NULL, '中文节点', '[]', '', 0, 0, 100, 50, '{}', 1000, 1000, 1, 0)",
            [],
        )
        .unwrap();
    })
    .unwrap();

    let pool = Arc::new(DocumentActorPool::new(8));
    let ws = WorkspaceEngine::new(pool);
    let opened = ws.open_workspace(&tmp.path).expect("open utf8 workspace");
    assert_eq!(opened.docs.len(), 1);
    assert_eq!(opened.docs[0].title, "导图一");

    let renamed_dir = tmp.path.join("归档目录");
    fs::rename(&cjk_dir, &renamed_dir).unwrap();
    let res = ws
        .notify_path_renamed(&cjk_dir, &renamed_dir, true, "win-1")
        .expect("rename cjk dir");
    assert_eq!(res.updated_docs, 1);
    let docs = ws.list_docs().expect("list docs after cjk dir rename");
    assert_eq!(docs[0].rel_path, "归档目录/导图一.prg");
}

