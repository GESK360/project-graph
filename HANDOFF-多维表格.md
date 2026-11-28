# Flux Graph 多维表格与 SQLite v3.0.0 架构 · 会话交接文档（v6.0.0）

> 供后续会话直接接手使用，无需重新探索仓库、数据格式与已落地改动。
> 更新时间：2026-11-28（Asia/Shanghai）· 对应发布版本：`Flux Graph v6.0.0`（tag `flux-v6.0.0`，`.prg` 格式 `3.0.0`）
> 完整重构设计蓝图见根目录 [PLAN-SQLite-v3重构.md](./PLAN-SQLite-v3重构.md)。

---

## 1. 路径与环境基线（必看，严禁混淆目录）

| 用途                   | 路径                                                                         | 说明                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **源码主仓库（Git）**  | `D:\Program Files D\flux graph`                                              | `GESK360/project-graph`（当前基线 `v6.0.0`，`.prg` 格式 `3.0.0` 原生 SQLite），**所有源码读写均在此目录** |
| **本地桌面测试程序**   | `D:\Program Files D\flux graph\app\src-tauri\target\debug\project-graph.exe` | 须用独立标识 `liren.project-graph.dev-test` 编译，配合 `1420` 端口纯前端 Vite 服务使用                    |
| Antigravity 工作区入口 | `d:\Library Files D\antigravity\flux graph`                                  | 仅作工作区指针与存放 `AGENTS.md` / `HANDOFF-多维表格.md` / `PLAN-SQLite-v3重构.md` 副本，**不是源码目录** |
| 用户脑图数据目录       | `D:\Library Files D\flux graph`                                              | 用户个人 `.prg` 文件，**禁止修改**                                                                        |
| 用户日常正式版         | `D:\Program Files D\flux graph user\project-graph.exe`                       | **严禁误杀进程或覆盖**                                                                                    |
| **必读全局技能**       | `C:\Users\admin\.gemini\config\skills\flux-graph-local-test\SKILL.md`        | 动手改代码、启测试软件或发版前**必须先读**                                                                |

---

## 2. v6.0.0 重大改动总览（相对 v5.1.4）

`v6.0.0` 完整落地了 `PLAN-SQLite-v3重构.md` 的全部四个里程碑（M1 → M4），并完成了验收阶段的 **TidyTabs 窗口流畅拖动适配**、**打开页面与大节点图 `< 20ms` 提速**、**新建窗口预热待命池** 与 **多窗口崩溃修复**：

### 2.1 M1：原生 SQLite `.prg v3.0.0` 引擎、`flux-media://` 媒体通道与一键备份升级

- **Rust SQLite 引擎（`app/src-tauri/src/sqlite_engine/`）**：
  - `.prg` 数据格式由 ZIP+MsgPack（`2.8.0`）升级为原生单文件 SQLite（`3.0.0`，启用 `WAL + synchronous=NORMAL + mmap_size=256MB + R-Tree + FTS5 + PRAGMA user_version = 3`）；通过文件头 16 字节魔数自动识别 `v3_sqlite` / `v2_zip` / `unknown`。
  - 新增 `DocumentActor` / `DocumentActorPool`（按规范路径单写者隔离 + 关闭文档 LRU 连接池容量 32 + 临时草稿预热池）与 `backup.rs`（`Ctrl+S` 升级为 WAL Checkpoint + 后台 SQLite Online Backup 在 `.flux-graph/history/` 留存历史快照；普通 v3 文件实时自动落盘，不再弹“未保存关闭阻断弹窗”，草稿 `draft:*` 仍保留另存为保护）。
  - 新增自定义协议 `flux-media://doc/<docId>/<attId>[?thumb=1]`（`media_protocol.rs`），附件写入时在 Rust 后台解码尺寸并生成 256px WebP 缩略图写入 `attachments.thumb_blob`，前端零 Base64 / 零 IPC 大拷贝按需直出；`read_prg_metadata` 同时兼容 v2 ZIP 与 v3 SQLite。
- **一键备份与无损升级**：
  - 新增 `migration.rs`、`V2ToV3Migrator.ts` 与 `UpgradeV3Dialog.tsx`：工作空间含旧版 v2.x `.prg` 时自动提示“一键备份并升级到 v3.0.0”，先完整保留目录结构备份至 `.flux-graph/backup-v2/<timestamp>/`（单文件留存 `.v2.bak`），校验无损后原子替换。

### 2.2 M2：CQRS 增量命令引擎、行级 Undo/Redo、画布热索引与原生多窗口同步

- **增量事务与行级历史**：
  - 新增 `commands.rs` / `undo.rs` / `DocCommandBus.ts` / `V3PatchApplier.ts` / `V3Serializer.ts`：所有画布与表格写操作收敛为强类型 `DocCommand` 批处理（严格区分几何/布局类 `touch_updated_at=false` 与语义类 `touch_updated_at=true`），每次提交在 SQLite 事务内记录最小行级 `history_ops` 并维护 `entities_rtree`、`entities_fts`、`cell_multi_options`。
  - 彻底移除全图 `serialize(project.stage)` 历史栈、`syncSemanticTimestamps()` 全图指纹扫描与 `LocalDocumentSync` Shadow-Doc 全图 Diff；`StageHistoryManager.tsx` 转为委托 `doc_undo` / `doc_redo` 的轻量代理；多窗口改由 Rust 按 `canonical_path` 定向广播百字节级 `pg-doc-changeset` 热补丁实时同步。
- **画布热缓存与显存控制**：
  - `StageManager.tsx` 建立 `byUuid` $O(1)$ Map、分类对象缓存、端点邻接表与 `rbush` 2D R-Tree 空间索引；`EntityRenderer` / `EdgeRenderer` / 框选命中均走 R-Tree 视口裁剪。
  - 新增 `ImageBitmapLruCache.ts`（256 MB 估算显存预算），`ImageNode` 仅在进入视口（含 1 屏缓冲）时按需解码位图，远离视口自动回收，局部 Undo/Redo 不销毁未变动图片。

### 2.3 M3：SQLite 查询下沉、增量公式 DAG 与虚拟化多维表格 UI

- **Rust 参数化 SQL 查询引擎（`table_query.rs`）**：
  - 提供 `table_query_page`（注册自定义 `NATURAL` 自然排序规则）、`table_query_filter_buckets`、`table_query_relation_candidates`（按需查询 + 递归 CTE 防循环嵌套）、`table_query_group_counts`、`table_query_date_range`、`doc_search_fts`。
- **增量公式 DAG（`FormulaDagEngine.ts`）**：
  - AST 按公式文本永久缓存 + 依赖图分析，仅重算受影响 `(rowUuid, formulaColId)` 并批量写回 SQLite `formula_cache`；易变函数 `TODAY()/NOW()` 改为跨午夜与切回前台按需刷新，彻底移除 60s 全表轮询。
- **统一 `TableDataSource` 与全视图虚拟化**：
  - 抽离 `TableDataSource.ts` 统一契约；重写 `stage-table-panel.tsx` 及全部 6 个视图（表格、看板、画廊、甘特、日历、间隔重复），接入 `@tanstack/react-virtual` 虚拟化、单例浮层编辑器 `StageTableCellEditorPortal.tsx`、原子选中态 Store `stage-table-selection-store.ts`、CSS 变量零重渲染列宽拖拽与 `StageTableScrollContainer.tsx`（保留冒泡阶段 `onWheel` 隔离）。

### 2.4 M4：工作空间 `.flux-graph/index.sqlite` 与跨文件多维表格（含全局间隔重复）

- **工作空间索引引擎（`workspace_engine.rs` + `workspace_query.rs`）**：
  - 维护工作空间根 `.flux-graph/index.sqlite`（增量 `stat` 校验 + `notify` 文件监听 + 全库 FTS5 检索 + `cross_doc_refs` 反向引用索引 + `workspace_columns` 共享字段库 + `workspace_views` 持久化跨文件视图）。
  - 实现三层字段对齐（`sys:*` 含所属画布/目录、`role:sr:*` 间隔重复 11 受保护列、`ws:*` 共享列与 `auto:<type>:<norm_name>` 同名同类型归并）及 `WorkspaceColumnsDialog.tsx` 管理面板。
  - 跨文件表内编辑/作答按 `docId` 经 `DocumentActorPool` 原子写回源 `.prg` → 同步 `index.sqlite` → 实时热刷新所有已打开窗口；`WorkspacePageOps.ts` 重命名/移动/复制/删除页面同步维护索引与 `cross_doc_refs`，复制时自动重签发新 `docId`。
- **跨文件 UI 入口与 CLI 适配**：
  - `WorkspaceTableSource.ts` 复用全部 6 个视图：右侧分屏顶栏新增作用域切换（`当前画布` / `当前文件夹` / `整个工作空间`），工作空间侧栏新增全屏 `WorkspaceTableTab.tsx`（含全局多维表格与全局间隔重复入口）及一键跨文件跳回源节点。
  - 新增 `ClosedProjectSqliteV3.ts` 适配 CLI 直接读写 v3.0.0 SQLite `.prg`。

### 2.5 v6.0.0 验收专项优化（TidyTabs 兼容、开页与建窗提速、多窗口稳定性）

- **TidyTabs 窗口拖动丝滑适配（仅改 Flux Graph，保持半透明特性）**：
  - 新增 `app/src-tauri/src/windows_drag_compat.rs`：在 WebView2 创建后安装 `ComCtl32` `SetWindowSubclass`（排在 `wry` 之前，内部使用 `Cell<T>` 避免 Win32 重入别名 UB），合并拖动及 TidyTabs `SetWindowPos`/`MoveWindow` 纯位移（含省略 `SWP_NOSIZE` 但宽高未变）触发的高频 `WM_MOVING` / `WM_MOVE` / `WM_WINDOWPOSCHANGED`，彻底消除逐像素同步跨进程 `ICoreWebView2Controller::NotifyParentWindowPositionChanged()` COM IPC 与 `tauri-plugin-window-state` 锁风暴；仅在 `WM_EXITSIZEMOVE` 或 80ms 静止时补发一次最终位置同步，Resize / 最大化 / 最小化 / 显示隐藏 / DPI 消息全部透传。
  - 新增 `start_window_drag` 命令修复 `tao` 在 Windows 标题栏拖窗时的栈指针 `LPARAM` 打包 Bug；拖动期间通过 `"pg-window-moving"` 事件暂停 `Tab.tsx` 的 Canvas 2D 120 FPS 重绘并在停止移动后立即补画 1 帧；移除 `docked-area.tsx` 不透明按钮上多余的 `backdrop-blur-md`。
- **打开页面与大节点图 `< 20ms` 级提速**：
  - **1-IPC 融合 + Rust 流式紧凑 Wire 直出**：`doc_open_with_ownership` 将所有权申请 + 魔数探测 + SQLite 读取合并为 1 次 IPC，并由 `DocumentActor::write_packed_open_doc_json` 直接借用 `rusqlite::Row` 页内切片流式写入 `tauri::ipc::Response::new(json)`（跳过 `details_plain`、`cell.canonical_key`、空值单元与无索引 `ORDER BY` 临时排序，经字节状态机校验后原生嵌入 `props`/`details`/`config`/`val_json` 消除双重转义）。实测 Debug 构建 2000 节点 + 1999 边 + 100 分组框 + 6000 单元格由 **77.65 ms（1,887 KB）降至 16.28 ms（521 KB）**；500 节点冷开 **6.22 ms** / LRU 温开 **2.45 ms**；50 MB 附件 **2.28 ms**。
  - **前端零 `JSON.parse` 水合与 O(1) 几何热路径**：`V3Serializer.ts` 新增 `hydrateV3PackedOpenResult`；`GlobalMenu.tsx` 消除 `dummyProject` 与二次 `loadAllServicesBeforeInit`，延迟 120ms 弹加载 Toast，最近文件异步写入；`TextNode` / `Section` 复用 SQLite 持久化尺寸，消除水合与 `updateReferences` 两遍 `section.adjustLocationAndSize()` 与 O(S×E) 扫描（`Section.getContentBounds` 改查 `StageManager.getMultiTargetNonLineEdges()`，`_collisionBoxWhenCollapsed` 懒建）；`StageManager` 对 `LineEdge` 直接按端点并集建 R-Tree（免开页构造数千条 `bodyLine` / `SymmetryCurve`），`getBoundingRectangle()` / `getCenter()` / `getSize()` 改用 O(1) R-Tree 根包围盒，`updateReferences` 懒建 `connectableEntities` Map 并用 ASCII 比较替代 `localeCompare`；`Entity.detailsManager` 改为懒加载并共享 `WeakMap`；`LatexNode` 改为视口驱动懒渲染；`Renderer.renderEdges` 在全景缩放 `< 0.15` 时跳过逐边 `ctx.clip("evenodd")`；`Minimap` 改用端点中心连线并按 `stageRevision` 缓存静态层。实测 2000 节点 + 1999 边 + 100 分组框 + 6000 单元格前端水合 + R-Tree 总耗时 **21.02 ms**。
- **新建窗口预热待命池与多窗口 Bug 修复**：
  - `window_manager.rs`、`main.tsx`、`App.tsx` 实现后台隐藏待命窗口池（`visible: false`、`skip_taskbar: true`，对任务栏与 TidyTabs 不可见，渲染循环暂停 0% CPU；最后一个可见窗口关闭时自动销毁待命窗口）与预热临时草稿 SQLite（弹出 **0.01–0.02 ms**）；主启动改为按需懒加载当前语言包、鉴权/扩展扫描后台异步执行、移除 4 个 Manager 启动只读 `store.save()`。
  - 修复副窗口/预热窗口因顶层 IIFE 先于 `const localeLoaders` 执行导致的 `ReferenceError: Cannot access 'localeLoaders' before initialization` 渲染崩溃，并消除预热激活事件与 React `useEffect` 挂载之间的竞态。

---

## 3. 已落地并拍板的产品规则（切勿回退）

1. **行模型**：1 行 = 1 个 `TextNode`/`Section`/`UrlNode`/`LatexNode`/`MediaNode`/`SvgNode`/`ReferenceBlockNode`/`ExtensionEntity`；单独 `ImageNode`、`PenStroke`、`ConnectPoint` 及 `Association` 不计入表格行；最左固定行序号列。
2. **图片双向联动**：框内图片自动进入对应行 `images` 列，支持多图缩略图（`flux-media://...?thumb=1`）、灯箱预览（`GlobalImageLightbox`）、粘贴/上传新增、逐张移除及 `TextNode <-> Section` 同 `uuid` 自动无损升降级。
3. **1-hop 拓扑关系列**：`parents` / `children`（排除自环）、`outer` / `inner`（单父树防循环嵌套）均与画布双向联动并遵守锁定框保护。
4. **语义 `updatedAt` 规则**：仅文本/详情/框内图片/拓扑关系/自定义单元格变动刷新 `updatedAt`；纯位移拖动、自动排版、折叠展开、间隔重复作答及撤销均绝不误刷，且 `Ctrl+Z` 精确回退时间戳。
5. **6 类属性与 6 种视图**：文本/数字/日期/单选/多选/公式（含增量 DAG 缓存）；表格、看板、画廊、甘特、日历、间隔重复（11 受保护列不可删/不可改类型，三级调度基准为 `作答日期`）；跨列字段编组、冻结列、列宽拖拽、自适应列宽、单文件右侧分屏 + 全屏工作空间跨文件表格 Tab 全部保留。

---

## 4. 核心文件地图（v6.0.0）

| 模块                  | 文件路径                                                                                                                                                                                                                                                                                                                                                                                                 | 职责说明                                                                                                                                                   |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rust SQLite 引擎      | `app/src-tauri/src/sqlite_engine/{mod,schema,document_actor,commands,undo,table_query,media_protocol,migration,backup,workspace_engine,workspace_query}.rs`                                                                                                                                                                                                                                              | `.prg` v3.0.0 单文件引擎、流式紧凑直出 `doc_open_with_ownership`、行级 CQRS + Undo、`flux-media://`、备份升级、`.flux-graph/index.sqlite` 跨文件索引与查询 |
| 窗口与 TidyTabs 兼容  | `app/src-tauri/src/windows_drag_compat.rs`、`app/src-tauri/src/window_manager.rs`、`app/src-tauri/src/lib.rs`                                                                                                                                                                                                                                                                                            | Win32 Subclass 拖动消息合并、`start_window_drag`、隐藏预热待命窗口池、多窗口焦点与跨窗广播路由                                                             |
| 前端 SQLite 桥接      | `app/src/core/sqlite/{DocClient,DocCommandBus,V3Serializer,V3PatchApplier,V3AutoPersist,V3CellCodec,V2ToV3Migrator,ImageBitmapLruCache,WorkspaceClient}.ts`                                                                                                                                                                                                                                              | 1-IPC 与紧凑流式零 `JSON.parse` 水合、`O(dirty)` 增量命令总线、跨窗热补丁、视口 LRU 位图缓存、v2→v3 迁移器                                                 |
| 启动与打开链路        | `app/src/main.tsx`、`app/src/App.tsx`、`app/src/core/Project.tsx`、`app/src/core/Tab.tsx`、`app/src/core/service/GlobalMenu.tsx`                                                                                                                                                                                                                                                                         | 预热窗口生命周期、按需语言包、拖动期暂停 120FPS 重绘、1-IPC 秒开接入                                                                                       |
| 画布热索引与渲染      | `app/src/core/stage/stageManager/StageManager.tsx`、`StageHistoryManager.tsx`、`Section.tsx`、`TextNode.tsx`、`LatexNode.tsx`、`LatexNodeRenderer.tsx`、`renderer.tsx`、`minimap.tsx`                                                                                                                                                                                                                    | `Map + RBush` 空间索引、O(1) 包围盒、零曲线 R-Tree 构建、LaTeX/详情懒加载、全景边裁剪优化、小地图版本缓存                                                  |
| 多维表格核心服务      | `app/src/core/service/dataManageService/stageTableService/{StageTableService.tsx,FormulaDagEngine.ts,formulaEngine.ts,TableDataSource.ts,WorkspaceTableSource.ts}`                                                                                                                                                                                                                                       | 单文件与跨文件统一数据源契约、增量公式 DAG、间隔重复与 6 视图查询                                                                                          |
| 多维表格与工作空间 UI | `app/src/components/{stage-table-panel,stage-table-cell-editor-portal,stage-table-scroll-container,stage-table-selection-store,stage-table-kanban-view,stage-table-gallery-view,stage-table-gantt-view,stage-table-calendar-view,stage-table-spaced-repetition-view,docked-area}.tsx`、`app/src/core/WorkspaceTableTab.tsx`、`app/src/components/workspace/{UpgradeV3Dialog,WorkspaceColumnsDialog}.tsx` | `@tanstack/react-virtual` 虚拟化表格与 5 拓展视图、单例浮层编辑器、原子选中态、右侧分屏范围切换与全屏工作空间多维表格 Tab                                  |
| CLI 与多语言          | `app/src/cli/{ClosedProjectInvocation,ClosedProjectSqliteV3}.ts`、`app/src/locales/{zh_CN,en,zh_TWC,id,zh_TW}.yml`                                                                                                                                                                                                                                                                                       | CLI 原生读写 v3.0.0 SQLite；四国手写词条 + OpenCC 自动繁体                                                                                                 |

---

## 5. 必避的 7 个技术坑（切勿回退）

1. **严禁在 120 FPS Canvas `renderer.tick()` 中调用 Rust/SQLite IPC**：画布渲染与拖拽全程只读写前端内存 `StageManager` + `RBush`，拖拽抬手时才通过 `DocCommandBus` 批量提交一次。
2. **列/选项/编组安全 ID 前缀与 `tableFields` 不可变引用**：自定义列、选项、编组 ID 必须保持 `col_<uuid>` / `opt_<uuid>` / `grp_<uuid>`，禁用 `"_"`、`"$"`、`"$u"`、`"__*"`；修改 `entity.tableFields` 须创建新对象引用（或走 `DocCommandBus` 通道）。
3. **保留冒泡阶段 `onWheel` 隔离**：`StageTablePanel` 及虚拟滚动容器严禁改为 `onWheelCapture`，否则会吞掉内部视口和双滑块的滚轮事件。
4. **`main.tsx` 顶层引导顺序（TDZ 红线）**：所有顶层 `const`（如 `localeLoaders`）与辅助函数必须声明在 `bootstrap()` 调用之前；副窗口/预热窗口跳过 `await getMatches()` 时会在同步微任务前直接执行初始化逻辑。
5. **Win32 Subclass 重入安全（`windows_drag_compat.rs`）**：`DefSubclassProc` 会同步重入子窗口过程，回调内只允许通过 `&SubclassState` 配合 `Cell<T>` 访问状态，严禁跨 `DefSubclassProc` 持有 `&mut`；修改窗口拖动逻辑时必须保持 `transparent: true` 与 `windowBackgroundAlpha` 正常工作。
6. **`eslint --fix` 与后台 Vite 8 文件监听竞争**：后台开着 `1420` 端口 Vite 时执行 `eslint --fix` 偶发令 Vite 缓存空模块；交付桌面测试前用 `Invoke-WebRequest http://localhost:1420/src/components/stage-table-panel.tsx` 校验含 `export default`，异常则用 `vite --force` 重启。
7. **本地测试严禁跑 `pnpm dev` / `tauri dev` 或误碰正式版**：打包发版后若要重新本地测试，必须按 `flux-graph-local-test` 技能用 `$env:TAURI_CONFIG = '{"identifier":"liren.project-graph.dev-test","productName":"Flux Graph (Dev Test)"}'` 重新编译 `cargo build --no-default-features --bin project-graph`，并单独常驻纯前端 Vite（`1420` 端口）；严禁杀掉或覆盖 `D:\Program Files D\flux graph user\project-graph.exe`。
