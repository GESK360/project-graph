# Flux Graph 多维表格功能 · 会话交接文档（v5.0.0）

> 供后续会话直接接手使用，无需重新探索仓库与数据格式。
> 更新时间：2026-11-25（Asia/Shanghai）· 对应发布版本：`Flux Graph v5.0.0`（tag `flux-v5.0.0`）

---

## 1. 路径与环境基线（必看，严禁混淆目录）

| 用途                   | 路径                                                                         | 说明                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **源码主仓库（Git）**  | `D:\Program Files D\flux graph`                                              | `GESK360/project-graph`（当前基线 `v5.0.0`，`.prg` 格式 `2.8.0`），**所有源码读写均在此目录** |
| **本地桌面测试程序**   | `D:\Program Files D\flux graph\app\src-tauri\target\debug\project-graph.exe` | 须用独立标识 `liren.project-graph.dev-test` 编译，配合 `1420` 端口纯前端 Vite 服务使用        |
| Antigravity 工作区入口 | `d:\Library Files D\antigravity\flux graph`                                  | 仅作工作区指针与存放 `AGENTS.md` / `HANDOFF-多维表格.md` 副本，**不是源码目录**               |
| 用户脑图数据目录       | `D:\Library Files D\flux graph`                                              | 用户个人 `.prg` 文件，**禁止修改**                                                            |
| 用户日常正式版         | `D:\Program Files D\flux graph user\project-graph.exe`                       | **严禁误杀进程或覆盖**                                                                        |
| **必读全局技能**       | `C:\Users\admin\.gemini\config\skills\flux-graph-local-test\SKILL.md`        | 动手改代码、启测试软件或发版前**必须先读**                                                    |

---

## 2. 已落地并拍板的产品与底层规则（v5.0.0 已上线，切勿回退）

1. **行模型（1 行 = 1 个 Node 或 1 个 Section；单独一张图片不计入表格行）**
   - 纳入表格行：`TextNode`、`Section`、`UrlNode`、`LatexNode`、`MediaNode`、`SvgNode`、`ReferenceBlockNode`、`ExtensionEntity`（见 `isTableRowEntity`）。
   - 排除在表格外：`ImageNode`（含普通图片与背景图片）、`PenStroke`（涂鸦）、`ConnectPoint`（中继质点）、以及所有连线/孪生关系（`Association`）。
   - 最左侧固定展示从上到下 `1, 2, 3...` 的行计数列。
2. **系统默认属性「图片 (`images`)」双向联动**
   - 单独一张画布 `ImageNode` 不计入多维表格行；当图片进入 `TextNode` / `Section` 内部（如画布 `Alt+左键` 跳入，或在框内粘贴/拖入）时，自动进入对应行的系统属性 `图片` 格（无论 `图片` 列在属性面板中显示或隐藏，底层关系始终实时存在）。
   - 支持单行**多张图片**缩略图并排展示、点击放大预览、粘贴/上传新增图片、逐张移除：
     - 表内给普通 `TextNode` 添加图片时，自动原地无损升级为同 `uuid` 的 `Section` 并在画布框内生成 `ImageNode`；
     - 表内移除图片时同步删除画布对应 `ImageNode`，若移除后 `Section` 为空则自动原地无损退化回同 `uuid` 的 `TextNode`。
3. **一级拓扑关系列（仅算直接相连/包含的第 1 层，双向联动）**
   - `父节点 (parents)` / `子节点 (children)`：覆盖全部有向边（实线/虚线/双线 `LineEdge`、`ArcEdge` 圆弧边、`CubicCatmullRomSplineEdge` 样条边），排除自环；表格增删时同步在画布创建/删除连线（遵守锁定框保护）。
   - `外节点 (outer)` / `内节点 (inner)`：分组框包含关系（单父树），支持 `TextNode <-> Section` 同 `uuid` 自动无损升降级、坐标就近安放与防循环嵌套校验。
4. **系统时间列规则**
   - 旧 `.prg`（`< 2.8.0`）升级时，通过文件系统 `stat`（`birthtime` / `mtime`）统一初始化所有存量实体的 `createdAt` 与 `updatedAt`。
   - **`updatedAt` 只算行内语义数据变动**：修改节点文本、富文本 `details`、框内图片、父子连线、内外包含关系、自定义属性值时刷新；**画布纯位置拖动、自动排版、框体尺寸自适应、折叠展开绝不刷新**，且支持 `Ctrl+Z` 撤销回退。
5. **自定义属性列与表头完整操作体系**
   - 已上线 **5 类自定义属性**：`文本 (text)`、`数字 (number)`、`日期 (date)`（输入 + 日历面板）、`单选 (select)`、`多选 (multi_select)`（支持「查找或添加选项」、彩色标签徽章与跨行复用已有选项），并在 `.prg` v2.8.0 中预留 `公式 (formula)` Schema。
   - **列排序与调宽**：「名称」列固定首位不可拖动，其余系统列与自定义列均支持拖拽表头调序；表格采用 `table-layout: fixed` + 精确总像素宽，拖动列右边界时**仅当前列宽度改变**，其余列保持固定像素宽不变。
   - **表头右键菜单与新建面板**：
     - **修改字段**：在当前列表头正下方弹出锚定面板（首行名称全选输入、第二行双列字段类型选择网格，支持兼容数据转换与系统列改显示别名）；
     - **插入字段（`← 向左插入` / `→ 向右插入`）及最右侧 `+` 新建列**：插入后表头切换为内联 `字段标题` 输入框并联动弹出双列类型网格（支持方向键选类型、`Enter` 完成、`Tab` 连续向右再建一列，在分组内插入自动继承分组）；
     - **字段编组（跨列合并分组表头）**：支持在表头上方创建如 `基础信息`、`自我理解`、`后台数据` 的跨列合并分组表头（双击改名、`▾` 菜单勾选包含列或解散编组）；
     - **底部五图标操作栏**：**复制**（复制自定义列结构、选项及各行单元格数据）、**自适应列宽**、**冻结**（固定最左列至当前列，再次点击取消冻结）、**隐藏**、**删除**。
6. **分屏布局与专用双滑块**
   - 挂载于 `DockedArea` 右侧独立分屏容器，不遮挡画布右侧快捷栏与右下角小地图；文件树切页时保持展开并自动切换当前画布数据源。
   - 自带常驻右侧垂直滑块与底部水平滑块，均支持鼠标拖拽滑块、点击轨道定位与鼠标滚轮控制（含 `Shift+滚轮` 横向滚动）。

---

## 3. 核心文件地图

| 模块                   | 文件路径                                                                                                                                                                                         | 职责说明                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 表结构与类型           | `app/src/types/table.tsx`                                                                                                                                                                        | 系统列 ID（含 `images`）、自定义列 `TableColumnSchema`、视图 `TableViewSchema`（含 `frozenColumnId`、`columnGroups`）、`normalizeTableData`、`cloneTableFields` |
| 实体字段持久化         | `app/src/core/stage/stageObject/abstract/StageEntity.tsx` 及 11 个实体子类                                                                                                                       | `@serializable createdAt / updatedAt / tableFields` 与 `restoreEntityTableMetadata`；`copyEngine.tsx` 粘贴副本重置时间并深拷贝字段                              |
| `.prg` v2.8.0 读写升级 | `app/src/core/ProjectFile.ts`、`app/src/core/Project.tsx`、`app/src/core/stage/ProjectUpgrader.tsx`                                                                                              | `LATEST_PROJECT_VERSION = "2.8.0"`；读写 `table.msgpack`；`convertN8toN9` 递归升级时间；桌面与 CLI `FileSystemProvider.stat`                                    |
| 核心表格服务           | `app/src/core/service/dataManageService/stageTableService/StageTableService.tsx`                                                                                                                 | 行提取、图片双向增删、1-hop 关系索引、列拖拽/左右插入/含数据复制/自适应列宽/冻结/字段编组、无损升降级、语义指纹 `syncSemanticTimestamps`                        |
| 历史与画布钩子         | `StageHistoryManager.tsx`、`utilsControl.tsx`、`StageSectionInOutManager.tsx`、`StageSectionPackManager.tsx`、`StageDeleteManager.tsx`、`ControllerEntityLayerMoving.tsx`、`imageNodeFactory.ts` | `recordStep` 前刷新 `updatedAt`、画布图片进出框/粘贴/删除实时通知多维表格刷新                                                                                   |
| 分屏与表格 UI          | `app/src/components/docked-area.tsx`、`app/src/components/stage-table-panel.tsx`、`app/src/state.tsx`                                                                                            | 右侧独立分屏、双层顶栏、跨列分组表头、表头右键菜单与锚定面板、冻结列定位、全部系统与自定义列单元格编辑器、双滑块                                                |
| 多语言与单测           | `app/src/locales/{zh_CN,en,zh_TWC,id,zh_TW}.yml`、`StageTableService.test.ts`、`stage-table-panel.test.tsx`                                                                                      | 四国手写词条 + OpenCC 自动繁体；覆盖数据升级、图片/关系联动、列操作、分组与冻结单测                                                                             |

---

## 4. 后续可继续迭代方向（Phase 3 路线图）

1. **激活顶栏与右键菜单中的视图/查询占位项**
   - **第一行视图栏 `+`**：支持新建多个表格视图（`PrgTableData.views` 与 `activeViewId` 已就绪，默认视图 `原始表` 保持不可删除）。
   - **第二行功能区 & 表头右键占位项**：
     - `+ 添加一行`：在当前画布可视中心附近空白处新建 `TextNode` 并聚焦表格行编辑；
     - `筛选 (Filter)`、`分组 (Group)`、`排序 (Sort)`、`行高 (Row Height)`：存入当前 `TableViewSchema` 并随 `table.msgpack` 持久化。
2. **自定义列「公式 (`formula`)」计算引擎**
   - 基于已预留的 `TableColumnSchema.formula` 字段接入表达式求值与只读渲染。

---

## 5. 必避的 4 个技术坑（切勿回退）

1. **`@graphif/serializer` 的引用共享与保留字陷阱（极重要）**
   - `packages/serializer/src/index.ts` 对普通对象（如 `entity.tableFields`）直接原样透传给 MsgPack（不做深拷贝，保留 64 位浮点精度）。
   - **铁律 ①**：修改或复制 `entity.tableFields` **必须创建新对象引用**（如 `cloneTableFields`），绝不可原地修改 `entity.tableFields[colId] = val`，否则会污染 `HistoryManager` 历史快照导致 `Ctrl+Z` 失效。
   - **铁律 ②**：列 ID、选项 ID、编组 ID 必须保持 `col_<uuid>` / `opt_<uuid>` / `grp_<uuid>`，绝不可出现 `"_"`、`"$"`、`"$u"` 或 `"__*"` 键名，否则反序列化 `replaceRef` 会报错损坏 `.prg`。
2. **React 滚轮事件拦截必须用冒泡阶段 `onWheel`，严禁用 `onWheelCapture`**
   - `StageTablePanel` 根容器上使用冒泡阶段 `onWheel={(e) => e.stopPropagation()}` 隔离画布滚轮；切勿改成 `onWheelCapture`，否则会吞掉内部视口和右侧/底部双滑块的滚轮事件。
3. **`eslint --fix` 与后台 Vite 8 文件监听竞争**
   - 后台开着 `1420` 端口 Vite 时执行 `eslint --fix`，重写瞬间偶发让 Vite 缓存空模块；交付桌面测试前用 `Invoke-WebRequest http://localhost:1420/src/components/stage-table-panel.tsx` 校验含 `export default`，异常则用 `vite --force` 重启。
4. **本地测试严禁跑 `pnpm dev` / `tauri dev` 或擅自覆盖测试二进制**
   - 发布打包完 `tauri build` 后，若下一轮需要重新做本地桌面测试，必须先按 `flux-graph-local-test` 规范用 `$env:TAURI_CONFIG = '{"identifier":"liren.project-graph.dev-test","productName":"Flux Graph (Dev Test)"}'` 重新 `cargo build --no-default-features --bin project-graph`，再启动纯前端 `pnpm.cmd --dir "D:\Program Files D\flux graph" --filter @graphif/project-graph dev`，避免与用户日常正式版发生单实例锁冲突。
