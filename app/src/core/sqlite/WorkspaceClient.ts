import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { WorkspaceTableScope } from "@/types/table";
import type {
  DocChangeSet,
  LegacyScanReport,
  TableColumnFilterQueryInput,
  TableDateRangeResult,
  TableExtraGroupFilterInput,
  TableFilterBucketsResult,
  TableFilterGroupQueryInput,
  TableGroupCountsResult,
  TablePageResult,
  TableRelationCandidatesQuery,
  TableRelationCandidatesResult,
  TableSortQueryInput,
} from "./DocClient";

export interface WorkspaceDocRecord {
  docId: string;
  relPath: string;
  folderPath: string;
  title: string;
  mtimeMs: number;
  fileSize: number;
  revision: number;
  formatVersion: string;
  absPath: string;
}

export interface WorkspaceColumnOption {
  id: string;
  name: string;
  color: string;
}

export interface WorkspaceColumnRecord {
  canonicalKey: string;
  name: string;
  type: string;
  isShared: boolean;
  configJson: string;
  docCount: number;
}

export interface WorkspaceViewRecord {
  id: string;
  name: string;
  type: string;
  deletable: boolean;
  position: number;
  scope: WorkspaceTableScope;
  configJson: string;
}

export interface WorkspaceSyncStats {
  totalDocs: number;
  indexedDocs: number;
  skippedDocs: number;
  removedDocs: number;
  legacyV2Docs: number;
  elapsedMs: number;
}

export interface WorkspaceOpenResult {
  root: string;
  indexPath: string;
  legacyReport: LegacyScanReport;
  syncStats: WorkspaceSyncStats;
  docs: WorkspaceDocRecord[];
  columns: WorkspaceColumnRecord[];
  views: WorkspaceViewRecord[];
  metaJson: string;
}

export interface WorkspaceIndexUpdatedPayload {
  root: string;
  reason: string;
  docIds: string[];
}

export interface WorkspaceTablePageQuery {
  scope: WorkspaceTableScope;
  offset?: number;
  limit?: number;
  filters?: TableColumnFilterQueryInput[];
  filterGroup?: TableFilterGroupQueryInput | null;
  sort?: TableSortQueryInput | null;
  todayKey?: string;
  extraGroupFilter?: TableExtraGroupFilterInput | null;
}

export interface WorkspaceTableFilterBucketsQuery {
  scope: WorkspaceTableScope;
  columnId: string;
  search?: string;
  limit?: number;
}

export interface WorkspaceTableGroupCountsQuery {
  scope: WorkspaceTableScope;
  groupByColumnId: string;
  filters?: TableColumnFilterQueryInput[];
  filterGroup?: TableFilterGroupQueryInput | null;
  todayKey?: string;
}

export interface WorkspaceTableDateRangeQuery {
  scope: WorkspaceTableScope;
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

export interface WorkspaceSearchFtsQuery {
  query: string;
  scope?: WorkspaceTableScope | null;
  limit?: number;
}

export interface WorkspaceSearchFtsHit {
  docId: string;
  relPath: string;
  folderPath: string;
  title: string;
  uuid: string;
  kind: string;
  text: string;
  detailsPlain: string;
}

export interface WorkspaceCellWriteInput {
  canonicalKey: string;
  value: unknown | null;
}

export interface SpacedRepetitionSnapshotDto {
  mastery?: number | null;
  correctCount?: number | null;
  delay?: number | null;
  answerDate?: string | null;
}

export interface WorkspaceAnswerSrResult {
  changeset: DocChangeSet;
  snapshot: SpacedRepetitionSnapshotDto;
}

export interface WorkspaceCreateRowResult {
  docId: string;
  uuid: string;
  changeset: DocChangeSet;
}

export interface WorkspacePathSyncResult {
  updatedDocs: number;
  updatedRefDocs: DocChangeSet[];
}

export interface WorkspaceBacklinkRecord {
  sourceDocId: string;
  sourceRelPath: string;
  sourceTitle: string;
  sourceUuid: string;
  targetDocId: string;
  targetSectionName: string;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export const WorkspaceClient = {
  isAvailable(): boolean {
    return isTauri() && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  },

  async openWorkspace(root: string): Promise<WorkspaceOpenResult> {
    return await invoke<WorkspaceOpenResult>("ws_open", { root });
  },

  async closeWorkspace(): Promise<void> {
    if (!WorkspaceClient.isAvailable()) return;
    await invoke<void>("ws_close");
  },

  async syncIncremental(): Promise<WorkspaceSyncStats> {
    return await invoke<WorkspaceSyncStats>("ws_sync_incremental");
  },

  async syncFile(path: string): Promise<string | null> {
    if (!WorkspaceClient.isAvailable()) return null;
    return await invoke<string | null>("ws_sync_file", { path });
  },

  async listDocs(): Promise<WorkspaceDocRecord[]> {
    return await invoke<WorkspaceDocRecord[]>("ws_list_docs");
  },

  async listColumns(): Promise<WorkspaceColumnRecord[]> {
    return await invoke<WorkspaceColumnRecord[]>("ws_list_columns");
  },

  async ensureSrColumns(): Promise<WorkspaceColumnRecord[]> {
    return await invoke<WorkspaceColumnRecord[]>("ws_ensure_sr_columns");
  },

  async createSharedColumn(name: string, colType: string, configJson?: string | null): Promise<WorkspaceColumnRecord> {
    return await invoke<WorkspaceColumnRecord>("ws_create_shared_column", {
      name,
      colType,
      configJson: configJson ?? null,
    });
  },

  async createOrGetOption(canonicalKey: string, optionName: string): Promise<WorkspaceColumnOption> {
    return await invoke<WorkspaceColumnOption>("ws_create_or_get_option", {
      canonicalKey,
      optionName,
    });
  },

  async promoteColumnToShared(sourceCanonicalKey: string, targetName?: string | null): Promise<WorkspaceColumnRecord> {
    return await invoke<WorkspaceColumnRecord>("ws_promote_column_to_shared", {
      sourceCanonicalKey,
      targetName: targetName ?? null,
    });
  },

  async mergeColumns(sourceCanonicalKeys: string[], targetCanonicalKey: string): Promise<WorkspaceColumnRecord> {
    return await invoke<WorkspaceColumnRecord>("ws_merge_columns", {
      sourceCanonicalKeys,
      targetCanonicalKey,
    });
  },

  async listViews(): Promise<WorkspaceViewRecord[]> {
    return await invoke<WorkspaceViewRecord[]>("ws_list_views");
  },

  async upsertView(view: WorkspaceViewRecord): Promise<void> {
    await invoke<void>("ws_upsert_view", { view });
  },

  async deleteView(viewId: string): Promise<void> {
    await invoke<void>("ws_delete_view", { viewId });
  },

  async reorderViews(orderedIds: string[]): Promise<void> {
    await invoke<void>("ws_reorder_views", { orderedIds });
  },

  async getTableMeta(): Promise<string> {
    return await invoke<string>("ws_get_table_meta");
  },

  async updateTableMeta(metaJson: string): Promise<void> {
    await invoke<void>("ws_update_table_meta", { metaJson });
  },

  async queryTablePage(query: WorkspaceTablePageQuery): Promise<TablePageResult> {
    return await invoke<TablePageResult>("ws_table_query_page", { query });
  },

  async queryTableFilterBuckets(query: WorkspaceTableFilterBucketsQuery): Promise<TableFilterBucketsResult> {
    return await invoke<TableFilterBucketsResult>("ws_table_query_filter_buckets", { query });
  },

  async queryTableGroupCounts(query: WorkspaceTableGroupCountsQuery): Promise<TableGroupCountsResult> {
    return await invoke<TableGroupCountsResult>("ws_table_query_group_counts", { query });
  },

  async queryTableDateRange(query: WorkspaceTableDateRangeQuery): Promise<TableDateRangeResult> {
    return await invoke<TableDateRangeResult>("ws_table_query_date_range", { query });
  },

  async queryRelationCandidates(query: TableRelationCandidatesQuery): Promise<TableRelationCandidatesResult> {
    return await invoke<TableRelationCandidatesResult>("ws_table_query_relation_candidates", { query });
  },

  async searchFts(query: WorkspaceSearchFtsQuery): Promise<WorkspaceSearchFtsHit[]> {
    return await invoke<WorkspaceSearchFtsHit[]>("ws_search_fts", { query });
  },

  async updateRowText(docId: string, rowUuid: string, text: string): Promise<DocChangeSet> {
    return await invoke<DocChangeSet>("ws_update_row_text", { docId, rowUuid, text });
  },

  async updateRowCells(
    docId: string,
    rowUuid: string,
    updates: WorkspaceCellWriteInput[],
    touchUpdatedAt = true,
    todayKey?: string,
  ): Promise<DocChangeSet> {
    return await invoke<DocChangeSet>("ws_update_row_cells", {
      docId,
      rowUuid,
      updates,
      touchUpdatedAt,
      todayKey: todayKey ?? null,
    });
  },

  async answerSpacedRepetition(
    docId: string,
    rowUuid: string,
    choice: string,
    todayKey?: string,
    baseline?: SpacedRepetitionSnapshotDto | null,
  ): Promise<WorkspaceAnswerSrResult> {
    return await invoke<WorkspaceAnswerSrResult>("ws_answer_spaced_repetition", {
      docId,
      rowUuid,
      choice,
      todayKey: todayKey ?? null,
      baseline: baseline ?? null,
    });
  },

  async restoreSpacedRepetition(
    docId: string,
    rowUuid: string,
    snapshot: SpacedRepetitionSnapshotDto,
    todayKey?: string,
  ): Promise<DocChangeSet> {
    return await invoke<DocChangeSet>("ws_restore_spaced_repetition", {
      docId,
      rowUuid,
      snapshot,
      todayKey: todayKey ?? null,
    });
  },

  async addRowImage(
    docId: string,
    rowUuid: string,
    attachmentId: string,
    mimeType: string,
    bytes: Uint8Array,
  ): Promise<DocChangeSet> {
    return await invoke<DocChangeSet>("ws_add_row_image", bytes, {
      headers: {
        "x-doc-id-b64": utf8ToBase64(docId),
        "x-row-uuid-b64": utf8ToBase64(rowUuid),
        "x-attachment-id-b64": utf8ToBase64(attachmentId),
        "x-mime-type-b64": utf8ToBase64(mimeType || "image/png"),
      },
    });
  },

  async removeRowImage(docId: string, rowUuid: string, imageNodeUuid: string): Promise<DocChangeSet> {
    return await invoke<DocChangeSet>("ws_remove_row_image", { docId, rowUuid, imageNodeUuid });
  },

  async setRowRelations(
    docId: string,
    rowUuid: string,
    relationKind: "parents" | "children" | "outer" | "inner",
    targetUuids: string[],
  ): Promise<DocChangeSet> {
    return await invoke<DocChangeSet>("ws_set_row_relations", {
      docId,
      rowUuid,
      relationKind,
      targetUuids,
    });
  },

  async createRow(
    docId: string,
    text: string,
    initialCells?: WorkspaceCellWriteInput[],
  ): Promise<WorkspaceCreateRowResult> {
    return await invoke<WorkspaceCreateRowResult>("ws_create_row", {
      docId,
      text,
      initialCells: initialCells ?? null,
    });
  },

  async notifyPathRenamed(oldPath: string, newPath: string, isDir: boolean): Promise<WorkspacePathSyncResult | null> {
    if (!WorkspaceClient.isAvailable()) return null;
    return await invoke<WorkspacePathSyncResult>("ws_notify_path_renamed", { oldPath, newPath, isDir });
  },

  async notifyPathDeleted(path: string, isDir: boolean): Promise<number> {
    if (!WorkspaceClient.isAvailable()) return 0;
    return await invoke<number>("ws_notify_path_deleted", { path, isDir });
  },

  async reissueCopiedDocIds(copiedPath: string, isDir: boolean): Promise<string[]> {
    if (!WorkspaceClient.isAvailable()) return [];
    return await invoke<string[]>("ws_reissue_copied_doc_ids", { copiedPath, isDir });
  },

  async listBacklinks(targetDocId: string): Promise<WorkspaceBacklinkRecord[]> {
    if (!WorkspaceClient.isAvailable()) return [];
    return await invoke<WorkspaceBacklinkRecord[]>("ws_list_backlinks", { targetDocId });
  },

  async onIndexUpdated(listener: (payload: WorkspaceIndexUpdatedPayload) => void): Promise<UnlistenFn> {
    if (!WorkspaceClient.isAvailable()) {
      return () => {};
    }
    return await listen<WorkspaceIndexUpdatedPayload>("pg-workspace-index-updated", (event) => {
      listener(event.payload);
    });
  },
};
