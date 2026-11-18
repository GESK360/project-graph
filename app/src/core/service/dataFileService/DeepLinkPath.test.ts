// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";

// 这个文件只测纯路径换算，但 DeepLinkHandler 顶层会拉起 Settings / 最近文件等
// 依赖 Tauri runtime 的模块，这里全部挡掉。
vi.mock("@/core/service/Settings", () => ({ Settings: { activeWorkspaceRoot: "", workspaceRoots: [] } }));
vi.mock("./RecentFileManager", () => ({ RecentFileManager: { getRecentFiles: vi.fn(async () => []) } }));
vi.mock("../GlobalMenu", () => ({ onOpenFile: vi.fn() }));
vi.mock("@tauri-apps/plugin-fs", () => ({ exists: vi.fn(async () => false), readFile: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

import { relativePathFromDir, resolveAgainstDir } from "./DeepLinkHandler";

/**
 * 相对路径是这次节点链接改动的核心：
 * 链接里写相对路径，文件搬家后仍指向正确目标。
 */
describe("relativePathFromDir", () => {
  it("同目录下的文件带 ./ 前缀", () => {
    expect(relativePathFromDir("C:/work", "C:/work/a.prg")).toBe("./a.prg");
  });

  it("子目录用正向相对路径", () => {
    expect(relativePathFromDir("C:/work", "C:/work/sub/a.prg")).toBe("./sub/a.prg");
  });

  it("向上跳目录", () => {
    expect(relativePathFromDir("C:/work/sub", "C:/work/a.prg")).toBe("../a.prg");
  });

  it("多层向上", () => {
    expect(relativePathFromDir("C:/work/a/b", "C:/work/x.prg")).toBe("../../x.prg");
  });

  it("反斜杠与正斜杠等价", () => {
    expect(relativePathFromDir("C:\\work", "C:\\work\\sub\\a.prg")).toBe("./sub/a.prg");
  });

  it("盘符大小写不敏感", () => {
    expect(relativePathFromDir("c:/work", "C:/work/a.prg")).toBe("./a.prg");
  });

  it("跨盘符无法表达相对路径", () => {
    expect(relativePathFromDir("C:/work", "D:/work/a.prg")).toBe(null);
  });
});

describe("resolveAgainstDir", () => {
  it("还原同目录文件", () => {
    expect(resolveAgainstDir("C:/work", "./a.prg")).toBe("c:/work/a.prg");
  });

  it("还原子目录文件", () => {
    expect(resolveAgainstDir("C:/work", "./sub/a.prg")).toBe("c:/work/sub/a.prg");
  });

  it("还原向上跳目录", () => {
    expect(resolveAgainstDir("C:/work/sub", "../a.prg")).toBe("c:/work/a.prg");
  });

  it("多余 .. 无法还原", () => {
    expect(resolveAgainstDir("C:/work", "../../../a.prg")).toBe(null);
  });

  it("与 relativePathFromDir 互为逆运算", () => {
    const base = "C:/work/pages";
    const target = "C:/work/assets/img/a.prg";
    const relative = relativePathFromDir(base, target);
    expect(relative).toBe("../assets/img/a.prg");
    expect(resolveAgainstDir(base, relative!)).toBe("c:/work/assets/img/a.prg");
  });
});
