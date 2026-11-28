// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Encoder } from "@msgpack/msgpack";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { Color, Vector } from "@graphif/data-structures";
import { Line, Rectangle } from "@graphif/shapes";

// 注册序列化类
import "@/core/stage/stageObject/collisionBox/collisionBox";
import "@/core/stage/stageObject/entity/TextNode";
import "@/core/stage/stageObject/entity/Section";
import "@/core/stage/stageObject/entity/ImageNode";
import "@/core/stage/stageObject/association/LineEdge";

void new Vector(0, 0);
void new Color(0, 0, 0, 0);
void new Rectangle(new Vector(0, 0), new Vector(10, 10));
void new Line(new Vector(0, 0), new Vector(10, 10));

const fileBuffers = new Map<string, Uint8Array>();
const mockBackupLegacyFiles = vi.fn(async (root: string, files: string[]) => ({
  backupDir: `${root}/.flux-graph/backup-v2/ts-100`,
  backedUpCount: files.length,
  totalBytes: 123,
}));
const mockBackupSingleLegacyFile = vi.fn(async (path: string) => ({
  backupPath: `${path}.v2.bak`,
}));
const mockMigrationBegin = vi.fn(async (targetPath: string) => ({
  sessionId: `sess-${targetPath}`,
  tmpPath: `${targetPath}.v3.tmp`,
}));
const mockMigrationPutAttachment = vi.fn<
  (
    sessionId: string,
    attachmentId: string,
    mimeType: string,
    bytes: Uint8Array,
  ) => Promise<{
    id: string;
    mime: string;
    width: number;
    height: number;
    sizeBytes: number;
    hasThumb: boolean;
  }>
>(async () => ({
  id: "att-1",
  mime: "image/png",
  width: 10,
  height: 10,
  sizeBytes: 3,
  hasThumb: true,
}));
const mockMigrationCommit = vi.fn(async (_sessionId: string, payload: any, counts: any) => ({
  docId: payload.docId,
  formatVersion: payload.formatVersion,
  entityCount: counts.entities,
  edgeCount: counts.edges,
  associationCount: counts.associations,
  attachmentCount: counts.attachments,
}));
const mockMigrationAbort = vi.fn<(sessionId: string) => Promise<void>>(async () => {});

vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn(async (path: string) => {
    const buf = fileBuffers.get(path);
    if (!buf) throw new Error(`missing fixture: ${path}`);
    return buf;
  }),
  stat: vi.fn(async () => ({
    birthtime: new Date(1700000100000),
    mtime: new Date(1700000200000),
  })),
}));

vi.mock("@/core/loadAllServices", () => ({
  loadAllServicesBeforeInit: vi.fn((project: any) => {
    project.stageManager = {
      getAssociations: () => [],
      updateReferences: vi.fn(),
    };
    project.stageStyleManager = { currentStyle: { StageObjectBorder: Color.Black } };
    project.textRenderer = { measureMultiLineTextSize: () => new Vector(100, 30) };
    project.sectionMethods = { isEntityInSection: () => false };
    project.sectionCollisionSolver = { solveOverlaps: vi.fn() };
    project.effects = { addMoveShadow: vi.fn(), addEffect: vi.fn() };
    project.syncAssociationManager = { syncFrom: vi.fn() };
    project.dispose = vi.fn(async () => {});
  }),
}));

vi.mock("@/core/service/Settings", () => ({
  Settings: {
    activeWorkspaceRoot: "",
    isEnableEntityCollision: false,
    sectionInitBorderStyle: "solid",
    textNodeInitBorderStyle: "solid",
    enableAutoEdgeWidth: false,
  },
}));

vi.mock("@/utils/font", () => ({
  getMultiLineTextSize: () => new Vector(80, 32),
  getTextSize: () => new Vector(80, 32),
}));

vi.mock("@/core/service/dataGenerateService/generateScreenshot", () => ({
  GenerateScreenshot: { generateSection: vi.fn(), generateFullView: vi.fn() },
}));
vi.mock("@/core/service/GlobalMenu", () => ({ onOpenFile: vi.fn() }));
vi.mock("@/core/service/feedbackService/SoundService", () => ({
  SoundService: { play: new Proxy({}, { get: () => vi.fn() }) },
}));

vi.mock("./DocClient", () => ({
  DocClient: {
    backupLegacyFiles: (root: string, files: string[]) => mockBackupLegacyFiles(root, files),
    backupSingleLegacyFile: (path: string) => mockBackupSingleLegacyFile(path),
    migrationBegin: (targetPath: string) => mockMigrationBegin(targetPath),
    migrationPutAttachment: (sessionId: string, attachmentId: string, mimeType: string, bytes: Uint8Array) =>
      mockMigrationPutAttachment(sessionId, attachmentId, mimeType, bytes),
    migrationCommit: (sessionId: string, payload: any, counts: any) => mockMigrationCommit(sessionId, payload, counts),
    migrationAbort: (sessionId: string) => mockMigrationAbort(sessionId),
  },
}));

import { migrateSingleLegacyFile, migrateWorkspaceLegacyPrg } from "./V2ToV3Migrator";

async function buildLegacyV2Zip(docId: string): Promise<Uint8Array> {
  const encoder = new Encoder();
  const stage = [
    {
      _: "TextNode",
      uuid: "node-1",
      text: "旧版节点",
      collisionBox: {
        _: "CollisionBox",
        shapes: [
          {
            _: "Rectangle",
            location: { _: "Vector", x: 10, y: 20 },
            size: { _: "Vector", x: 100, y: 50 },
          },
        ],
      },
    },
  ];
  const uwriter = new Uint8ArrayWriter();
  const writer = new ZipWriter(uwriter, { level: 0 });
  await writer.add("stage.msgpack", new Uint8ArrayReader(encoder.encode(stage)), { level: 0 });
  await writer.add("tags.msgpack", new Uint8ArrayReader(encoder.encode(["t1"])), { level: 0 });
  await writer.add("reference.msgpack", new Uint8ArrayReader(encoder.encode({ sections: {}, files: [] })), {
    level: 0,
  });
  await writer.add("metadata.msgpack", new Uint8ArrayReader(encoder.encode({ version: "2.7.0", docId })), {
    level: 0,
  });
  await writer.add("attachments/att-1.png", new Uint8ArrayReader(new Uint8Array([137, 80, 78])), { level: 0 });
  await writer.close();
  return await uwriter.getData();
}

describe("V2ToV3Migrator", () => {
  beforeEach(() => {
    fileBuffers.clear();
    vi.clearAllMocks();
  });

  it("backs up outside-workspace single file as .v2.bak and streams attachments to Rust", async () => {
    const target = "d:/outside/board.prg";
    fileBuffers.set(target, await buildLegacyV2Zip("doc-single-1"));

    const res = await migrateSingleLegacyFile(target, { workspaceRoot: "d:/ws" });
    expect(mockBackupSingleLegacyFile).toHaveBeenCalledWith(target);
    expect(res.backupPath).toBe("d:/outside/board.prg.v2.bak");
    expect(mockMigrationPutAttachment).toHaveBeenCalledOnce();
    expect(mockMigrationCommit).toHaveBeenCalledOnce();
    expect(res.meta).toMatchObject({
      docId: "doc-single-1",
      formatVersion: "3.0.0",
      entityCount: 1,
      attachmentCount: 1,
    });
  });

  it("backs up workspace files together and tolerates per-file failure without aborting batch", async () => {
    const okPath = "d:/ws/ok.prg";
    const badPath = "d:/ws/broken.prg";
    fileBuffers.set(okPath, await buildLegacyV2Zip("doc-ws-1"));
    fileBuffers.set(badPath, new Uint8Array([1, 2, 3, 4])); // 损坏 ZIP

    const res = await migrateWorkspaceLegacyPrg({
      root: "d:/ws",
      files: [
        { path: okPath, relPath: "ok.prg", sizeBytes: 100 },
        { path: badPath, relPath: "broken.prg", sizeBytes: 4 },
      ],
      totalBytes: 104,
    });

    expect(mockBackupLegacyFiles).toHaveBeenCalledWith("d:/ws", [okPath, badPath]);
    expect(res.succeeded).toHaveLength(1);
    expect(res.succeeded[0].meta.docId).toBe("doc-ws-1");
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0].relPath).toBe("broken.prg");
  });

  it("keeps offscreen migration headless without decoding ImageNode bitmaps or starting rAF loop", async () => {
    const createBitmapSpy = vi.fn(async () => ({ width: 10, height: 10, close: vi.fn() }));
    const rafSpy = vi.fn(() => 1);
    vi.stubGlobal("createImageBitmap", createBitmapSpy);
    vi.stubGlobal("requestAnimationFrame", rafSpy);
    try {
      const encoder = new Encoder();
      const stage = [
        {
          _: "ImageNode",
          uuid: "img-1",
          attachmentId: "att-1",
          scale: 1,
          collisionBox: {
            _: "CollisionBox",
            shapes: [
              {
                _: "Rectangle",
                location: { _: "Vector", x: 0, y: 0 },
                size: { _: "Vector", x: 100, y: 80 },
              },
            ],
          },
        },
      ];
      const uwriter = new Uint8ArrayWriter();
      const writer = new ZipWriter(uwriter, { level: 0 });
      await writer.add("stage.msgpack", new Uint8ArrayReader(encoder.encode(stage)), { level: 0 });
      await writer.add("tags.msgpack", new Uint8ArrayReader(encoder.encode([])), { level: 0 });
      await writer.add("reference.msgpack", new Uint8ArrayReader(encoder.encode({ sections: {}, files: [] })), {
        level: 0,
      });
      await writer.add(
        "metadata.msgpack",
        new Uint8ArrayReader(encoder.encode({ version: "2.8.0", docId: "doc-img" })),
        {
          level: 0,
        },
      );
      await writer.add("attachments/att-1.png", new Uint8ArrayReader(new Uint8Array([137, 80, 78, 71])), { level: 0 });
      await writer.close();

      const target = "d:/ws/with-image.prg";
      fileBuffers.set(target, await uwriter.getData());

      const res = await migrateSingleLegacyFile(target, { workspaceRoot: "d:/ws" });
      expect(res.meta.entityCount).toBe(1);
      expect(res.meta.attachmentCount).toBe(1);
      expect(createBitmapSpy).not.toHaveBeenCalled();
      expect(rafSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
