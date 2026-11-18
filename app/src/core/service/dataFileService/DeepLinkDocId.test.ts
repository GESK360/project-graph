// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Encoder } from "@msgpack/msgpack";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

// 用真实文件系统替身，验证「文件改名后仍能按 docId 找回」这条链路。
const fsState = { files: new Set<string>() };

vi.mock("@tauri-apps/plugin-fs", () => ({
  exists: vi.fn(
    async (path: string) =>
      fsState.files.has(path) ||
      (() => {
        try {
          readdirSync(path);
          return true;
        } catch {
          return false;
        }
      })(),
  ),
  readFile: vi.fn(async (path: string) => new Uint8Array(readFileSync(path))),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (command: string, args: { path: string }) => {
    // read_prg_metadata：真实实现是 Rust 只取 metadata.msgpack 那一段，
    // 这里按同样的契约返回该段的 base64，保证被测代码拿到的是 metadata 原始字节
    if (command === "read_prg_metadata") {
      // vi.mock 的工厂会被提升到文件顶部，那时静态导入还没求值，
      // 所以这里必须动态 import，不能直接用外层的 ZipReader
      const { ZipReader, Uint8ArrayReader, Uint8ArrayWriter } = await import("@zip.js/zip.js");
      const content = new Uint8Array(readFileSync(args.path));
      const reader = new ZipReader(new Uint8ArrayReader(content));
      try {
        const entries = await reader.getEntries();
        const entry = entries.find((it) => it.filename === "metadata.msgpack");
        if (!entry || !("getData" in entry) || typeof entry.getData !== "function") {
          throw new Error("缺少 metadata.msgpack");
        }
        const raw = await entry.getData(new Uint8ArrayWriter());
        return Buffer.from(raw).toString("base64");
      } finally {
        await reader.close();
      }
    }
    if (command !== "read_folder_recursive") return [];
    const out: string[] = [];
    const walk = (dir: string) => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".prg")) out.push(full);
      }
    };
    walk(args.path);
    return out;
  }),
}));

vi.mock("@/core/service/Settings", () => ({ Settings: { activeWorkspaceRoot: "", workspaceRoots: [] } }));
vi.mock("./RecentFileManager", () => ({ RecentFileManager: { getRecentFiles: vi.fn(async () => []) } }));
vi.mock("../GlobalMenu", () => ({ onOpenFile: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

import { findFileByDocId, readPrgDocId } from "./DeepLinkHandler";

async function writePrg(path: string, docId: string) {
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0 });
  const encoder = new Encoder();
  await writer.add("stage.msgpack", new Uint8ArrayReader(encoder.encode([])), { level: 0 });
  await writer.add("metadata.msgpack", new Uint8ArrayReader(encoder.encode({ version: "2.7.0", docId })), {
    level: 0,
  });
  const content = await writer.close();
  writeFileSync(path, content);
  fsState.files.add(path);
}

describe("按 docId 反查文件（文件改名/移动后仍可定位）", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "flux-deeplink-"));
    fsState.files.clear();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("能读出 .prg 里的 docId", async () => {
    const file = join(dir, "a.prg");
    await writePrg(file, "doc-1");
    expect(await readPrgDocId(file)).toBe("doc-1");
  });

  it("文件改名后仍能找到", async () => {
    const original = join(dir, "a.prg");
    await writePrg(original, "doc-1");

    const renamed = join(dir, "b.prg");
    renameSync(original, renamed);
    fsState.files.delete(original);
    fsState.files.add(renamed);

    expect(await findFileByDocId("doc-1", [dir])).toBe(renamed);
  });

  it("文件移动到子目录后仍能找到", async () => {
    const original = join(dir, "a.prg");
    await writePrg(original, "doc-2");

    const sub = join(dir, "moved");
    mkdirSync(sub);
    const moved = join(sub, "a.prg");
    renameSync(original, moved);
    fsState.files.delete(original);
    fsState.files.add(moved);

    expect(await findFileByDocId("doc-2", [dir])).toBe(moved);
  });

  it("多个同内容文件时按 docId 精确命中", async () => {
    const first = join(dir, "a.prg");
    const second = join(dir, "b.prg");
    await writePrg(first, "doc-a");
    await writePrg(second, "doc-b");

    expect(await findFileByDocId("doc-b", [dir])).toBe(second);
    expect(await findFileByDocId("doc-a", [dir])).toBe(first);
  });

  it("找不到时返回 null", async () => {
    const file = join(dir, "a.prg");
    await writePrg(file, "doc-1");
    expect(await findFileByDocId("missing", [dir])).toBe(null);
  });

  it("跳过 .flux-graph/history 里的历史快照，避免命中过期副本", async () => {
    const historyDir = join(dir, ".flux-graph", "history", "a");
    mkdirSync(historyDir, { recursive: true });
    // 快照与正本 docId 相同，若不过滤会先命中快照
    await writePrg(join(historyDir, "20260101-000000.prg"), "doc-1");
    const current = join(dir, "current.prg");
    await writePrg(current, "doc-1");

    expect(await findFileByDocId("doc-1", [dir])).toBe(current);
  });
});
