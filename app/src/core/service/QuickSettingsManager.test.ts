import { beforeEach, describe, expect, it, vi } from "vitest";
import { QuickSettingsManager } from "./QuickSettingsManager";

const saved = vi.hoisted(() => new Map<string, unknown>());

vi.mock("@/utils/store", () => ({
  createStore: async () => ({
    get: async (key: string) => saved.get(key),
    set: async (key: string, value: unknown) => {
      saved.set(key, value);
    },
    save: async () => {},
  }),
}));

vi.mock("./Settings", async () => {
  const { z } = await import("zod");
  return {
    settingsSchema: z.object({
      showMinimap: z.boolean().default(true),
      showDebug: z.boolean().default(false),
      drawingPaletteOpen: z.boolean().default(false),
      mouseLeftMode: z.union([z.literal("selectAndMove"), z.literal("draw")]).default("selectAndMove"),
      mouseRightDragBackground: z.union([z.literal("cut"), z.literal("moveCamera")]).default("cut"),
    }),
  };
});

vi.mock("./SettingsIcons", () => ({
  settingsIcons: {
    showMinimap: true,
    showDebug: true,
    drawingPaletteOpen: true,
    mouseLeftMode: true,
    mouseRightDragBackground: true,
  },
}));

const branch = "persistentDragToConnectMindMap";
const aligned = "persistentDragToConnectMindMapAligned";
type SettingKey = QuickSettingsManager.QuickSettingItem["settingKey"];
const items = (...keys: SettingKey[]) => keys.map((settingKey) => ({ settingKey }));
const sidebarKeys = async () => (await QuickSettingsManager.getSidebarItems()).map(({ settingKey }) => settingKey);

beforeEach(() => saved.clear());

describe("sidebar ordering", () => {
  it("upgrades old order without duplicating branch controls or exposing fixed mouse modes as sortable items", async () => {
    saved.set("quickSettings", items("mouseLeftMode", branch, "showDebug", "mouseRightDragBackground", branch));

    await QuickSettingsManager.init();

    expect(await sidebarKeys()).toEqual([aligned, branch, "showDebug", "showMinimap"]);
    expect(await QuickSettingsManager.getQuickSettings()).toEqual(items("showDebug", "showMinimap"));
    expect(QuickSettingsManager.isValidQuickSetting("mouseRightDragBackground")).toBe(false);
    expect(QuickSettingsManager.isValidQuickSetting("drawingPaletteOpen")).toBe(false);
  });

  it("persists interleaved order across initialization and follows subsequent settings edits", async () => {
    saved.set("quickSettings", items("showDebug", "showMinimap"));
    await QuickSettingsManager.init();
    await QuickSettingsManager.moveSidebarItem(branch, "showDebug", true);

    await QuickSettingsManager.init();
    expect(await sidebarKeys()).toEqual([aligned, "showDebug", branch, "showMinimap"]);

    await QuickSettingsManager.reorderQuickSettings(items("showMinimap", "showDebug"));
    expect(await sidebarKeys()).toEqual([aligned, "showMinimap", branch, "showDebug"]);

    await QuickSettingsManager.removeQuickSetting("showMinimap");
    expect(await sidebarKeys()).toEqual([aligned, branch, "showDebug"]);
  });

  it("applies overlapping moves against the last saved order", async () => {
    saved.set("quickSettings", items("showDebug", "showMinimap"));
    await QuickSettingsManager.init();

    await Promise.all([
      QuickSettingsManager.moveSidebarItem(branch, "showDebug", true),
      QuickSettingsManager.moveSidebarItem(aligned, "showMinimap", true),
    ]);

    expect(await sidebarKeys()).toEqual(["showDebug", branch, "showMinimap", aligned]);
  });
});
