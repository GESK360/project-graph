// @vitest-environment jsdom

import { createTabGroup } from "@/core/TabGroup";
import { evaluateTableFormulas } from "@/core/service/dataManageService/stageTableService/formulaEngine";
import { activeTabAtom, stageTableOpenAtom, store, tabGroupRootAtom, tabsAtom } from "@/state";
import {
  createDefaultTableData,
  getColumnFilterKind,
  getDefaultFilterOperator,
  getFilterOperatorsForKind,
} from "@/types/table";
import { Provider } from "jotai";
import React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MockProjectClass = vi.hoisted(() => {
  return class MockProject {
    id: string;
    layout = "docked" as const;
    projectState = 0;
    table = createDefaultTableData();
    rows: any[];
    private listeners = new Set<() => void>();
    private selectionListeners = new Set<(uuids: string[]) => void>();
    selectedCanvasRowIds: string[] = [];
    attachments = new Map<string, Blob>();
    stageManager = {
      getEntities: () => [],
      getAssociations: () => [],
      getSelectedStageObjects: () => [],
    };
    renderer = {
      getCoverWorldRectangle: () => ({ isCollideWith: () => true }),
    };
    camera = {
      currentScale: 1,
      reset: vi.fn(),
    };
    sectionMethods = {
      isEntityInSection: () => false,
    };
    stageTable: any;

    constructor(id: string, rowTexts: string[]) {
      this.id = id;
      this.rows = rowTexts.map((text, idx) => ({
        uuid: `${id}-row-${idx}`,
        entity: {},
        kind: "text",
        primaryText: text,
        editableText: true,
        images: [],
        canEditImages: true,
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        parents: [],
        children: [],
        outer: null,
        inner: [],
        canEditInner: true,
        tableFields: {},
        formulaValues: {},
      }));
      this.stageTable = {
        subscribe: (fn: () => void) => {
          this.listeners.add(fn);
          return () => this.listeners.delete(fn);
        },
        subscribeSelection: (fn: (uuids: string[]) => void) => {
          this.selectionListeners.add(fn);
          return () => this.selectionListeners.delete(fn);
        },
        getSelectedRowUUIDs: () => [...this.selectedCanvasRowIds],
        selectRowsOnCanvas: vi.fn((uuids: string[]) => {
          this.selectedCanvasRowIds = [...uuids];
        }),
        getViews: () => this.table.views,
        getActiveView: () => this.table.views.find((v: any) => v.id === this.table.activeViewId) ?? this.table.views[0],
        setActiveView: (viewId: string) => {
          if (!this.table.views.some((v: any) => v.id === viewId)) return false;
          this.table.activeViewId = viewId;
          this.listeners.forEach((fn) => fn());
          return true;
        },
        createView: ({ type, name }: { type: any; name?: string }) => {
          const base = name || type;
          const names = new Set(this.table.views.map((v: any) => v.name));
          let finalName = base;
          let idx = 2;
          while (names.has(finalName)) {
            finalName = `${base} ${idx++}`;
          }
          const selectCol = this.table.columns.find((c: any) => c.type === "select");
          const dateCols = this.table.columns.filter((c: any) => c.type === "date");
          const cur = this.stageTable.getActiveView();
          const nextView: any = {
            id: `view_${this.table.views.length + 1}`,
            name: finalName,
            type,
            deletable: true,
            visibleColumnIds: [...cur.visibleColumnIds],
            columnWidths: { ...(cur.columnWidths ?? {}) },
            ...(type === "kanban" ? { kanban: { groupByColumnId: selectCol?.id ?? null, showFieldNames: true } } : {}),
            ...(type === "gantt"
              ? {
                  gantt: {
                    startDateColumnId: dateCols[0]?.id ?? "createdAt",
                    endDateColumnId: dateCols[1]?.id ?? null,
                    timeScale: "month",
                    showLeftTable: true,
                  },
                }
              : {}),
            ...(type === "gallery" ? { gallery: { coverMode: "images", cardSize: "medium" } } : {}),
            ...(type === "calendar"
              ? {
                  calendar: {
                    dateColumnId: dateCols[0]?.id ?? "createdAt",
                    displayMode: "month",
                    cellHeight: "medium",
                    weekStartsOn: 1,
                  },
                }
              : {}),
            ...(type === "spaced_repetition"
              ? {
                  spacedRepetition: {
                    columns: 2,
                    queueTab: "due",
                    imageFit: "contain",
                  },
                }
              : {}),
          };
          if (type === "spaced_repetition") {
            this.stageTable.ensureSpacedRepetitionColumns(false);
          }
          this.table.views = [...this.table.views, nextView];
          this.table.activeViewId = nextView.id;
          this.listeners.forEach((fn) => fn());
          return nextView;
        },
        renameView: (viewId: string, nextName: string) => {
          this.table.views = this.table.views.map((v: any) => (v.id === viewId ? { ...v, name: nextName.trim() } : v));
          this.listeners.forEach((fn) => fn());
          return true;
        },
        duplicateView: (viewId: string, suffix = "副本") => {
          const src = this.table.views.find((v: any) => v.id === viewId);
          if (!src) return null;
          const dup = {
            ...src,
            id: `view_dup_${this.table.views.length + 1}`,
            name: `${src.name} ${suffix}`,
            deletable: true,
            visibleColumnIds: [...src.visibleColumnIds],
          };
          this.table.views = [...this.table.views, dup];
          this.table.activeViewId = dup.id;
          this.listeners.forEach((fn) => fn());
          return dup;
        },
        deleteView: (viewId: string) => {
          const target = this.table.views.find((v: any) => v.id === viewId);
          if (!target || !target.deletable || this.table.views.length <= 1) return false;
          this.table.views = this.table.views.filter((v: any) => v.id !== viewId);
          if (this.table.activeViewId === viewId) {
            this.table.activeViewId = this.table.views[0].id;
          }
          this.listeners.forEach((fn) => fn());
          return true;
        },
        reorderViews: vi.fn((draggedId: string, targetId: string, position: "before" | "after") => {
          const dragged = this.table.views.find((v: any) => v.id === draggedId);
          if (!dragged || draggedId === targetId) return false;
          const rest = this.table.views.filter((v: any) => v.id !== draggedId);
          const idx = rest.findIndex((v: any) => v.id === targetId);
          if (idx === -1) return false;
          rest.splice(position === "before" ? idx : idx + 1, 0, dragged);
          this.table.views = rest;
          this.listeners.forEach((fn) => fn());
          return true;
        }),
        updateActiveViewConfig: (patch: any) => {
          const active = this.stageTable.getActiveView();
          this.table.views = this.table.views.map((v: any) =>
            v.id === active.id
              ? {
                  ...v,
                  ...(patch.rowHeight ? { rowHeight: patch.rowHeight } : {}),
                  ...(patch.kanban ? { kanban: { ...(v.kanban ?? {}), ...patch.kanban } } : {}),
                  ...(patch.gantt ? { gantt: { ...(v.gantt ?? {}), ...patch.gantt } } : {}),
                  ...(patch.gallery ? { gallery: { ...(v.gallery ?? {}), ...patch.gallery } } : {}),
                  ...(patch.calendar ? { calendar: { ...(v.calendar ?? {}), ...patch.calendar } } : {}),
                  ...(patch.spacedRepetition
                    ? { spacedRepetition: { ...(v.spacedRepetition ?? {}), ...patch.spacedRepetition } }
                    : {}),
                }
              : v,
          );
          this.listeners.forEach((fn) => fn());
        },
        getSort: () => this.stageTable.getActiveView().sort ?? null,
        setSort: (sort: any) => {
          this.stageTable.getActiveView().sort = sort ?? undefined;
          this.listeners.forEach((fn) => fn());
        },
        toggleColumnSort: (colId: string, preferred?: "asc" | "desc") => {
          const active = this.stageTable.getActiveView();
          const cur = active.sort;
          const next = preferred
            ? cur && cur.columnId === colId && cur.direction === preferred
              ? null
              : { columnId: colId, direction: preferred }
            : !cur || cur.columnId !== colId
              ? { columnId: colId, direction: "asc" as const }
              : cur.direction === "asc"
                ? { columnId: colId, direction: "desc" as const }
                : null;
          active.sort = next ?? undefined;
          this.listeners.forEach((fn) => fn());
          return next;
        },
        getFilters: () => this.stageTable.getActiveView().filters ?? [],
        getColumnFilter: (colId: string) =>
          (this.stageTable.getActiveView().filters ?? []).find((f: any) => f.columnId === colId) ?? null,
        setColumnFilter: (colId: string, flt: any) => {
          const active = this.stageTable.getActiveView();
          const rest = (active.filters ?? []).filter((f: any) => f.columnId !== colId);
          active.filters = flt ? [...rest, { columnId: colId, ...flt }] : rest.length > 0 ? rest : undefined;
          this.listeners.forEach((fn) => fn());
        },
        getFilterGroup: () => this.stageTable.getActiveView().filterGroup ?? { conjunction: "and", conditions: [] },
        setFilterConjunction: (conjunction: "and" | "or") => {
          const active = this.stageTable.getActiveView();
          const cur = active.filterGroup ?? { conjunction: "and", conditions: [] };
          active.filterGroup = { ...cur, conjunction };
          this.listeners.forEach((fn) => fn());
        },
        addFilterCondition: (columnId?: string) => {
          const active = this.stageTable.getActiveView();
          const cur = active.filterGroup ?? { conjunction: "and", conditions: [] };
          const used = new Set(cur.conditions.map((c: any) => c.columnId));
          const targetColId =
            columnId ?? this.stageTable.getVisibleColumnIds().find((cid: string) => !used.has(cid)) ?? "name";
          const colSchema = this.table.columns.find((c: any) => c.id === targetColId);
          const kind = getColumnFilterKind(targetColId, colSchema);
          const cond = {
            id: `flt_${cur.conditions.length + 1}_${Math.random().toString(36).slice(2, 6)}`,
            columnId: targetColId,
            operator: getDefaultFilterOperator(kind),
          };
          active.filterGroup = { conjunction: cur.conjunction, conditions: [...cur.conditions, cond] };
          this.listeners.forEach((fn) => fn());
          return cond;
        },
        updateFilterCondition: (conditionId: string, patch: any) => {
          const active = this.stageTable.getActiveView();
          const cur = active.filterGroup ?? { conjunction: "and", conditions: [] };
          active.filterGroup = {
            ...cur,
            conditions: cur.conditions.map((c: any) => {
              if (c.id !== conditionId) return c;
              const nextColId = patch.columnId ?? c.columnId;
              const colChanged = nextColId !== c.columnId;
              const nextSchema = this.table.columns.find((col: any) => col.id === nextColId);
              const nextKind = getColumnFilterKind(nextColId, nextSchema);
              const allowed = getFilterOperatorsForKind(nextKind);
              const nextOp =
                patch.operator && allowed.includes(patch.operator)
                  ? patch.operator
                  : colChanged
                    ? getDefaultFilterOperator(nextKind)
                    : c.operator;
              return {
                id: c.id,
                columnId: nextColId,
                operator: nextOp,
                value: "value" in patch ? patch.value : colChanged ? undefined : c.value,
                values: "values" in patch ? patch.values : colChanged ? undefined : c.values,
                datePreset: "datePreset" in patch ? patch.datePreset : colChanged ? undefined : c.datePreset,
                collapsed: "collapsed" in patch ? patch.collapsed : c.collapsed,
              };
            }),
          };
          this.listeners.forEach((fn) => fn());
        },
        removeFilterCondition: (conditionId: string) => {
          const active = this.stageTable.getActiveView();
          const cur = active.filterGroup;
          if (!cur) return;
          const next = cur.conditions.filter((c: any) => c.id !== conditionId);
          active.filterGroup = next.length > 0 ? { ...cur, conditions: next } : undefined;
          this.listeners.forEach((fn) => fn());
        },
        toggleFilterConditionCollapsed: (conditionId: string) => {
          const active = this.stageTable.getActiveView();
          const cur = active.filterGroup;
          if (!cur) return;
          active.filterGroup = {
            ...cur,
            conditions: cur.conditions.map((c: any) => (c.id === conditionId ? { ...c, collapsed: !c.collapsed } : c)),
          };
          this.listeners.forEach((fn) => fn());
        },
        reorderFilterConditions: vi.fn((draggedId: string, targetId: string, position: "before" | "after") => {
          if (draggedId === targetId) return false;
          const active = this.stageTable.getActiveView();
          const cur = active.filterGroup;
          if (!cur) return false;
          const dragged = cur.conditions.find((c: any) => c.id === draggedId);
          if (!dragged) return false;
          const remaining = cur.conditions.filter((c: any) => c.id !== draggedId);
          const targetIdx = remaining.findIndex((c: any) => c.id === targetId);
          if (targetIdx === -1) return false;
          const insertIdx = position === "before" ? targetIdx : targetIdx + 1;
          remaining.splice(insertIdx, 0, dragged);
          active.filterGroup = { ...cur, conditions: remaining };
          this.listeners.forEach((fn) => fn());
          return true;
        }),
        clearAllFilters: () => {
          const active = this.stageTable.getActiveView();
          active.filters = undefined;
          active.filterGroup = undefined;
          this.listeners.forEach((fn) => fn());
        },
        getColumns: () => this.table.columns,
        getVisibleColumnIds: () => [
          "name",
          ...this.stageTable.getActiveView().visibleColumnIds.filter((x: string) => x !== "name"),
        ],
        isColumnVisible: (colId: string) =>
          colId === "name" || this.stageTable.getActiveView().visibleColumnIds.includes(colId),
        setColumnVisible: (colId: string, visible: boolean) => {
          const active = this.stageTable.getActiveView();
          const cur = active.visibleColumnIds;
          active.visibleColumnIds = visible
            ? ["name", ...cur.filter((x: string) => x !== "name" && x !== colId), colId]
            : ["name", ...cur.filter((x: string) => x !== "name" && x !== colId)];
          this.listeners.forEach((fn) => fn());
        },
        setColumnWidth: (colId: string, width: number) => {
          const active = this.stageTable.getActiveView();
          active.columnWidths = { ...(active.columnWidths ?? {}), [colId]: width };
          this.listeners.forEach((fn) => fn());
        },
        reorderColumn: (draggedId: string, targetId: string, position: "before" | "after") => {
          if (draggedId === "name" || draggedId === targetId) return false;
          const rest = this.table.views[0].visibleColumnIds.filter((x) => x !== draggedId);
          const idx = rest.indexOf(targetId);
          const insertAt = targetId === "name" ? 1 : position === "before" ? Math.max(1, idx) : idx + 1;
          rest.splice(insertAt, 0, draggedId);
          this.table.views[0].visibleColumnIds = rest;
          this.listeners.forEach((fn) => fn());
          return true;
        },
        addCustomColumn: ({ name, type }: { name: string; type: any }) => {
          const col = { id: `col_${this.table.columns.length + 1}`, name, type, options: [] };
          this.table.columns = [...this.table.columns, col];
          this.table.views[0].visibleColumnIds = [...this.table.views[0].visibleColumnIds, col.id];
          this.listeners.forEach((fn) => fn());
          return col;
        },
        insertCustomColumn: ({
          name,
          type,
          targetColumnId,
          side,
        }: {
          name: string;
          type: any;
          targetColumnId?: string;
          side?: "left" | "right";
        }) => {
          const col = { id: `col_${this.table.columns.length + 1}`, name, type, options: [] };
          this.table.columns = [...this.table.columns, col];
          const cur = [...this.table.views[0].visibleColumnIds];
          if (targetColumnId && cur.includes(targetColumnId)) {
            const idx = cur.indexOf(targetColumnId);
            const at = targetColumnId === "name" ? 1 : side === "left" ? Math.max(1, idx) : idx + 1;
            cur.splice(at, 0, col.id);
          } else {
            cur.push(col.id);
          }
          this.table.views[0].visibleColumnIds = cur;
          this.listeners.forEach((fn) => fn());
          return col;
        },
        duplicateCustomColumn: vi.fn(),
        autoFitColumnWidth: vi.fn(),
        getFrozenColumnId: () => this.table.views[0].frozenColumnId ?? null,
        toggleFreezeUpToColumn: (colId: string) => {
          this.table.views[0].frozenColumnId = this.table.views[0].frozenColumnId === colId ? undefined : colId;
          this.listeners.forEach((fn) => fn());
          return this.table.views[0].frozenColumnId ?? null;
        },
        getColumnGroups: () => this.table.views[0].columnGroups ?? [],
        isColumnProtected: (colId: string) => {
          const col: any = this.table.columns.find((c: any) => c.id === colId);
          return Boolean(col?.protectedRole);
        },
        addSpacedRepetitionCustomColumn: ({
          name,
          type,
          side,
        }: {
          name: string;
          type: any;
          side: "front" | "back";
        }) => {
          const col: any = {
            id: `col_sr_custom_${this.table.columns.length + 1}`,
            name: name.trim() || "未命名",
            type,
            ...(type === "select" || type === "multi_select" ? { options: [] } : {}),
          };
          this.table.columns = [...this.table.columns, col];
          const active = this.stageTable.getActiveView();
          if (active.type === "spaced_repetition") {
            const sr = active.spacedRepetition ?? {};
            if (side === "front") {
              active.spacedRepetition = {
                ...sr,
                frontFieldIds: Array.from(new Set([...(sr.frontFieldIds ?? []), col.id])),
              };
            } else if (sr.backFieldIds !== undefined) {
              active.spacedRepetition = {
                ...sr,
                backFieldIds: Array.from(new Set([...sr.backFieldIds, col.id])),
              };
            }
          }
          this.listeners.forEach((fn) => fn());
          return col;
        },
        reorderSpacedRepetitionFields: vi.fn(
          (
            side: "front" | "back",
            draggedColId: string,
            targetColId: string,
            position: "top" | "bottom" | "left" | "right" | "before" | "after",
            currentRowsOrIds?: readonly string[][] | readonly string[],
          ) => {
            if (draggedColId === targetColId) return false;
            const active = this.stageTable.getActiveView();
            if (active.type !== "spaced_repetition") return false;
            const sr = active.spacedRepetition ?? {};
            const toRows = (input?: readonly string[][] | readonly string[]) =>
              (input ?? []).map((x) => (Array.isArray(x) ? [...x] : [x])).filter((r) => r.length > 0);
            const baseRows =
              side === "front"
                ? sr.frontFieldRows?.length
                  ? toRows(sr.frontFieldRows)
                  : toRows(currentRowsOrIds ?? sr.frontFieldIds)
                : sr.backFieldRows?.length
                  ? toRows(sr.backFieldRows)
                  : toRows(currentRowsOrIds ?? sr.backFieldIds);
            const withoutDragged = baseRows
              .map((row) => row.filter((id) => id !== draggedColId))
              .filter((row) => row.length > 0);
            let rIdx = -1;
            let cIdx = -1;
            for (let r = 0; r < withoutDragged.length; r++) {
              const c = withoutDragged[r].indexOf(targetColId);
              if (c !== -1) {
                rIdx = r;
                cIdx = c;
                break;
              }
            }
            if (rIdx === -1) return false;
            const nextRows = withoutDragged.map((row) => [...row]);
            if (position === "left") nextRows[rIdx].splice(cIdx, 0, draggedColId);
            else if (position === "right") nextRows[rIdx].splice(cIdx + 1, 0, draggedColId);
            else if (position === "top" || position === "before") nextRows.splice(rIdx, 0, [draggedColId]);
            else nextRows.splice(rIdx + 1, 0, [draggedColId]);
            active.spacedRepetition = {
              ...sr,
              ...(side === "front"
                ? { frontFieldIds: nextRows.flat(), frontFieldRows: nextRows }
                : { backFieldIds: nextRows.flat(), backFieldRows: nextRows }),
            };
            this.listeners.forEach((fn) => fn());
            return true;
          },
        ),
        ensureSpacedRepetitionColumns: (notify = true) => {
          const specs: Array<{ role: string; name: string; type: any; format?: string; opts?: any[] }> = [
            { role: "source", name: "出处", type: "select", opts: [] },
            { role: "notes", name: "备注", type: "text" },
            { role: "knowledge", name: "知识点", type: "multi_select", opts: [] },
            { role: "mastery", name: "掌握程度", type: "number" },
            { role: "correctCount", name: "答对次数", type: "number" },
            { role: "nextInterval", name: "下次作答", type: "formula", format: "0" },
            { role: "delay", name: "延期", type: "number" },
            { role: "answerDate", name: "作答日期", type: "date" },
            { role: "nextDueDate", name: "下次要求作答时间", type: "formula", format: "YYYY-MM-DD" },
            { role: "dueStatus", name: "是否到期", type: "formula" },
            {
              role: "archiveStatus",
              name: "归档状态",
              type: "select",
              opts: [
                { id: "opt_unarchived", name: "未归档", color: "gray" },
                { id: "opt_archived", name: "已归档", color: "green" },
              ],
            },
          ];
          const ids: Record<string, string> = {};
          let changed = false;
          for (const spec of specs) {
            let col = this.table.columns.find((c: any) => c.protectedRole === spec.role);
            if (!col) {
              col = {
                id: `col_sr_${spec.role}`,
                name: spec.name,
                type: spec.type,
                protectedRole: spec.role,
                ...(spec.opts ? { options: spec.opts } : {}),
                ...(spec.format ? { format: spec.format } : {}),
              } as any;
              this.table.columns = [...this.table.columns, col!];
              changed = true;
            }
            ids[spec.role] = col!.id;
          }
          const setFormula = (role: string, formula: string) => {
            const col = this.table.columns.find((c: any) => c.id === ids[role]);
            if (col && !col.formula) {
              col.formula = formula;
              changed = true;
            }
          };
          setFormula(
            "nextInterval",
            `POWER(2, IFBLANK({{${ids.correctCount}}}, 0)) - 1 + IFBLANK({{${ids.delay}}}, 0)`,
          );
          setFormula(
            "nextDueDate",
            `IF(ISBLANK({{${ids.answerDate}}}), "", TODATE({{${ids.answerDate}}}) + {{${ids.nextInterval}}})`,
          );
          setFormula(
            "dueStatus",
            `IF({{${ids.archiveStatus}}} = "已归档", "已归档", IF(ISBLANK({{${ids.answerDate}}}), "待复习", IF(TODATE({{${ids.nextDueDate}}}) <= TODAY(), "待复习", "未到期")))`,
          );
          if (changed && notify) {
            this.listeners.forEach((fn) => fn());
          }
          return ids;
        },
        answerSpacedRepetitionRow: (uuid: string, choice: string, options?: { baseline?: any }) => {
          const ids = this.stageTable.ensureSpacedRepetitionColumns(false);
          const r = this.rows.find((item) => item.uuid === uuid);
          if (!r) return null;
          const snapshot = options?.baseline ?? {
            mastery: r.tableFields[ids.mastery],
            correctCount: r.tableFields[ids.correctCount],
            delay: r.tableFields[ids.delay],
            answerDate: r.tableFields[ids.answerDate],
          };
          const prevCorrect = typeof snapshot.correctCount === "number" ? snapshot.correctCount : 0;
          const prevDelay = typeof snapshot.delay === "number" ? snapshot.delay : 0;
          const now = new Date();
          const pad = (n: number) => String(n).padStart(2, "0");
          const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
          r.tableFields = {
            ...r.tableFields,
            [ids.mastery]: choice === "correct_closed" ? 1 : choice === "correct_open" ? 2 : 3,
            [ids.correctCount]: choice === "wrong" ? Math.max(0, prevCorrect - 1) : prevCorrect + 1,
            [ids.delay]: choice === "wrong" ? prevDelay + 1 : 0,
            [ids.answerDate]: todayKey,
          };
          this.listeners.forEach((fn) => fn());
          return snapshot;
        },
        restoreSpacedRepetitionRow: (uuid: string, snapshot: any) => {
          const ids = this.stageTable.ensureSpacedRepetitionColumns(false);
          const r = this.rows.find((item) => item.uuid === uuid);
          if (!r) return false;
          const next = { ...r.tableFields };
          for (const [role, val] of [
            ["mastery", snapshot.mastery],
            ["correctCount", snapshot.correctCount],
            ["delay", snapshot.delay],
            ["answerDate", snapshot.answerDate],
          ] as const) {
            if (val === undefined || val === null) delete next[ids[role]];
            else next[ids[role]] = val;
          }
          r.tableFields = next;
          this.listeners.forEach((fn) => fn());
          return true;
        },
        deleteCustomColumn: vi.fn((colId: string) => {
          const col: any = this.table.columns.find((c: any) => c.id === colId);
          if (!col || col.protectedRole) return false;
          this.table.columns = this.table.columns.filter((c: any) => c.id !== colId);
          this.table.views = this.table.views.map((v: any) =>
            v.spacedRepetition
              ? {
                  ...v,
                  spacedRepetition: {
                    ...v.spacedRepetition,
                    ...(v.spacedRepetition.frontFieldIds
                      ? { frontFieldIds: v.spacedRepetition.frontFieldIds.filter((id: string) => id !== colId) }
                      : {}),
                    ...(v.spacedRepetition.backFieldIds
                      ? { backFieldIds: v.spacedRepetition.backFieldIds.filter((id: string) => id !== colId) }
                      : {}),
                    ...(v.spacedRepetition.frontFieldRows
                      ? {
                          frontFieldRows: v.spacedRepetition.frontFieldRows
                            .map((r: string[]) => r.filter((id) => id !== colId))
                            .filter((r: string[]) => r.length > 0),
                        }
                      : {}),
                    ...(v.spacedRepetition.backFieldRows
                      ? {
                          backFieldRows: v.spacedRepetition.backFieldRows
                            .map((r: string[]) => r.filter((id) => id !== colId))
                            .filter((r: string[]) => r.length > 0),
                        }
                      : {}),
                  },
                }
              : v,
          );
          this.listeners.forEach((fn) => fn());
          return true;
        }),
        updateColumn: (
          colId: string,
          patch: { name?: string; type?: any; formula?: string; format?: string | null },
        ) => {
          this.table.columns = this.table.columns.map((c) =>
            c.id === colId
              ? {
                  ...c,
                  ...(patch.name ? { name: patch.name } : {}),
                  ...(patch.type ? { type: patch.type } : {}),
                  ...(patch.formula !== undefined ? { formula: patch.formula } : {}),
                  ...(patch.format !== undefined ? { format: patch.format ?? undefined } : {}),
                }
              : c,
          );
          this.listeners.forEach((fn) => fn());
          return true;
        },
        createOrGetSelectOption: (colId: string, optName: string) => {
          const col = this.table.columns.find((c) => c.id === colId);
          if (!col) return null;
          const opt = { id: `opt_${(col.options?.length ?? 0) + 1}`, name: optName, color: "purple" };
          col.options = [...(col.options ?? []), opt];
          this.listeners.forEach((fn) => fn());
          return opt;
        },
        getRows: () => {
          const evaluatedMap = evaluateTableFormulas(this.rows, this.table.columns);
          return this.rows.map((r) => ({
            ...r,
            formulaValues: evaluatedMap.get(r.uuid) ?? r.formulaValues ?? {},
          }));
        },
        updateRowPrimaryText: vi.fn((uuid: string, nextText: string) => {
          const r = this.rows.find((item) => item.uuid === uuid);
          if (r) {
            r.primaryText = nextText;
            this.listeners.forEach((fn) => fn());
          }
          return true;
        }),
        updateRowCustomField: (uuid: string, colId: string, val: any) => {
          const r = this.rows.find((item) => item.uuid === uuid);
          if (r) {
            r.tableFields = { ...r.tableFields, [colId]: val };
            this.listeners.forEach((fn) => fn());
          }
          return true;
        },
        updateRowCustomFields: (uuid: string, patch: Record<string, any>) => {
          const r = this.rows.find((item) => item.uuid === uuid);
          if (r) {
            r.tableFields = { ...r.tableFields, ...patch };
            this.listeners.forEach((fn) => fn());
          }
          return true;
        },
        createRow: (options?: { text?: string; tableFields?: Record<string, any> }) => {
          const row = {
            uuid: `${this.id}-row-${this.rows.length}`,
            entity: {},
            kind: "text",
            primaryText: options?.text ?? "",
            editableText: true,
            images: [],
            canEditImages: true,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            parents: [],
            children: [],
            outer: null,
            inner: [],
            canEditInner: true,
            tableFields: { ...(options?.tableFields ?? {}) },
            formulaValues: {},
          };
          this.rows = [...this.rows, row];
          this.listeners.forEach((fn) => fn());
          return row;
        },
        addRowImages: vi.fn(),
        removeRowImage: vi.fn(),
        setRowParents: vi.fn(),
        setRowChildren: vi.fn(),
        setRowOuter: vi.fn(),
        setRowInner: vi.fn(),
        focusRowOnCanvas: vi.fn(),
      };
    }

    emitCanvasSelection(uuids: string[]) {
      this.selectedCanvasRowIds = [...uuids];
      this.selectionListeners.forEach((fn) => fn(uuids));
    }

    getService(name: string) {
      return name === "stageTable" ? this.stageTable : undefined;
    }

    on() {}
    off() {}

    getComponent() {
      const id = this.id;
      return function MockCanvasView() {
        return <div data-mock-canvas={id}>Canvas {id}</div>;
      };
    }
  };
});

vi.mock("@/core/Project", () => ({
  Project: MockProjectClass,
  ProjectState: { Saved: 0, Stashed: 1, Unsaved: 2 },
}));
vi.mock("@/core/Tab", () => ({
  Tab: class {},
  isResourceTab: (tab: unknown) => tab instanceof MockProjectClass,
}));
vi.mock("@/core/TabWorkspace", () => ({
  TabWorkspace: { focus: vi.fn(), resizeSplit: vi.fn() },
}));
vi.mock("@/utils/platform", () => ({ isMac: false }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/ProjectTabs", () => ({
  ProjectTabs: () => <div data-pg-tab-bar />,
}));

import DockedArea from "./docked-area";

describe("Docked StageTablePanel split & sliders", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    localStorage.clear();
    store.set(stageTableOpenAtom, false);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await React.act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("renders as a sibling split page without covering canvas children and stays open across file-tree page switches", async () => {
    const projectA = new MockProjectClass("proj-a", ["Alpha Node"]);
    const projectB = new MockProjectClass("proj-b", ["Beta Node"]);

    store.set(tabsAtom, [projectA as never, projectB as never]);
    store.set(tabGroupRootAtom, {
      id: "main",
      type: "group",
      tabIds: ["proj-a", "proj-b"],
      activeTabId: "proj-a",
    });
    store.set(activeTabAtom, projectA as never);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    expect(container.querySelector("[data-stage-table-docked-pane]")).toBeNull();
    const toggleBtn = container.querySelector<HTMLButtonElement>("[data-stage-table-toggle]")!;
    expect(toggleBtn).not.toBeNull();

    // Expand multidimensional table panel
    await React.act(async () => {
      toggleBtn.click();
    });

    const dockedPane = container.querySelector<HTMLElement>("[data-stage-table-docked-pane]");
    const canvasEl = container.querySelector<HTMLElement>('[data-mock-canvas="proj-a"]');
    expect(dockedPane).not.toBeNull();
    expect(canvasEl).not.toBeNull();
    // Docked pane is a separate sibling branch, NOT inside the Project canvas subtree
    expect(canvasEl!.contains(dockedPane)).toBe(false);
    expect(dockedPane!.textContent).toContain("Alpha Node");

    // Simulate switching .prg page in Workspace file tree (active tab -> projectB)
    await React.act(async () => {
      store.set(tabGroupRootAtom, {
        id: "main",
        type: "group",
        tabIds: ["proj-a", "proj-b"],
        activeTabId: "proj-b",
      });
      store.set(activeTabAtom, projectB as never);
    });

    // Panel stays open and switches rows to Project B
    const dockedPaneAfterSwitch = container.querySelector<HTMLElement>("[data-stage-table-docked-pane]");
    expect(dockedPaneAfterSwitch).not.toBeNull();
    expect(store.get(stageTableOpenAtom)).toBe(true);
    expect(dockedPaneAfterSwitch!.textContent).toContain("Beta Node");
  });

  it("supports dragging and wheel-scrolling both right vertical and bottom horizontal sliders", async () => {
    const projectA = new MockProjectClass("proj-scroll", ["Row 1", "Row 2", "Row 3"]);
    projectA.table.views[0].visibleColumnIds = [
      "name",
      "createdAt",
      "updatedAt",
      "parents",
      "children",
      "outer",
      "inner",
    ];

    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, createTabGroup(["proj-scroll"], "main"));
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    const viewport = container.querySelector<HTMLElement>("[data-stage-table-viewport]")!;
    const vBar = container.querySelector<HTMLElement>("[data-stage-table-v-scrollbar]")!;
    const hBar = container.querySelector<HTMLElement>("[data-stage-table-h-scrollbar]")!;
    const vThumb = container.querySelector<HTMLElement>("[data-stage-table-v-thumb]")!;
    const hThumb = container.querySelector<HTMLElement>("[data-stage-table-h-thumb]")!;

    expect(vBar).not.toBeNull();
    expect(hBar).not.toBeNull();

    // Mock overflow dimensions on viewport & tracks
    Object.defineProperty(viewport, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(viewport, "scrollHeight", { value: 600, configurable: true });
    Object.defineProperty(viewport, "clientWidth", { value: 300, configurable: true });
    Object.defineProperty(viewport, "scrollWidth", { value: 1200, configurable: true });
    Object.defineProperty(vBar, "clientHeight", { value: 200, configurable: true });
    Object.defineProperty(hBar, "clientWidth", { value: 300, configurable: true });

    await React.act(async () => {
      viewport.dispatchEvent(new Event("scroll"));
    });

    // 1. Mouse wheel on bottom slider scrolls horizontally
    await React.act(async () => {
      hBar.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120 }));
    });
    expect(viewport.scrollLeft).toBe(120);

    // 2. Mouse wheel on right slider scrolls vertically
    await React.act(async () => {
      vBar.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 90 }));
    });
    expect(viewport.scrollTop).toBe(90);

    // 3. Pointer drag on right & bottom thumbs updates scrollTop / scrollLeft
    vThumb.setPointerCapture = vi.fn();
    hThumb.setPointerCapture = vi.fn();

    await React.act(async () => {
      vThumb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 1, clientY: 50 }));
      vThumb.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 1, clientY: 100 }));
      vThumb.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 1, clientY: 100 }));
    });
    expect(viewport.scrollTop).toBeGreaterThan(90);

    await React.act(async () => {
      hThumb.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, pointerId: 2, clientX: 40 }));
      hThumb.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: 0, pointerId: 2, clientX: 120 }));
      hThumb.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0, pointerId: 2, clientX: 120 }));
    });
    expect(viewport.scrollLeft).toBeGreaterThan(120);
  });

  it("renders 1-based row numbers, independent fixed column widths, + custom column creation, header drag reorder, and right-click edit field menu", async () => {
    const projectA = new MockProjectClass("proj-ops", ["第一行", "第二行", "第三行"]);
    projectA.table.views[0].visibleColumnIds = ["name", "images", "createdAt"];

    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, createTabGroup(["proj-ops"], "main"));
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    // 1. Row counter from 1..N
    const indexCells = Array.from(container.querySelectorAll<HTMLElement>("[data-stage-table-row-index]"));
    expect(indexCells.map((el) => el.textContent)).toEqual(["1", "2", "3"]);

    // 2. Independent fixed pixel column widths (resizing "name" only changes "name" col width, not "images" or "createdAt")
    const grid = container.querySelector<HTMLTableElement>("[data-stage-table-grid]")!;
    expect(grid.style.tableLayout).toBe("fixed");
    const colsBefore = Array.from(grid.querySelectorAll("colgroup col")).map((c) => (c as HTMLElement).style.width);
    expect(colsBefore).toEqual(["44px", "220px", "170px", "164px", "40px"]);

    const nameResizer = container.querySelector<HTMLElement>('[data-col-resizer="name"]')!;
    await React.act(async () => {
      nameResizer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, clientX: 200 }));
      window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 260 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: 260 }));
    });
    const colsAfter = Array.from(grid.querySelectorAll("colgroup col")).map((c) => (c as HTMLElement).style.width);
    expect(colsAfter).toEqual(["44px", "280px", "170px", "164px", "40px"]);

    // 3. Rightmost + button inserts column & opens 图 4 inline title input + 2-col field type grid
    const addColBtn = container.querySelector<HTMLButtonElement>("[data-stage-table-add-col]")!;
    await React.act(async () => {
      addColBtn.click();
    });
    expect(projectA.table.columns).toHaveLength(1);
    const inlineTitleInput = container.querySelector<HTMLInputElement>("[data-creating-col-title-input]")!;
    expect(inlineTitleInput).not.toBeNull();

    const selectTypeOptionBtn = document.body.querySelector<HTMLButtonElement>('[data-field-type-option="select"]')!;
    expect(selectTypeOptionBtn).not.toBeNull();
    await React.act(async () => {
      selectTypeOptionBtn.click();
    });
    expect(projectA.table.columns[0].type).toBe("select");

    // 4. Right-clicking a custom column header shows 图 1/3/5 context menu (修改字段, 插入字段, 字段编组 + bottom 5-icon bar)
    const customColId = projectA.table.columns[0].id;
    const customHeaderTrigger = container.querySelector<HTMLElement>(
      `[data-table-col-id="${customColId}"] > div > div`,
    )!;
    await React.act(async () => {
      customHeaderTrigger.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 360, clientY: 80 }),
      );
    });
    expect(document.body.textContent).toContain("headerMenu.editField");
    expect(document.body.textContent).toContain("headerMenu.insertField");
    const bottomBar = document.body.querySelector<HTMLElement>("[data-header-menu-bottom-actions]");
    expect(bottomBar).not.toBeNull();
    expect(bottomBar!.querySelectorAll('[role="menuitem"]')).toHaveLength(5);

    // 5. Frozen columns + 图 6 multi-column super-header groups render merged colSpan & sticky left offsets
    await React.act(async () => {
      projectA.table.views[0].columnGroups = [
        { id: "grp_1", name: "基础信息", columnIds: ["name", "images"] },
        { id: "grp_2", name: "后台数据", columnIds: ["createdAt", customColId] },
      ];
      projectA.stageTable.toggleFreezeUpToColumn("images");
    });

    const groupRow = container.querySelector<HTMLTableRowElement>("[data-stage-table-group-row]")!;
    expect(groupRow).not.toBeNull();
    expect(groupRow.textContent).toContain("基础信息");
    expect(groupRow.textContent).toContain("后台数据");
    const groupThs = Array.from(groupRow.querySelectorAll("th"));
    // [#] + [基础信息 colSpan=2] + [后台数据 colSpan=2] + [+]
    expect(groupThs[1].colSpan).toBe(2);
    expect(groupThs[2].colSpan).toBe(2);

    const nameTh = container.querySelector<HTMLElement>('[data-table-col-id="name"]')!;
    const imagesTh = container.querySelector<HTMLElement>('[data-table-col-id="images"]')!;
    expect(nameTh.style.left).toBe("44px");
    expect(imagesTh.style.left).toBe("324px"); // 44 + 280 (resized name width)
  });

  it("supports cell/row/column/multi selection, bidirectional canvas sync, and Explorer-style column sort & filter UI", async () => {
    const projectA = new MockProjectClass("proj-sel", ["节点 10", "节点 2", "节点 1"]);
    projectA.table.views[0].visibleColumnIds = ["name", "createdAt", "updatedAt"];
    projectA.rows[0].createdAt = 1700000003000;
    projectA.rows[1].createdAt = 1700000001000;
    projectA.rows[2].createdAt = 1700000002000;

    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, createTabGroup(["proj-sel"], "main"));
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    // 1. Cell selection: single cell, Shift-range cells, Ctrl multi-cell
    const cell00 = container.querySelector<HTMLElement>('[data-row-id="proj-sel-row-0"][data-col-id="name"]')!;
    const cell11 = container.querySelector<HTMLElement>('[data-row-id="proj-sel-row-1"][data-col-id="createdAt"]')!;
    const cell22 = container.querySelector<HTMLElement>('[data-row-id="proj-sel-row-2"][data-col-id="updatedAt"]')!;

    await React.act(async () => {
      cell00.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    });
    expect(cell00.dataset.cellSelected).toBe("true");
    expect(cell00.dataset.cellActive).toBe("true");
    expect(container.querySelectorAll('[data-cell-selected="true"]')).toHaveLength(1);
    expect(projectA.stageTable.selectRowsOnCanvas).toHaveBeenLastCalledWith(["proj-sel-row-0"]);

    await React.act(async () => {
      cell11.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, shiftKey: true }));
    });
    // 2x2 rectangle -> 4 cells selected across rows 0 and 1
    expect(container.querySelectorAll('[data-cell-selected="true"]')).toHaveLength(4);
    expect(projectA.stageTable.selectRowsOnCanvas).toHaveBeenLastCalledWith(["proj-sel-row-0", "proj-sel-row-1"]);

    await React.act(async () => {
      cell22.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: true }));
    });
    expect(container.querySelectorAll('[data-cell-selected="true"]')).toHaveLength(5);
    expect(projectA.stageTable.selectRowsOnCanvas).toHaveBeenLastCalledWith([
      "proj-sel-row-0",
      "proj-sel-row-1",
      "proj-sel-row-2",
    ]);

    // 2. Column selection: single column + Ctrl multi-column
    const nameTh = container.querySelector<HTMLElement>('[data-table-col-id="name"]')!;
    const updatedTh = container.querySelector<HTMLElement>('[data-table-col-id="updatedAt"]')!;
    await React.act(async () => {
      nameTh.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    });
    expect(nameTh.dataset.colSelected).toBe("true");
    expect(container.querySelectorAll('[data-cell-selected="true"]')).toHaveLength(3);

    await React.act(async () => {
      updatedTh.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, ctrlKey: true }));
    });
    expect(nameTh.dataset.colSelected).toBe("true");
    expect(updatedTh.dataset.colSelected).toBe("true");
    expect(container.querySelectorAll('[data-cell-selected="true"]')).toHaveLength(6);

    // 3. Row selection & Table -> Canvas sync (single + Shift multi-row)
    const rowIdx0 = container.querySelector<HTMLElement>('[data-stage-table-row-index][data-row-id="proj-sel-row-0"]')!;
    const rowIdx2 = container.querySelector<HTMLElement>('[data-stage-table-row-index][data-row-id="proj-sel-row-2"]')!;
    await React.act(async () => {
      rowIdx0.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
    });
    expect(projectA.stageTable.selectRowsOnCanvas).toHaveBeenLastCalledWith(["proj-sel-row-0"]);

    await React.act(async () => {
      rowIdx2.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0, shiftKey: true }));
    });
    expect(projectA.stageTable.selectRowsOnCanvas).toHaveBeenLastCalledWith([
      "proj-sel-row-0",
      "proj-sel-row-1",
      "proj-sel-row-2",
    ]);

    // 4. Canvas -> Table bidirectional sync (multi-select)
    await React.act(async () => {
      projectA.emitCanvasSelection(["proj-sel-row-1", "proj-sel-row-2"]);
    });
    const selectedTrs = Array.from(container.querySelectorAll<HTMLElement>('tr[data-row-selected="true"]'));
    expect(selectedTrs.map((tr) => tr.dataset.stageTableRowId)).toEqual(["proj-sel-row-1", "proj-sel-row-2"]);

    // 5. Explorer-style column sort & filter dropdown + top-center sort chevron arrow
    const nameFilterBtn = container.querySelector<HTMLButtonElement>('[data-col-filter-trigger="name"]')!;
    await React.act(async () => {
      nameFilterBtn.click();
    });
    const sortAscBtn = document.body.querySelector<HTMLButtonElement>("[data-col-sort-asc]")!;
    expect(sortAscBtn).not.toBeNull();
    await React.act(async () => {
      sortAscBtn.click();
    });
    // Top-center arrow appears with direction="asc", rows ordered naturally: 节点 1, 节点 2, 节点 10
    let sortIndicator = container.querySelector<HTMLButtonElement>('[data-col-sort-indicator="name"]')!;
    expect(sortIndicator).not.toBeNull();
    expect(sortIndicator.dataset.sortDirection).toBe("asc");
    const rowOrderAsc = Array.from(container.querySelectorAll<HTMLElement>("tr[data-stage-table-row-id]")).map(
      (tr) => tr.dataset.stageTableRowId,
    );
    expect(rowOrderAsc).toEqual(["proj-sel-row-2", "proj-sel-row-1", "proj-sel-row-0"]);

    // Clicking the top-center arrow toggles direction asc -> desc
    await React.act(async () => {
      sortIndicator.click();
    });
    sortIndicator = container.querySelector<HTMLButtonElement>('[data-col-sort-indicator="name"]')!;
    expect(sortIndicator.dataset.sortDirection).toBe("desc");
    const rowOrderDesc = Array.from(container.querySelectorAll<HTMLElement>("tr[data-stage-table-row-id]")).map(
      (tr) => tr.dataset.stageTableRowId,
    );
    expect(rowOrderDesc).toEqual(["proj-sel-row-0", "proj-sel-row-1", "proj-sel-row-2"]);

    // Unchecking "节点 2" in the filter popover hides that row
    const optionRow2 = document.body.querySelector<HTMLElement>(
      '[data-col-filter-option="节点 2"] button[role="checkbox"]',
    )!;
    await React.act(async () => {
      optionRow2.click();
    });
    expect(nameTh.dataset.colFiltered).toBe("true");
    const filteredRowIds = Array.from(container.querySelectorAll<HTMLElement>("tr[data-stage-table-row-id]")).map(
      (tr) => tr.dataset.stageTableRowId,
    );
    expect(filteredRowIds).toEqual(["proj-sel-row-0", "proj-sel-row-2"]);
  });

  it("allows picking a date from the Calendar popover in a custom date column without losing click events", async () => {
    const projectA = new MockProjectClass("proj-date", ["日程节点"]);
    const dateCol = projectA.stageTable.addCustomColumn({ name: "截止日期", type: "date" });
    projectA.rows[0].tableFields = { [dateCol.id]: "2026-11-25" };

    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, createTabGroup(["proj-date"], "main"));
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    const dateTd = container.querySelector<HTMLElement>(
      `td[data-row-id="proj-date-row-0"][data-col-id="${dateCol.id}"]`,
    )!;
    const dateTrigger = dateTd.querySelector<HTMLElement>('[role="button"]')!;

    await React.act(async () => {
      dateTrigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      dateTrigger.click();
    });

    const day15Button = Array.from(document.body.querySelectorAll<HTMLButtonElement>("button[data-day]")).find(
      (btn) => btn.textContent?.trim() === "15",
    )!;
    expect(day15Button).toBeDefined();

    // Simulate full real pointerdown -> pointerup -> click on Calendar day button; DOM node must stay mounted and commit
    await React.act(async () => {
      day15Button.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
      window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
      expect(day15Button.isConnected).toBe(true);
      day15Button.click();
    });

    expect(projectA.rows[0].tableFields[dateCol.id]).toBe("2026-11-15");
    expect(dateTd.textContent).toContain("2026-11-15");
  });

  it("opens the high-spec formula editor when creating a formula column, inserts column pills, previews, and saves computed cells", async () => {
    const projectA = new MockProjectClass("proj-formula", ["细胞膜图像", "线粒体"]);
    const correctCol = projectA.stageTable.addCustomColumn({ name: "答对次数", type: "number" });
    projectA.rows[0].tableFields = { [correctCol.id]: 3 };
    projectA.rows[1].tableFields = { [correctCol.id]: 1 };

    // Wire formula evaluation into mock getRows
    projectA.stageTable.getRows = () => {
      const evaluated = evaluateTableFormulas(projectA.rows, projectA.table.columns);
      return projectA.rows.map((r: any) => ({
        ...r,
        formulaValues: evaluated.get(r.uuid) ?? {},
      }));
    };

    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, createTabGroup(["proj-formula"], "main"));
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    // Click right-most "+" button to insert a new custom column
    const addColBtn = container.querySelector<HTMLButtonElement>('button[aria-label="addColumnPopover.triggerAria"]')!;
    await React.act(async () => {
      addColBtn.click();
    });

    // Pick "formula" in FieldTypeGridPicker -> auto-opens Formula Editor dialog
    const formulaTypeBtn = document.body.querySelector<HTMLButtonElement>('button[data-field-type-option="formula"]')!;
    expect(formulaTypeBtn).toBeTruthy();
    await React.act(async () => {
      formulaTypeBtn.click();
    });

    const editorDialog = document.body.querySelector<HTMLElement>("[data-stage-table-formula-editor]");
    expect(editorDialog).toBeTruthy();

    // Click POWER function & column item in sidebar to insert snippet and blue pill
    const pillInput = editorDialog!.querySelector<HTMLElement>("[data-formula-pill-input]")!;
    const colSidebarBtn = editorDialog!.querySelector<HTMLButtonElement>(
      `button[data-formula-catalog-item="col:${correctCol.id}"]`,
    )!;
    expect(colSidebarBtn).toBeTruthy();

    await React.act(async () => {
      colSidebarBtn.click();
    });

    // Verify atomic pill rendered inside editor and live preview shows "3"
    const insertedPill = pillInput.querySelector<HTMLElement>(`[data-formula-pill="${correctCol.id}"]`);
    expect(insertedPill).toBeTruthy();
    expect(insertedPill!.textContent).toContain("答对次数");

    // Append " * 2" and dispatch input event so preview updates to "6"
    await React.act(async () => {
      pillInput.appendChild(document.createTextNode(" * 2"));
      pillInput.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const previewVal = editorDialog!.querySelector<HTMLElement>("[data-formula-preview-value]")!;
    expect(previewVal.textContent?.trim()).toBe("6");

    // Click confirm save button
    const saveBtn = editorDialog!.querySelector<HTMLButtonElement>("[data-formula-editor-save]")!;
    await React.act(async () => {
      saveBtn.click();
    });

    // Formula dialog closes and table cells render 6 and 2
    const formulaCol = projectA.table.columns.find((c: any) => c.type === "formula")!;
    expect(formulaCol).toBeTruthy();
    expect(formulaCol.formula).toBe(`{{${correctCol.id}}} * 2`);

    const cell0 = container.querySelector<HTMLElement>(
      `td[data-row-id="proj-formula-row-0"][data-col-id="${formulaCol.id}"]`,
    )!;
    const cell1 = container.querySelector<HTMLElement>(
      `td[data-row-id="proj-formula-row-1"][data-col-id="${formulaCol.id}"]`,
    )!;
    expect(cell0.textContent?.trim()).toBe("6");
    expect(cell1.textContent?.trim()).toBe("2");
  });

  it("creates and switches multiple views (Table, Kanban, Gantt, Gallery, Calendar) inside the same table", async () => {
    const projectA = new MockProjectClass("proj-views", ["细胞器图像", "光合作用"]);
    const sourceCol = projectA.stageTable.addCustomColumn({ name: "出处", type: "select" });
    const optBook = projectA.stageTable.createOrGetSelectOption(sourceCol.id, "课本")!;
    projectA.stageTable.createOrGetSelectOption(sourceCol.id, "真题分类");
    projectA.rows[0].tableFields = { [sourceCol.id]: optBook.id };

    const group = createTabGroup([projectA as never], projectA as never);
    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, group);
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    // Open "+" New View menu and verify all 5 view types appear
    const addViewBtn = container.querySelector<HTMLButtonElement>("[data-stage-table-add-view-btn]")!;
    expect(addViewBtn).toBeTruthy();
    await React.act(async () => {
      addViewBtn.click();
    });

    const addViewMenu = document.body.querySelector<HTMLElement>("[data-stage-table-add-view-menu]");
    expect(addViewMenu).toBeTruthy();
    for (const vType of ["table", "kanban", "gantt", "gallery", "calendar"]) {
      expect(addViewMenu!.querySelector(`[data-create-view-option="${vType}"]`)).toBeTruthy();
    }

    // Create Kanban view
    await React.act(async () => {
      addViewMenu!.querySelector<HTMLButtonElement>('[data-create-view-option="kanban"]')!.click();
    });
    expect(container.querySelector("[data-stage-table-kanban-view]")).toBeTruthy();
    expect(container.querySelector(`[data-kanban-group="${optBook.id}"]`)).toBeTruthy();
    expect(container.querySelector('[data-kanban-group="__ungrouped__"]')).toBeTruthy();

    // Create a second Kanban view + Gantt + Gallery + Calendar
    for (const vType of ["kanban", "gantt", "gallery", "calendar"] as const) {
      await React.act(async () => {
        container.querySelector<HTMLButtonElement>("[data-stage-table-add-view-btn]")!.click();
      });
      await React.act(async () => {
        document.body.querySelector<HTMLButtonElement>(`[data-create-view-option="${vType}"]`)!.click();
      });
    }

    expect(projectA.table.views.length).toBe(6);
    expect(container.querySelector("[data-stage-table-calendar-view]")).toBeTruthy();

    // Switch Calendar display modes (week / day / month) and toggle Undated drawer
    await React.act(async () => {
      container.querySelector<HTMLButtonElement>('[data-calendar-mode="week"]')!.click();
    });
    expect(projectA.stageTable.getActiveView().calendar?.displayMode).toBe("week");
    await React.act(async () => {
      container.querySelector<HTMLButtonElement>("[data-calendar-undated-trigger]")!.click();
    });
    expect(container.querySelector("[data-calendar-undated-drawer]")).toBeTruthy();

    // Switch to Gallery view
    const galleryTab = container.querySelector<HTMLElement>('[data-view-type="gallery"]')!;
    await React.act(async () => {
      galleryTab.click();
    });
    expect(container.querySelector("[data-stage-table-gallery-view]")).toBeTruthy();
    expect(container.querySelectorAll("[data-gallery-card]").length).toBe(2);

    // Switch to Gantt view and test scale switch + left table collapse
    const ganttTab = container.querySelector<HTMLElement>('[data-view-type="gantt"]')!;
    await React.act(async () => {
      ganttTab.click();
    });
    expect(container.querySelector("[data-stage-table-gantt-view]")).toBeTruthy();
    expect(container.querySelector("[data-gantt-left-pane]")).toBeTruthy();

    await React.act(async () => {
      container.querySelector<HTMLButtonElement>('[data-gantt-scale="week"]')!.click();
    });
    expect(projectA.stageTable.getActiveView().gantt?.timeScale).toBe("week");

    await React.act(async () => {
      container.querySelector<HTMLButtonElement>("[data-gantt-toggle-left]")!.click();
    });
    expect(container.querySelector("[data-gantt-left-pane]")).toBeNull();

    // Duplicate & delete view from active view menu
    const activeViewId = projectA.stageTable.getActiveView().id;
    await React.act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-view-tab-menu-trigger="${activeViewId}"]`)!.click();
    });
    await React.act(async () => {
      document.body.querySelector<HTMLButtonElement>("[data-view-action-duplicate]")!.click();
    });
    expect(projectA.table.views.length).toBe(7);

    const dupViewId = projectA.stageTable.getActiveView().id;
    await React.act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-view-tab-menu-trigger="${dupViewId}"]`)!.click();
    });
    await React.act(async () => {
      document.body.querySelector<HTMLButtonElement>("[data-view-action-delete]")!.click();
    });
    expect(projectA.table.views.length).toBe(6);
  });

  it("supports image lightbox navigation (arrows & bottom thumbnails), non-squashed Kanban cards, and pointer view-tab drag reorder", async () => {
    const projectA = new MockProjectClass(
      "proj-img-kanban",
      Array.from({ length: 65 }, (_, i) => `节点 ${i + 1}`),
    );
    (projectA as any).attachments = new Map([
      ["att-1", new Blob(["a"], { type: "image/png" })],
      ["att-2", new Blob(["b"], { type: "image/png" })],
      ["att-3", new Blob(["c"], { type: "image/png" })],
    ]);
    projectA.rows[0].images = [
      { uuid: "img-1", attachmentId: "att-1" },
      { uuid: "img-2", attachmentId: "att-2" },
    ];
    projectA.rows[1].images = [{ uuid: "img-3", attachmentId: "att-3" }];

    // Mock URL.createObjectURL for jsdom lightbox previews
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => "blob:mock-image");
    URL.revokeObjectURL = vi.fn();

    try {
      const group = createTabGroup([projectA as never], projectA as never);
      store.set(tabsAtom, [projectA as never]);
      store.set(tabGroupRootAtom, group);
      store.set(activeTabAtom, projectA as never);
      store.set(stageTableOpenAtom, true);

      await React.act(async () => {
        root.render(
          <Provider store={store}>
            <DockedArea
              onTabClick={vi.fn()}
              onTabClose={vi.fn()}
              onTitleBarMouseDown={vi.fn()}
              isClassroomMode={false}
            />
            <div data-pg-titlebar-tab-space />
          </Provider>,
        );
      });

      // 1. Create Gallery view and open Lightbox by clicking first card's image
      await React.act(async () => {
        container.querySelector<HTMLButtonElement>("[data-stage-table-add-view-btn]")!.click();
      });
      await React.act(async () => {
        document.body.querySelector<HTMLButtonElement>('[data-create-view-option="gallery"]')!.click();
      });

      const firstCardImg = container.querySelector<HTMLImageElement>(
        '[data-gallery-card="proj-img-kanban-row-0"] img',
      )!;
      expect(firstCardImg).toBeTruthy();
      await React.act(async () => {
        firstCardImg.click();
      });

      const lightbox = document.body.querySelector<HTMLElement>("[data-image-lightbox]")!;
      expect(lightbox).toBeTruthy();
      expect(lightbox.querySelector("[data-lightbox-counter]")?.textContent?.trim()).toBe("1 / 2");
      expect(lightbox.querySelectorAll("[data-lightbox-thumb]").length).toBe(2);

      // Click right arrow -> switches to 2nd image
      await React.act(async () => {
        lightbox.querySelector<HTMLButtonElement>("[data-lightbox-next]")!.click();
      });
      expect(lightbox.querySelector("[data-lightbox-counter]")?.textContent?.trim()).toBe("2 / 2");

      // Switch scope to "all" -> sees all 3 images across rows, click thumbnail #2 (3rd image)
      await React.act(async () => {
        lightbox.querySelector<HTMLButtonElement>('[data-lightbox-scope="all"]')!.click();
      });
      expect(lightbox.querySelectorAll("[data-lightbox-thumb]").length).toBe(3);
      await React.act(async () => {
        lightbox.querySelector<HTMLButtonElement>('[data-lightbox-thumb="2"]')!.click();
      });
      expect(lightbox.querySelector("[data-lightbox-counter]")?.textContent?.trim()).toBe("3 / 3");
      expect(lightbox.querySelector("[data-lightbox-main-img]")?.getAttribute("data-lightbox-main-img")).toBe("att-3");

      // Click left arrow -> jumps back to 2 / 3
      await React.act(async () => {
        lightbox.querySelector<HTMLButtonElement>("[data-lightbox-prev]")!.click();
      });
      expect(lightbox.querySelector("[data-lightbox-counter]")?.textContent?.trim()).toBe("2 / 3");

      // Close lightbox
      await React.act(async () => {
        lightbox.querySelector<HTMLButtonElement>("[data-lightbox-close]")!.click();
      });
      expect(document.body.querySelector("[data-image-lightbox]")).toBeNull();

      // 2. Create Kanban view with 65 ungrouped items and verify cards carry shrink-0 (preventing thin-line squashing)
      await React.act(async () => {
        container.querySelector<HTMLButtonElement>("[data-stage-table-add-view-btn]")!.click();
      });
      await React.act(async () => {
        document.body.querySelector<HTMLButtonElement>('[data-create-view-option="kanban"]')!.click();
      });
      const kanbanCards = container.querySelectorAll<HTMLElement>("[data-kanban-card]");
      expect(kanbanCards.length).toBe(65);
      expect(kanbanCards[0].className).toContain("shrink-0");

      // 3. Pointer-drag reorder view tabs left/right
      const tabs = Array.from(container.querySelectorAll<HTMLElement>("[data-stage-table-view-tab]"));
      expect(tabs.length).toBe(3);
      tabs.forEach((tabEl, idx) => {
        tabEl.getBoundingClientRect = () =>
          ({
            left: idx * 100,
            right: (idx + 1) * 100,
            width: 100,
            top: 0,
            bottom: 32,
            height: 32,
            x: idx * 100,
            y: 0,
            toJSON: () => {},
          }) as DOMRect;
      });

      const draggedTab = tabs[2]; // Kanban (rightmost)
      const firstViewId = tabs[0].dataset.stageTableViewTab!;
      const draggedViewId = draggedTab.dataset.stageTableViewTab!;

      await React.act(async () => {
        draggedTab.dispatchEvent(
          new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 250, clientY: 16 }),
        );
        window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 20, clientY: 16 }));
        window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 20, clientY: 16 }));
      });

      expect(projectA.stageTable.reorderViews).toHaveBeenCalledWith(draggedViewId, firstViewId, "before");
      expect(projectA.table.views[0].id).toBe(draggedViewId);
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });

  it("renders grouped original-table field picker, supports condition drag-reorder, collapse, and live filtering", async () => {
    const projectA = new MockProjectClass("proj-flt", ["细胞膜", "线粒体", "核糖体"]);
    const colStatus = projectA.stageTable.addCustomColumn({ name: "归档状态", type: "select" });
    const colNum = projectA.stageTable.addCustomColumn({ name: "数字", type: "number" });
    const colHidden = projectA.stageTable.addCustomColumn({ name: "隐藏列", type: "text" });
    colStatus.options = [
      { id: "opt_arch", name: "归档", color: "blue" },
      { id: "opt_open", name: "进行中", color: "green" },
    ];
    // 原始表从左到右仅展示：基础信息(name, images) -> 后台数据(colStatus) -> 未分组(colNum)；隐藏列与未展示系统列不应出现在筛选字段列表中
    projectA.table.views[0].visibleColumnIds = ["name", "images", colStatus.id, colNum.id];
    projectA.table.views[0].columnGroups = [
      { id: "grp_basic", name: "基础信息", columnIds: ["name", "images"] },
      { id: "grp_backend", name: "后台数据", columnIds: [colStatus.id] },
    ];

    projectA.rows[0].tableFields = { [colNum.id]: 80, [colStatus.id]: "opt_arch" };
    projectA.rows[1].tableFields = { [colNum.id]: 20, [colStatus.id]: "opt_open" };
    projectA.rows[2].tableFields = {};
    projectA.rows[2].images = [{ uuid: "img-2", attachmentId: "att-2" }];

    const group = createTabGroup([projectA as never], projectA as never);
    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, group);
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    const filterBtn = container.querySelector<HTMLButtonElement>("[data-stage-table-filter-toolbar]")!;
    expect(filterBtn).toBeTruthy();
    await React.act(async () => {
      filterBtn.click();
    });

    const popover = document.body.querySelector<HTMLElement>("[data-stage-table-filter-popover]")!;
    expect(popover).toBeTruthy();
    // Must NOT include Feishu's "仅你可见" toggle
    expect(popover.textContent).not.toContain("仅你可见");

    // 1. Clicking "+ 添加筛选条件" opens grouped "选择字段" popover ordered left-to-right from 原始表
    await React.act(async () => {
      popover.querySelector<HTMLButtonElement>("[data-filter-add-condition]")!.click();
    });
    const addFieldPopover = document.body.querySelector<HTMLElement>("[data-filter-add-field-popover]")!;
    expect(addFieldPopover).toBeTruthy();
    const pickerGroups = Array.from(addFieldPopover.querySelectorAll<HTMLElement>("[data-filter-field-group]")).map(
      (el) => el.dataset.filterFieldGroup,
    );
    expect(pickerGroups).toEqual(["grp_basic", "grp_backend"]);
    const pickerOptions = Array.from(addFieldPopover.querySelectorAll<HTMLElement>("[data-filter-field-option]")).map(
      (el) => el.dataset.filterFieldOption,
    );
    expect(pickerOptions).toEqual(["name", "images", colStatus.id, colNum.id]);
    // Hidden custom column and unshown system columns must NOT appear
    expect(pickerOptions).not.toContain(colHidden.id);
    expect(pickerOptions).not.toContain("parents");
    expect(pickerOptions).not.toContain("createdAt");

    // Toggle group collapse inside "选择字段"
    await React.act(async () => {
      addFieldPopover.querySelector<HTMLButtonElement>('[data-filter-field-group-toggle="grp_basic"]')!.click();
    });
    expect(addFieldPopover.querySelector('[data-filter-field-option="name"]')).toBeNull();
    await React.act(async () => {
      addFieldPopover.querySelector<HTMLButtonElement>('[data-filter-field-group-toggle="grp_basic"]')!.click();
    });
    expect(addFieldPopover.querySelector('[data-filter-field-option="name"]')).toBeTruthy();

    // Pick "数字" directly from the grouped picker
    await React.act(async () => {
      addFieldPopover.querySelector<HTMLButtonElement>(`[data-filter-field-option="${colNum.id}"]`)!.click();
    });

    const firstCard = popover.querySelector<HTMLElement>("[data-filter-condition-card]")!;
    const firstCondId = firstCard.dataset.filterConditionCard!;
    expect(popover.querySelector(`[data-filter-condition-body="${firstCondId}"]`)).toBeTruthy();

    // Collapse & expand via small arrow
    await React.act(async () => {
      popover.querySelector<HTMLButtonElement>(`[data-filter-toggle-collapse="${firstCondId}"]`)!.click();
    });
    expect(popover.querySelector(`[data-filter-condition-body="${firstCondId}"]`)).toBeNull();
    expect(popover.querySelector(`[data-filter-collapsed-summary="${firstCondId}"]`)).toBeTruthy();

    await React.act(async () => {
      popover.querySelector<HTMLButtonElement>(`[data-filter-toggle-collapse="${firstCondId}"]`)!.click();
    });
    expect(popover.querySelector(`[data-filter-condition-body="${firstCondId}"]`)).toBeTruthy();

    // Open operator dropdown -> verify exact 8 number operators
    await React.act(async () => {
      popover.querySelector<HTMLButtonElement>(`[data-filter-operator-trigger="${firstCondId}"]`)!.click();
    });
    const numOps = Array.from(document.body.querySelectorAll<HTMLElement>("[data-filter-operator-option]")).map(
      (el) => el.dataset.filterOperatorOption,
    );
    expect(numOps).toEqual(["eq", "neq", "gt", "gte", "lt", "lte", "is_empty", "is_not_empty"]);

    // Select ">" and enter 50 -> only row 0 ("细胞膜") matches
    await React.act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-filter-operator-option="gt"]')!.click();
    });
    await React.act(async () => {
      projectA.stageTable.updateFilterCondition(firstCondId, { value: "50" });
    });
    expect(container.querySelectorAll("tbody tr[data-stage-table-row-id]").length).toBe(1);
    expect(filterBtn.textContent).toContain("1");

    // 2. Add second condition on "images" via "+ 添加筛选条件" picker -> verify only 2 operators & no value input
    await React.act(async () => {
      popover.querySelector<HTMLButtonElement>("[data-filter-add-condition]")!.click();
    });
    await React.act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-filter-field-option="images"]')!.click();
    });
    const cards = Array.from(popover.querySelectorAll<HTMLElement>("[data-filter-condition-card]"));
    expect(cards.length).toBe(2);
    const imgCondId = cards[1].dataset.filterConditionCard!;
    expect(popover.querySelector(`[data-filter-text-input="${imgCondId}"]`)).toBeNull();
    expect(popover.querySelector(`[data-filter-number-input="${imgCondId}"]`)).toBeNull();

    await React.act(async () => {
      popover.querySelector<HTMLButtonElement>(`[data-filter-operator-trigger="${imgCondId}"]`)!.click();
    });
    const imgOps = Array.from(document.body.querySelectorAll<HTMLElement>("[data-filter-operator-option]")).map(
      (el) => el.dataset.filterOperatorOption,
    );
    expect(imgOps).toEqual(["is_empty", "is_not_empty"]);
    await React.act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-filter-operator-option="is_not_empty"]')!.click();
    });

    // Under AND: number > 50 (row 0) AND images not empty (row 2) => 0 rows
    expect(container.querySelectorAll("tbody tr[data-stage-table-row-id]").length).toBe(0);

    // Switch conjunction to OR -> row 0 and row 2 match (2 rows)
    await React.act(async () => {
      popover.querySelector<HTMLButtonElement>("[data-filter-conjunction-trigger]")!.click();
    });
    await React.act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-filter-conjunction-option="or"]')!.click();
    });
    expect(container.querySelectorAll("tbody tr[data-stage-table-row-id]").length).toBe(2);

    // 3. Drag-and-drop reorder condition cards: drag 2nd card (images) above 1st card (number)
    const currentCards = Array.from(popover.querySelectorAll<HTMLElement>("[data-filter-condition-card]"));
    currentCards.forEach((cardEl, idx) => {
      cardEl.getBoundingClientRect = () =>
        ({
          top: idx * 100,
          bottom: (idx + 1) * 100,
          height: 100,
          left: 0,
          right: 340,
          width: 340,
          x: 0,
          y: idx * 100,
          toJSON: () => {},
        }) as DOMRect;
    });
    const dragHandle = popover.querySelector<HTMLButtonElement>(`[data-filter-drag-handle="${imgCondId}"]`)!;
    await React.act(async () => {
      dragHandle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 12, clientY: 120 }));
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 12, clientY: 15 }));
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 12, clientY: 15 }));
    });
    expect(projectA.stageTable.reorderFilterConditions).toHaveBeenCalledWith(imgCondId, firstCondId, "before");
    const reorderedIds = Array.from(popover.querySelectorAll<HTMLElement>("[data-filter-condition-card]")).map(
      (el) => el.dataset.filterConditionCard,
    );
    expect(reorderedIds).toEqual([imgCondId, firstCondId]);

    // 4. Add third condition on select column -> verify exact 6 operators and option pills
    await React.act(async () => {
      projectA.stageTable.addFilterCondition(colStatus.id);
    });
    const selectCondId = Array.from(popover.querySelectorAll<HTMLElement>("[data-filter-condition-card]"))[2].dataset
      .filterConditionCard!;
    expect(popover.querySelector('[data-filter-select-option="opt_arch"]')).toBeTruthy();
    await React.act(async () => {
      popover.querySelector<HTMLButtonElement>(`[data-filter-operator-trigger="${selectCondId}"]`)!.click();
    });
    const selectOps = Array.from(document.body.querySelectorAll<HTMLElement>("[data-filter-operator-option]")).map(
      (el) => el.dataset.filterOperatorOption,
    );
    expect(selectOps).toEqual(["contains", "not_contains", "eq", "neq", "is_empty", "is_not_empty"]);

    // Remove condition & clear all
    await React.act(async () => {
      popover.querySelector<HTMLButtonElement>(`[data-filter-remove-condition="${selectCondId}"]`)!.click();
    });
    expect(popover.querySelectorAll("[data-filter-condition-card]").length).toBe(2);

    await React.act(async () => {
      popover.querySelector<HTMLButtonElement>("[data-filter-clear-all]")!.click();
    });
    expect(container.querySelectorAll("tbody tr[data-stage-table-row-id]").length).toBe(3);
  });

  it("间隔重复视图：创建后自动补齐隐藏受保护列、支持单/双列切换、三按钮作答改选撤销、右上角翻转与正反面双击编辑", async () => {
    const projectA = new MockProjectClass("sr-proj", ["线粒体双层膜结构", "高尔基体功能"]);
    projectA.rows[0].images = [{ uuid: "img-1", attachmentId: "att-1" }];
    const group = createTabGroup([projectA as never], projectA as never);
    store.set(tabsAtom, [projectA as never]);
    store.set(tabGroupRootAtom, group);
    store.set(activeTabAtom, projectA as never);
    store.set(stageTableOpenAtom, true);

    await React.act(async () => {
      root.render(
        <Provider store={store}>
          <DockedArea onTabClick={vi.fn()} onTabClose={vi.fn()} onTitleBarMouseDown={vi.fn()} isClassroomMode={false} />
          <div data-pg-titlebar-tab-space />
        </Provider>,
      );
    });

    // 1. 点击 + 新建视图 -> 选择「间隔重复」
    await React.act(async () => {
      container.querySelector<HTMLButtonElement>("[data-stage-table-add-view-btn]")!.click();
    });
    const srOption = document.body.querySelector<HTMLButtonElement>('[data-create-view-option="spaced_repetition"]')!;
    expect(srOption).toBeTruthy();
    await React.act(async () => {
      srOption.click();
    });

    // 验证自动补齐 11 列且原始表默认仅可见 name 列
    expect(projectA.table.columns.length).toBe(11);
    expect(projectA.table.views[0].visibleColumnIds).toEqual(["name"]);
    expect(container.querySelector("[data-stage-table-spaced-repetition-view]")).toBeTruthy();

    // 2. 验证默认双列布局，切换到单列后网格列数变为 1
    const grid = () => container.querySelector<HTMLElement>("[data-sr-card-grid]")!;
    expect(grid().dataset.srColumnCount).toBe("2");
    await React.act(async () => {
      container.querySelector<HTMLButtonElement>('[data-sr-cols="1"]')!.click();
    });
    expect(grid().dataset.srColumnCount).toBe("1");

    // 3. 验证卡片正面：文字在上、图片在下、底部从左到右三个等大无文字图标按钮（对-闭卷 / 对-开卷 / 错）
    const firstCard = () => container.querySelector<HTMLElement>('[data-sr-card="sr-proj-row-0"]')!;
    expect(firstCard().dataset.srCardSide).toBe("front");
    expect(firstCard().querySelector('[data-sr-front-text="sr-proj-row-0"]')?.textContent).toContain(
      "线粒体双层膜结构",
    );
    expect(firstCard().querySelector('[data-sr-front-images="sr-proj-row-0"]')).toBeTruthy();
    const answerButtons = Array.from(firstCard().querySelectorAll<HTMLButtonElement>("[data-sr-answer-btn]"));
    expect(answerButtons.map((b) => b.dataset.srAnswerBtn)).toEqual(["correct_closed", "correct_open", "wrong"]);
    // 三个按钮均为纯图标不含可见文字
    for (const btn of answerButtons) {
      expect(btn.textContent?.trim()).toBe("");
      expect(btn.querySelector("svg")).toBeTruthy();
    }

    // 4. 点击左按钮「对-闭卷」：掌握程度=1，答对次数=1，延期=0，卡片原地保留并高亮
    await React.act(async () => {
      answerButtons[0].click();
    });
    expect(firstCard().dataset.srAnswered).toBe("correct_closed");
    expect(projectA.rows[0].tableFields.col_sr_mastery).toBe(1);
    expect(projectA.rows[0].tableFields.col_sr_correctCount).toBe(1);
    expect(projectA.rows[0].tableFields.col_sr_delay).toBe(0);

    // 改选中间按钮「对-开卷」：基于首次作答前快照计算，掌握程度=2，答对次数仍为 1
    await React.act(async () => {
      firstCard().querySelector<HTMLButtonElement>('[data-sr-answer-btn="correct_open"]')!.click();
    });
    expect(firstCard().dataset.srAnswered).toBe("correct_open");
    expect(projectA.rows[0].tableFields.col_sr_mastery).toBe(2);
    expect(projectA.rows[0].tableFields.col_sr_correctCount).toBe(1);

    // 改选右按钮「错」：掌握程度=3，答对次数=0，延期=1
    await React.act(async () => {
      firstCard().querySelector<HTMLButtonElement>('[data-sr-answer-btn="wrong"]')!.click();
    });
    expect(firstCard().dataset.srAnswered).toBe("wrong");
    expect(projectA.rows[0].tableFields.col_sr_mastery).toBe(3);
    expect(projectA.rows[0].tableFields.col_sr_correctCount).toBe(0);
    expect(projectA.rows[0].tableFields.col_sr_delay).toBe(1);

    // 再次点击「错」撤销本次作答
    await React.act(async () => {
      firstCard().querySelector<HTMLButtonElement>('[data-sr-answer-btn="wrong"]')!.click();
    });
    expect(firstCard().dataset.srAnswered).toBe("");
    expect(projectA.rows[0].tableFields.col_sr_mastery).toBeUndefined();

    // 5. 正面添加自定义属性：同步到表格视图、默认隐藏、不可删除，并在卡片正面立即展示
    await React.act(async () => {
      firstCard().querySelector<HTMLButtonElement>('[data-sr-card-add-front-field="sr-proj-row-0"]')!.click();
    });
    const frontNameInput = document.body.querySelector<HTMLInputElement>('[data-sr-add-field-name-input="front"]')!;
    expect(frontNameInput).toBeTruthy();
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(frontNameInput, "题干提示");
      frontNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await React.act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-sr-add-field-confirm="front"]')!.click();
    });
    const frontCustomCol = projectA.table.columns.find((c: any) => c.name === "题干提示")!;
    expect(frontCustomCol).toBeTruthy();
    expect(frontCustomCol.protectedRole).toBeUndefined();
    expect(projectA.table.views[0].visibleColumnIds).not.toContain(frontCustomCol.id);
    expect(firstCard().querySelector(`[data-sr-field-row="${frontCustomCol.id}"]`)).toBeTruthy();

    // 6. 正面双击节点文字直接编辑
    await React.act(async () => {
      firstCard()
        .querySelector<HTMLElement>('[data-sr-front-text="sr-proj-row-0"]')!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const titleInput = firstCard().querySelector<HTMLTextAreaElement>('[data-sr-title-input="sr-proj-row-0"]')!;
    expect(titleInput).toBeTruthy();
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(titleInput, "线粒体双层膜与嵴");
      titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await React.act(async () => {
      titleInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
    });
    expect(projectA.stageTable.updateRowPrimaryText).toHaveBeenCalledWith("sr-proj-row-0", "线粒体双层膜与嵴");

    // 7. 点击右上角翻转按钮进入背面，展示最后编辑时间与调度字段，支持背面添加自定义属性与双击编辑
    await React.act(async () => {
      firstCard().querySelector<HTMLButtonElement>('[data-sr-flip-btn="sr-proj-row-0"]')!.click();
    });
    expect(firstCard().dataset.srCardSide).toBe("back");
    expect(firstCard().querySelector('[data-sr-back-updated-at="sr-proj-row-0"]')).toBeTruthy();

    await React.act(async () => {
      firstCard().querySelector<HTMLButtonElement>('[data-sr-card-add-back-field="sr-proj-row-0"]')!.click();
    });
    const backNameInput = document.body.querySelector<HTMLInputElement>('[data-sr-add-field-name-input="back"]')!;
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(backNameInput, "错因归类");
      backNameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await React.act(async () => {
      document.body.querySelector<HTMLButtonElement>('[data-sr-add-field-confirm="back"]')!.click();
    });
    const backCustomCol = projectA.table.columns.find((c: any) => c.name === "错因归类")!;
    expect(backCustomCol).toBeTruthy();
    expect(backCustomCol.protectedRole).toBeUndefined();
    expect(projectA.table.views[0].visibleColumnIds).not.toContain(backCustomCol.id);
    expect(firstCard().querySelector(`[data-sr-field-row="${backCustomCol.id}"]`)).toBeTruthy();

    // 在背面拖动排序属性：1) 将「延期」拖到第一行右侧并排（自动等分填满宽度）；2) 再拖到第一行上方独立成行
    const backContainer = firstCard().querySelector<HTMLElement>('[data-sr-back-fields="sr-proj-row-0"]')!;
    const mockBackItemRects = () => {
      const items = Array.from(backContainer.querySelectorAll<HTMLElement>("[data-sr-sortable-item]"));
      items.forEach((el, idx) => {
        el.getBoundingClientRect = () =>
          ({
            top: idx * 40,
            bottom: (idx + 1) * 40,
            left: 0,
            right: 320,
            width: 320,
            height: 40,
            x: 0,
            y: idx * 40,
            toJSON: () => {},
          }) as DOMRect;
      });
      return items;
    };
    const backItemsBefore = mockBackItemRects();
    const firstBackColId = backItemsBefore[0].dataset.srSortableItem!;
    const delayDragHandle = backContainer.querySelector<HTMLElement>('[data-sr-field-drag-handle="col_sr_delay"]')!;
    expect(delayDragHandle).toBeTruthy();

    // 拖到第一项的右半中间区域 (clientX: 280, clientY: 20) -> position === "right" -> 合并为同一行 [firstBackColId, col_sr_delay]
    await React.act(async () => {
      delayDragHandle.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 20, clientY: 240 }),
      );
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 280, clientY: 20 }));
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 280, clientY: 20 }));
    });
    expect(projectA.stageTable.reorderSpacedRepetitionFields).toHaveBeenCalledWith(
      "back",
      "col_sr_delay",
      firstBackColId,
      "right",
      expect.any(Array),
    );
    const firstRowAfterRight = backContainer.querySelector<HTMLElement>("[data-sr-field-layout-row]")!;
    expect(firstRowAfterRight.dataset.srFieldLayoutRow).toBe(`${firstBackColId},col_sr_delay`);
    expect(firstRowAfterRight.style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");

    // 再将「延期」拖到第一项上边缘 (clientY: 4) -> position === "top" -> 独立成为第一行自动占满 100% 宽度
    mockBackItemRects();
    const delayDragHandle2 = backContainer.querySelector<HTMLElement>('[data-sr-field-drag-handle="col_sr_delay"]')!;
    await React.act(async () => {
      delayDragHandle2.dispatchEvent(
        new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 200, clientY: 60 }),
      );
      window.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 80, clientY: 4 }));
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 80, clientY: 4 }));
    });
    const firstRowAfterTop = backContainer.querySelector<HTMLElement>("[data-sr-field-layout-row]")!;
    expect(firstRowAfterTop.dataset.srFieldLayoutRow).toBe("col_sr_delay");
    expect(firstRowAfterTop.style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");

    // 在视图设置中删除新增的自定义属性列：可正常删除，核心 11 列无删除按钮且不可删除
    await React.act(async () => {
      container.querySelector<HTMLButtonElement>("[data-sr-settings-trigger]")!.click();
    });
    expect(document.body.querySelector('[data-sr-delete-custom-field="col_sr_delay"]')).toBeNull();
    const deleteFrontBtn = document.body.querySelector<HTMLButtonElement>(
      `[data-sr-delete-custom-field="${frontCustomCol.id}"]`,
    )!;
    expect(deleteFrontBtn).toBeTruthy();
    await React.act(async () => {
      deleteFrontBtn.click();
    });
    expect(projectA.table.columns.some((c: any) => c.id === frontCustomCol.id)).toBe(false);
    expect(projectA.stageTable.deleteCustomColumn(backCustomCol.id)).toBe(true);
    expect(projectA.stageTable.deleteCustomColumn("col_sr_delay")).toBe(false);
    await React.act(async () => {
      container.querySelector<HTMLButtonElement>("[data-sr-settings-trigger]")!.click();
    });

    await React.act(async () => {
      firstCard()
        .querySelector<HTMLElement>('[data-sr-field-row="col_sr_delay"]')!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    const delayInput = firstCard().querySelector<HTMLInputElement>('[data-sr-inline-input="col_sr_delay"]')!;
    expect(delayInput).toBeTruthy();
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(delayInput, "4");
      delayInput.dispatchEvent(new Event("input", { bubbles: true }));
      delayInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(projectA.rows[0].tableFields.col_sr_delay).toBe(4);

    // 8. 验证筛选与排序在间隔重复视图中可筛选/排序默认隐藏的间隔重复字段
    await React.act(async () => {
      container.querySelector<HTMLButtonElement>("[data-stage-table-filter-toolbar]")!.click();
    });
    const filterPopover = document.body.querySelector<HTMLElement>("[data-stage-table-filter-popover]")!;
    expect(filterPopover).toBeTruthy();
    await React.act(async () => {
      filterPopover.querySelector<HTMLButtonElement>("[data-filter-add-condition]")!.click();
    });
    const delayFilterOption = document.body.querySelector<HTMLButtonElement>(
      '[data-filter-field-option="col_sr_delay"]',
    )!;
    expect(delayFilterOption).toBeTruthy();
    await React.act(async () => {
      delayFilterOption.click();
    });
    const condId =
      filterPopover.querySelector<HTMLElement>("[data-filter-condition-card]")!.dataset.filterConditionCard!;
    await React.act(async () => {
      projectA.stageTable.updateFilterCondition(condId, { operator: "eq", value: "4" });
    });
    expect(container.querySelectorAll("[data-sr-card]").length).toBe(1);
    await React.act(async () => {
      projectA.stageTable.clearAllFilters();
    });
    expect(container.querySelectorAll("[data-sr-card]").length).toBe(2);

    // 排序按延期降序：延期=4 的第 0 张卡排在首位，按名称降序可实时重排
    await React.act(async () => {
      projectA.stageTable.setSort({ columnId: "col_sr_delay", direction: "asc" });
    });
    const cardIdsAsc = Array.from(container.querySelectorAll<HTMLElement>("[data-sr-card]")).map(
      (el) => el.dataset.srCard,
    );
    expect(cardIdsAsc).toEqual(["sr-proj-row-0", "sr-proj-row-1"]);
    await React.act(async () => {
      projectA.stageTable.setSort({ columnId: "name", direction: "desc" });
    });
    const cardIdsNameDesc = Array.from(container.querySelectorAll<HTMLElement>("[data-sr-card]")).map(
      (el) => el.dataset.srCard,
    );
    expect(cardIdsNameDesc).toEqual(["sr-proj-row-0", "sr-proj-row-1"]);
    await React.act(async () => {
      projectA.stageTable.setSort({ columnId: "name", direction: "asc" });
    });
    const cardIdsNameAsc = Array.from(container.querySelectorAll<HTMLElement>("[data-sr-card]")).map(
      (el) => el.dataset.srCard,
    );
    expect(cardIdsNameAsc).toEqual(["sr-proj-row-1", "sr-proj-row-0"]);
  });
});
