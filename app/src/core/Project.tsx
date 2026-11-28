import Minimap from "@/components/minimap";
import RightToolbar from "@/components/right-toolbar";
import { Dialog } from "@/components/ui/dialog";
import type { CurveRenderer } from "@/core/render/canvas2d/basicRenderer/curveRenderer";
import type { ImageRenderer } from "@/core/render/canvas2d/basicRenderer/ImageRenderer";
import type { ShapeRenderer } from "@/core/render/canvas2d/basicRenderer/shapeRenderer";
import type { SvgRenderer } from "@/core/render/canvas2d/basicRenderer/svgRenderer";
import type { TextRenderer } from "@/core/render/canvas2d/basicRenderer/textRenderer";
import type { DrawingControllerRenderer } from "@/core/render/canvas2d/controllerRenderer/drawingRenderer";
import type { CollisionBoxRenderer } from "@/core/render/canvas2d/entityRenderer/CollisionBoxRenderer";
import type { StraightEdgeRenderer } from "@/core/render/canvas2d/entityRenderer/edge/concrete/StraightEdgeRenderer";
import type { SymmetryCurveEdgeRenderer } from "@/core/render/canvas2d/entityRenderer/edge/concrete/SymmetryCurveEdgeRenderer";
import type { VerticalPolyEdgeRenderer } from "@/core/render/canvas2d/entityRenderer/edge/concrete/VerticalPolyEdgeRenderer";
import type { EdgeRenderer } from "@/core/render/canvas2d/entityRenderer/edge/EdgeRenderer";
import type { EntityDetailsButtonRenderer } from "@/core/render/canvas2d/entityRenderer/EntityDetailsButtonRenderer";
import type { EntityRenderer } from "@/core/render/canvas2d/entityRenderer/EntityRenderer";
import type { LatexNodeRenderer } from "@/core/render/canvas2d/entityRenderer/latexNode/LatexNodeRenderer";
import type { MediaNodeRenderer } from "@/core/render/canvas2d/entityRenderer/mediaNode/MediaNodeRenderer";
import type { MultiTargetUndirectedEdgeRenderer } from "@/core/render/canvas2d/entityRenderer/multiTargetUndirectedEdge/MultiTargetUndirectedEdgeRenderer";
import type { ReferenceBlockRenderer } from "@/core/render/canvas2d/entityRenderer/ReferenceBlockRenderer";
import type { SectionRenderer } from "@/core/render/canvas2d/entityRenderer/section/SectionRenderer";
import type { SvgNodeRenderer } from "@/core/render/canvas2d/entityRenderer/svgNode/SvgNodeRenderer";
import type { TextNodeRenderer } from "@/core/render/canvas2d/entityRenderer/textNode/TextNodeRenderer";
import type { UrlNodeRenderer } from "@/core/render/canvas2d/entityRenderer/urlNode/urlNodeRenderer";
import type { Renderer } from "@/core/render/canvas2d/renderer";
import type { BackgroundRenderer } from "@/core/render/canvas2d/utilsRenderer/backgroundRenderer";
import type { RenderUtils } from "@/core/render/canvas2d/utilsRenderer/RenderUtils";
import type { SearchContentHighlightRenderer } from "@/core/render/canvas2d/utilsRenderer/searchContentHighlightRenderer";
import type { WorldRenderUtils } from "@/core/render/canvas2d/utilsRenderer/WorldRenderUtils";
import type { InputElement } from "@/core/render/domElement/inputElement";
import type { AutoLayoutFastTree } from "@/core/service/controlService/autoLayoutEngine/autoLayoutFastTreeMode";
import type { AutoLayout } from "@/core/service/controlService/autoLayoutEngine/mainTick";
import type { ControllerUtils } from "@/core/service/controlService/controller/concrete/utilsControl";
import type { Controller } from "@/core/service/controlService/controller/Controller";
import type { KeyboardOnlyEngine } from "@/core/service/controlService/keyboardOnlyEngine/keyboardOnlyEngine";
import type { KeyboardOnlyGraphEngine } from "@/core/service/controlService/keyboardOnlyEngine/keyboardOnlyGraphEngine";
import type { KeyboardOnlyTreeEngine } from "@/core/service/controlService/keyboardOnlyEngine/keyboardOnlyTreeEngine";
import type { SelectChangeEngine } from "@/core/service/controlService/keyboardOnlyEngine/selectChangeEngine";
import type { RectangleSelect } from "@/core/service/controlService/rectangleSelectEngine/rectangleSelectEngine";
import type { KeyBindHintEngine } from "@/core/service/controlService/shortcutKeysEngine/KeyBindHintEngine";
import type { MouseInteraction } from "@/core/service/controlService/stageMouseInteractionCore/stageMouseInteractionCore";
import type { AutoComputeUtils } from "@/core/service/dataGenerateService/autoComputeEngine/AutoComputeUtils";
import type { AutoCompute } from "@/core/service/dataGenerateService/autoComputeEngine/mainTick";
import type { GenerateFromFolder } from "@/core/service/dataGenerateService/generateFromFolderEngine/GenerateFromFolderEngine";
import type { StageExport } from "@/core/service/dataGenerateService/stageExportEngine/stageExportEngine";
import type { StageExportPng } from "@/core/service/dataGenerateService/stageExportEngine/StageExportPng";
import type { StageExportSvg } from "@/core/service/dataGenerateService/stageExportEngine/StageExportSvg";
import type { StageImport } from "@/core/service/dataGenerateService/stageImportEngine/stageImportEngine";
import type { AIEngine } from "@/core/service/dataManageService/aiEngine/AIEngine";
import type { ComplexityDetector } from "@/core/service/dataManageService/ComplexityDetector";
import type { ContentSearch } from "@/core/service/dataManageService/contentSearchEngine/contentSearchEngine";
import type { CopyEngine } from "@/core/service/dataManageService/copyEngine/copyEngine";
import type { StageTableService } from "@/core/service/dataManageService/stageTableService/StageTableService";
import type { Effects } from "@/core/service/feedbackService/effectEngine/effectMachine";
import type { StageStyleManager } from "@/core/service/feedbackService/stageStyle/StageStyleManager";
import { Settings } from "@/core/service/Settings";
import type { Camera } from "@/core/stage/Camera";
import type { Canvas } from "@/core/stage/Canvas";
import type { GraphMethods } from "@/core/stage/stageManager/basicMethods/GraphMethods";
import type { SectionMethods } from "@/core/stage/stageManager/basicMethods/SectionMethods";
import type { LayoutManager } from "@/core/stage/stageManager/concreteMethods/LayoutManager";
import type { SectionCollisionSolver } from "@/core/stage/stageManager/concreteMethods/SectionCollisionSolver";
import type { AutoAlign } from "@/core/stage/stageManager/concreteMethods/StageAutoAlignManager";
import type { DeleteManager } from "@/core/stage/stageManager/concreteMethods/StageDeleteManager";
import type { EntityMoveManager } from "@/core/stage/stageManager/concreteMethods/StageEntityMoveManager";
import type { StageUtils } from "@/core/stage/stageManager/concreteMethods/StageManagerUtils";
import type { MultiTargetEdgeMove } from "@/core/stage/stageManager/concreteMethods/StageMultiTargetEdgeMove";
import type { NodeAdder } from "@/core/stage/stageManager/concreteMethods/StageNodeAdder";
import type { NodeConnector } from "@/core/stage/stageManager/concreteMethods/StageNodeConnector";
import type { StageNodeRotate } from "@/core/stage/stageManager/concreteMethods/stageNodeRotate";
import type { StageObjectColorManager } from "@/core/stage/stageManager/concreteMethods/StageObjectColorManager";
import type { StageObjectSelectCounter } from "@/core/stage/stageManager/concreteMethods/StageObjectSelectCounter";
import type { SectionInOutManager } from "@/core/stage/stageManager/concreteMethods/StageSectionInOutManager";
import type { SectionPackManager } from "@/core/stage/stageManager/concreteMethods/StageSectionPackManager";
import type { StageSyncAssociationManager } from "@/core/stage/stageManager/concreteMethods/StageSyncAssociationManager";
import type { TagManager } from "@/core/stage/stageManager/concreteMethods/StageTagManager";
import type { HistoryManager } from "@/core/stage/stageManager/StageHistoryManager";
import type { StageManager } from "@/core/stage/stageManager/StageManager";
import { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import { nextProjectIdAtom, store, tabsAtom } from "@/state";
import { createDefaultMetadata, PrgMetadata } from "@/types/metadata";
import { createDefaultTableData, PrgTableData } from "@/types/table";
import { deserialize, serialize } from "@graphif/serializer";
import { Decoder, Encoder } from "@msgpack/msgpack";
import { BlobReader, Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { File } from "lucide-react";
import mime from "mime";
import React from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { URI } from "vscode-uri";
import type { CollaborationService } from "./service/collaboration/CollaborationService";
import type { AutoSaveBackupService } from "./service/dataFileService/AutoSaveBackupService";
import { generateThumbnail } from "./service/dataGenerateService/generateThumbnail";
import { ProjectOwnershipLifecycle, ProjectOwnershipLease } from "./ProjectOwnership";
import { compareProjectVersions, parseProjectFile } from "./ProjectFile";
import {
  buildFluxMediaUrl,
  DocClient,
  isPackedV3DocumentOpenResult,
  type V3AnyDocumentOpenResult,
  type V3AttachmentMeta,
} from "./sqlite/DocClient";
import type { DocCommandBus } from "./sqlite/DocCommandBus";
import { ImageBitmapLruCache } from "./sqlite/ImageBitmapLruCache";
import { V3AutoPersistController } from "./sqlite/V3AutoPersist";
import { ProjectUpgrader } from "./stage/ProjectUpgrader";
import type { ReferenceManager } from "./stage/stageManager/concreteMethods/StageReferenceManager";
import { Tab } from "./Tab";

type HydrateV3OpenResultFn = typeof import("./sqlite/V3Serializer").hydrateV3OpenResult;

let cachedHydrateV3OpenResult: HydrateV3OpenResultFn | null = null;
let hydrateV3OpenResultLoader: Promise<HydrateV3OpenResultFn> | null = null;

function loadHydrateV3OpenResult(): Promise<HydrateV3OpenResultFn> {
  if (!hydrateV3OpenResultLoader) {
    hydrateV3OpenResultLoader = import("./sqlite/V3Serializer").then((mod) => {
      cachedHydrateV3OpenResult = mod.hydrateV3OpenResult;
      return mod.hydrateV3OpenResult;
    });
  }
  return hydrateV3OpenResultLoader;
}

void loadHydrateV3OpenResult().catch(() => {});

export enum ProjectState {
  /**
   * “已保存”
   * 已写入到原始文件中
   * 已上传到云端
   */
  Saved,
  /**
   * "已暂存"
   * 未写入到原始文件中，但是已经暂存到数据目录
   * 未上传到云端，但是已经暂存到本地
   */
  Stashed,
  /**
   * “未保存”
   * 未写入到原始文件中，也未暂存到数据目录（真·未保存）
   * 未上传到云端，也未暂存到本地
   */
  Unsaved,
}

/**
 * “工程”
 * 一个标签页对应一个工程，一个工程只能对应一个URI
 * 一个工程可以加载不同的服务，类似vscode的扩展（Extensions）机制
 */
export class Project extends Tab {
  static readonly latestVersion = 18;

  /**
   * 工程文件的URI
   * key: 服务ID
   * value: 服务实例
   */
  private _uri: URI;
  private _projectState: ProjectState = ProjectState.Unsaved;
  private _isSaving = false;
  private readonly projectOwnership = new ProjectOwnershipLifecycle(this);
  public stage: StageObject[] = [];
  public sectionMoveDepth = 0;
  public tags: string[] = [];
  /**
   * string：UUID
   * value: Blob
   */
  public attachments = new Map<string, Blob>();
  public storageFormat: "v3_sqlite" | "v2_zip" | "draft" = "draft";
  public v3DocId: string | null = null;
  public v3Revision = 0;
  public stageRevision = 0;
  /** 离屏临时项目标记（如 v2→v3 迁移）：禁止启动 rAF 渲染循环、全局窗口键盘监听与图片位图解码 */
  public isOffscreen = false;
  public v3AttachmentMetas = new Map<string, V3AttachmentMeta>();
  public readonly imageBitmapCache = new ImageBitmapLruCache();
  private v3AutoPersist: V3AutoPersistController | null = null;
  /**
   * 创建Encoder对象比直接用encode()快
   * @see https://github.com/msgpack/msgpack-javascript#reusing-encoder-and-decoder-instances
   */
  private encoder = new Encoder();
  private decoder = new Decoder();

  /**
   * 创建一个项目
   * @param uri 工程文件的URI
   * 之所以从“路径”改为了“URI”，是因为要为后面的云同步功能做铺垫。
   * 普通的“路径”无法表示云盘中的文件，而URI可以。
   * 同时，草稿文件也从硬编码的“Project Graph”特殊文件路径改为了协议为draft、内容为UUID的URI。
   * @see https://code.visualstudio.com/api/references/vscode-api#workspace.workspaceFile
   */
  constructor(uri: URI) {
    super({});
    this._uri = uri;
  }

  override loop(): void {
    if (this.isOffscreen) return;
    super.loop();
  }

  public bumpStageRevision(): void {
    this.stageRevision++;
  }

  attachProjectOwnership(ownership: ProjectOwnershipLease) {
    this.projectOwnership.attach(ownership);
  }

  get projectOwnerIdentity() {
    return this.projectOwnership.ownershipId;
  }

  get canonicalProjectPath() {
    return this.projectOwnership.canonicalPath;
  }

  get projectOwnershipPeerWindow() {
    return this.projectOwnership.peerWindowLabel;
  }

  getOwnershipHolderCount(): Promise<number> {
    return this.projectOwnership.getHolderCount();
  }

  activateOpenRuntimeHost() {
    this.projectOwnership.activate();
  }
  /**
   * 创建一个草稿工程
   * URI为draft:UUID
   */
  static newDraft(): Project {
    // const num = store.get(tabsAtom).filter((p) => p.isDraft).length + 1;
    if (store.get(tabsAtom).length === 0) store.set(nextProjectIdAtom, 1);
    const num = store.get(nextProjectIdAtom);
    const uri = URI.parse("draft:" + num);
    store.set(nextProjectIdAtom, num + 1);
    return new Project(uri);
  }

  /**
   * 检查是否需要升级，如果需要则显示确认对话框
   * @param currentVersion 当前文件版本
   * @param latestVersion 最新版本
   */
  private async checkAndConfirmUpgrade(currentVersion: string, latestVersion: string): Promise<boolean> {
    const versionDiff = compareProjectVersions(currentVersion, latestVersion);

    // 文件版本 > 软件版本：文件来自更新版本的软件，当前软件无法安全解析，拒绝打开
    if (versionDiff > 0) {
      await Dialog.buttons(
        "文件版本过新，无法打开",
        `该文件由更新版本的软件保存（prg文件版本 ${currentVersion}，当前软件支持的prg最高版本 ${latestVersion}）。\n\n请升级软件后再打开此文件，以避免数据损坏。`,
        [{ id: "ok", label: "确定" }],
      );
      return false;
    }

    // 文件版本 == 软件版本：无需升级，直接打开
    if (versionDiff === 0) {
      return true;
    }

    // 文件版本 < 软件版本：需要升级旧文件，弹出确认对话框
    const response = await Dialog.buttons(
      "检测到旧版本项目文件",
      `当前文件版本为 ${currentVersion}，需要升级到 ${latestVersion} (是prg文件版本,非软件版本)。\n\n升级过程不可逆且可能存在风险，特别是对于大型文件，建议提前备份。是否继续升级？`,
      [
        { id: "cancel", label: "取消", variant: "ghost" },
        { id: "upgrade", label: "确认升级" },
      ],
    );

    if (response === "cancel") {
      // 用户取消升级，返回 false 表示取消
      return false;
    }

    // 添加延迟，确保用户看到提示并给系统时间处理
    await new Promise((resolve) => setTimeout(resolve, 500));
    return true;
  }

  /**
   * 服务加载完成后再调用
   */
  async init(options?: { readOnlyCopy?: boolean }) {
    if (this.isDraft) {
      if (!options?.readOnlyCopy && DocClient.isAvailable()) {
        await this.initTempDraftSqlite();
      }
      return;
    }
    if (!(await this.fs.exists(this.uri))) {
      return;
    }
    try {
      // 桌面端本地 .prg 先探测魔数：v3.0.0 直接走 Rust SQLite 秒开，旧版 v2.x 提示一键备份升级
      if (this.uri.scheme === "file" && DocClient.isAvailable()) {
        const format = await DocClient.detectFormat(this.uri.fsPath);
        if (format === "v3_sqlite") {
          const openedOk = await this.openV3SqliteDocument(this.uri.fsPath, {
            attachAutoPersist: !options?.readOnlyCopy,
          });
          if (openedOk) {
            this.projectState = ProjectState.Saved;
          }
          return;
        }
        if (format === "v2_zip" && !options?.readOnlyCopy) {
          const confirmed = await this.confirmSingleFileV3Upgrade();
          if (!confirmed) return;
          const { migrateSingleLegacyFile } = await import("./sqlite/V2ToV3Migrator");
          const result = await migrateSingleLegacyFile(this.uri.fsPath, {
            workspaceRoot: Settings.activeWorkspaceRoot || undefined,
          });
          toast.success(`已备份旧文件并无损升级至 v3.0.0（备份：${result.backupPath}）`);
          const openedOk = await this.openV3SqliteDocument(this.uri.fsPath, {
            attachAutoPersist: true,
          });
          if (openedOk) {
            this.wasUpgraded = false;
            this.projectState = ProjectState.Saved;
          }
          return;
        }
      }

      // 解析旧版 ZIP 项目文件（草稿、只读历史副本或非 Tauri 测试环境）
      const { serializedStageObjects, tags, references, metadata, table, readme } = await parseProjectFile(
        await this.fs.read(this.uri),
        this.decoder,
        this.attachments,
      );

      // 检查并确认升级
      const currentVersion = metadata?.version || "2.0.0";
      const latestVersion = ProjectUpgrader.NLatestVersion;
      const confirmed = options?.readOnlyCopy
        ? compareProjectVersions(currentVersion, latestVersion) <= 0
        : await this.checkAndConfirmUpgrade(currentVersion, latestVersion);
      if (!confirmed) return; // 用户取消升级，不打开文件，跳过 this.projectState = ProjectState.Saved

      const fileStat =
        compareProjectVersions(currentVersion, latestVersion) < 0 ? await this.fs.stat?.(this.uri) : undefined;

      // 升级数据
      const [upgradedStageObjects, upgradedMetadata] = ProjectUpgrader.upgradeNAnyToNLatest(
        serializedStageObjects,
        metadata as any,
        {
          defaultCreatedAt: fileStat?.createdAt,
          defaultUpdatedAt: fileStat?.modifiedAt,
        },
      );

      // 应用升级后的数据
      this.storageFormat = this.isDraft ? "draft" : "v2_zip";
      this.stage = deserialize(upgradedStageObjects, this);
      const { convertLatexNodes } = await import("@/core/stage/stageObject/tools/convertLatexNodes");
      convertLatexNodes(this);
      this.tags = tags;
      this.references = references;
      this.metadata = upgradedMetadata;
      this.table = table;
      this.readme = readme;

      // 更新引用关系，包括双向线的偏移状态
      // 注意：这里需要在服务加载后才能调用，所以需要检查服务是否已加载
      if (this.getService("stageManager")) {
        this.stageManager.updateReferences();
      }
      if (this.getService("stageTable")) {
        this.stageTable.resetAfterStageRestore();
      }

      this.wasUpgraded = !options?.readOnlyCopy && currentVersion !== latestVersion;
    } catch (e) {
      console.warn(e);
      const errorMessage = `打开文件时发生错误，文件内容可能已损坏或与当前软件版本不兼容。\n\n错误信息：${e}`;
      const result = await Dialog.buttons("文件解析失败", errorMessage, [
        { id: "ok", label: "确定" },
        { id: "copy", label: "复制错误信息" },
      ]);
      if (result === "copy") {
        navigator.clipboard.writeText(errorMessage);
      }
      return;
    }
    this.projectState = ProjectState.Saved;
  }

  private async confirmSingleFileV3Upgrade(): Promise<boolean> {
    const response = await Dialog.buttons(
      "检测到旧版 v2.x 项目文件",
      "该文件为旧版 ZIP 格式，需要升级为 SQLite v3.0.0 格式以启用秒开与实时自动落盘。\n\n升级前将自动完整备份原文件（工作空间内备份至 .flux-graph/backup-v2/，工作空间外在同目录留存 .v2.bak），校验无损后再原子替换。是否立即升级？",
      [
        { id: "cancel", label: "取消", variant: "ghost" },
        { id: "upgrade", label: "一键备份并升级到 v3.0.0" },
      ],
    );
    return response === "upgrade";
  }

  private async initTempDraftSqlite(): Promise<void> {
    if (this.v3DocId) return;
    try {
      const opened = await DocClient.openTempDraft();
      this.storageFormat = "v3_sqlite";
      this.v3DocId = opened.docId;
      this.v3Revision = opened.revision;
      this.v3AttachmentMetas = new Map(opened.attachments.map((meta) => [meta.id, meta]));
      this.docCommandBus?.resetBaseline();
      this.attachV3AutoPersist();
    } catch (error) {
      console.warn("初始化临时草稿 SQLite 失败，回退至内存草稿模式:", error);
    }
  }

  private async openV3SqliteDocument(fsPath: string, options: { attachAutoPersist: boolean }): Promise<boolean> {
    const opened = await DocClient.openDocument(fsPath);
    return await this.initWithPreloadedV3(opened, options);
  }

  /**
   * 使用 Rust 融合 IPC 预先返回的 `V3AnyDocumentOpenResult` 直接水合工程（零额外 IPC 往返）。
   */
  public async initWithPreloadedV3(
    opened: V3AnyDocumentOpenResult,
    options: { attachAutoPersist: boolean } = { attachAutoPersist: true },
  ): Promise<boolean> {
    if (compareProjectVersions(opened.formatVersion, ProjectUpgrader.NLatestVersion) > 0) {
      await DocClient.closeDocument(opened.docId);
      await Dialog.buttons(
        "文件版本过新，无法打开",
        `该文件由更新版本的软件保存（prg文件版本 ${opened.formatVersion}，当前软件支持的prg最高版本 ${ProjectUpgrader.NLatestVersion}）。\n\n请升级软件后再打开此文件，以避免数据损坏。`,
        [{ id: "ok", label: "确定" }],
      );
      return false;
    }

    const hydrateV3OpenResult: HydrateV3OpenResultFn = cachedHydrateV3OpenResult ?? (await loadHydrateV3OpenResult());
    const attachmentMetas: V3AttachmentMeta[] = isPackedV3DocumentOpenResult(opened)
      ? opened.attachments.map(([id, mime, width, height, sizeBytes, hasThumbInt]) => ({
          id,
          mime,
          width,
          height,
          sizeBytes,
          hasThumb: hasThumbInt !== 0,
        }))
      : opened.attachments;

    if (!options.attachAutoPersist) {
      // 只读快照副本：先将所需附件读入内存后立即释放快照 SQLite 连接，
      // 防止后续在草稿副本中的任何编辑误写回历史快照文件。
      const tempDocId = opened.docId;
      this.attachments.clear();
      this.v3AttachmentMetas.clear();
      for (const meta of attachmentMetas) {
        try {
          const resp = await fetch(buildFluxMediaUrl(tempDocId, meta.id));
          if (resp.ok) {
            this.attachments.set(meta.id, await resp.blob());
          }
        } catch {
          // 单个附件读取失败不阻断画布恢复
        }
      }
      await DocClient.closeDocument(tempDocId);
      this.storageFormat = "draft";
      this.v3DocId = null;
      this.v3Revision = 0;

      const hydrated = hydrateV3OpenResult(this, opened);
      this.stage = hydrated.stage;
      this.tags = hydrated.tags;
      this.references = hydrated.references;
      this.metadata = hydrated.metadata;
      this.table = hydrated.table;
      this.readme = hydrated.readme;

      if (this.getService("stageManager")) {
        this.stageManager.updateReferences({ skipIndexRebuild: true, skipSectionAdjust: true });
      }
      if (this.getService("stageTable")) {
        this.stageTable.resetAfterStageRestore({
          deferFormulaSync: true,
          needsFormulaRecompute: opened.needsFormulaRecompute,
        });
      }
      this.docCommandBus?.resetBaseline();
      return true;
    }

    // 必须在 hydrateV3OpenResult 之前登记 docId 与附件元数据，使图片/媒体节点构造时即可拼出 flux-media:// URL
    this.storageFormat = "v3_sqlite";
    this.v3DocId = opened.docId;
    this.v3Revision = opened.revision;
    this.v3AttachmentMetas = new Map(attachmentMetas.map((meta) => [meta.id, meta]));
    this.attachments.clear();

    const hydrated = hydrateV3OpenResult(this, opened);
    this.stage = hydrated.stage;
    this.tags = hydrated.tags;
    this.references = hydrated.references;
    this.metadata = hydrated.metadata;
    this.table = hydrated.table;
    this.readme = hydrated.readme;

    if (this.getService("stageManager")) {
      this.stageManager.updateReferences({ skipIndexRebuild: true, skipSectionAdjust: true });
    }
    if (this.getService("stageTable")) {
      this.stageTable.resetAfterStageRestore({
        deferFormulaSync: true,
        needsFormulaRecompute: opened.needsFormulaRecompute,
      });
    }
    this.docCommandBus?.resetBaseline();
    if (options.attachAutoPersist) {
      this.attachV3AutoPersist();
    }
    this.projectState = ProjectState.Saved;
    return true;
  }

  public get isSqliteV3(): boolean {
    return this.storageFormat === "v3_sqlite" && this.v3DocId !== null;
  }

  public get totalAttachmentCount(): number {
    if (this.v3AttachmentMetas.size === 0) return this.attachments.size;
    const ids = new Set<string>(this.attachments.keys());
    for (const id of this.v3AttachmentMetas.keys()) {
      ids.add(id);
    }
    return ids.size;
  }

  public registerV3AttachmentMeta(meta: V3AttachmentMeta): void {
    this.v3AttachmentMetas.set(meta.id, meta);
  }

  public hasAttachment(attachmentId: string): boolean {
    return Boolean(attachmentId) && (this.attachments.has(attachmentId) || this.v3AttachmentMetas.has(attachmentId));
  }

  public getAttachmentMediaUrl(attachmentId: string, options?: { thumb?: boolean }): string | null {
    if (!attachmentId || !this.isSqliteV3 || !this.v3DocId) return null;
    if (this.attachments.has(attachmentId)) return null;
    if (!this.v3AttachmentMetas.has(attachmentId)) return null;
    return buildFluxMediaUrl(this.v3DocId, attachmentId, options);
  }

  public async readAttachmentBlob(attachmentId: string): Promise<Blob | undefined> {
    if (!attachmentId) return undefined;
    const local = this.attachments.get(attachmentId);
    if (local) return local;
    const url = this.getAttachmentMediaUrl(attachmentId);
    if (!url) return undefined;
    const resp = await fetch(url);
    if (!resp.ok) return undefined;
    return await resp.blob();
  }

  public attachV3AutoPersist(): void {
    if (this.v3AutoPersist || !this.isSqliteV3) return;
    this.v3AutoPersist = new V3AutoPersistController(this);
  }

  public async flushV3Persist(): Promise<void> {
    await this.docCommandBus?.flush();
    await this.v3AutoPersist?.flush();
  }

  get isDraft() {
    return this.uri.scheme === "draft";
  }
  get isCollab() {
    return this.uri.scheme === "collab";
  }
  get title(): string {
    return this.uri.scheme === "draft"
      ? `临时草稿 (${this.uri.path})`
      : this.uri.scheme === "collab"
        ? `协作 (${this.uri.path})`
        : this.uri.scheme === "file"
          ? this.uri.path.split("/").pop()!
          : this.uri.toString();
  }
  get icon() {
    return File;
  }
  get uri() {
    return this._uri;
  }
  set uri(uri: URI) {
    this._uri = uri;
    this.projectState = ProjectState.Unsaved;
  }

  /**
   * 将文件暂存到数据目录中（通常为~/.local/share）
   * ~/.local/share/liren.project-graph/stash/<normalizedUri>
   * @see https://code.visualstudio.com/blogs/2016/11/30/hot-exit-in-insiders
   *
   * 频繁用msgpack序列化不会卡吗？
   * 虽然JSON.stringify()在V8上面速度和msgpack差不多
   * 但是要考虑跨平台，目前linux和macos用的都是webkit，目前还没有JavaScriptCore相关的benchmark
   * 而且考虑到以后会把图片也放进文件里面，JSON肯定不合适了
   * @see https://github.com/msgpack/msgpack-javascript#benchmark
   */
  async stash() {
    // TODO: stash
  }
  async save(options: { includeThumbnail?: boolean; createSnapshot?: boolean } = {}) {
    if (this.isDraft || this.isCollab) {
      const path = await saveDialog({
        title: this.isDraft ? "保存草稿" : "保存协作工程",
        filters: [{ name: "Project Graph", extensions: ["prg"] }],
      });
      if (!path) throw new Error("未选择路径");
      await this.saveAs(URI.file(path), options);
      return;
    }
    try {
      this.isSaving = true;
      if (this.isSqliteV3 && this.v3DocId && DocClient.isAvailable()) {
        await this.flushV3Persist();
        let snapshotPath: string | null = null;
        if (options.createSnapshot !== false) {
          const { WorkspaceManager } = await import("./service/workspace/WorkspaceManager");
          snapshotPath = WorkspaceManager.resolveSnapshotTargetPath(this.uri.fsPath);
        }
        const res = await DocClient.checkpointAndSnapshot(this.v3DocId, snapshotPath);
        if (res.snapshotPath) {
          const { WorkspaceManager } = await import("./service/workspace/WorkspaceManager");
          await WorkspaceManager.prunePageSnapshots(this.uri.fsPath);
        }
        this.docIdNeedsSave = false;
        this.projectState = ProjectState.Saved;
        void import("./service/dataFileService/LocalDocumentSync").then(({ LocalDocumentSync }) =>
          LocalDocumentSync.notifySaved(this),
        );
        return;
      }

      if (this.uri.scheme === "file" && DocClient.isAvailable()) {
        const { writeProjectAsV3Atomic } = await import("./sqlite/V2ToV3Migrator");
        await writeProjectAsV3Atomic(this, this.uri.fsPath);
        const opened = await DocClient.openDocument(this.uri.fsPath);
        this.storageFormat = "v3_sqlite";
        this.v3DocId = opened.docId;
        this.v3Revision = opened.revision;
        this.v3AttachmentMetas = new Map(opened.attachments.map((meta) => [meta.id, meta]));
        this.attachments.clear();
        this.docCommandBus?.resetBaseline();
        this.attachV3AutoPersist();
        this.docIdNeedsSave = false;
        this.projectState = ProjectState.Saved;
        void import("./service/dataFileService/LocalDocumentSync").then(({ LocalDocumentSync }) =>
          LocalDocumentSync.notifySaved(this),
        );
        return;
      }

      await this.fs.write(this.uri, await this.getFileContent(options));
      this.docIdNeedsSave = false;
      this.projectState = ProjectState.Saved;
      void import("./service/dataFileService/LocalDocumentSync").then(({ LocalDocumentSync }) =>
        LocalDocumentSync.notifySaved(this),
      );
    } finally {
      this.isSaving = false;
    }
  }

  async saveAs(targetUri: URI, options: { includeThumbnail?: boolean } = {}) {
    if (targetUri.scheme !== "file") throw new Error("Project Save As requires a file URI");
    const fileSystemProvider = this.fileSystemProviders.get("file");
    if (!fileSystemProvider) throw new Error("File Project provider is not registered");

    try {
      this.isSaving = true;
      if (DocClient.isAvailable()) {
        await this.flushV3Persist();
        const prevDocId = this.v3DocId;
        const { writeProjectAsV3Atomic } = await import("./sqlite/V2ToV3Migrator");
        await this.projectOwnership.saveAs(targetUri, async () => {
          await writeProjectAsV3Atomic(this, targetUri.fsPath, {
            copyAttachmentsFromDocId: prevDocId ?? undefined,
          });
        });
        if (prevDocId) {
          await this.v3AutoPersist?.dispose();
          this.v3AutoPersist = null;
          await DocClient.closeDocument(prevDocId);
        }
        const opened = await DocClient.openDocument(targetUri.fsPath);
        this.storageFormat = "v3_sqlite";
        this.v3DocId = opened.docId;
        this.v3Revision = opened.revision;
        this.v3AttachmentMetas = new Map(opened.attachments.map((meta) => [meta.id, meta]));
        this.attachments.clear();
        this.docCommandBus?.resetBaseline();
        this.attachV3AutoPersist();
        this.docIdNeedsSave = false;
        this.projectState = ProjectState.Saved;
        if (this.canonicalProjectPath) {
          const { LocalDocumentSync } = await import("./service/dataFileService/LocalDocumentSync");
          LocalDocumentSync.rebind(this, this.canonicalProjectPath);
        }
        void import("./service/dataFileService/LocalDocumentSync").then(({ LocalDocumentSync }) =>
          LocalDocumentSync.notifySaved(this),
        );
        return;
      }

      const content = await this.getFileContent(options);
      await this.projectOwnership.saveAs(targetUri, () => fileSystemProvider.write(targetUri, content));
      this.docIdNeedsSave = false;
      this.projectState = ProjectState.Saved;
      if (this.canonicalProjectPath) {
        const { LocalDocumentSync } = await import("./service/dataFileService/LocalDocumentSync");
        LocalDocumentSync.rebind(this, this.canonicalProjectPath);
      }
      void import("./service/dataFileService/LocalDocumentSync").then(({ LocalDocumentSync }) =>
        LocalDocumentSync.notifySaved(this),
      );
    } finally {
      this.isSaving = false;
    }
  }

  // 反向引用数据
  public references: { sections: Record<string, string[]>; files: string[] } = { sections: {}, files: [] };
  public metadata: PrgMetadata = createDefaultMetadata(ProjectUpgrader.NLatestVersion);
  public table: PrgTableData = createDefaultTableData();
  public readme?: string;
  public wasUpgraded = false;

  /**
   * 文档身份。老文件没有 docId，第一次被保存时补一个并随 metadata 写回，
   * 之后永久复用，节点相对链接依赖它在文件移动/改名后重新找到本文件。
   */
  get docId(): string {
    const existing = this.metadata.docId;
    if (existing) return existing;
    const created = crypto.randomUUID();
    this.metadata = { ...this.metadata, docId: created };
    this.docIdNeedsSave = true;
    return created;
  }

  /**
   * docId 是本次新生成、还没写进文件。
   * 相对链接靠 docId 扛住改名，没落盘的话改名后反查会失败，所以复制时要提示用户保存。
   */
  public docIdNeedsSave = false;

  // 旧版 ZIP 兼容写出路径（仅非 Tauri / 非 v3 环境使用）
  async getFileContent(options: { includeThumbnail?: boolean } = {}) {
    const includeThumbnail = options.includeThumbnail !== false;
    // 触发一次 docId，保证老文件在被保存时补上身份并随 metadata 落盘
    void this.docId;
    await this.docCommandBus?.flush();
    const serializedStage = serialize(this.stage);
    const encodedStage = this.encoder.encode(serializedStage);
    const uwriter = new Uint8ArrayWriter();

    // @zip.js/zip.js 从 ^2.7.63 升到了 ^2.8.26，需要显示指定 level: 0，防止保存的时候卡顿
    const writer = new ZipWriter(uwriter, { level: 0 });
    await writer.add("stage.msgpack", new Uint8ArrayReader(encodedStage), { level: 0 });
    await writer.add("tags.msgpack", new Uint8ArrayReader(this.encoder.encode(this.tags)), { level: 0 });
    await writer.add("reference.msgpack", new Uint8ArrayReader(this.encoder.encode(this.references)), { level: 0 });
    await writer.add("metadata.msgpack", new Uint8ArrayReader(this.encoder.encode(this.metadata)), { level: 0 });
    await writer.add("table.msgpack", new Uint8ArrayReader(this.encoder.encode(this.table)), { level: 0 });
    if (this.readme) {
      await writer.add("README.md", new Uint8ArrayReader(new TextEncoder().encode(this.readme)), { level: 0 });
    }
    // 添加附件
    for (const [uuid, attachment] of this.attachments.entries()) {
      await writer.add(`attachments/${uuid}.${mime.getExtension(attachment.type)}`, new BlobReader(attachment), {
        level: 0,
      });
    }
    // 添加缩略图
    if (includeThumbnail) {
      try {
        const thumbnailBlob = await generateThumbnail(this);
        if (thumbnailBlob) {
          await writer.add("thumbnail.png", new BlobReader(thumbnailBlob), { level: 0 });
        }
      } catch {
        // 缩略图生成失败不阻止保存
      }
    }
    await writer.close();

    const fileContent = await uwriter.getData();
    return fileContent;
  }

  /**
   * 注册一个文件管理器
   * @param scheme 目前有 "file" | "draft"， 以后可能有其他的协议
   */

  addAttachment(data: Blob, id: string = crypto.randomUUID()): string {
    const uuid = id;
    this.attachments.set(uuid, data);
    if (this.isSqliteV3 && this.v3AutoPersist) {
      // 等 Rust 落库完成后再由 V3AutoPersistController 登记 v3AttachmentMetas 并释放内存 Blob，
      // 避免未写完前前端缩略图抢跑请求 flux-media:// 返回 404。
      void this.v3AutoPersist.enqueueAttachmentPersist(uuid, data);
    }
    this.emit("attachment-add", { id: uuid, data });
    return uuid;
  }

  set projectState(state: ProjectState) {
    if (state === this._projectState) return;
    this._projectState = state;
    this.emit("state-change", state);
  }

  get projectState(): ProjectState {
    return this._projectState;
  }

  set isSaving(isSaving: boolean) {
    if (isSaving === this._isSaving) return;
    this._isSaving = isSaving;
    this.emit("state-change", this._projectState);
  }

  get isSaving(): boolean {
    return this._isSaving;
  }

  private containerRef = React.createRef<HTMLDivElement>();

  /**
   * 立刻加载一个新的服务
   */
  loadService(service: { id?: string; new (...args: any[]): any }) {
    super.loadService(service);
    // 如果加载的是 canvas 服务，且容器已经准备好了，就进行挂载
    if (service.id === "canvas" && (this as any)._lastContainer) {
      this.canvas.mount((this as any)._lastContainer);
    }
  }

  componentDidMount(): void {
    // 这里的 this 是 Project 实例，不再作为 React 组件直接使用
  }

  private currentComponent: React.ComponentType | null = null;

  public getComponent(): React.ComponentType {
    if (this.currentComponent) return this.currentComponent;
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.currentComponent = class extends React.Component<
      Record<string, never>,
      { showQuickSettingsToolbar: boolean }
    > {
      displayName = "ProjectContainer";
      private containerRef = React.createRef<HTMLDivElement>();
      private unwatchShowQuickSettingsToolbar?: () => void;
      state = {
        showQuickSettingsToolbar: Settings.showQuickSettingsToolbar,
      };

      componentDidMount(): void {
        (self as any)._lastContainer = this.containerRef.current;
        if (this.containerRef.current && self.getService("canvas")) {
          self.canvas.mount(this.containerRef.current);
        }
        this.unwatchShowQuickSettingsToolbar = Settings.watch("showQuickSettingsToolbar", (value) => {
          this.setState({ showQuickSettingsToolbar: value });
        });
      }

      componentWillUnmount(): void {
        this.unwatchShowQuickSettingsToolbar?.();
      }

      render() {
        return (
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute inset-0 overflow-hidden" ref={this.containerRef}></div>
            <RightToolbar project={self} showQuickSettingsToolbar={this.state.showQuickSettingsToolbar} />
            <Minimap project={self} />
          </div>
        );
      }
    };
    return this.currentComponent as React.ComponentType;
  }

  render(): React.ReactNode {
    return (
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute inset-0 overflow-hidden" ref={this.containerRef}></div>
        <RightToolbar project={this} showQuickSettingsToolbar={Settings.showQuickSettingsToolbar} />
        <Minimap project={this} />
      </div>
    );
  }

  override async dispose() {
    const cleanupErrors: unknown[] = [];
    try {
      await this.docCommandBus?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await this.v3AutoPersist?.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      this.v3AutoPersist = null;
    }
    const docIdToClose = this.v3DocId;
    this.v3DocId = null;

    const { LocalDocumentSync } = await import("./service/dataFileService/LocalDocumentSync");
    await LocalDocumentSync.flushAndDetach(this);
    try {
      await this.projectOwnership.dispose(async () => {
        try {
          await super.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
        const stageCleanupTasks = this.stage.map((stageObject) =>
          Promise.resolve().then(() => stageObject.dispose?.()),
        );
        const stageCleanupResults = await Promise.allSettled(stageCleanupTasks);
        cleanupErrors.push(
          ...stageCleanupResults
            .filter((result): result is PromiseRejectedResult => result.status === "rejected")
            .map(({ reason }) => reason),
        );
        this.imageBitmapCache.dispose();
        this.stage.length = 0;
        this.attachments.clear();
        this.v3AttachmentMetas.clear();
      });
    } catch (error) {
      if (error instanceof AggregateError) cleanupErrors.push(...error.errors);
      else cleanupErrors.push(error);
    } finally {
      if (docIdToClose && DocClient.isAvailable()) {
        try {
          await DocClient.closeDocument(docIdToClose);
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Project cleanup failed");
  }
}

declare module "./Project" {
  interface Project {
    docCommandBus: DocCommandBus;
    canvas: Canvas;
    inputElement: InputElement;
    controllerUtils: ControllerUtils;
    autoComputeUtils: AutoComputeUtils;
    renderUtils: RenderUtils;
    worldRenderUtils: WorldRenderUtils;
    historyManager: HistoryManager;
    stageManager: StageManager;
    camera: Camera;
    effects: Effects;
    autoCompute: AutoCompute;
    rectangleSelect: RectangleSelect;
    stageNodeRotate: StageNodeRotate;
    complexityDetector: ComplexityDetector;
    aiEngine: AIEngine;
    copyEngine: CopyEngine;
    autoLayout: AutoLayout;
    autoLayoutFastTree: AutoLayoutFastTree;
    layoutManager: LayoutManager;
    autoAlign: AutoAlign;
    mouseInteraction: MouseInteraction;
    contentSearch: ContentSearch;
    deleteManager: DeleteManager;
    nodeAdder: NodeAdder;
    entityMoveManager: EntityMoveManager;
    stageUtils: StageUtils;
    multiTargetEdgeMove: MultiTargetEdgeMove;
    nodeConnector: NodeConnector;
    stageObjectColorManager: StageObjectColorManager;
    stageObjectSelectCounter: StageObjectSelectCounter;
    sectionInOutManager: SectionInOutManager;
    sectionPackManager: SectionPackManager;
    sectionCollisionSolver: SectionCollisionSolver;
    tagManager: TagManager;
    syncAssociationManager: StageSyncAssociationManager;
    keyboardOnlyEngine: KeyboardOnlyEngine;
    keyboardOnlyGraphEngine: KeyboardOnlyGraphEngine;
    keyboardOnlyTreeEngine: KeyboardOnlyTreeEngine;
    selectChangeEngine: SelectChangeEngine;
    textRenderer: TextRenderer;
    imageRenderer: ImageRenderer;
    referenceBlockRenderer: ReferenceBlockRenderer;
    shapeRenderer: ShapeRenderer;
    entityRenderer: EntityRenderer;
    edgeRenderer: EdgeRenderer;
    multiTargetUndirectedEdgeRenderer: MultiTargetUndirectedEdgeRenderer;
    curveRenderer: CurveRenderer;
    svgRenderer: SvgRenderer;
    drawingControllerRenderer: DrawingControllerRenderer;
    collisionBoxRenderer: CollisionBoxRenderer;
    entityDetailsButtonRenderer: EntityDetailsButtonRenderer;
    straightEdgeRenderer: StraightEdgeRenderer;
    symmetryCurveEdgeRenderer: SymmetryCurveEdgeRenderer;
    verticalPolyEdgeRenderer: VerticalPolyEdgeRenderer;
    sectionRenderer: SectionRenderer;
    svgNodeRenderer: SvgNodeRenderer;
    latexNodeRenderer: LatexNodeRenderer;
    mediaNodeRenderer: MediaNodeRenderer;
    textNodeRenderer: TextNodeRenderer;
    urlNodeRenderer: UrlNodeRenderer;
    backgroundRenderer: BackgroundRenderer;
    searchContentHighlightRenderer: SearchContentHighlightRenderer;
    renderer: Renderer;
    controller: Controller;
    stageExport: StageExport;
    stageExportPng: StageExportPng;
    stageExportSvg: StageExportSvg;
    stageImport: StageImport;
    generateFromFolder: GenerateFromFolder;
    keyBindHintEngine: KeyBindHintEngine;
    sectionMethods: SectionMethods;
    graphMethods: GraphMethods;
    stageStyleManager: StageStyleManager;
    autoSaveBackup: AutoSaveBackupService;
    referenceManager: ReferenceManager;
    stageTable: StageTableService;
    collaboration: CollaborationService;
  }
}

/**
 * 装饰器（使用函数声明以便在 ESM 循环依赖时自动提升，避免 TDZ ReferenceError）
 */
export function service(id: string) {
  return <
    T extends {
      [x: string | number | symbol]: any;
      id?: string;
      new (...args: any[]): any;
    },
  >(
    target: T,
  ): T & { id: string } => {
    target.id = id;
    return target as T & { id: string };
  };
}
