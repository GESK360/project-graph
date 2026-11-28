import { createStore } from "@/utils/store";
import { settingsSchema } from "./Settings";
import { settingsIcons } from "./SettingsIcons";
import { z } from "zod";
import type { Store } from "@tauri-apps/plugin-store";

/**
 * 管理右侧快捷设置项列表
 * 有数据持久化机制
 */
export namespace QuickSettingsManager {
  let store: Store;
  let writeQueue = Promise.resolve();

  /**
   * 设置项的类型
   */
  export type SettingType = "boolean" | "enum" | "number" | "unknown";

  /** 标记「小地图」开关是否已经补进快捷栏，避免用户删掉后又加回来 */
  const MINIMAP_MIGRATION_FLAG = "minimapQuickSettingAdded";

  /**
   * 快捷设置项类型
   */
  export type QuickSettingItem = {
    /**
     * 设置项的 key（支持 boolean、enum、number 类型的设置项）
     */
    settingKey: keyof typeof settingsSchema.shape;
  };

  const branchControls = ["persistentDragToConnectMindMap", "persistentDragToConnectMindMapAligned"] as const;
  type SettingKey = QuickSettingItem["settingKey"];

  export function isBranchControl(settingKey: string): settingKey is (typeof branchControls)[number] {
    return branchControls.some((key) => key === settingKey);
  }

  const DEFAULT_QUICK_SETTINGS: QuickSettingItem[] = [
    { settingKey: "isStealthModeEnabled" },
    { settingKey: "stealthModeReverseMask" },
    { settingKey: "forceHideTextNodeBorder" },
    { settingKey: "alwaysShowDetails" },
    { settingKey: "showDebug" },
    { settingKey: "enableDragAutoAlign" },
    { settingKey: "reverseTreeMoveMode" },
    { settingKey: "textIntegerLocationAndSizeRender" },
    { settingKey: "showMinimap" },
  ];

  export async function init() {
    store = await createStore("quick-settings.json");
    const stored = (await store.get<QuickSettingItem[]>("quickSettings")) ?? [];
    const sidebar = await getSidebarItems();
    if (sidebar.every(({ settingKey }) => isBranchControl(settingKey))) {
      await saveSidebarItems([...sidebar, ...DEFAULT_QUICK_SETTINGS]);
    } else {
      const changed =
        stored.length !== sidebar.length || stored.some((item, index) => item.settingKey !== sidebar[index].settingKey);
      if (changed) {
        await saveSidebarItems(sidebar);
      }
      await migrateMinimapQuickSetting();
    }
  }

  /**
   * 老用户的快捷栏列表里没有「小地图」开关，升级后补一个到末尾
   */
  async function migrateMinimapQuickSetting() {
    if (await store.get(MINIMAP_MIGRATION_FLAG)) return;
    await addQuickSetting({ settingKey: "showMinimap" });
    await store.set(MINIMAP_MIGRATION_FLAG, true);
    await store.save();
  }

  /**
   * 获取快捷设置项列表
   */
  export async function getQuickSettings(): Promise<QuickSettingItem[]> {
    return (await getSidebarItems()).filter((item) => !isBranchControl(item.settingKey));
  }

  export async function getSidebarItems(): Promise<QuickSettingItem[]> {
    const stored = (await store.get<QuickSettingItem[]>("quickSettings")) ?? [];
    const keys = new Set(stored.map(({ settingKey }) => settingKey));
    const missingBranchControls = branchControls.filter((key) => !keys.has(key));
    return [...missingBranchControls, ...keys]
      .filter((key) => isBranchControl(key) || isValidQuickSetting(key))
      .map((settingKey) => ({ settingKey }));
  }

  async function saveSidebarItems(items: QuickSettingItem[]): Promise<void> {
    await store.set("quickSettings", items);
    await store.save();
  }

  function updateSidebarItems(update: (current: QuickSettingItem[]) => QuickSettingItem[]) {
    const result = writeQueue.then(async () => {
      const current = await getSidebarItems();
      const next = update(current);
      if (current !== next) await saveSidebarItems(next);
      return next;
    });
    writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  export async function moveSidebarItem(source: SettingKey, target: SettingKey, after: boolean) {
    return updateSidebarItems((sidebar) => {
      const moved = sidebar.find((item) => item.settingKey === source);
      if (!moved || source === target) return sidebar;
      const next = sidebar.filter((item) => item.settingKey !== source);
      const index = next.findIndex((item) => item.settingKey === target);
      if (index === -1) return sidebar;
      next.splice(index + Number(after), 0, moved);
      return next;
    });
  }

  /**
   * 添加一个快捷设置项
   */
  export async function addQuickSetting(item: QuickSettingItem): Promise<void> {
    if (!isValidQuickSetting(item.settingKey)) return;
    await updateSidebarItems((sidebar) =>
      sidebar.some(({ settingKey }) => settingKey === item.settingKey) ? sidebar : [...sidebar, item],
    );
  }

  /**
   * 删除一个快捷设置项
   */
  export async function removeQuickSetting(settingKey: keyof typeof settingsSchema.shape): Promise<void> {
    if (isBranchControl(settingKey)) return;
    await updateSidebarItems((sidebar) => sidebar.filter((item) => item.settingKey !== settingKey));
  }

  /**
   * 更新快捷设置项的顺序
   */
  export async function reorderQuickSettings(newOrder: QuickSettingItem[]): Promise<void> {
    await updateSidebarItems((sidebar) => {
      const quickKeys = new Set<SettingKey>(
        sidebar.map(({ settingKey }) => settingKey).filter((key) => !isBranchControl(key)),
      );
      const requestedKeys = newOrder.map(({ settingKey }) => settingKey).filter((key) => quickKeys.has(key));
      const order = Array.from(new Set([...requestedKeys, ...quickKeys]));
      let index = 0;
      return sidebar.map((item) => (isBranchControl(item.settingKey) ? item : { settingKey: order[index++] }));
    });
  }

  /**
   * 解包 Zod schema（处理 ZodDefault / ZodOptional 包装）
   */
  function unwrapSchema(schema: any): any {
    if (schema instanceof z.ZodDefault) return unwrapSchema(schema._def.innerType);
    if (schema instanceof z.ZodOptional) return unwrapSchema(schema._def.innerType);
    return schema;
  }

  /**
   * 获取设置项的类型
   */
  export function getSettingType(settingKey: string): SettingType {
    const schema = settingsSchema.shape[settingKey as keyof typeof settingsSchema.shape];
    if (!schema) return "unknown";
    const inner = unwrapSchema(schema);
    if (inner instanceof z.ZodBoolean) return "boolean";
    if (inner instanceof z.ZodUnion) return "enum";
    if (inner instanceof z.ZodNumber) return "number";
    return "unknown";
  }

  /**
   * 验证设置项是否为布尔类型
   */
  export function isValidBooleanSetting(settingKey: string): boolean {
    return getSettingType(settingKey) === "boolean";
  }

  /**
   * 验证设置项是否为枚举（下拉）类型
   */
  export function isValidEnumSetting(settingKey: string): boolean {
    return getSettingType(settingKey) === "enum";
  }

  /**
   * 验证设置项是否为数值类型
   */
  export function isValidNumberSetting(settingKey: string): boolean {
    return getSettingType(settingKey) === "number";
  }

  /**
   * 验证设置项是否可以加入快捷栏（boolean/enum/number 且有图标）
   */
  export function isValidQuickSetting(settingKey: string): boolean {
    if (
      isBranchControl(settingKey) ||
      settingKey === "mouseLeftMode" ||
      settingKey === "mouseRightDragBackground" ||
      settingKey === "drawingPaletteOpen"
    ) {
      return false;
    }
    const type = getSettingType(settingKey);
    if (type === "unknown") return false;
    // 必须有对应图标才能在工具栏中展示
    return settingKey in settingsIcons;
  }

  /**
   * 获取所有可用的布尔类型设置项（向后兼容保留）
   */
  export function getAllAvailableBooleanSettings(): Array<keyof typeof settingsSchema.shape> {
    const schema = settingsSchema.shape;
    return Object.keys(schema).filter((key) => isValidBooleanSetting(key)) as Array<keyof typeof settingsSchema.shape>;
  }

  /**
   * 获取所有可加入快捷栏的设置项（boolean + enum + number，且有图标）
   */
  export function getAllAvailableSettings(): Array<keyof typeof settingsSchema.shape> {
    const schema = settingsSchema.shape;
    return Object.keys(schema).filter((key) => isValidQuickSetting(key)) as Array<keyof typeof settingsSchema.shape>;
  }

  /**
   * 从 schema 中提取枚举选项
   */
  export function getEnumOptions(settingKey: string): string[] {
    const schema = settingsSchema.shape[settingKey as keyof typeof settingsSchema.shape];
    if (!schema) return [];
    const inner = unwrapSchema(schema);
    if (!(inner instanceof z.ZodUnion)) return [];
    return inner._def.options.map((opt: any) => opt._def.values[0] as string);
  }

  /**
   * 从 schema 中提取数值范围信息
   */
  export function getNumberRange(settingKey: string): {
    min: number | null;
    max: number | null;
    step: number;
    hasRange: boolean;
  } {
    const schema = settingsSchema.shape[settingKey as keyof typeof settingsSchema.shape];
    if (!schema) return { min: null, max: null, step: 0.01, hasRange: false };
    const inner = unwrapSchema(schema);
    if (!(inner instanceof z.ZodNumber)) return { min: null, max: null, step: 0.01, hasRange: false };

    const bag = (inner as any)._zod?.bag ?? {};
    const min = bag.minimum ?? null;
    const max = bag.maximum ?? null;
    const isInt = bag.format === "safeint";
    const step = isInt ? 1 : 0.01;
    const hasRange = min !== null && max !== null;

    return { min, max, step, hasRange };
  }
}
