import { invoke, isTauri } from "@tauri-apps/api/core";

export type PrgFormat = "v2_zip" | "v3_sqlite" | "unknown";

export interface V3AttachmentMeta {
  id: string;
  mime: string;
  width?: number | null;
  height?: number | null;
  sizeBytes: number;
  hasThumb: boolean;
}

export interface V3EntityRecord {
  uuid: string;
  kind:
    | "text"
    | "section"
    | "image"
    | "url"
    | "latex"
    | "media"
    | "svg"
    | "reference"
    | "extension"
    | "connect_point"
    | "pen_stroke";
  parentSectionUuid: string | null;
  text: string;
  detailsJson: string;
  detailsPlain: string;
  x: number;
  y: number;
  w: number;
  h: number;
  propsJson: string;
  createdAt: number;
  updatedAt: number;
  isRow: boolean;
  sortOrder: number;
}

export interface V3EdgeRecord {
  uuid: string;
  kind: "line" | "arc" | "cr_spline";
  sourceUuid: string;
  targetUuid: string;
  text: string;
  propsJson: string;
  sortOrder: number;
}

export interface V3AssociationRecord {
  uuid: string;
  kind: "multi_target" | "sync";
  memberUuidsJson: string;
  propsJson: string;
  sortOrder: number;
}

export interface V3TableColumnRecord {
  id: string;
  canonicalKey: string;
  name: string;
  type: string;
  position: number;
  configJson: string;
}

export interface V3TableViewRecord {
  id: string;
  name: string;
  type: string;
  deletable: boolean;
  position: number;
  configJson: string;
}

export interface V3MultiOptionEntry {
  optionId: string;
  optionName: string;
}

export interface V3CellValueRecord {
  entityUuid: string;
  colId: string;
  canonicalKey: string;
  valType: "text" | "number" | "date" | "select" | "multi_select";
  valText?: string | null;
  valNum?: number | null;
  valDate?: string | null;
  valJson?: string | null;
  multiOptions: V3MultiOptionEntry[];
}

export interface V3ImportPayload {
  docId: string;
  formatVersion: string;
  readme?: string | null;
  tags: string[];
  references: { sections: Record<string, string[]>; files: string[] };
  extensionJson?: string | null;
  tableMetaJson: string;
  entities: V3EntityRecord[];
  edges: V3EdgeRecord[];
  associations: V3AssociationRecord[];
  tableColumns: V3TableColumnRecord[];
  tableViews: V3TableViewRecord[];
  cellValues: V3CellValueRecord[];
}

export interface V3DocumentOpenResult extends V3ImportPayload {
  canonicalPath: string;
  revision: number;
  attachments: V3AttachmentMeta[];
  needsFormulaRecompute?: boolean;
}

/**
 * 紧凑流式 IPC Wire 格式（Rust `doc_open_with_ownership` 直出，消除大节点图重复键名与双重 JSON 解析）：
 * - Entity tuple: `[uuid, kindCode, parentUuidOr0, text, x, y, w, h, createdAt, updatedAt, sortOrder, propsObjOr0, detailsValOr0]`
 * - Edge tuple: `[uuid, kindCode, sourceUuid, targetUuid, text, sortOrder, propsObjOr0]`
 * - Association tuple: `[uuid, kindCode, memberUuids, propsObjOr0, sortOrder]`
 * - TableColumn tuple: `[id, canonicalKey, name, type, position, configObjOr0]`
 * - TableView tuple: `[id, name, type, deletableInt, position, configObjOr0]`
 * - CellValue tuple: `[entityUuid, colId, valTypeCode, val]`
 * - Attachment tuple: `[id, mime, widthOrNull, heightOrNull, sizeBytes, hasThumbInt]`
 */
export type V3PackedEntityTuple = [
  uuid: string,
  kindCode: number,
  parentSectionUuidOr0: string | 0,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  createdAt: number,
  updatedAt: number,
  sortOrder: number,
  propsObjOr0: Record<string, unknown> | 0,
  detailsValOr0: unknown[] | 0,
];

export type V3PackedEdgeTuple = [
  uuid: string,
  kindCode: number,
  sourceUuid: string,
  targetUuid: string,
  text: string,
  sortOrder: number,
  propsObjOr0: Record<string, unknown> | 0,
];

export type V3PackedAssociationTuple = [
  uuid: string,
  kindCode: number,
  memberUuids: string[],
  propsObjOr0: Record<string, unknown> | 0,
  sortOrder: number,
];

export type V3PackedTableColumnTuple = [
  id: string,
  canonicalKey: string,
  name: string,
  type: string,
  position: number,
  configObjOr0: Record<string, unknown> | 0,
];

export type V3PackedTableViewTuple = [
  id: string,
  name: string,
  type: string,
  deletableInt: number,
  position: number,
  configObjOr0: Record<string, unknown> | 0,
];

export type V3PackedCellTuple = [
  entityUuid: string,
  colId: string,
  valTypeCode: number,
  val: string | number | string[],
];

export type V3PackedAttachmentTuple = [
  id: string,
  mime: string,
  width: number | null,
  height: number | null,
  sizeBytes: number,
  hasThumbInt: number,
];

export interface V3PackedDocumentOpenResult {
  packed: true;
  canonicalPath: string;
  docId: string;
  formatVersion: string;
  revision: number;
  readme?: string | null;
  tags: string[];
  references: { sections: Record<string, string[]>; files: string[] };
  extension?: Record<string, unknown> | 0;
  tableMeta: Record<string, unknown>;
  tableColumns: V3PackedTableColumnTuple[];
  tableViews: V3PackedTableViewTuple[];
  entities: V3PackedEntityTuple[];
  edges: V3PackedEdgeTuple[];
  associations: V3PackedAssociationTuple[];
  cellValues: V3PackedCellTuple[];
  attachments: V3PackedAttachmentTuple[];
  needsFormulaRecompute?: boolean;
}

export type V3AnyDocumentOpenResult = V3DocumentOpenResult | V3PackedDocumentOpenResult;

export function isPackedV3DocumentOpenResult(doc: V3AnyDocumentOpenResult): doc is V3PackedDocumentOpenResult {
  return "packed" in doc && doc.packed === true;
}

export type DocOpenWithOwnershipResponse =
  | {
      status: "already_owned";
      ownershipId: string;
      canonicalPath: string;
    }
  | {
      status: "opened_v3";
      ownershipId: string;
      canonicalPath: string;
      peerWindowLabel?: string;
      doc: V3AnyDocumentOpenResult;
    }
  | {
      status: "needs_legacy_path";
      ownershipId: string;
      canonicalPath: string;
      peerWindowLabel?: string;
      format: PrgFormat;
    };

export interface V3SyncResult {
  revision: number;
}

export interface LegacyPrgEntry {
  path: string;
  relPath: string;
  sizeBytes: number;
}

export interface LegacyScanReport {
  root: string;
  files: LegacyPrgEntry[];
  totalBytes: number;
}

export interface BackupResult {
  backupDir: string;
  backedUpCount: number;
  totalBytes: number;
}

export interface SingleBackupResult {
  backupPath: string;
}

export interface MigrationSessionInfo {
  sessionId: string;
  tmpPath: string;
}

export interface V3MigrationCounts {
  entities: number;
  edges: number;
  associations: number;
  attachments: number;
}

export interface V3MigrationMeta {
  docId: string;
  formatVersion: string;
  entityCount: number;
  edgeCount: number;
  associationCount: number;
  attachmentCount: number;
}

export interface CheckpointSnapshotResult {
  checkpointed: boolean;
  snapshotPath?: string | null;
}

export type ChangeSource = "command" | "undo" | "redo";

export interface V3CellKey {
  entityUuid: string;
  colId: string;
}

export interface DocChangeSet {
  docId: string;
  canonicalPath: string;
  revision: number;
  originWindow: string;
  source: ChangeSource;
  dirtyEntities: V3EntityRecord[];
  deletedEntityUuids: string[];
  dirtyEdges: V3EdgeRecord[];
  deletedEdgeUuids: string[];
  dirtyAssociations: V3AssociationRecord[];
  deletedAssociationUuids: string[];
  dirtyCells: V3CellValueRecord[];
  deletedCells: V3CellKey[];
  schemaChanged: boolean;
  tableColumns?: V3TableColumnRecord[] | null;
  tableViews?: V3TableViewRecord[] | null;
  tableMetaJson?: string | null;
  metadataChanged: boolean;
  tags?: string[] | null;
  references?: { sections: Record<string, string[]>; files: string[] } | null;
  readme?: string | null;
  canUndo: boolean;
  canRedo: boolean;
  undoCursor: number;
}

export interface HistoryStateInfo {
  canUndo: boolean;
  canRedo: boolean;
  undoCursor: number;
  totalEntries: number;
}

export interface EntityMoveItem {
  uuid: string;
  x: number;
  y: number;
}

export interface EntityBoundsItem {
  uuid: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface EntityStylePatch {
  uuid: string;
  propsPatch: Record<string, unknown>;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface EdgeStylePatch {
  uuid: string;
  propsPatch: Record<string, unknown>;
  text?: string;
}

export interface AssociationStylePatch {
  uuid: string;
  propsPatch: Record<string, unknown>;
}

export interface ReparentItem {
  uuid: string;
  parentSectionUuid: string | null;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
}

export interface SectionChildOrderPatch {
  sectionUuid: string;
  childOrder: string[];
}

export interface CellMutationItem {
  entityUuid: string;
  colId: string;
  value: V3CellValueRecord | null;
}

export interface FormulaCacheEntry {
  entityUuid: string;
  colId: string;
  canonicalKey: string;
  kind: string;
  displayText: string;
  valNum?: number | null;
  valDateMs?: number | null;
  valJson?: string | null;
  isVolatile: boolean;
  computedDay?: string | null;
}

export type DocCommand =
  | { type: "move_entities"; moves: EntityMoveItem[]; sectionBounds?: EntityBoundsItem[] }
  | {
      type: "resize_entity";
      uuid: string;
      x: number;
      y: number;
      w: number;
      h: number;
      sizeAdjust?: string;
      scale?: number;
      sectionBounds?: EntityBoundsItem[];
    }
  | { type: "toggle_section_collapse"; uuid: string; isCollapsed: boolean }
  | { type: "toggle_branch_collapse"; edgeUuids: string[]; isBranchCollapsed: boolean }
  | { type: "update_view_camera"; x: number; y: number; scale: number }
  | {
      type: "set_style_props";
      entityPatches?: EntityStylePatch[];
      edgePatches?: EdgeStylePatch[];
      associationPatches?: AssociationStylePatch[];
    }
  | {
      type: "create_entities";
      entities: V3EntityRecord[];
      sectionChildOrders?: SectionChildOrderPatch[];
      sectionBounds?: EntityBoundsItem[];
    }
  | {
      type: "delete_entities";
      uuids: string[];
      sectionChildOrders?: SectionChildOrderPatch[];
      sectionBounds?: EntityBoundsItem[];
    }
  | {
      type: "update_entity_text";
      uuid: string;
      text: string;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      propsPatch?: Record<string, unknown>;
      sectionBounds?: EntityBoundsItem[];
    }
  | { type: "update_entity_details"; uuid: string; detailsJson: string; detailsPlain: string }
  | {
      type: "promote_text_to_section";
      uuid: string;
      propsJson: string;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      touchUpdatedAt?: boolean;
    }
  | {
      type: "demote_section_to_text";
      uuid: string;
      propsJson: string;
      x?: number;
      y?: number;
      w?: number;
      h?: number;
      touchUpdatedAt?: boolean;
    }
  | {
      type: "reparent_entities";
      items: ReparentItem[];
      sectionChildOrders?: SectionChildOrderPatch[];
      sectionBounds?: EntityBoundsItem[];
    }
  | {
      type: "add_entity_image";
      imageEntity: V3EntityRecord;
      parentSectionUuid: string;
      sectionChildOrder?: string[];
      sectionBounds?: EntityBoundsItem[];
    }
  | {
      type: "remove_entity_image";
      imageUuid: string;
      parentSectionUuid: string;
      sectionChildOrder?: string[];
      sectionBounds?: EntityBoundsItem[];
    }
  | { type: "upsert_entities"; entities: V3EntityRecord[]; touchUpdatedAt?: boolean }
  | { type: "create_edges"; edges: V3EdgeRecord[] }
  | { type: "delete_edges"; uuids: string[] }
  | { type: "update_edge"; edge: V3EdgeRecord }
  | { type: "upsert_association"; association: V3AssociationRecord }
  | { type: "delete_association"; uuid: string }
  | { type: "update_cells"; updates: CellMutationItem[]; touchUpdatedAt: boolean }
  | { type: "upsert_column"; column: V3TableColumnRecord }
  | { type: "delete_column"; id: string }
  | { type: "reorder_columns"; orderedIds: string[] }
  | { type: "upsert_view"; view: V3TableViewRecord }
  | { type: "delete_view"; id: string }
  | { type: "reorder_views"; orderedIds: string[] }
  | { type: "update_table_meta"; tableMetaJson: string }
  | { type: "update_formula_cache_batch"; entries: FormulaCacheEntry[] }
  | {
      type: "update_doc_metadata";
      tags?: string[];
      references?: { sections: Record<string, string[]>; files: string[] };
      readme?: string | null;
      extensionJson?: string | null;
    }
  | { type: "batch"; commands: DocCommand[] };

export interface ApplyCommandsRequest {
  docId: string;
  commands: DocCommand[];
  label?: string;
  recordHistory?: boolean;
  nowMs?: number;
  maxHistorySize?: number;
}

export interface TableColumnFilterQueryInput {
  columnId: string;
  values: string[];
  includeEmpty: boolean;
}

export interface TableFilterConditionQueryInput {
  id: string;
  columnId: string;
  operator: string;
  value?: string;
  values?: string[];
  datePreset?: string;
}

export interface TableFilterGroupQueryInput {
  conjunction: "and" | "or";
  conditions: TableFilterConditionQueryInput[];
}

export interface TableSortQueryInput {
  columnId: string;
  direction: "asc" | "desc";
}

export interface TableExtraGroupFilterInput {
  columnId: string;
  groupKey: string | null;
  pinnedUuids?: string[];
}

export interface TablePageQuery {
  docId: string;
  offset?: number;
  limit?: number;
  filters?: TableColumnFilterQueryInput[];
  filterGroup?: TableFilterGroupQueryInput | null;
  sort?: TableSortQueryInput | null;
  todayKey?: string;
  extraGroupFilter?: TableExtraGroupFilterInput | null;
}

export interface V3RelationItemRecord {
  uuid: string;
  label: string;
  kind: string;
}

export interface V3ImageItemRecord {
  uuid: string;
  attachmentId: string;
}

export interface V3FormulaCellRecord {
  kind: "empty" | "number" | "string" | "boolean" | "date" | "list" | "row" | "error";
  displayText: string;
  numericValue?: number | null;
  dateMs?: number | null;
  dateHasTime?: boolean | null;
  booleanValue?: boolean | null;
  listItems?: string[] | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

export interface V3TableRowRecord {
  docId: string;
  uuid: string;
  kind: string;
  primaryText: string;
  editableText: boolean;
  images: V3ImageItemRecord[];
  canEditImages: boolean;
  createdAt: number;
  updatedAt: number;
  parents: V3RelationItemRecord[];
  children: V3RelationItemRecord[];
  outer: V3RelationItemRecord | null;
  inner: V3RelationItemRecord[];
  canEditInner: boolean;
  cellValues: V3CellValueRecord[];
  formulaValues: Record<string, V3FormulaCellRecord>;
  sortOrder: number;
  sourceFile?: string | null;
  sourceFolder?: string | null;
  sourceRelPath?: string | null;
}

export interface TablePageResult {
  totalCount: number;
  unfilteredTotalCount: number;
  offset: number;
  limit: number;
  rows: V3TableRowRecord[];
}

export interface TableFilterBucketsQuery {
  docId: string;
  columnId: string;
  search?: string;
  limit?: number;
}

export interface ColumnFilterBucketRecord {
  key: string;
  label: string;
  count: number;
  color?: string | null;
}

export interface TableFilterBucketsResult {
  buckets: ColumnFilterBucketRecord[];
  emptyCount: number;
  totalBuckets: number;
}

export interface TableRelationCandidatesQuery {
  docId: string;
  rowUuid: string;
  relationKind: "parents" | "children" | "outer" | "inner";
  search?: string;
  limit?: number;
}

export interface TableRelationCandidatesResult {
  candidates: V3RelationItemRecord[];
  totalCount: number;
  hasMore: boolean;
}

export interface TableGroupCountsQuery {
  docId: string;
  groupByColumnId: string;
  filters?: TableColumnFilterQueryInput[];
  filterGroup?: TableFilterGroupQueryInput | null;
  todayKey?: string;
}

export interface TableGroupCountItem {
  key: string;
  label: string;
  count: number;
  color?: string | null;
}

export interface TableGroupCountsResult {
  totalCount: number;
  ungroupedCount: number;
  groups: TableGroupCountItem[];
}

export interface TableDateRangeQuery {
  docId: string;
  startColumnId: string;
  endColumnId?: string | null;
  minDate: string;
  maxDate: string;
  filters?: TableColumnFilterQueryInput[];
  filterGroup?: TableFilterGroupQueryInput | null;
  sort?: TableSortQueryInput | null;
  todayKey?: string;
  includeUndated?: boolean;
  undatedLimit?: number;
}

export interface TableDateRangeResult {
  rows: V3TableRowRecord[];
  undatedCount: number;
  undatedRows: V3TableRowRecord[];
  totalFilteredCount: number;
}

export interface DocSearchFtsQuery {
  docId: string;
  query: string;
  limit?: number;
}

export interface DocSearchFtsHit {
  uuid: string;
  objectKind: "entity" | "edge";
  text: string;
  detailsPlain: string;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 构造跨平台 `flux-media` 自定义协议 URL：
 * - Windows WebView2 使用 `http://flux-media.localhost/doc/<docId>/<attId>`
 * - macOS / Linux 使用 `flux-media://localhost/doc/<docId>/<attId>`
 */
function isWindowsRuntime(): boolean {
  if (typeof navigator === "undefined") return false;
  return /windows/i.test(navigator.userAgent ?? "") || /win/i.test(navigator.platform ?? "");
}

export function buildFluxMediaUrl(docId: string, attachmentId: string, options?: { thumb?: boolean }): string {
  const encodedDoc = encodeURIComponent(docId);
  const encodedAtt = encodeURIComponent(attachmentId);
  const query = options?.thumb ? "?thumb=1" : "";
  if (isWindowsRuntime()) {
    return `http://flux-media.localhost/doc/${encodedDoc}/${encodedAtt}${query}`;
  }
  return `flux-media://localhost/doc/${encodedDoc}/${encodedAtt}${query}`;
}

export const DocClient = {
  isAvailable(): boolean {
    return isTauri() && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  },

  async detectFormat(path: string): Promise<PrgFormat> {
    return await invoke<PrgFormat>("doc_detect_format", { path });
  },

  async openDocument(path: string): Promise<V3DocumentOpenResult> {
    return await invoke<V3DocumentOpenResult>("doc_open", { path });
  },

  async openDocumentWithOwnership(path: string): Promise<DocOpenWithOwnershipResponse> {
    return await invoke<DocOpenWithOwnershipResponse>("doc_open_with_ownership", { path });
  },

  async openTempDraft(): Promise<V3DocumentOpenResult> {
    return await invoke<V3DocumentOpenResult>("doc_open_temp_draft");
  },

  async applyCommands(request: ApplyCommandsRequest): Promise<DocChangeSet> {
    return await invoke<DocChangeSet>("doc_apply_commands", { request });
  },

  async undo(docId: string): Promise<DocChangeSet | null> {
    return await invoke<DocChangeSet | null>("doc_undo", { docId });
  },

  async redo(docId: string): Promise<DocChangeSet | null> {
    return await invoke<DocChangeSet | null>("doc_redo", { docId });
  },

  async clearHistory(docId: string): Promise<HistoryStateInfo> {
    return await invoke<HistoryStateInfo>("doc_clear_history", { docId });
  },

  async getHistoryState(docId: string): Promise<HistoryStateInfo> {
    return await invoke<HistoryStateInfo>("doc_get_history_state", { docId });
  },

  async syncSnapshot(docId: string, snapshot: V3ImportPayload): Promise<V3SyncResult> {
    return await invoke<V3SyncResult>("doc_sync_snapshot", { docId, snapshot });
  },

  async closeDocument(docId: string): Promise<void> {
    await invoke<void>("doc_close", { docId });
  },

  async releasePath(path: string): Promise<void> {
    if (!DocClient.isAvailable()) return;
    await invoke<void>("doc_release_path", { path });
  },

  async releaseUnderPrefix(prefix: string): Promise<void> {
    if (!DocClient.isAvailable()) return;
    await invoke<void>("doc_release_under_prefix", { prefix });
  },

  async putAttachment(
    docId: string,
    attachmentId: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<V3AttachmentMeta> {
    return await invoke<V3AttachmentMeta>("doc_put_attachment", bytes, {
      headers: {
        "x-doc-id-b64": utf8ToBase64(docId),
        "x-attachment-id-b64": utf8ToBase64(attachmentId),
        "x-mime-type-b64": utf8ToBase64(mimeType || "application/octet-stream"),
      },
    });
  },

  async checkpointAndSnapshot(docId: string, snapshotPath?: string | null): Promise<CheckpointSnapshotResult> {
    return await invoke<CheckpointSnapshotResult>("doc_checkpoint_and_snapshot", {
      docId,
      snapshotPath: snapshotPath ?? null,
    });
  },

  async scanWorkspaceLegacyPrg(root: string): Promise<LegacyScanReport> {
    return await invoke<LegacyScanReport>("doc_scan_workspace_legacy_prg", { root });
  },

  async backupLegacyFiles(root: string, files: string[]): Promise<BackupResult> {
    return await invoke<BackupResult>("doc_backup_legacy_files", { root, files });
  },

  async backupSingleLegacyFile(path: string): Promise<SingleBackupResult> {
    return await invoke<SingleBackupResult>("doc_backup_single_legacy_file", { path });
  },

  async migrationBegin(targetPath: string): Promise<MigrationSessionInfo> {
    return await invoke<MigrationSessionInfo>("doc_migration_begin", { targetPath });
  },

  async migrationPutAttachment(
    sessionId: string,
    attachmentId: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<V3AttachmentMeta> {
    return await invoke<V3AttachmentMeta>("doc_migration_put_attachment", bytes, {
      headers: {
        "x-session-id-b64": utf8ToBase64(sessionId),
        "x-attachment-id-b64": utf8ToBase64(attachmentId),
        "x-mime-type-b64": utf8ToBase64(mimeType || "application/octet-stream"),
      },
    });
  },

  async migrationCopyAttachments(sessionId: string, sourceDocId: string): Promise<number> {
    return await invoke<number>("doc_migration_copy_attachments", { sessionId, sourceDocId });
  },

  async migrationCommit(
    sessionId: string,
    snapshot: V3ImportPayload,
    expectedCounts: V3MigrationCounts,
  ): Promise<V3MigrationMeta> {
    return await invoke<V3MigrationMeta>("doc_migration_commit", {
      sessionId,
      snapshot,
      expectedCounts,
    });
  },

  async migrationAbort(sessionId: string): Promise<void> {
    await invoke<void>("doc_migration_abort", { sessionId });
  },

  async queryTablePage(query: TablePageQuery): Promise<TablePageResult> {
    return await invoke<TablePageResult>("table_query_page", { query });
  },

  async queryTableFilterBuckets(query: TableFilterBucketsQuery): Promise<TableFilterBucketsResult> {
    return await invoke<TableFilterBucketsResult>("table_query_filter_buckets", { query });
  },

  async queryTableRelationCandidates(query: TableRelationCandidatesQuery): Promise<TableRelationCandidatesResult> {
    return await invoke<TableRelationCandidatesResult>("table_query_relation_candidates", { query });
  },

  async queryTableGroupCounts(query: TableGroupCountsQuery): Promise<TableGroupCountsResult> {
    return await invoke<TableGroupCountsResult>("table_query_group_counts", { query });
  },

  async queryTableDateRange(query: TableDateRangeQuery): Promise<TableDateRangeResult> {
    return await invoke<TableDateRangeResult>("table_query_date_range", { query });
  },

  async searchDocFts(query: DocSearchFtsQuery): Promise<DocSearchFtsHit[]> {
    return await invoke<DocSearchFtsHit[]>("doc_search_fts", { query });
  },
};
