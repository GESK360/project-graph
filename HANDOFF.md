# Flux Graph 交接文档

> 给下一个对话窗口用的。读完这份就能接手，不用重新摸索。
> 最后更新：2026-11-17 21:42（Asia/Shanghai）

---

## 0. 一句话现状

Flux Graph 是 **GESK360 对 graphif/project-graph 的 fork**，已经把「节点链接」这条链路从扩展插件重做进了软件本体（Rust），并在 Windows 上编译、打包、发版完成。当前 `master` 干净，没有未提交改动。

---

## 1. 坐标（先记这几个路径）

| 项                      | 值                                                                                              |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| 本地仓库                | `D:\Program Files D\flux graph`                                                                 |
| GitHub fork             | https://github.com/GESK360/project-graph                                                        |
| 上游                    | https://github.com/graphif/project-graph                                                        |
| 分支                    | `master`（当前 HEAD `3f1380de`）                                                                |
| 已发布                  | tag `flux-v1.0.0` → https://github.com/GESK360/project-graph/releases/tag/flux-v1.0.0           |
| CI 工作流               | `.github/workflows/build-flux-graph.yml`（Windows 编译 + NSIS 打包 + 上传 artifact）            |
| CI 专用配置             | `app/src-tauri/tauri.ci.conf.json`（只做一件事：关掉 createUpdaterArtifacts，因为没有签名私钥） |
| 用户数据目录            | `%APPDATA%\liren.project-graph`（**identifier 故意保持上游值**，不迁移旧数据）                  |
| 用户当前装的 Flux Graph | `D:\Program Files D\flux graph test\Flux Graph\`                                                |
| 上游 Project Graph 仍在 | `D:\Program Files D\Project Graph\`（两个程序共用同一个数据目录）                               |

版本号：`app/src-tauri/tauri.conf.json` 里的 `version` 仍是 `4.2.6-alpha1`（沿用上游）。发下一版要改这里，tag 用 `flux-vX.Y.Z`。

---

## 2. 环境与命令（踩过的坑都在这）

### 工具链

| 工具         | 状态                                                       |
| ------------ | ---------------------------------------------------------- |
| Node         | v24.20.0（仓库要求 `>=26`，只是 WARN，能跑）               |
| pnpm         | 11.3.0，**必须用 `pnpm.cmd`**，`pnpm.ps1` 被执行策略拒绝   |
| Rust / cargo | **没装**，本地编不了 Tauri，只能靠 GitHub Actions 出安装包 |
| MSVC         | 没装                                                       |

### 常用命令

```powershell
# 类型检查（改完代码用这个，不要 build）
& "C:\Users\admin\AppData\Roaming\npm\pnpm.cmd" --filter @graphif/project-graph type-check

# 依赖重装
& "C:\Users\admin\AppData\Roaming\npm\pnpm.cmd" install

# 触发 CI 构建（约 10-11 分钟）
gh workflow run build-flux-graph.yml --ref master --repo GESK360/project-graph

# 看构建进度
gh run view <RUN_ID> --repo GESK360/project-graph
gh run view --job=<JOB_ID> --repo GESK360/project-graph

# 下安装包
gh run download <RUN_ID> --repo GESK360/project-graph -n flux-graph-windows-nsis -D <目录>
```

### gh CLI 的坑

- `gh pr view --json merged` 没这个字段，用 `mergedAt`
- `gh release view --json assets --jq ...` 有参数解析问题，改用 `gh api repos/OWNER/REPO/releases/tags/<TAG>`
- PowerShell 会把原生命令的 stderr 当异常抛。`git` / `gh` 往 stderr 输出是正常现象，别误判为失败，以退出码或后续验证为准

### 仓库禁令（AGENTS.md 写的，必须遵守）

- **禁止** `build` / `build:ci` / `build:no-tauri` / `tauri build`（本地编不了，也没必要）
- 禁止用 `node -e` / `python` / sed 之类脚本批量改文件，一律用 read / write / edit 工具
- 禁止 grep `node_modules/**`
- 文案改 `en.yml` / `zh_CN.yml` / `zh_TWC.yml` / `id.yml`；**`zh_TW.yml` 是 OpenCC 自动生成的，不要手改**
- Commit 用 Conventional Commits，冒号后写中文，例如 `fix: 减弱节点创建动画`
- 提交时会跑 husky + lint-staged（eslint --fix + prettier），会改暂存区文件，属正常

---

## 3. 这次做了什么（已发布为 flux-v1.0.0）

### 3.1 核心：原生单实例转发（Rust）

**问题**：上游没装单实例插件。系统注册表里 `prg://` 的打开命令是 `"project-graph.exe" "%1"`，软件已在运行时点链接会**再起一个进程**，于是抢注全局快捷键失败（`HotKey already registered`）+ 抢工程文件失败（`projectOwnership.busy`）。这是扩展插件改不了的。

**做法**（`app/src-tauri/src/lib.rs`）：

```rust
// lib.rs:99  必须是第一个注册的插件
#[cfg(desktop)]
let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
    focus_main_window(app);         // lib.rs:33  show / unminimize / set_focus
    forward_open_files(app, &args); // lib.rs:45  双击 .prg 时 emit("open-file-from-os")
}));
```

- 依赖加在 `app/src-tauri/Cargo.toml` 的 `[target.'cfg(not(any(target_os = "android", target_os = "ios")))'.dependencies]` 下：
  `tauri-plugin-single-instance = { version = "2", features = ["deep-link"] }`
- 开 `deep-link` 特性后，转发来的 URL 会先交给 deep-link 插件，再派发 `deep-link://new-url` 事件，前端 `onOpenUrl` 收到
- 插件在 Windows 上用 `WM_COPYDATA` 转发 argv，并用 `AllowSetForegroundWindow` 把前台权限让渡给已运行实例（所以回调里 `set_focus` 真的能弹到最前）

### 3.2 前端：唤起即定位

- `app/src/main.tsx` → `loadStartFile()`：**先 `onOpenUrl(...)` 再 `await getCurrent()`**。顺序不能反，否则启动瞬间到达的转发会漏。这是上一版留下的竞态。
- `app/src/core/service/dataFileService/DeepLinkHandler.ts`：
  - `isProjectGraphDeepLink` 现在认 `prg:` 和 `flux:` 两种 scheme
  - 去重从「永久 Set」改成「2 秒时间窗」（`handledUrls` 是 `Map<string, number>`，`DEDUPE_WINDOW_MS = 2000`）。**原来的永久去重会让同一条链接第二次点击静默失效**，这是上一版的隐性 bug
  - 定位逻辑没动：`handleDeepLink` → `onOpenFile` → `applyCameraParams` → `camera.resetByRectangle(entity.collisionBox.getRectangle())`

### 3.3 右键「复制节点链接」（原生，不再依赖扩展）

- 动作：`shortcutKeysRegister.tsx:1520`，id = `copySelectedEntityPrgDeepLink`，`defaultKey: ""`
- 逻辑：草稿 → `showDraftCannotExportDeepLinkDialog()`；选中 0 个 → toast；>1 个 → toast；否则 `createSelectedEntityDeepLink(project)` → `writeText(url)` + toast
- 菜单位置 A：`Settings.tsx` 的 `clipboard-group`（右键顶部那排图标里的链接图标）
- 菜单位置 B：`Settings.tsx` 的 `exportPrgDeepLinkSub` 子菜单（「prg 协议链接」→「复制节点链接」）
- 文案：四个 locale 文件的 `copySelectedEntityPrgDeepLink.title`
- **注意**：`app/src/sub/SettingsWindow/keybinds.tsx` 的 `shortcutKeysGroups` 里**没有**列任何 `*PrgDeepLink` id，所以这些动作不会出现在设置页的快捷键分组里（与上游现状一致，不是遗漏）

### 3.4 右键菜单不再堆「死条目」

`app/src/components/context-menu-content.tsx`：

- `checkVisible`（:131-138）：`ext:` 开头的条目，如果 `KeyBindsUI.getUIKeyBind(id)` 拿不到动作 → 不渲染
- `hasVisibleNeighbor`（:350-360）+ :403：被过滤的条目前后只剩分隔线时，连分隔线一起丢掉（含菜单首尾）

### 3.5 品牌更名

- `tauri.conf.json`：`productName` / 窗口 `title` / `bundle.longDescription` / `shortDescription` / `fileAssociations` / `plugins.cli.description`
- `app/README.md`（**真正的 README**；根目录 `README.md` 只有 16 字节，内容是一行 `./app/README.md`，是给 GitHub 渲染用的存根，别删）
- `app/index.html` 的 `<title>`
- `plugins.deep-link.desktop.schemes` = `["prg", "flux"]`

---

## 4. 已实测 / 未实测（别把未测当已测）

### 已实测

| 项                                                         | 结果                                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 单实例转发（带假链接）                                     | 第二进程 48ms 退出，exit code 0                                                          |
| 单实例转发（带真实工程 `D:\Users\admin\Pictures\111.prg`） | 第二进程 79ms 退出，首实例在同一进程内打开了该工程（ownership connectable 时间戳被刷新） |
| 类型检查                                                   | `tsc --noEmit` 零报错                                                                    |
| CI Windows 编译 + NSIS 打包                                | 通过（约 10m41s）                                                                        |

### 未实测（下一个窗口如果要，优先补这些）

- **镜头定位精度**：`resetByRectangle` 是否把节点放在舒服的位置
- **跨工程跳转**：链接指向另一个工程时的表现（`onOpenFile` 有 alreadyOpen 分支，理论上能切，但没跑过）
- **冷启动**（软件没开时点链接）：走上游原有流程，这次没碰
- 双屏 / 最小化到托盘时 `set_focus` 的真实表现

---

## 5. 环境里的历史包袱（重要，别被误导）

1. **旧扩展目录已空**：`%APPDATA%\liren.project-graph\extensions` 现在是空的，上一版的 `node-link` 扩展已经没了。
2. **设置里已被清理干净**：`settings.json` 的 `contextMenuConfig` 里三条 `ext:` 遗留（`ext-node-link-sep`、`ext:node-link:copyNodeLink`、`ext:node-link:jumpToNodeLink`）和 `keybinds2.json` 里两条 `ext:node-link:*` 已删除，现在 `ext:` / `node-link` 引用数都是 0。
3. **注册表已被改过**：`HKCU\Software\Classes\prg\shell\open\command` 现在指向 `"D:\Program Files D\flux graph test\Flux Graph\project-graph.exe" "%1"`，`flux` 同名键也一样。原来曾被上一版改成指向一个 `.vbs` 转发脚本，已还原。想彻底干净就重装一次 Flux Graph，安装器会重写这两个键。
4. **上一次的失败方案不要重走**：曾试过「VBS 转发脚本 + 插件每 2 秒 PowerShell 轮询收件文件」，会导致软件卡顿 + 不停闪 cmd 窗口。**不要再用轮询 + 起子进程的方案**，原生单实例才是正解。
5. 用户当前装的那个 Flux Graph（`flux graph test` 目录，20:56 构建）**不含**死条目过滤那次修复，要看到过滤效果得装 `flux-v1.0.0` 的包。

---

## 6. 代码地图（改东西前先看这里）

| 想改什么                        | 去哪个文件                                                                                    |
| ------------------------------- | --------------------------------------------------------------------------------------------- |
| 深链接格式 / 解析 / 定位        | `app/src/core/service/dataFileService/DeepLinkHandler.ts`                                     |
| 深链接启动流程、onOpenUrl       | `app/src/main.tsx` → `loadStartFile()`                                                        |
| 单实例转发、窗口置前、双击 .prg | `app/src-tauri/src/lib.rs`                                                                    |
| 快捷键动作（含复制节点链接）    | `app/src/core/service/controlService/shortcutKeysEngine/shortcutKeysRegister.tsx`             |
| 快捷键 UI 注册（扩展用）        | `.../shortcutKeysEngine/KeyBindsUI.tsx`、`app/src/core/extension/ExtensionKeyBindManager.tsx` |
| 右键菜单渲染                    | `app/src/components/context-menu-content.tsx`                                                 |
| 右键菜单默认项 / 设置 schema    | `app/src/core/service/Settings.tsx`（`contextMenuConfig`）                                    |
| 打开文件（已打开则切标签页）    | `app/src/core/service/GlobalMenu.tsx` → `onOpenFile` / `focusExistingTab`                     |
| Tauri 配置、协议注册、安装包    | `app/src-tauri/tauri.conf.json`                                                               |
| NSIS 安装钩子                   | `app/src-tauri/nsis/installer.nsh`（目前只改 PATH）                                           |
| 文案                            | `app/src/locales/{en,zh_CN,zh_TWC,id}.yml`                                                    |

仓库自带 agent 技能，动手前先读：`AGENTS.md`、`.agents/skills/create-keybind/SKILL.md`、`create-setting-item/SKILL.md`、`type-check/SKILL.md`。

---

## 7. 发布流程（下次照做）

```powershell
# 1. 改代码 → 类型检查
& "C:\Users\admin\AppData\Roaming\npm\pnpm.cmd" --filter @graphif/project-graph type-check

# 2. 提交（Conventional Commits，冒号后中文）
git -C "D:\Program Files D\flux graph" add -A
git -C "D:\Program Files D\flux graph" commit -m "feat: xxx"
git -C "D:\Program Files D\flux graph" push origin master

# 3. 等 CI 绿（push 到 master / feat/** 会自动触发；也可手动 dispatch）
gh run list --repo GESK360/project-graph --branch master --limit 3

# 4. 下产物
gh run download <RUN_ID> --repo GESK360/project-graph -n flux-graph-windows-nsis -D "D:\Library Files D\deepseek harness\project graph\rel-x.y.z"

# 5. 发版（tag 必须用 flux- 前缀，否则和上游 v* tag 冲突）
gh release create flux-vX.Y.Z --repo GESK360/project-graph --target master --title "Flux Graph vX.Y.Z · 一句话亮点" --notes-file <notes.md> "<目录>\Flux Graph_<ver>_x64-setup.exe"
```

**发版前记得**：改 `app/src-tauri/tauri.conf.json` 的 `version`（安装包文件名带这个版本号）。

**tag 命名规矩**：上游已占用 `v0.x` 到 `v4.3.7` 全部 `v*` tag，fork 的发布一律 `flux-vX.Y.Z`。

**CI 为什么不需要 secrets**：`LR_API_BASE_URL` 缺失时前端会回落到 `https://hub.graphif.dev`（见 `app/src/core/service/AuthClient.tsx`），所以 fork 能直接编译。`createUpdaterArtifacts` 用 `tauri.ci.conf.json` 关掉了。

---

## 8. 已知限制 / 待办候选

限制（当前不打算改，除非用户明确要）：

- exe 名仍是 `project-graph.exe`。要改成 `flux-graph.exe` 得同时动 Cargo crate 名、`app/scripts/prepare-bundle.js` 的 `SECONDARY_BINS`、`app/scripts/materialize-cli.ts`、`app/src/cli/project-graph-production.ts` 里写死的 `project-graph-ownership-helper` 路径常量，以及 `project_runtime_bridge.rs:414`。收益不抵风险。
- `bundle.updater` 的 endpoint 仍指向上游 release 服务器。`checkUpdate()`（`app/src/utils/updater.tsx`）在代码里**没有任何调用点**，所以不会自动更新覆盖 fork。真要接自动更新得换 endpoint 并配签名密钥。
- 冷启动（软件未运行）点链接走上游原有流程，不经过插件。

用户提过的下一步（原话留档）：

- 把 exe 名也改成 `flux-graph.exe`
- 「复制为 Markdown 链接」之类的变体
- 继续开发别的功能（这次交接就是为了开新功能）

---

## 9. 给下一个窗口的操作建议

1. 先 `cd "D:\Program Files D\flux graph"`，`git log --oneline -4` 确认还在 `3f1380de` 或更新。`git status` 里只应该有这一份 `HANDOFF.md`（未跟踪，用户没要求提交），其余干净。
2. 读 `AGENTS.md` + 相关 `.agents/skills/*/SKILL.md`，别绕过仓库约定。
3. 改完代码只跑 `type-check`，**不要**跑 build（本地没 Rust 工具链）。
4. 要看到运行效果 → 触发 CI → 下安装包 → 让用户装。别指望本地 `pnpm dev`（`tauri dev` 需要 cargo）。
5. 碰用户设置或注册表时，改之前先记录原值，改完复核。这次就因为删条目时少删一个逗号把 `settings.json` 弄成非法 JSON 过一次，虽然立刻修好了。
6. 如果用户说「右键菜单还有多余项」，先查 `%APPDATA%\liren.project-graph\settings.json` 的 `contextMenuConfig`，再查 `keybinds2.json`，而不是先改代码。
7. 只启动一个 Flux Graph 实例做测试，测完把自己启的进程杀掉（`Stop-Process -Id <pid>`），别留后台进程污染后续测试。

---

## 10. 一句话记住这次的关键结论

**点链接另起进程、报 HotKey / projectOwnership 错，根因不是链接格式，而是上游缺单实例转发。** 修在 `lib.rs` 里注册 `tauri-plugin-single-instance`（带 deep-link 特性）即可，别再用外部脚本或轮询绕过。
