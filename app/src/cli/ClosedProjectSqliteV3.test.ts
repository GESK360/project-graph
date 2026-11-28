// @vitest-environment jsdom
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Rectangle } from "@graphif/shapes";
import { Vector } from "@graphif/data-structures";

vi.mock("@/core/service/Settings", () => ({
  Settings: {
    watch: vi.fn(() => vi.fn()),
    historyManagerMode: "timeEfficient",
    historySize: 50,
    showDebug: false,
    isEnableEntityCollision: false,
    sectionInitBorderStyle: "solid",
    textNodeInitBorderStyle: "solid",
    defaultEdgeLineType: "solid",
    defaultEdgeArrowType: "default",
    enableAutoEdgeWidth: false,
    hideSectionContentsWhenBigTitleActive: false,
    sectionBitTitleRenderType: "none",
    autoLayoutWhenSectionCollapseToggle: false,
    stageTableAutoFocusCanvasOnSelect: true,
  },
}));
vi.mock("@/core/service/feedbackService/SoundService", () => ({
  SoundService: { play: { entityJumpSoundFile: vi.fn() } },
}));
vi.mock("@/utils/font", () => ({
  getMultiLineTextSize: () => new Vector(60, 30),
  getTextSize: () => new Vector(60, 30),
}));

import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import {
  createClosedSqliteV3Project,
  isSqliteV3Buffer,
  readClosedV3SqliteDocument,
  saveClosedV3SqliteProject,
} from "./ClosedProjectSqliteV3";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function createSqliteV3Fixture(): Promise<{ filePath: string; docId: string }> {
  const dir = mkdtempSync(join(tmpdir(), "fg-cli-sqlite-v3-"));
  tempDirs.push(dir);
  const filePath = join(dir, "sample.prg");
  const docId = "11111111-1111-4111-8111-111111111111";

  const modName = "node:sqlite";
  const { DatabaseSync } = (await import(/* @vite-ignore */ modName)) as {
    DatabaseSync: new (path: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...args: unknown[]): unknown;
        get(...args: unknown[]): Record<string, unknown> | undefined;
        all(...args: unknown[]): Array<Record<string, unknown>>;
      };
      close(): void;
    };
  };

  const db = new DatabaseSync(filePath);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE entities (
        uuid TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        parent_section_uuid TEXT,
        text TEXT NOT NULL DEFAULT '',
        details_json TEXT NOT NULL DEFAULT '[]',
        details_plain TEXT NOT NULL DEFAULT '',
        x REAL NOT NULL DEFAULT 0,
        y REAL NOT NULL DEFAULT 0,
        w REAL NOT NULL DEFAULT 100,
        h REAL NOT NULL DEFAULT 50,
        props_json TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        is_row INTEGER NOT NULL DEFAULT 1,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE entity_rtree_map (
        rtree_id INTEGER PRIMARY KEY AUTOINCREMENT,
        uuid TEXT UNIQUE NOT NULL REFERENCES entities(uuid) ON DELETE CASCADE
      );
      CREATE VIRTUAL TABLE entities_rtree USING rtree(id, min_x, max_x, min_y, max_y);
      CREATE VIRTUAL TABLE entities_fts USING fts5(uuid UNINDEXED, text, details_plain, tokenize='unicode61');
      CREATE TABLE edges (
        uuid TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        source_uuid TEXT NOT NULL,
        target_uuid TEXT NOT NULL,
        text TEXT NOT NULL DEFAULT '',
        props_json TEXT NOT NULL DEFAULT '{}',
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE associations (
        uuid TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        member_uuids_json TEXT NOT NULL,
        props_json TEXT NOT NULL DEFAULT '{}',
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE table_columns (
        id TEXT PRIMARY KEY,
        canonical_key TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        position INTEGER NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE table_views (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        deletable INTEGER NOT NULL DEFAULT 1,
        position INTEGER NOT NULL,
        config_json TEXT NOT NULL
      );
      CREATE TABLE cell_values (
        entity_uuid TEXT NOT NULL REFERENCES entities(uuid) ON DELETE CASCADE,
        col_id TEXT NOT NULL REFERENCES table_columns(id) ON DELETE CASCADE,
        canonical_key TEXT NOT NULL,
        val_type TEXT NOT NULL,
        val_text TEXT,
        val_num REAL,
        val_date TEXT,
        val_json TEXT,
        PRIMARY KEY (entity_uuid, col_id)
      );
      CREATE TABLE cell_multi_options (
        entity_uuid TEXT NOT NULL REFERENCES entities(uuid) ON DELETE CASCADE,
        col_id TEXT NOT NULL REFERENCES table_columns(id) ON DELETE CASCADE,
        option_id TEXT NOT NULL,
        option_name TEXT NOT NULL,
        PRIMARY KEY (entity_uuid, col_id, option_id)
      );
      CREATE TABLE formula_cache (
        entity_uuid TEXT NOT NULL REFERENCES entities(uuid) ON DELETE CASCADE,
        col_id TEXT NOT NULL REFERENCES table_columns(id) ON DELETE CASCADE,
        canonical_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        display_text TEXT NOT NULL DEFAULT '',
        val_num REAL,
        val_date_ms INTEGER,
        val_json TEXT,
        is_volatile INTEGER NOT NULL DEFAULT 0,
        computed_day TEXT,
        PRIMARY KEY (entity_uuid, col_id)
      );
      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        width INTEGER,
        height INTEGER,
        size_bytes INTEGER NOT NULL,
        thumb_blob BLOB,
        data_blob BLOB NOT NULL
      );
      CREATE TABLE history_ops (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        tx_id TEXT NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        undo_ops_json TEXT NOT NULL,
        redo_ops_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);

    const insMeta = db.prepare("INSERT INTO metadata (key, value) VALUES (?, ?)");
    insMeta.run("docId", docId);
    insMeta.run("format_version", "3.0.0");
    insMeta.run("schema_version", "3");
    insMeta.run("revision", "1");
    insMeta.run("tags_json", "[]");
    insMeta.run("references_json", JSON.stringify({ sections: {}, files: [] }));
    insMeta.run("table_meta_json", "{}");

    db.prepare(
      `INSERT INTO entities
       (uuid, kind, parent_section_uuid, text, details_json, details_plain, x, y, w, h, props_json, created_at, updated_at, is_row, sort_order)
       VALUES (?, 'text', NULL, ?, '[]', '', 10, 20, 120, 60, '{}', 1700000000000, 1700000000000, 1, 0)`,
    ).run("node-a", "初始节点");

    db.prepare(
      `INSERT INTO table_columns (id, canonical_key, name, type, position, config_json)
       VALUES ('col_note', 'ws:shared-note', '备注', 'text', 0, '{"canonicalKey":"ws:shared-note"}')`,
    ).run();
    db.prepare(
      `INSERT INTO cell_values (entity_uuid, col_id, canonical_key, val_type, val_text, val_num, val_date, val_json)
       VALUES ('node-a', 'col_note', 'ws:shared-note', 'text', '第一条备注', NULL, NULL, NULL)`,
    ).run();
    db.prepare(
      `INSERT INTO attachments (id, mime, width, height, size_bytes, thumb_blob, data_blob)
       VALUES ('att-keep', 'image/png', 16, 16, 4, ?, ?)`,
    ).run(new Uint8Array([1, 2, 3, 4]), new Uint8Array([9, 8, 7, 6]));
    db.prepare(
      `INSERT INTO history_ops (tx_id, label, undo_ops_json, redo_ops_json, created_at)
       VALUES ('tx-0', 'init', '[]', '[]', 1700000000000)`,
    ).run();

    db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    db.close();
  }

  return { filePath, docId };
}

describe("ClosedProjectSqliteV3", () => {
  it("detects SQLite v3 magic header vs ZIP magic header", async () => {
    const { filePath } = await createSqliteV3Fixture();
    const bytes = new Uint8Array(readFileSync(filePath));
    expect(isSqliteV3Buffer(bytes)).toBe(true);
    expect(isSqliteV3Buffer(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isSqliteV3Buffer(new Uint8Array([1, 2, 3]))).toBe(false);
  });

  it("reads, mutates, and saves SQLite v3.0.0 .prg while updating R-Tree/FTS5 and preserving attachments/history", async () => {
    const { filePath, docId } = await createSqliteV3Fixture();

    const raw = await readClosedV3SqliteDocument(filePath);
    expect(raw.docId).toBe(docId);
    expect(raw.formatVersion).toBe("3.0.0");
    expect(raw.entities).toHaveLength(1);
    expect(raw.entities[0].text).toBe("初始节点");
    expect(raw.tableColumns[0].canonicalKey).toBe("ws:shared-note");

    const opened = await createClosedSqliteV3Project(filePath, new Map());
    try {
      expect(opened.formatVersion).toBe("3.0.0");
      expect(opened.project.isSqliteV3).toBe(true);
      const firstNode = opened.project.stage.find((obj): obj is TextNode => obj instanceof TextNode);
      expect(firstNode?.text).toBe("初始节点");

      // 修改已有节点文本并新增一个节点
      firstNode!.text = "修改后的节点";
      const added = new TextNode(opened.project, {
        uuid: "node-b",
        text: "CLI新增节点 AlphaNode",
        collisionBox: new CollisionBox([new Rectangle(new Vector(300, 400), new Vector(180, 70))]),
      });
      opened.project.stageManager.add(added);

      await saveClosedV3SqliteProject(filePath, opened.project);
    } finally {
      await opened.dispose();
    }

    // 直接用 node:sqlite 校验落盘结果
    const modName = "node:sqlite";
    const { DatabaseSync } = (await import(/* @vite-ignore */ modName)) as {
      DatabaseSync: new (
        path: string,
        opts?: { readOnly?: boolean },
      ) => {
        prepare(sql: string): {
          get(...args: unknown[]): Record<string, unknown> | undefined;
          all(...args: unknown[]): Array<Record<string, unknown>>;
        };
        close(): void;
      };
    };
    const verifyDb = new DatabaseSync(filePath, { readOnly: true });
    try {
      const revRow = verifyDb.prepare("SELECT value FROM metadata WHERE key = 'revision'").get();
      expect(Number(revRow?.value)).toBe(2);

      const entities = verifyDb.prepare("SELECT uuid, text FROM entities ORDER BY uuid ASC").all();
      expect(entities).toEqual([
        { uuid: "node-a", text: "修改后的节点" },
        { uuid: "node-b", text: "CLI新增节点 AlphaNode" },
      ]);

      // 确认 R-Tree 已重建
      const rtreeHits = verifyDb
        .prepare("SELECT COUNT(*) AS cnt FROM entities_rtree WHERE min_x <= 350 AND max_x >= 300")
        .get();
      expect(Number(rtreeHits?.cnt)).toBe(1);

      // 确认 FTS5 已重建
      const ftsHits = verifyDb.prepare("SELECT uuid FROM entities_fts WHERE entities_fts MATCH 'AlphaNode'").all();
      expect(ftsHits.map((r) => r.uuid)).toEqual(["node-b"]);

      // 确认共享列 canonical_key、既有 attachments 与 history_ops 完整保留
      const colRow = verifyDb.prepare("SELECT canonical_key FROM table_columns WHERE id = 'col_note'").get();
      expect(colRow?.canonical_key).toBe("ws:shared-note");
      const attRow = verifyDb.prepare("SELECT id, size_bytes FROM attachments WHERE id = 'att-keep'").get();
      expect(attRow).toEqual({ id: "att-keep", size_bytes: 4 });
      const histRow = verifyDb.prepare("SELECT tx_id FROM history_ops WHERE tx_id = 'tx-0'").get();
      expect(histRow?.tx_id).toBe("tx-0");
    } finally {
      verifyDb.close();
    }
  });
});
