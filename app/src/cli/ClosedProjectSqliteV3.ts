import { Project, ProjectState } from "@/core/Project";
import type {
  V3AssociationRecord,
  V3AttachmentMeta,
  V3CellValueRecord,
  V3DocumentOpenResult,
  V3EdgeRecord,
  V3EntityRecord,
  V3MultiOptionEntry,
  V3TableColumnRecord,
  V3TableViewRecord,
} from "@/core/sqlite/DocClient";
import { hydrateV3OpenResult, serializeProjectToV3Payload } from "@/core/sqlite/V3Serializer";
import { StageManager } from "@/core/stage/stageManager/StageManager";
import { URI } from "vscode-uri";
import { FileSystemProviderFile } from "./ClosedProjectFileSystemProvider";

const SQLITE_MAGIC_BYTES = [
  0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x20, 0x66, 0x6f, 0x72, 0x6d, 0x61, 0x74, 0x20, 0x33, 0x00,
];

interface NodeSqliteStatement {
  all(...params: unknown[]): Array<Record<string, unknown>>;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  run(...params: unknown[]): unknown;
}

interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}

async function openNodeSqliteDatabase(filePath: string, readOnly: boolean): Promise<NodeSqliteDatabase> {
  const modName = "node:sqlite";
  const mod = (await import(/* @vite-ignore */ modName)) as {
    DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => NodeSqliteDatabase;
  };
  return new mod.DatabaseSync(filePath, { readOnly });
}

/** 仅检测前 16 字节是否匹配 `"SQLite format 3\0"` 魔数。 */
export function isSqliteV3Buffer(bytes: Uint8Array): boolean {
  if (bytes.length < SQLITE_MAGIC_BYTES.length) return false;
  for (let i = 0; i < SQLITE_MAGIC_BYTES.length; i++) {
    if (bytes[i] !== SQLITE_MAGIC_BYTES[i]) return false;
  }
  return true;
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Node.js CLI / AI Tools 无 Tauri 环境下直接读取 SQLite v3.0.0 `.prg` 文件。
 */
export async function readClosedV3SqliteDocument(canonicalPath: string): Promise<V3DocumentOpenResult> {
  const db = await openNodeSqliteDatabase(canonicalPath, true);
  try {
    db.exec("PRAGMA busy_timeout = 5000;");
    const metaRows = db.prepare("SELECT key, value FROM metadata").all();
    const meta = new Map<string, string>();
    for (const row of metaRows) {
      meta.set(String(row.key ?? ""), String(row.value ?? ""));
    }

    const docId = meta.get("docId") || meta.get("doc_id") || crypto.randomUUID();
    const formatVersion = meta.get("format_version") || "3.0.0";
    const revision = Number(meta.get("revision") ?? "1") || 1;
    const readme = meta.get("readme") ?? null;
    const tags = safeJsonParse<string[]>(meta.get("tags_json"), []);
    const references = safeJsonParse<{ sections: Record<string, string[]>; files: string[] }>(
      meta.get("references_json"),
      { sections: {}, files: [] },
    );
    const extensionJson = meta.get("extension_json") ?? null;
    const tableMetaJson = meta.get("table_meta_json") || "{}";

    const entities: V3EntityRecord[] = db
      .prepare(
        `SELECT uuid, kind, parent_section_uuid, text, details_json, details_plain,
                x, y, w, h, props_json, created_at, updated_at, is_row, sort_order
         FROM entities
         ORDER BY sort_order ASC, uuid ASC`,
      )
      .all()
      .map((r) => ({
        uuid: String(r.uuid),
        kind: String(r.kind) as V3EntityRecord["kind"],
        parentSectionUuid: r.parent_section_uuid ? String(r.parent_section_uuid) : null,
        text: String(r.text ?? ""),
        detailsJson: String(r.details_json ?? "[]"),
        detailsPlain: String(r.details_plain ?? ""),
        x: Number(r.x ?? 0),
        y: Number(r.y ?? 0),
        w: Number(r.w ?? 100),
        h: Number(r.h ?? 50),
        propsJson: String(r.props_json ?? "{}"),
        createdAt: Number(r.created_at ?? 0),
        updatedAt: Number(r.updated_at ?? 0),
        isRow: Number(r.is_row ?? 1) !== 0,
        sortOrder: Number(r.sort_order ?? 0),
      }));

    const edges: V3EdgeRecord[] = db
      .prepare(
        `SELECT uuid, kind, source_uuid, target_uuid, text, props_json, sort_order
         FROM edges
         ORDER BY sort_order ASC, uuid ASC`,
      )
      .all()
      .map((r) => ({
        uuid: String(r.uuid),
        kind: String(r.kind) as V3EdgeRecord["kind"],
        sourceUuid: String(r.source_uuid),
        targetUuid: String(r.target_uuid),
        text: String(r.text ?? ""),
        propsJson: String(r.props_json ?? "{}"),
        sortOrder: Number(r.sort_order ?? 0),
      }));

    const associations: V3AssociationRecord[] = db
      .prepare(
        `SELECT uuid, kind, member_uuids_json, props_json, sort_order
         FROM associations
         ORDER BY sort_order ASC, uuid ASC`,
      )
      .all()
      .map((r) => ({
        uuid: String(r.uuid),
        kind: String(r.kind) as V3AssociationRecord["kind"],
        memberUuidsJson: String(r.member_uuids_json ?? "[]"),
        propsJson: String(r.props_json ?? "{}"),
        sortOrder: Number(r.sort_order ?? 0),
      }));

    const tableColumns: V3TableColumnRecord[] = db
      .prepare(
        `SELECT id, canonical_key, name, type, position, config_json
         FROM table_columns
         ORDER BY position ASC`,
      )
      .all()
      .map((r) => ({
        id: String(r.id),
        canonicalKey: String(r.canonical_key),
        name: String(r.name),
        type: String(r.type),
        position: Number(r.position ?? 0),
        configJson: String(r.config_json ?? "{}"),
      }));

    const tableViews: V3TableViewRecord[] = db
      .prepare(
        `SELECT id, name, type, deletable, position, config_json
         FROM table_views
         ORDER BY position ASC`,
      )
      .all()
      .map((r) => ({
        id: String(r.id),
        name: String(r.name),
        type: String(r.type),
        deletable: Number(r.deletable ?? 1) !== 0,
        position: Number(r.position ?? 0),
        configJson: String(r.config_json ?? "{}"),
      }));

    const multiByCell = new Map<string, V3MultiOptionEntry[]>();
    for (const r of db.prepare("SELECT entity_uuid, col_id, option_id, option_name FROM cell_multi_options").all()) {
      const key = `${String(r.entity_uuid)}\u0000${String(r.col_id)}`;
      const list = multiByCell.get(key) ?? [];
      list.push({ optionId: String(r.option_id), optionName: String(r.option_name) });
      multiByCell.set(key, list);
    }

    const cellValues: V3CellValueRecord[] = db
      .prepare(
        `SELECT entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json
         FROM cell_values`,
      )
      .all()
      .map((r) => {
        const entityUuid = String(r.entity_uuid);
        const colId = String(r.col_id);
        return {
          entityUuid,
          colId,
          canonicalKey: String(r.canonical_key),
          valType: String(r.val_type) as V3CellValueRecord["valType"],
          valText: r.val_text !== null && r.val_text !== undefined ? String(r.val_text) : null,
          valNum: r.val_num !== null && r.val_num !== undefined ? Number(r.val_num) : null,
          valDate: r.val_date !== null && r.val_date !== undefined ? String(r.val_date) : null,
          valJson: r.val_json !== null && r.val_json !== undefined ? String(r.val_json) : null,
          multiOptions: multiByCell.get(`${entityUuid}\u0000${colId}`) ?? [],
        };
      });

    const attachments: V3AttachmentMeta[] = db
      .prepare(
        `SELECT id, mime, width, height, size_bytes, (thumb_blob IS NOT NULL) AS has_thumb
         FROM attachments`,
      )
      .all()
      .map((r) => ({
        id: String(r.id),
        mime: String(r.mime ?? "application/octet-stream"),
        width: r.width !== null && r.width !== undefined ? Number(r.width) : null,
        height: r.height !== null && r.height !== undefined ? Number(r.height) : null,
        sizeBytes: Number(r.size_bytes ?? 0),
        hasThumb: Number(r.has_thumb ?? 0) !== 0,
      }));

    return {
      canonicalPath,
      docId,
      formatVersion,
      revision,
      readme,
      tags,
      references,
      extensionJson,
      tableMetaJson,
      entities,
      edges,
      associations,
      tableColumns,
      tableViews,
      cellValues,
      attachments,
    };
  } finally {
    db.close();
  }
}

export async function createClosedSqliteV3Project(
  canonicalPath: string,
  attachments: Map<string, Blob>,
): Promise<{
  project: Project;
  formatVersion: string;
  dispose(): Promise<void>;
}> {
  const opened = await readClosedV3SqliteDocument(canonicalPath);
  const project = new Project(URI.file(canonicalPath));
  project.registerFileSystemProvider("file", FileSystemProviderFile);
  project.attachments = attachments;
  project.storageFormat = "v3_sqlite";
  project.v3DocId = opened.docId;
  project.v3Revision = opened.revision;
  const hydrated = hydrateV3OpenResult(project, opened);
  project.tags = hydrated.tags;
  project.references = hydrated.references;
  project.metadata = hydrated.metadata;
  project.table = hydrated.table;
  project.readme = hydrated.readme;
  project.stage = hydrated.stage;
  project.loadService(StageManager);
  project.stageManager.updateReferences();
  project.projectState = ProjectState.Saved;

  return {
    project,
    formatVersion: opened.formatVersion,
    async dispose() {
      await project.dispose();
      project.stage.length = 0;
    },
  };
}

/**
 * 将 CLI / AI Tools 修改后的 SQLite v3.0.0 `Project` 原子事务回写到原 `.prg` 数据库，
 * 同步重建 R-Tree / FTS5 索引并保留既有二进制附件与历史操作表。
 */
export async function saveClosedV3SqliteProject(canonicalPath: string, project: Project): Promise<void> {
  const payload = serializeProjectToV3Payload({
    docId: project.v3DocId || project.metadata.docId || crypto.randomUUID(),
    metadata: project.metadata,
    stage: project.stage,
    tags: project.tags,
    references: project.references,
    table: project.table,
    readme: project.readme,
  });

  // 预先把新增/变更的附件 Blob 转为字节，避免在事务内执行 async IO
  const pendingAttachments: Array<{ id: string; mime: string; bytes: Uint8Array }> = [];
  for (const [id, blob] of project.attachments.entries()) {
    pendingAttachments.push({
      id,
      mime: blob.type || "application/octet-stream",
      bytes: new Uint8Array(await blob.arrayBuffer()),
    });
  }

  const db = await openNodeSqliteDatabase(canonicalPath, false);
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    db.exec("BEGIN IMMEDIATE;");
    try {
      const revRow = db.prepare("SELECT value FROM metadata WHERE key = 'revision'").get();
      const nextRev = (Number(revRow?.value ?? "0") || 0) + 1;

      const upsertMeta = db.prepare(
        "INSERT INTO metadata(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      upsertMeta.run("schema_version", "3");
      upsertMeta.run("docId", payload.docId);
      upsertMeta.run("format_version", payload.formatVersion || "3.0.0");
      upsertMeta.run("revision", String(nextRev));
      upsertMeta.run("tags_json", JSON.stringify(payload.tags));
      upsertMeta.run("references_json", JSON.stringify(payload.references));
      upsertMeta.run("table_meta_json", payload.tableMetaJson);
      if (payload.readme !== undefined && payload.readme !== null) {
        upsertMeta.run("readme", payload.readme);
      } else {
        db.prepare("DELETE FROM metadata WHERE key = 'readme'").run();
      }
      if (payload.extensionJson !== undefined && payload.extensionJson !== null) {
        upsertMeta.run("extension_json", payload.extensionJson);
      } else {
        db.prepare("DELETE FROM metadata WHERE key = 'extension_json'").run();
      }

      db.exec(`
        DELETE FROM cell_multi_options;
        DELETE FROM cell_values;
        DELETE FROM formula_cache;
        DELETE FROM table_views;
        DELETE FROM table_columns;
        DELETE FROM associations;
        DELETE FROM edges;
        DELETE FROM entities_fts;
        DELETE FROM entities_rtree;
        DELETE FROM entity_rtree_map;
        DELETE FROM entities;
      `);

      const insertEntity = db.prepare(
        `INSERT INTO entities(
           uuid, kind, parent_section_uuid, text, details_json, details_plain,
           x, y, w, h, props_json, created_at, updated_at, is_row, sort_order
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertRtreeMap = db.prepare("INSERT INTO entity_rtree_map(uuid) VALUES (?)");
      const getRtreeId = db.prepare("SELECT rtree_id FROM entity_rtree_map WHERE uuid = ?");
      const insertRtree = db.prepare(
        "INSERT INTO entities_rtree(id, min_x, max_x, min_y, max_y) VALUES (?, ?, ?, ?, ?)",
      );
      const insertFts = db.prepare("INSERT INTO entities_fts(uuid, text, details_plain) VALUES (?, ?, ?)");

      for (const e of payload.entities) {
        insertEntity.run(
          e.uuid,
          e.kind,
          e.parentSectionUuid,
          e.text,
          e.detailsJson,
          e.detailsPlain,
          e.x,
          e.y,
          e.w,
          e.h,
          e.propsJson,
          e.createdAt,
          e.updatedAt,
          e.isRow ? 1 : 0,
          e.sortOrder,
        );
        insertRtreeMap.run(e.uuid);
        const rtreeRow = getRtreeId.get(e.uuid);
        if (rtreeRow?.rtree_id !== undefined) {
          insertRtree.run(Number(rtreeRow.rtree_id), e.x, e.x + Math.max(0, e.w), e.y, e.y + Math.max(0, e.h));
        }
        insertFts.run(e.uuid, e.text, e.detailsPlain);
      }

      const insertEdge = db.prepare(
        `INSERT INTO edges(uuid, kind, source_uuid, target_uuid, text, props_json, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const edge of payload.edges) {
        insertEdge.run(
          edge.uuid,
          edge.kind,
          edge.sourceUuid,
          edge.targetUuid,
          edge.text,
          edge.propsJson,
          edge.sortOrder,
        );
      }

      const insertAssoc = db.prepare(
        `INSERT INTO associations(uuid, kind, member_uuids_json, props_json, sort_order)
         VALUES (?, ?, ?, ?, ?)`,
      );
      for (const assoc of payload.associations) {
        insertAssoc.run(assoc.uuid, assoc.kind, assoc.memberUuidsJson, assoc.propsJson, assoc.sortOrder);
      }

      const insertCol = db.prepare(
        `INSERT INTO table_columns(id, canonical_key, name, type, position, config_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const col of payload.tableColumns) {
        insertCol.run(col.id, col.canonicalKey, col.name, col.type, col.position, col.configJson);
      }

      const insertView = db.prepare(
        `INSERT INTO table_views(id, name, type, deletable, position, config_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const view of payload.tableViews) {
        insertView.run(view.id, view.name, view.type, view.deletable ? 1 : 0, view.position, view.configJson);
      }

      const insertCell = db.prepare(
        `INSERT INTO cell_values(entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertMulti = db.prepare(
        `INSERT OR IGNORE INTO cell_multi_options(entity_uuid, col_id, option_id, option_name)
         VALUES (?, ?, ?, ?)`,
      );
      for (const cell of payload.cellValues) {
        insertCell.run(
          cell.entityUuid,
          cell.colId,
          cell.canonicalKey,
          cell.valType,
          cell.valText ?? null,
          cell.valNum ?? null,
          cell.valDate ?? null,
          cell.valJson ?? null,
        );
        for (const mo of cell.multiOptions) {
          insertMulti.run(cell.entityUuid, cell.colId, mo.optionId, mo.optionName);
        }
      }

      if (pendingAttachments.length > 0) {
        const upsertAtt = db.prepare(
          `INSERT INTO attachments(id, mime, width, height, size_bytes, thumb_blob, data_blob)
           VALUES (?, ?, NULL, NULL, ?, NULL, ?)
           ON CONFLICT(id) DO UPDATE SET mime = excluded.mime, size_bytes = excluded.size_bytes, data_blob = excluded.data_blob`,
        );
        for (const att of pendingAttachments) {
          upsertAtt.run(att.id, att.mime, att.bytes.byteLength, att.bytes);
        }
      }

      db.exec("COMMIT;");
      project.v3Revision = nextRev;
      project.projectState = ProjectState.Saved;
    } catch (err) {
      db.exec("ROLLBACK;");
      throw err;
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }
}
