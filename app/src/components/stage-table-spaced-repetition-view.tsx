import { StageTableFilterToolbarPopover } from "@/components/stage-table-filter-popover";
import {
  StageTableAttachmentThumb,
  StageTableColumnIcon,
  StageTableFieldValueDisplay,
  StageTableSortToolbarPopover,
  formatViewTimestamp,
  getRowDisplayTitle,
  getViewOptionBadgeClass,
} from "@/components/stage-table-views-shared";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { Project } from "@/core/Project";
import type {
  SpacedRepetitionAnswerSnapshot,
  StageTableRow,
} from "@/core/service/dataManageService/stageTableService/StageTableService";
import {
  CREATABLE_CUSTOM_COLUMN_TYPES,
  countActiveFilterConditions,
  isProtectedTableColumn,
  parseLocalDateKey,
  toLocalDateKey,
  type CustomColumnType,
  type SpacedRepetitionAnswerChoice,
  type SpacedRepetitionColumnRole,
  type SpacedRepetitionColumns,
  type SpacedRepetitionFieldDropPosition,
  type SpacedRepetitionQueueTab,
  type TableColumnFilter,
  type TableColumnGroup,
  type TableColumnSchema,
  type TableFilterGroup,
  type TableSortConfig,
  type TableSpacedRepetitionViewConfig,
  type TableViewSchema,
} from "@/types/table";
import { cn } from "@/utils/cn";
import {
  Check,
  Crosshair,
  GripVertical,
  Pencil,
  Plus,
  PlusCircle,
  RefreshCw,
  RotateCw,
  SlidersHorizontal,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

interface SessionAnswerRecord {
  choice: SpacedRepetitionAnswerChoice;
  snapshot: SpacedRepetitionAnswerSnapshot;
}

interface FieldDragState {
  containerKey: string;
  side: "front" | "back";
  draggedColId: string;
  targetColId: string | null;
  position: SpacedRepetitionFieldDropPosition;
}

const COLUMN_COUNT_OPTIONS: readonly SpacedRepetitionColumns[] = [1, 2, 3, 4];
const QUEUE_TABS: readonly SpacedRepetitionQueueTab[] = ["due", "all", "upcoming", "archived"];

const LEARNING_ROLES: readonly SpacedRepetitionColumnRole[] = ["notes", "source", "knowledge", "mastery"];
const SCHEDULE_ROLES: readonly SpacedRepetitionColumnRole[] = [
  "correctCount",
  "answerDate",
  "delay",
  "nextInterval",
  "nextDueDate",
  "dueStatus",
  "archiveStatus",
];

/**
 * 对-开卷图标：左侧为半对符号（√ 上画一撇），右侧为一本摊开的书。
 */
function AnswerOpenBookCorrectIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 46 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("h-5 w-10 shrink-0", className)}
    >
      {/* 半对符号：√ 上画一撇 */}
      <path d="M2.5 13L7.5 18L17.5 5.5" strokeWidth="2.2" />
      <path d="M10.5 7.5L16.2 12.6" strokeWidth="2" />
      {/* 摊开的书 */}
      <path d="M33 7.5C30 5.8 26.2 5.8 23 7.2V18.8C26.2 17.4 30 17.4 33 19.2" strokeWidth="1.9" />
      <path d="M33 7.5C36 5.8 39.8 5.8 43 7.2V18.8C39.8 17.4 36 17.4 33 19.2" strokeWidth="1.9" />
      <path d="M33 7.5V19.2" strokeWidth="1.7" />
      <path d="M25.8 10.6H30M25.8 13.6H29.6M36 10.6H40.2M36.4 13.6H40.2" strokeWidth="1.35" opacity="0.78" />
    </svg>
  );
}

/**
 * 对-闭卷图标：左侧为对号（√），右侧为一本锁头锁住的书。
 */
function AnswerClosedBookCorrectIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 46 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("h-5 w-10 shrink-0", className)}
    >
      {/* 对号 √ */}
      <path d="M2.5 13L7.8 18.2L17.8 5.8" strokeWidth="2.3" />
      {/* 合上的书 */}
      <rect x="23.5" y="4.2" width="17" height="15.6" rx="2" strokeWidth="1.9" />
      <path d="M27.2 4.5V19.5" strokeWidth="1.5" opacity="0.7" />
      {/* 书封上的锁头 */}
      <path d="M31.8 11.4V9.9C31.8 8.6 32.8 7.6 34.1 7.6C35.4 7.6 36.4 8.6 36.4 9.9V11.4" strokeWidth="1.65" />
      <rect x="30.6" y="11.3" width="7" height="5.3" rx="1.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * 错图标：清晰的 × 号。
 */
function AnswerWrongIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-5 shrink-0", className)}
    >
      <path d="M6 6L18 18" />
      <path d="M18 6L6 18" />
    </svg>
  );
}

function getDueStatusText(
  row: StageTableRow,
  roleColMap: Partial<Record<SpacedRepetitionColumnRole, string>>,
): "待复习" | "未到期" | "已归档" {
  const dueColId = roleColMap.dueStatus;
  if (dueColId) {
    const evaluated = row.formulaValues?.[dueColId]?.displayText?.trim();
    if (evaluated === "已归档" || evaluated === "未到期" || evaluated === "待复习") {
      return evaluated;
    }
  }
  return "待复习";
}

function formatMasteryLabel(val: unknown, t: (key: string, opts?: Record<string, unknown>) => string): string | null {
  if (val === 1) return `1 · ${t("spacedRepetition.mastery_1")}`;
  if (val === 2) return `2 · ${t("spacedRepetition.mastery_2")}`;
  if (val === 3) return `3 · ${t("spacedRepetition.mastery_3")}`;
  return null;
}

/**
 * 正面/背面新增受保护自定义属性的弹窗组件（同步到表格视图，默认隐藏、不可删除）。
 */
function AddSpacedRepetitionFieldPopover({
  side,
  trigger,
  onCreate,
  t,
}: {
  side: "front" | "back";
  trigger: React.ReactNode;
  onCreate: (name: string, type: CustomColumnType) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [selectedType, setSelectedType] = useState<CustomColumnType>("text");

  const handleConfirm = () => {
    const finalName = name.trim() || t(`columnTypes.${selectedType}`);
    onCreate(finalName, selectedType);
    setName("");
    setSelectedType("text");
    setOpen(false);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          setName("");
          setSelectedType("text");
        }
      }}
    >
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent
        align="start"
        data-sr-add-field-popover={side}
        className="w-64 space-y-2.5 p-3 text-xs select-none"
        onCloseAutoFocus={(e) => e.preventDefault()}
        onWheel={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-foreground font-medium">
          {side === "front" ? t("spacedRepetition.addFrontFieldTitle") : t("spacedRepetition.addBackFieldTitle")}
        </div>
        <Input
          autoFocus
          data-sr-add-field-name-input={side}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              handleConfirm();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setOpen(false);
            }
          }}
          placeholder={t("addColumnPopover.namePlaceholder")}
          className="h-7 text-xs"
        />
        <div className="space-y-1">
          <div className="text-muted-foreground text-[11px]">{t("addColumnPopover.typeLabel")}</div>
          <div className="grid grid-cols-2 gap-1">
            {CREATABLE_CUSTOM_COLUMN_TYPES.map((colType) => {
              const active = selectedType === colType;
              return (
                <button
                  key={colType}
                  type="button"
                  data-sr-add-field-type={colType}
                  onClick={() => setSelectedType(colType)}
                  className={cn(
                    "flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[11px] transition-colors",
                    active
                      ? "border-primary bg-primary/12 text-primary font-medium"
                      : "border-border/60 text-foreground hover:bg-accent",
                  )}
                >
                  <StageTableColumnIcon
                    columnId=""
                    customColumn={{ id: "", name: "", type: colType }}
                    className="size-3.5"
                  />
                  <span className="truncate">{t(`columnTypes.${colType}`)}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="text-muted-foreground text-[10px] leading-snug">{t("spacedRepetition.addCustomFieldHint")}</div>
        <div className="flex items-center justify-end gap-1.5 pt-0.5">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => setOpen(false)}
          >
            {t("fieldDialog.cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            data-sr-add-field-confirm={side}
            className="h-7 px-2.5 text-xs"
            onClick={handleConfirm}
          >
            {t("addColumnPopover.create")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * 支持双击原地编辑的字段单元格（覆盖文本、数字、日期、单选、多选与公式编辑入口）。
 */
function SpacedRepetitionInlineField({
  project,
  row,
  columnId,
  customCol,
  label,
  onPreviewImage,
  onOpenFormulaEditor,
  multiline = false,
  onDragHandlePointerDown,
  t,
}: {
  project: Project;
  row: StageTableRow;
  columnId: string;
  customCol?: TableColumnSchema;
  label: string;
  onPreviewImage: (attachmentId: string, rowUuid?: string) => void;
  onOpenFormulaEditor?: (colId: string, rowUuid: string) => void;
  multiline?: boolean;
  onDragHandlePointerDown?: (e: React.PointerEvent) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [selectQuery, setSelectQuery] = useState("");

  const raw = customCol ? row.tableFields?.[customCol.id] : undefined;
  const isEditableCustom = Boolean(customCol && customCol.type !== "formula");
  const isFormula = customCol?.type === "formula";

  const startDoubleClickEdit = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isFormula && customCol) {
      onOpenFormulaEditor?.(customCol.id, row.uuid);
      return;
    }
    if (!customCol) return;
    if (customCol.type === "text") {
      setDraft(typeof raw === "string" ? raw : "");
      setEditing(true);
    } else if (customCol.type === "number") {
      setDraft(typeof raw === "number" && Number.isFinite(raw) ? String(raw) : "");
      setEditing(true);
    } else if (customCol.type === "date" || customCol.type === "select" || customCol.type === "multi_select") {
      setSelectQuery("");
      setPopoverOpen(true);
    }
  };

  const commitTextOrNumber = () => {
    if (!customCol) {
      setEditing(false);
      return;
    }
    if (customCol.type === "text") {
      const prev = typeof raw === "string" ? raw : "";
      if (draft !== prev) {
        project.stageTable.updateRowCustomField(row.uuid, customCol.id, draft || null);
      }
    } else if (customCol.type === "number") {
      const trimmed = draft.trim();
      if (!trimmed) {
        if (raw !== undefined && raw !== null) {
          project.stageTable.updateRowCustomField(row.uuid, customCol.id, null);
        }
      } else {
        const num = Number(trimmed);
        if (Number.isFinite(num) && num !== raw) {
          project.stageTable.updateRowCustomField(row.uuid, customCol.id, num);
        }
      }
    }
    setEditing(false);
  };

  const renderReadonlyValue = () => {
    if (columnId === "createdAt") {
      return <span className="text-foreground/85 text-xs tabular-nums">{formatViewTimestamp(row.createdAt)}</span>;
    }
    if (columnId === "updatedAt") {
      return <span className="text-foreground/85 text-xs tabular-nums">{formatViewTimestamp(row.updatedAt)}</span>;
    }
    if (customCol?.protectedRole === "mastery" && typeof raw === "number") {
      const masteryText = formatMasteryLabel(raw, t);
      if (masteryText) {
        const badgeCls =
          raw === 3
            ? "bg-rose-500/15 text-rose-700 dark:text-rose-300 border-rose-500/30"
            : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30";
        return (
          <span
            className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium", badgeCls)}
          >
            {masteryText}
          </span>
        );
      }
    }
    if (customCol?.protectedRole === "dueStatus") {
      const cell = row.formulaValues?.[customCol.id];
      const text = cell?.displayText?.trim();
      if (text) {
        const cls =
          text === "待复习"
            ? "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/35"
            : text === "已归档"
              ? "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300 border-zinc-500/30"
              : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/35";
        return (
          <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium", cls)}>
            {text}
          </span>
        );
      }
    }
    const display = StageTableFieldValueDisplay({
      project,
      row,
      columnId,
      customCol,
      onPreviewImage,
      compact: true,
      t,
    });
    if (display) return display;
    return <span className="text-muted-foreground/45 text-[11px] italic">{t("spacedRepetition.emptyField")}</span>;
  };

  if (editing && customCol && (customCol.type === "text" || customCol.type === "number")) {
    return (
      <div
        data-sr-field-row={columnId}
        className="space-y-1"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
          <StageTableColumnIcon columnId={columnId} customColumn={customCol} className="size-3" />
          <span className="truncate">{label}</span>
        </div>
        {multiline && customCol.type === "text" ? (
          <textarea
            autoFocus
            data-sr-inline-input={columnId}
            value={draft}
            rows={3}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTextOrNumber}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                commitTextOrNumber();
              }
            }}
            className="border-primary/70 bg-background text-foreground focus:ring-primary/30 w-full resize-y rounded-md border px-2 py-1.5 text-xs outline-none focus:ring-2"
          />
        ) : (
          <Input
            autoFocus
            data-sr-inline-input={columnId}
            type={customCol.type === "number" ? "number" : "text"}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitTextOrNumber}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") {
                e.preventDefault();
                setEditing(false);
              } else if (e.key === "Enter") {
                e.preventDefault();
                commitTextOrNumber();
              }
            }}
            className="border-primary/70 h-7 text-xs tabular-nums"
          />
        )}
      </div>
    );
  }

  if (customCol && (customCol.type === "date" || customCol.type === "select" || customCol.type === "multi_select")) {
    const selectedIds =
      customCol.type === "multi_select"
        ? Array.isArray(raw)
          ? raw
          : typeof raw === "string"
            ? [raw]
            : []
        : typeof raw === "string"
          ? [raw]
          : [];
    const options = customCol.options ?? [];
    const filteredOpts = options.filter(
      (o) => !selectQuery.trim() || o.name.toLowerCase().includes(selectQuery.trim().toLowerCase()),
    );
    const exactExists = options.some((o) => o.name.toLowerCase() === selectQuery.trim().toLowerCase());

    return (
      <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
        <PopoverTrigger asChild>
          <div
            data-sr-field-row={columnId}
            title={t("spacedRepetition.doubleClickToEdit")}
            onClick={(e) => {
              // 仅通过双击进入编辑，单击不触发 Popover
              e.preventDefault();
              e.stopPropagation();
            }}
            onDoubleClick={startDoubleClickEdit}
            className="hover:bg-accent/55 -mx-1.5 cursor-text rounded-md px-1.5 py-1 transition-colors"
          >
            <div
              onPointerDown={onDragHandlePointerDown}
              className={cn(
                "text-muted-foreground mb-0.5 flex items-center gap-1 text-[11px] select-none",
                onDragHandlePointerDown && "cursor-grab active:cursor-grabbing",
              )}
            >
              {onDragHandlePointerDown && (
                <span
                  data-sr-field-drag-handle={columnId}
                  title={t("spacedRepetition.dragFieldHint")}
                  className="text-muted-foreground/55 group-hover/srfielditem:text-muted-foreground -ml-0.5 inline-flex shrink-0 items-center transition-colors"
                >
                  <GripVertical className="size-3" />
                </span>
              )}
              <StageTableColumnIcon columnId={columnId} customColumn={customCol} className="size-3" />
              <span className="truncate">{label}</span>
            </div>
            <div className="min-h-5">{renderReadonlyValue()}</div>
          </div>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-auto p-2 text-xs select-none"
          onWheel={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {customCol.type === "date" ? (
            <div className="space-y-2">
              <Calendar
                mode="single"
                selected={typeof raw === "string" ? (parseLocalDateKey(raw) ?? undefined) : undefined}
                onSelect={(day) => {
                  project.stageTable.updateRowCustomField(row.uuid, customCol.id, day ? toLocalDateKey(day) : null);
                  setPopoverOpen(false);
                }}
              />
              <div className="border-border/60 flex items-center justify-between gap-2 border-t pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  onClick={() => {
                    project.stageTable.updateRowCustomField(row.uuid, customCol.id, toLocalDateKey(new Date()));
                    setPopoverOpen(false);
                  }}
                >
                  {t("calendar.today")}
                </Button>
                {typeof raw === "string" && raw && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => {
                      project.stageTable.updateRowCustomField(row.uuid, customCol.id, null);
                      setPopoverOpen(false);
                    }}
                  >
                    {t("dateCell.clear")}
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <div className="w-56">
              <Input
                autoFocus
                value={selectQuery}
                onChange={(e) => setSelectQuery(e.target.value)}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && selectQuery.trim()) {
                    e.preventDefault();
                    const opt = project.stageTable.createOrGetSelectOption?.(customCol.id, selectQuery.trim());
                    if (opt) {
                      if (customCol.type === "multi_select") {
                        project.stageTable.updateRowCustomField(
                          row.uuid,
                          customCol.id,
                          Array.from(new Set([...selectedIds, opt.id])),
                        );
                      } else {
                        project.stageTable.updateRowCustomField(row.uuid, customCol.id, opt.id);
                        setPopoverOpen(false);
                      }
                      setSelectQuery("");
                    }
                  } else if (e.key === "Escape") {
                    setPopoverOpen(false);
                  }
                }}
                placeholder={t("selectCell.searchOrAddPlaceholder")}
                className="mb-1.5 h-7 text-xs"
              />
              <div className="max-h-44 space-y-0.5 overflow-y-auto">
                {filteredOpts.map((opt) => {
                  const active = selectedIds.includes(opt.id);
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => {
                        if (customCol.type === "multi_select") {
                          const next = active ? selectedIds.filter((id) => id !== opt.id) : [...selectedIds, opt.id];
                          project.stageTable.updateRowCustomField(
                            row.uuid,
                            customCol.id,
                            next.length > 0 ? next : null,
                          );
                        } else {
                          project.stageTable.updateRowCustomField(row.uuid, customCol.id, active ? null : opt.id);
                          setPopoverOpen(false);
                        }
                      }}
                      className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-1.5 py-1"
                    >
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[11px] font-medium",
                          getViewOptionBadgeClass(opt.color),
                        )}
                      >
                        {opt.name}
                      </span>
                      {active && <Check className="text-primary size-3.5" />}
                    </button>
                  );
                })}
                {selectQuery.trim() && !exactExists && (
                  <button
                    type="button"
                    onClick={() => {
                      const opt = project.stageTable.createOrGetSelectOption?.(customCol.id, selectQuery.trim());
                      if (opt) {
                        if (customCol.type === "multi_select") {
                          project.stageTable.updateRowCustomField(
                            row.uuid,
                            customCol.id,
                            Array.from(new Set([...selectedIds, opt.id])),
                          );
                        } else {
                          project.stageTable.updateRowCustomField(row.uuid, customCol.id, opt.id);
                          setPopoverOpen(false);
                        }
                        setSelectQuery("");
                      }
                    }}
                    className="hover:bg-accent text-primary flex w-full cursor-pointer items-center gap-1.5 rounded px-1.5 py-1 text-left"
                  >
                    <Plus className="size-3" />
                    <span>
                      {t("selectCell.createPrefix")} &ldquo;{selectQuery.trim()}&rdquo;
                    </span>
                  </button>
                )}
              </div>
            </div>
          )}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <div
      data-sr-field-row={columnId}
      title={
        isEditableCustom
          ? t("spacedRepetition.doubleClickToEdit")
          : isFormula
            ? t("formulaEditor.doubleClickHint")
            : undefined
      }
      onDoubleClick={isEditableCustom || isFormula ? startDoubleClickEdit : undefined}
      className={cn(
        "-mx-1.5 rounded-md px-1.5 py-1 transition-colors",
        (isEditableCustom || isFormula) && "hover:bg-accent/55 cursor-text",
      )}
    >
      <div
        onPointerDown={onDragHandlePointerDown}
        className={cn(
          "text-muted-foreground mb-0.5 flex items-center gap-1 text-[11px] select-none",
          onDragHandlePointerDown && "cursor-grab active:cursor-grabbing",
        )}
      >
        {onDragHandlePointerDown && (
          <span
            data-sr-field-drag-handle={columnId}
            title={t("spacedRepetition.dragFieldHint")}
            className="text-muted-foreground/55 group-hover/srfielditem:text-muted-foreground -ml-0.5 inline-flex shrink-0 items-center transition-colors"
          >
            <GripVertical className="size-3" />
          </span>
        )}
        <StageTableColumnIcon columnId={columnId} customColumn={customCol} className="size-3" />
        <span className="truncate">{label}</span>
      </div>
      <div className="min-h-5">{renderReadonlyValue()}</div>
    </div>
  );
}

export function StageTableSpacedRepetitionView({
  project,
  activeView,
  allRows,
  rows,
  allColumnIds,
  filterableColumnIds,
  filterColumnGroups,
  customColumns,
  customColumnMap,
  activeFilters,
  activeFilterGroup,
  activeSort,
  selectedRowIds,
  getColumnLabel,
  onSelectRows,
  onOpenRecord,
  onPreviewImage,
  onOpenFormulaEditor,
  t,
}: {
  project: Project;
  activeView: TableViewSchema;
  allRows: readonly StageTableRow[];
  rows: readonly StageTableRow[];
  allColumnIds: readonly string[];
  filterableColumnIds: readonly string[];
  filterColumnGroups: readonly TableColumnGroup[];
  customColumns: readonly TableColumnSchema[];
  customColumnMap: ReadonlyMap<string, TableColumnSchema>;
  activeFilters: readonly TableColumnFilter[];
  activeFilterGroup: TableFilterGroup;
  activeSort: TableSortConfig | null;
  selectedRowIds: ReadonlySet<string>;
  getColumnLabel: (colId: string) => string;
  onSelectRows: (uuids: string[], focusCamera?: boolean) => void;
  onOpenRecord: (rowUuid: string) => void;
  onPreviewImage: (attachmentId: string, rowUuid?: string) => void;
  onOpenFormulaEditor?: (colId: string, rowUuid: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [flippedIds, setFlippedIds] = useState<Set<string>>(() => new Set());
  const [sessionAnswered, setSessionAnswered] = useState<Map<string, SessionAnswerRecord>>(() => new Map());
  const [editingTitleRowId, setEditingTitleRowId] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState("");
  const [fieldDragState, setFieldDragState] = useState<FieldDragState | null>(null);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const uploadTargetRowRef = useRef<string | null>(null);

  const config: TableSpacedRepetitionViewConfig = activeView.spacedRepetition ?? {};
  const columns: SpacedRepetitionColumns = config.columns ?? 2;
  const queueTab: SpacedRepetitionQueueTab = config.queueTab ?? "due";
  const imageFit = config.imageFit ?? "contain";
  const frontFieldIds = config.frontFieldIds ?? [];

  const hasAnyActiveFilter =
    activeFilters.length > 0 || countActiveFilterConditions(activeFilterGroup, customColumns) > 0;

  // 若旧工程里已存在间隔重复视图但缺失受保护列，进入视图时自动补齐（幂等）
  useEffect(() => {
    project.stageTable.ensureSpacedRepetitionColumns?.(true);
  }, [project, activeView.id]);

  // 切换视图时重置局部翻转与当次作答保留状态
  useEffect(() => {
    setFlippedIds(new Set());
    setSessionAnswered(new Map());
    setEditingTitleRowId(null);
  }, [activeView.id]);

  const roleColMap = useMemo(() => {
    const map: Partial<Record<SpacedRepetitionColumnRole, string>> = {};
    for (const col of customColumns) {
      if (col.protectedRole) {
        map[col.protectedRole] = col.id;
      }
    }
    return map;
  }, [customColumns]);

  const queueCounts = useMemo(() => {
    let due = 0;
    let upcoming = 0;
    let archived = 0;
    for (const row of rows) {
      const status = getDueStatusText(row, roleColMap);
      if (status === "待复习") due++;
      else if (status === "未到期") upcoming++;
      else if (status === "已归档") archived++;
    }
    return {
      due,
      all: rows.length,
      upcoming,
      archived,
    };
  }, [rows, roleColMap]);

  const displayedRows = useMemo(() => {
    if (queueTab === "all") return rows;
    return rows.filter((row) => {
      if (queueTab === "due" && sessionAnswered.has(row.uuid)) {
        return true;
      }
      const status = getDueStatusText(row, roleColMap);
      if (queueTab === "due") return status === "待复习";
      if (queueTab === "upcoming") return status === "未到期";
      return status === "已归档";
    });
  }, [rows, queueTab, roleColMap, sessionAnswered]);

  // 计算间隔重复视图可用的完整筛选与排序字段列表（包含默认隐藏的 11 个核心列与正/背面新增自定义属性）
  const srFilterableColumnIds = useMemo(() => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const add = (id?: string) => {
      if (id && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    };
    add("name");
    add("images");
    for (const role of LEARNING_ROLES) add(roleColMap[role]);
    for (const role of SCHEDULE_ROLES) add(roleColMap[role]);
    for (const col of customColumns) add(col.id);
    for (const cid of filterableColumnIds) add(cid);
    for (const cid of allColumnIds) add(cid);
    return ordered;
  }, [roleColMap, customColumns, filterableColumnIds, allColumnIds]);

  const srFilterColumnGroups = useMemo(() => {
    const claimed = new Set<string>();
    const groups: TableColumnGroup[] = [];
    for (const grp of filterColumnGroups) {
      const validIds = grp.columnIds.filter((id) => srFilterableColumnIds.includes(id) && !claimed.has(id));
      if (validIds.length > 0) {
        validIds.forEach((id) => claimed.add(id));
        groups.push({ ...grp, columnIds: validIds });
      }
    }
    const learningIds = LEARNING_ROLES.map((r) => roleColMap[r]).filter(
      (id): id is string => Boolean(id) && !claimed.has(id!),
    );
    if (learningIds.length > 0) {
      learningIds.forEach((id) => claimed.add(id));
      groups.push({
        id: "sr_grp_learning",
        name: t("spacedRepetition.sectionLearning"),
        columnIds: learningIds,
      });
    }
    const scheduleIds = SCHEDULE_ROLES.map((r) => roleColMap[r]).filter(
      (id): id is string => Boolean(id) && !claimed.has(id!),
    );
    if (scheduleIds.length > 0) {
      scheduleIds.forEach((id) => claimed.add(id));
      groups.push({
        id: "sr_grp_schedule",
        name: t("spacedRepetition.sectionSchedule"),
        columnIds: scheduleIds,
      });
    }
    return groups;
  }, [filterColumnGroups, srFilterableColumnIds, roleColMap, t]);

  // 计算默认背面展示字段（核心字段 + 非正面专属自定义字段 + 创建/最后编辑时间）
  const frontFieldIdSet = useMemo(() => new Set(frontFieldIds), [frontFieldIds]);

  const allBackCandidateIds = useMemo(() => {
    const ordered: string[] = [];
    const seen = new Set<string>();
    const add = (id?: string) => {
      if (id && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    };
    for (const role of LEARNING_ROLES) add(roleColMap[role]);
    for (const role of SCHEDULE_ROLES) add(roleColMap[role]);
    for (const col of customColumns) add(col.id);
    add("createdAt");
    add("updatedAt");
    return ordered;
  }, [roleColMap, customColumns]);

  const defaultBackFieldIds = useMemo(() => {
    return allBackCandidateIds.filter((cid) => {
      const col = customColumnMap.get(cid);
      if (col && !col.protectedRole && frontFieldIdSet.has(cid)) {
        return false;
      }
      return true;
    });
  }, [allBackCandidateIds, customColumnMap, frontFieldIdSet]);

  const orderedFrontFieldRows = useMemo<string[][]>(() => {
    const valid = (cid: string) => customColumnMap.has(cid);
    if (config.frontFieldRows !== undefined) {
      const seen = new Set<string>();
      const rowsFromConfig: string[][] = [];
      for (const rowIds of config.frontFieldRows) {
        const cleaned = rowIds.filter((cid) => valid(cid) && !seen.has(cid));
        cleaned.forEach((cid) => seen.add(cid));
        if (cleaned.length > 0) rowsFromConfig.push(cleaned);
      }
      for (const cid of frontFieldIds) {
        if (valid(cid) && !seen.has(cid)) {
          seen.add(cid);
          rowsFromConfig.push([cid]);
        }
      }
      return rowsFromConfig;
    }
    return frontFieldIds.filter(valid).map((cid) => [cid]);
  }, [config.frontFieldRows, frontFieldIds, customColumnMap]);

  const orderedFrontFieldIds = useMemo(() => orderedFrontFieldRows.flat(), [orderedFrontFieldRows]);

  const defaultBackFieldRows = useMemo<string[][]>(() => {
    const allowedSet = new Set(defaultBackFieldIds);
    const seen = new Set<string>();
    const rowsOut: string[][] = [];
    const pushRow = (candidates: Array<string | undefined>) => {
      const cleaned = candidates.filter(
        (cid): cid is string => Boolean(cid) && allowedSet.has(cid!) && !seen.has(cid!),
      );
      cleaned.forEach((cid) => seen.add(cid));
      if (cleaned.length > 0) rowsOut.push(cleaned);
    };
    pushRow([roleColMap.notes]);
    pushRow([roleColMap.source, roleColMap.mastery]);
    pushRow([roleColMap.knowledge]);
    pushRow([roleColMap.correctCount, roleColMap.answerDate]);
    pushRow([roleColMap.delay, roleColMap.nextInterval]);
    pushRow([roleColMap.nextDueDate, roleColMap.dueStatus]);
    pushRow([roleColMap.archiveStatus]);
    for (const cid of defaultBackFieldIds) {
      if (cid !== "createdAt" && cid !== "updatedAt" && !seen.has(cid)) {
        pushRow([cid]);
      }
    }
    pushRow(["createdAt", "updatedAt"]);
    return rowsOut;
  }, [defaultBackFieldIds, roleColMap]);

  const orderedBackFieldRows = useMemo<string[][]>(() => {
    const valid = (cid: string) => cid === "createdAt" || cid === "updatedAt" || customColumnMap.has(cid);
    if (config.backFieldRows !== undefined) {
      const seen = new Set<string>();
      const rowsFromConfig: string[][] = [];
      for (const rowIds of config.backFieldRows) {
        const cleaned = rowIds.filter((cid) => valid(cid) && !seen.has(cid));
        cleaned.forEach((cid) => seen.add(cid));
        if (cleaned.length > 0) rowsFromConfig.push(cleaned);
      }
      if (config.backFieldIds) {
        for (const cid of config.backFieldIds) {
          if (valid(cid) && !seen.has(cid)) {
            seen.add(cid);
            rowsFromConfig.push([cid]);
          }
        }
      }
      return rowsFromConfig;
    }
    if (config.backFieldIds !== undefined) {
      return config.backFieldIds.filter(valid).map((cid) => [cid]);
    }
    return defaultBackFieldRows;
  }, [config.backFieldRows, config.backFieldIds, customColumnMap, defaultBackFieldRows]);

  const orderedBackFieldIds = useMemo(() => orderedBackFieldRows.flat(), [orderedBackFieldRows]);

  const activeBackFieldSet = useMemo(() => new Set(orderedBackFieldIds), [orderedBackFieldIds]);

  const settingsFrontColumns = useMemo(() => {
    const activeOrder = orderedFrontFieldIds
      .map((id) => customColumnMap.get(id))
      .filter((col): col is TableColumnSchema => Boolean(col));
    const activeSet = new Set(activeOrder.map((c) => c.id));
    return [...activeOrder, ...customColumns.filter((c) => !activeSet.has(c.id))];
  }, [orderedFrontFieldIds, customColumnMap, customColumns]);

  const settingsBackFieldIds = useMemo(() => {
    const activeSet = new Set(orderedBackFieldIds);
    return [...orderedBackFieldIds, ...allBackCandidateIds.filter((cid) => !activeSet.has(cid))];
  }, [orderedBackFieldIds, allBackCandidateIds]);

  const handleCreateCustomSideField = (
    side: "front" | "back",
    name: string,
    type: CustomColumnType,
    rowUuid?: string,
  ) => {
    const created = project.stageTable.addSpacedRepetitionCustomColumn?.({ name, type, side });
    if (created && type === "formula" && onOpenFormulaEditor) {
      const targetRow = rowUuid ?? displayedRows[0]?.uuid ?? allRows[0]?.uuid ?? "";
      onOpenFormulaEditor(created.id, targetRow);
    }
  };

  const startFieldDrag = (
    e: React.PointerEvent,
    opts: {
      containerKey: string;
      side: "front" | "back";
      colId: string;
      layout: "vertical" | "rows2d";
    },
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    let started = false;
    let latestTarget: { colId: string; position: SpacedRepetitionFieldDropPosition } | null = null;

    const handleMove = (ev: PointerEvent) => {
      if (!started) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        started = true;
        document.body.style.cursor = "grabbing";
      }

      const escapedKey =
        typeof CSS !== "undefined" && typeof CSS.escape === "function"
          ? CSS.escape(opts.containerKey)
          : opts.containerKey.replace(/"/g, '\\"');
      const containerEl = document.querySelector<HTMLElement>(`[data-sr-sortable-container="${escapedKey}"]`);
      if (!containerEl) return;
      const itemEls = Array.from(containerEl.querySelectorAll<HTMLElement>("[data-sr-sortable-item]"));
      if (itemEls.length < 2) return;

      let bestEl: HTMLElement | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const el of itemEls) {
        const rect = el.getBoundingClientRect();
        const insideX = ev.clientX >= rect.left && ev.clientX <= rect.right;
        const insideY = ev.clientY >= rect.top && ev.clientY <= rect.bottom;
        if (insideX && insideY) {
          bestEl = el;
          break;
        }
        const dx =
          ev.clientX < rect.left ? rect.left - ev.clientX : ev.clientX > rect.right ? ev.clientX - rect.right : 0;
        const dy =
          ev.clientY < rect.top ? rect.top - ev.clientY : ev.clientY > rect.bottom ? ev.clientY - rect.bottom : 0;
        const dist = Math.hypot(dx, dy);
        if (dist < bestDist) {
          bestDist = dist;
          bestEl = el;
        }
      }

      const targetColId = bestEl?.dataset.srSortableItem ?? null;
      if (!bestEl || !targetColId || targetColId === opts.colId) {
        latestTarget = null;
        setFieldDragState({
          containerKey: opts.containerKey,
          side: opts.side,
          draggedColId: opts.colId,
          targetColId: null,
          position: "top",
        });
        return;
      }

      const rect = bestEl.getBoundingClientRect();
      let position: SpacedRepetitionFieldDropPosition;
      if (opts.layout === "rows2d") {
        // 上下各留 28% 边缘热区用于独立成行，中间 44% 区域按左右分半用于并排合并至同一行并自动填满宽度
        const topZone = rect.top + rect.height * 0.28;
        const bottomZone = rect.bottom - rect.height * 0.28;
        if (ev.clientY < topZone) {
          position = "top";
        } else if (ev.clientY > bottomZone) {
          position = "bottom";
        } else {
          position = ev.clientX < rect.left + rect.width / 2 ? "left" : "right";
        }
      } else {
        position = ev.clientY < rect.top + rect.height / 2 ? "before" : "after";
      }

      latestTarget = { colId: targetColId, position };
      setFieldDragState({
        containerKey: opts.containerKey,
        side: opts.side,
        draggedColId: opts.colId,
        targetColId,
        position,
      });
    };

    const finish = (commit: boolean) => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleCancel);
      document.body.style.cursor = "";
      setFieldDragState(null);
      if (commit && started && latestTarget && latestTarget.colId !== opts.colId) {
        project.stageTable.reorderSpacedRepetitionFields?.(
          opts.side,
          opts.colId,
          latestTarget.colId,
          latestTarget.position,
          opts.side === "front" ? orderedFrontFieldRows : orderedBackFieldRows,
        );
      }
    };

    const handleUp = () => finish(true);
    const handleCancel = () => finish(false);

    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    window.addEventListener("pointercancel", handleCancel);
  };

  const toggleFlip = (rowUuid: string) => {
    setFlippedIds((prev) => {
      const next = new Set(prev);
      if (next.has(rowUuid)) next.delete(rowUuid);
      else next.add(rowUuid);
      return next;
    });
    if (editingTitleRowId === rowUuid) {
      setEditingTitleRowId(null);
    }
  };

  const handleAnswer = (row: StageTableRow, choice: SpacedRepetitionAnswerChoice) => {
    const existing = sessionAnswered.get(row.uuid);
    // 再次点击当前已选按钮：撤销本次作答
    if (existing && existing.choice === choice) {
      const restored = project.stageTable.restoreSpacedRepetitionRow?.(row.uuid, existing.snapshot);
      if (restored) {
        setSessionAnswered((prev) => {
          const next = new Map(prev);
          next.delete(row.uuid);
          return next;
        });
      }
      return;
    }

    // 首次作答或改选：基于首次作答前快照计算，杜绝重复叠加
    const snapshot = project.stageTable.answerSpacedRepetitionRow?.(row.uuid, choice, {
      baseline: existing?.snapshot,
    });
    if (snapshot) {
      setSessionAnswered((prev) => {
        const next = new Map(prev);
        next.set(row.uuid, { choice, snapshot });
        return next;
      });
    }
  };

  const handleUndoAnswer = (rowUuid: string) => {
    const existing = sessionAnswered.get(rowUuid);
    if (!existing) return;
    const restored = project.stageTable.restoreSpacedRepetitionRow?.(rowUuid, existing.snapshot);
    if (restored) {
      setSessionAnswered((prev) => {
        const next = new Map(prev);
        next.delete(rowUuid);
        return next;
      });
    }
  };

  const handleSwitchQueueTab = (tab: SpacedRepetitionQueueTab) => {
    setSessionAnswered(new Map());
    project.stageTable.updateActiveViewConfig?.({ spacedRepetition: { queueTab: tab } });
  };

  const handleAddCard = () => {
    const created = project.stageTable.createRow?.({ text: "" });
    if (created) {
      onSelectRows([created.uuid], false);
      setEditingTitleRowId(created.uuid);
      setTitleDraft("");
    }
  };

  const commitTitleEdit = (row: StageTableRow) => {
    if (titleDraft !== row.primaryText) {
      project.stageTable.updateRowPrimaryText(row.uuid, titleDraft);
    }
    setEditingTitleRowId(null);
  };

  const toggleBackField = (colId: string, checked: boolean) => {
    const nextRows = checked
      ? orderedBackFieldIds.includes(colId)
        ? orderedBackFieldRows
        : [...orderedBackFieldRows, [colId]]
      : orderedBackFieldRows.map((row) => row.filter((id) => id !== colId)).filter((row) => row.length > 0);
    project.stageTable.updateActiveViewConfig?.({
      spacedRepetition: {
        backFieldIds: nextRows.flat(),
        backFieldRows: nextRows,
      },
    });
  };

  const toggleFrontField = (colId: string, checked: boolean) => {
    const nextRows = checked
      ? orderedFrontFieldIds.includes(colId)
        ? orderedFrontFieldRows
        : [...orderedFrontFieldRows, [colId]]
      : orderedFrontFieldRows.map((row) => row.filter((id) => id !== colId)).filter((row) => row.length > 0);
    project.stageTable.updateActiveViewConfig?.({
      spacedRepetition: {
        frontFieldIds: nextRows.flat(),
        frontFieldRows: nextRows,
      },
    });
  };

  return (
    <div data-stage-table-spaced-repetition-view className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <input
        ref={uploadInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          const rowUuid = uploadTargetRowRef.current;
          if (rowUuid && files.length > 0) {
            void project.stageTable.addRowImages?.(rowUuid, files);
          }
          uploadTargetRowRef.current = null;
          e.target.value = "";
        }}
      />

      {/* 第二行功能栏：队列切换 | 筛选 | 排序 | 列数切换 | 添加卡片 | 视图设置（自动换行，确保筛选与排序始终可见可用） */}
      <div className="border-border/60 flex min-h-9 shrink-0 flex-wrap items-center gap-x-1.5 gap-y-1 border-b px-3 py-1.5 text-xs">
        {/* 队列快捷切换（待复习 / 全部 / 未到期 / 已归档） */}
        <div
          data-sr-queue-tabs
          className="bg-muted/70 inline-flex shrink-0 items-center rounded-md p-0.5"
          role="tablist"
        >
          {QUEUE_TABS.map((tab) => {
            const active = queueTab === tab;
            const count = queueCounts[tab];
            return (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={active}
                data-sr-queue-tab={tab}
                onClick={() => handleSwitchQueueTab(tab)}
                className={cn(
                  "inline-flex h-6 cursor-pointer items-center gap-1 rounded px-2 text-[11px] font-medium transition-colors",
                  active ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span>{t(`spacedRepetition.queue_${tab}`)}</span>
                <span
                  className={cn(
                    "rounded-full px-1 text-[10px] tabular-nums",
                    active ? "bg-primary/15 text-primary" : "bg-background/60 text-muted-foreground",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

        {/* 筛选与排序：支持全部间隔重复核心列、自定义属性与系统列 */}
        <StageTableFilterToolbarPopover
          filterableColumnIds={srFilterableColumnIds}
          columnGroups={srFilterColumnGroups}
          customColumns={customColumns}
          customColumnMap={customColumnMap}
          allRows={allRows}
          activeFilters={activeFilters}
          filterGroup={activeFilterGroup}
          getColumnLabel={getColumnLabel}
          onSetConjunction={(conj) => project.stageTable.setFilterConjunction?.(conj)}
          onAddCondition={(cid) => project.stageTable.addFilterCondition?.(cid)}
          onUpdateCondition={(id, patch) => project.stageTable.updateFilterCondition?.(id, patch)}
          onRemoveCondition={(id) => project.stageTable.removeFilterCondition?.(id)}
          onToggleConditionCollapse={(id) => project.stageTable.toggleFilterConditionCollapsed?.(id)}
          onReorderConditions={(dragId, targetId, pos) =>
            project.stageTable.reorderFilterConditions?.(dragId, targetId, pos)
          }
          onSetColumnFilter={(cid, flt) => project.stageTable.setColumnFilter?.(cid, flt)}
          onClearAllFilters={() => project.stageTable.clearAllFilters?.()}
          t={t}
        />

        <StageTableSortToolbarPopover
          allColumnIds={srFilterableColumnIds}
          customColumnMap={customColumnMap}
          activeSort={activeSort}
          getColumnLabel={getColumnLabel}
          onSetSort={(sort) => project.stageTable.setSort?.(sort)}
          t={t}
        />

        <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

        {/* 列数切换：单列 / 双列 / 三列 / 四列 */}
        <div
          data-sr-columns-switcher
          className="bg-muted/70 inline-flex shrink-0 items-center rounded-md p-0.5"
          aria-label={t("spacedRepetition.columnsLabel")}
        >
          {COLUMN_COUNT_OPTIONS.map((colCount) => {
            const active = columns === colCount;
            return (
              <Tooltip key={colCount}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    data-sr-cols={colCount}
                    aria-pressed={active}
                    onClick={() =>
                      project.stageTable.updateActiveViewConfig?.({
                        spacedRepetition: { columns: colCount },
                      })
                    }
                    className={cn(
                      "inline-flex h-6 cursor-pointer items-center justify-center rounded px-2 text-[11px] font-medium transition-colors",
                      active
                        ? "bg-background text-foreground shadow-xs"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {t(`spacedRepetition.cols_${colCount}`)}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom">{t(`spacedRepetition.colsTooltip_${colCount}`)}</TooltipContent>
              </Tooltip>
            );
          })}
        </div>

        <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

        <button
          type="button"
          data-sr-add-card
          onClick={handleAddCard}
          className="text-primary hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 font-medium transition-colors"
        >
          <PlusCircle className="size-3.5" />
          <span>{t("spacedRepetition.addCard")}</span>
        </button>

        {/* 视图设置（含正面/背面新增受保护自定义属性） */}
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-sr-settings-trigger
              className="text-foreground hover:bg-accent data-[state=open]:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors"
            >
              <SlidersHorizontal className="size-3.5" />
              <span>{t("spacedRepetition.settings")}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-72 space-y-3 p-3 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="space-y-2">
              <div className="text-muted-foreground text-[11px] font-medium">
                {t("spacedRepetition.displaySettings")}
              </div>
              <div className="flex items-center justify-between gap-2 px-1">
                <span>{t("gallery.coverFit")}</span>
                <div className="bg-muted flex rounded-md p-0.5">
                  {(["contain", "cover"] as const).map((fit) => (
                    <button
                      key={fit}
                      type="button"
                      onClick={() =>
                        project.stageTable.updateActiveViewConfig?.({ spacedRepetition: { imageFit: fit } })
                      }
                      className={cn(
                        "cursor-pointer rounded px-2 py-0.5 text-[11px] transition-colors",
                        imageFit === fit
                          ? "bg-background text-foreground shadow-xs"
                          : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t(`gallery.fit_${fit}`)}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="border-border/60 border-t pt-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-1">
                <span className="text-muted-foreground text-[11px] font-medium">
                  {t("spacedRepetition.frontExtraFields")}
                </span>
                <AddSpacedRepetitionFieldPopover
                  side="front"
                  onCreate={(name, type) => handleCreateCustomSideField("front", name, type)}
                  t={t}
                  trigger={
                    <button
                      type="button"
                      data-sr-add-front-field-settings
                      className="text-primary hover:bg-accent inline-flex cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium"
                    >
                      <Plus className="size-3" />
                      <span>{t("spacedRepetition.addCustomField")}</span>
                    </button>
                  }
                />
              </div>
              <div data-sr-sortable-container="settings:front" className="max-h-32 space-y-0.5 overflow-y-auto">
                {settingsFrontColumns.map((col) => {
                  const checked = frontFieldIds.includes(col.id);
                  const deletable = !isProtectedTableColumn(col);
                  const isDraggingThis =
                    fieldDragState?.containerKey === "settings:front" && fieldDragState.draggedColId === col.id;
                  const showDropBefore =
                    fieldDragState?.containerKey === "settings:front" &&
                    fieldDragState.targetColId === col.id &&
                    fieldDragState.position === "before";
                  const showDropAfter =
                    fieldDragState?.containerKey === "settings:front" &&
                    fieldDragState.targetColId === col.id &&
                    fieldDragState.position === "after";
                  return (
                    <div
                      key={col.id}
                      data-sr-sortable-item={checked ? col.id : undefined}
                      className={cn(
                        "group/srfield hover:bg-accent relative flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs transition-opacity",
                        isDraggingThis && "opacity-45",
                      )}
                    >
                      {showDropBefore && (
                        <div className="bg-primary pointer-events-none absolute -top-0.5 right-1 left-1 h-0.5 rounded-full" />
                      )}
                      {showDropAfter && (
                        <div className="bg-primary pointer-events-none absolute right-1 -bottom-0.5 left-1 h-0.5 rounded-full" />
                      )}
                      {checked && (
                        <button
                          type="button"
                          title={t("spacedRepetition.dragFieldHint")}
                          onPointerDown={(e) =>
                            startFieldDrag(e, {
                              containerKey: "settings:front",
                              side: "front",
                              colId: col.id,
                              layout: "vertical",
                            })
                          }
                          className="text-muted-foreground/55 hover:text-foreground -ml-0.5 flex size-4 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
                        >
                          <GripVertical className="size-3" />
                        </button>
                      )}
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                        <Checkbox checked={checked} onCheckedChange={(val) => toggleFrontField(col.id, Boolean(val))} />
                        <StageTableColumnIcon columnId={col.id} customColumn={col} />
                        <span className="min-w-0 flex-1 truncate">{col.name}</span>
                      </label>
                      {deletable && (
                        <button
                          type="button"
                          data-sr-delete-custom-field={col.id}
                          title={t("headerMenu.delete")}
                          aria-label={t("headerMenu.delete")}
                          onClick={(e) => {
                            e.stopPropagation();
                            project.stageTable.deleteCustomColumn?.(col.id);
                          }}
                          className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive flex size-5 shrink-0 cursor-pointer items-center justify-center rounded opacity-60 transition-opacity hover:opacity-100"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="border-border/60 border-t pt-2.5">
              <div className="mb-1.5 flex items-center justify-between gap-1">
                <span className="text-muted-foreground text-[11px] font-medium">
                  {t("spacedRepetition.backFields")}
                </span>
                <div className="flex items-center gap-1.5">
                  {(config.backFieldIds !== undefined || config.backFieldRows !== undefined) && (
                    <button
                      type="button"
                      onClick={() =>
                        project.stageTable.updateActiveViewConfig?.({
                          spacedRepetition: { backFieldIds: undefined, backFieldRows: undefined },
                        })
                      }
                      className="text-muted-foreground hover:text-foreground cursor-pointer text-[11px] hover:underline"
                    >
                      {t("spacedRepetition.resetDefault")}
                    </button>
                  )}
                  <AddSpacedRepetitionFieldPopover
                    side="back"
                    onCreate={(name, type) => handleCreateCustomSideField("back", name, type)}
                    t={t}
                    trigger={
                      <button
                        type="button"
                        data-sr-add-back-field-settings
                        className="text-primary hover:bg-accent inline-flex cursor-pointer items-center gap-0.5 rounded px-1.5 py-0.5 text-[11px] font-medium"
                      >
                        <Plus className="size-3" />
                        <span>{t("spacedRepetition.addCustomField")}</span>
                      </button>
                    }
                  />
                </div>
              </div>
              <div data-sr-sortable-container="settings:back" className="max-h-40 space-y-0.5 overflow-y-auto">
                {settingsBackFieldIds.map((cid) => {
                  const customCol = customColumnMap.get(cid);
                  const checked = activeBackFieldSet.has(cid);
                  const deletable = Boolean(customCol && !isProtectedTableColumn(customCol));
                  const isDraggingThis =
                    fieldDragState?.containerKey === "settings:back" && fieldDragState.draggedColId === cid;
                  const showDropBefore =
                    fieldDragState?.containerKey === "settings:back" &&
                    fieldDragState.targetColId === cid &&
                    fieldDragState.position === "before";
                  const showDropAfter =
                    fieldDragState?.containerKey === "settings:back" &&
                    fieldDragState.targetColId === cid &&
                    fieldDragState.position === "after";
                  return (
                    <div
                      key={cid}
                      data-sr-sortable-item={checked ? cid : undefined}
                      className={cn(
                        "group/srfield hover:bg-accent relative flex items-center gap-1 rounded-sm px-1.5 py-1 text-xs transition-opacity",
                        isDraggingThis && "opacity-45",
                      )}
                    >
                      {showDropBefore && (
                        <div className="bg-primary pointer-events-none absolute -top-0.5 right-1 left-1 h-0.5 rounded-full" />
                      )}
                      {showDropAfter && (
                        <div className="bg-primary pointer-events-none absolute right-1 -bottom-0.5 left-1 h-0.5 rounded-full" />
                      )}
                      {checked && (
                        <button
                          type="button"
                          title={t("spacedRepetition.dragFieldHint")}
                          onPointerDown={(e) =>
                            startFieldDrag(e, {
                              containerKey: "settings:back",
                              side: "back",
                              colId: cid,
                              layout: "vertical",
                            })
                          }
                          className="text-muted-foreground/55 hover:text-foreground -ml-0.5 flex size-4 shrink-0 cursor-grab items-center justify-center active:cursor-grabbing"
                        >
                          <GripVertical className="size-3" />
                        </button>
                      )}
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2">
                        <Checkbox checked={checked} onCheckedChange={(val) => toggleBackField(cid, Boolean(val))} />
                        <StageTableColumnIcon columnId={cid} customColumn={customCol} />
                        <span className="min-w-0 flex-1 truncate">{getColumnLabel(cid)}</span>
                      </label>
                      {deletable && (
                        <button
                          type="button"
                          data-sr-delete-custom-field={cid}
                          title={t("headerMenu.delete")}
                          aria-label={t("headerMenu.delete")}
                          onClick={(e) => {
                            e.stopPropagation();
                            project.stageTable.deleteCustomColumn?.(cid);
                          }}
                          className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive flex size-5 shrink-0 cursor-pointer items-center justify-center rounded opacity-60 transition-opacity hover:opacity-100"
                        >
                          <Trash2 className="size-3" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </PopoverContent>
        </Popover>

        {sessionAnswered.size > 0 && queueTab === "due" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                data-sr-refresh-queue
                onClick={() => setSessionAnswered(new Map())}
                className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded bg-emerald-500/15 px-2 text-[11px] font-medium text-emerald-700 transition-colors hover:bg-emerald-500/25 dark:text-emerald-300"
              >
                <RefreshCw className="size-3" />
                <span>{t("spacedRepetition.sessionAnsweredRefresh", { count: sessionAnswered.size })}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("spacedRepetition.refreshQueueHint")}</TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* 类网页从上到下滑动的卡片流 */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        {displayedRows.length === 0 ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2.5 text-xs">
            <span>
              {allRows.length === 0
                ? t("emptyCanvas")
                : hasAnyActiveFilter
                  ? t("sortFilter.noFilterMatch")
                  : queueTab === "due"
                    ? t("spacedRepetition.emptyDue")
                    : t("spacedRepetition.emptyQueue")}
            </span>
            <div className="flex items-center gap-2">
              {queueTab !== "all" && rows.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => handleSwitchQueueTab("all")}
                  className="h-7 px-3 text-xs"
                >
                  {t("spacedRepetition.viewAllCards")}
                </Button>
              )}
              {allRows.length > 0 && hasAnyActiveFilter && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => project.stageTable.clearAllFilters?.()}
                  className="h-7 px-3 text-xs"
                >
                  {t("sortFilter.clearAllFilters")}
                </Button>
              )}
            </div>
          </div>
        ) : (
          <div
            data-sr-card-grid
            data-sr-column-count={columns}
            style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
            className={cn("grid items-start gap-4", columns === 1 && "mx-auto max-w-3xl")}
          >
            {displayedRows.map((row) => {
              const titleInfo = getRowDisplayTitle(row, t);
              const isSelected = selectedRowIds.has(row.uuid);
              const isFlipped = flippedIds.has(row.uuid);
              const answered = sessionAnswered.get(row.uuid);
              const isEditingTitle = editingTitleRowId === row.uuid;
              const dueStatus = getDueStatusText(row, roleColMap);
              const nextDueText = roleColMap.nextDueDate
                ? row.formulaValues?.[roleColMap.nextDueDate]?.displayText?.trim()
                : "";

              const cardHighlightClass = answered
                ? answered.choice === "wrong"
                  ? "border-rose-500/65 ring-1 ring-rose-500/25"
                  : "border-emerald-500/65 ring-1 ring-emerald-500/25"
                : isSelected
                  ? "border-primary ring-primary/30 ring-2"
                  : "border-border/75 hover:border-border";

              return (
                <article
                  key={row.uuid}
                  data-sr-card={row.uuid}
                  data-sr-card-side={isFlipped ? "back" : "front"}
                  data-sr-answered={answered?.choice ?? ""}
                  onClick={(e) => {
                    if (e.ctrlKey || e.metaKey) {
                      const next = new Set(selectedRowIds);
                      if (next.has(row.uuid)) next.delete(row.uuid);
                      else next.add(row.uuid);
                      onSelectRows(Array.from(next), false);
                    } else {
                      onSelectRows([row.uuid], false);
                    }
                  }}
                  onPaste={(e) => {
                    if (isEditingTitle || row.canEditImages === false) return;
                    const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
                    if (files.length > 0) {
                      e.preventDefault();
                      void project.stageTable.addRowImages?.(row.uuid, files);
                    }
                  }}
                  className={cn(
                    "group/srcard bg-card relative flex min-w-0 flex-col overflow-hidden rounded-xl border shadow-xs transition-all",
                    cardHighlightClass,
                  )}
                >
                  {/* 卡片顶部栏：当次状态提示 + 右上角操作（含翻转按钮） */}
                  <div className="flex items-center justify-between gap-2 px-3.5 pt-2.5 pb-1">
                    <div className="flex min-w-0 items-center gap-1.5">
                      {answered ? (
                        <span
                          className={cn(
                            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                            answered.choice === "wrong"
                              ? "border-rose-500/35 bg-rose-500/12 text-rose-700 dark:text-rose-300"
                              : "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
                          )}
                        >
                          <span>{t(`spacedRepetition.answeredBadge_${answered.choice}`)}</span>
                          {nextDueText && <span className="opacity-75">· {nextDueText}</span>}
                        </span>
                      ) : isFlipped ? (
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium",
                            dueStatus === "待复习"
                              ? "border-amber-500/35 bg-amber-500/12 text-amber-700 dark:text-amber-300"
                              : dueStatus === "已归档"
                                ? "border-zinc-500/30 bg-zinc-500/12 text-zinc-600 dark:text-zinc-300"
                                : "border-emerald-500/35 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
                          )}
                        >
                          {dueStatus}
                        </span>
                      ) : null}
                    </div>

                    <div className="flex shrink-0 items-center gap-0.5">
                      {answered && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              data-sr-undo-btn={row.uuid}
                              aria-label={t("spacedRepetition.undoAnswer")}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleUndoAnswer(row.uuid);
                              }}
                              className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md transition-colors"
                            >
                              <Undo2 className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">{t("spacedRepetition.undoAnswer")}</TooltipContent>
                        </Tooltip>
                      )}

                      {!isFlipped && (
                        <AddSpacedRepetitionFieldPopover
                          side="front"
                          onCreate={(name, type) => handleCreateCustomSideField("front", name, type, row.uuid)}
                          t={t}
                          trigger={
                            <button
                              type="button"
                              data-sr-card-add-front-field={row.uuid}
                              title={t("spacedRepetition.addFrontFieldTitle")}
                              aria-label={t("spacedRepetition.addFrontFieldTitle")}
                              onClick={(e) => e.stopPropagation()}
                              className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all group-hover/srcard:opacity-100"
                            >
                              <Plus className="size-3.5" />
                            </button>
                          }
                        />
                      )}

                      {row.canEditImages !== false && !isFlipped && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              aria-label={t("imagesCell.add")}
                              onClick={(e) => {
                                e.stopPropagation();
                                uploadTargetRowRef.current = row.uuid;
                                uploadInputRef.current?.click();
                              }}
                              className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all group-hover/srcard:opacity-100"
                            >
                              <Upload className="size-3.5" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top">{t("imagesCell.add")}</TooltipContent>
                        </Tooltip>
                      )}

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={t("jumpToNode")}
                            onClick={(e) => {
                              e.stopPropagation();
                              project.stageTable.focusRowOnCanvas(row.uuid);
                            }}
                            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all group-hover/srcard:opacity-100"
                          >
                            <Crosshair className="size-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top">{t("jumpToNode")}</TooltipContent>
                      </Tooltip>

                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            aria-label={t("views.editRecord")}
                            onClick={(e) => {
                              e.stopPropagation();
                              onOpenRecord(row.uuid);
                            }}
                            className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md opacity-0 transition-all group-hover/srcard:opacity-100"
                          >
                            <Pencil className="size-3.5" />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top">{t("views.editRecord")}</TooltipContent>
                      </Tooltip>

                      {/* 右上角翻转卡片按钮（始终可见） */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            data-sr-flip-btn={row.uuid}
                            aria-label={
                              isFlipped ? t("spacedRepetition.flipToFront") : t("spacedRepetition.flipToBack")
                            }
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleFlip(row.uuid);
                            }}
                            className={cn(
                              "flex size-7 cursor-pointer items-center justify-center rounded-md border transition-colors",
                              isFlipped
                                ? "border-primary/40 bg-primary/12 text-primary"
                                : "border-border/60 text-muted-foreground hover:bg-accent hover:text-foreground",
                            )}
                          >
                            <RotateCw className={cn("size-3.5 transition-transform", isFlipped && "rotate-180")} />
                          </button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {isFlipped ? t("spacedRepetition.flipToFront") : t("spacedRepetition.flipToBack")}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>

                  {!isFlipped ? (
                    /* ======================== 正面 ======================== */
                    <div data-sr-front className="flex flex-1 flex-col gap-3 px-4 pt-1 pb-3.5">
                      {/* 文字在上（双击可直接编辑） */}
                      <div
                        data-sr-front-text={row.uuid}
                        title={row.editableText ? t("spacedRepetition.doubleClickToEdit") : undefined}
                        onDoubleClick={(e) => {
                          if (!row.editableText) return;
                          e.stopPropagation();
                          setTitleDraft(row.primaryText);
                          setEditingTitleRowId(row.uuid);
                        }}
                        className={cn(
                          "-mx-1.5 rounded-md px-1.5 py-1 transition-colors",
                          row.editableText && !isEditingTitle && "hover:bg-accent/45 cursor-text",
                        )}
                      >
                        {isEditingTitle ? (
                          <div className="space-y-1" onClick={(e) => e.stopPropagation()}>
                            <textarea
                              autoFocus
                              data-sr-title-input={row.uuid}
                              value={titleDraft}
                              rows={Math.max(2, Math.min(8, titleDraft.split("\n").length + 1))}
                              onChange={(e) => setTitleDraft(e.target.value)}
                              onBlur={() => commitTitleEdit(row)}
                              onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === "Escape") {
                                  e.preventDefault();
                                  setEditingTitleRowId(null);
                                } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                  e.preventDefault();
                                  commitTitleEdit(row);
                                }
                              }}
                              placeholder={t("views.unnamedRecord")}
                              className="border-primary/70 bg-background text-foreground focus:ring-primary/30 w-full resize-y rounded-md border px-2.5 py-1.5 text-[15px] leading-relaxed outline-none focus:ring-2"
                            />
                            <div className="text-muted-foreground text-[10px]">
                              {t("spacedRepetition.inlineTextHint")}
                            </div>
                          </div>
                        ) : (
                          <div
                            className={cn(
                              "text-[15px] leading-relaxed font-medium break-words whitespace-pre-wrap",
                              titleInfo.isPlaceholder && "text-muted-foreground/55 font-normal",
                            )}
                          >
                            {titleInfo.text}
                          </div>
                        )}
                      </div>

                      {/* 图片在下 */}
                      {row.images.length > 0 && (
                        <div
                          data-sr-front-images={row.uuid}
                          className={cn("grid gap-2", row.images.length > 1 ? "grid-cols-2" : "grid-cols-1")}
                        >
                          {row.images.map((img) => (
                            <div
                              key={img.uuid}
                              className="group/srimg bg-muted/25 border-border/50 relative overflow-hidden rounded-lg border"
                            >
                              <StageTableAttachmentThumb
                                project={project}
                                attachmentId={img.attachmentId}
                                className={cn(
                                  "w-full rounded-none border-0",
                                  row.images.length === 1
                                    ? columns === 1
                                      ? "h-auto max-h-96 min-h-32"
                                      : "h-auto max-h-64 min-h-28"
                                    : "h-40",
                                  imageFit === "contain" ? "object-contain p-1" : "object-cover",
                                )}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onPreviewImage(img.attachmentId, row.uuid);
                                }}
                              />
                              {row.canEditImages !== false && (
                                <button
                                  type="button"
                                  title={t("imagesCell.remove")}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    project.stageTable.removeRowImage?.(row.uuid, img.uuid);
                                  }}
                                  className="bg-background/90 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground border-border absolute top-1.5 right-1.5 flex size-5 cursor-pointer items-center justify-center rounded-full border opacity-0 shadow-xs transition-opacity group-hover/srimg:opacity-100"
                                >
                                  <X className="size-3" />
                                </button>
                              )}
                            </div>
                          ))}
                        </div>
                      )}

                      {/* 正面附加属性（支持上下/左右拖动排序，同行自动等分填满宽度，双击原地编辑） */}
                      {orderedFrontFieldRows.length > 0 && (
                        <div
                          data-sr-sortable-container={`${row.uuid}:front`}
                          data-sr-front-fields={row.uuid}
                          className="border-border/50 space-y-2 border-t pt-2"
                        >
                          {orderedFrontFieldRows.map((rowFieldIds, rowIdx) => {
                            const containerKey = `${row.uuid}:front`;
                            const rowHasTopDrop =
                              fieldDragState?.containerKey === containerKey &&
                              fieldDragState.position === "top" &&
                              Boolean(fieldDragState.targetColId && rowFieldIds.includes(fieldDragState.targetColId));
                            const rowHasBottomDrop =
                              fieldDragState?.containerKey === containerKey &&
                              fieldDragState.position === "bottom" &&
                              Boolean(fieldDragState.targetColId && rowFieldIds.includes(fieldDragState.targetColId));
                            return (
                              <div
                                key={`${rowIdx}:${rowFieldIds.join(",")}`}
                                data-sr-field-layout-row={rowFieldIds.join(",")}
                                style={{ gridTemplateColumns: `repeat(${rowFieldIds.length}, minmax(0, 1fr))` }}
                                className="relative grid gap-2"
                              >
                                {rowHasTopDrop && (
                                  <div className="bg-primary pointer-events-none absolute -top-1 right-0 left-0 z-20 h-0.5 rounded-full" />
                                )}
                                {rowHasBottomDrop && (
                                  <div className="bg-primary pointer-events-none absolute right-0 -bottom-1 left-0 z-20 h-0.5 rounded-full" />
                                )}
                                {rowFieldIds.map((cid) => {
                                  const customCol = customColumnMap.get(cid);
                                  if (!customCol) return null;
                                  const isDraggingThis =
                                    fieldDragState?.containerKey === containerKey &&
                                    fieldDragState.draggedColId === cid;
                                  const showDropLeft =
                                    fieldDragState?.containerKey === containerKey &&
                                    fieldDragState.targetColId === cid &&
                                    fieldDragState.position === "left";
                                  const showDropRight =
                                    fieldDragState?.containerKey === containerKey &&
                                    fieldDragState.targetColId === cid &&
                                    fieldDragState.position === "right";
                                  return (
                                    <div
                                      key={cid}
                                      data-sr-sortable-item={cid}
                                      className={cn(
                                        "group/srfielditem bg-muted/15 border-border/45 relative min-w-0 rounded-lg border px-2.5 py-0.5 transition-all",
                                        isDraggingThis && "border-primary/50 bg-primary/5 opacity-45",
                                      )}
                                    >
                                      {showDropLeft && (
                                        <div className="bg-primary pointer-events-none absolute top-0.5 bottom-0.5 -left-1.5 z-20 w-1 rounded-full" />
                                      )}
                                      {showDropRight && (
                                        <div className="bg-primary pointer-events-none absolute top-0.5 -right-1.5 bottom-0.5 z-20 w-1 rounded-full" />
                                      )}
                                      <SpacedRepetitionInlineField
                                        project={project}
                                        row={row}
                                        columnId={cid}
                                        customCol={customCol}
                                        label={getColumnLabel(cid)}
                                        onPreviewImage={onPreviewImage}
                                        onOpenFormulaEditor={onOpenFormulaEditor}
                                        multiline={customCol.protectedRole === "notes"}
                                        onDragHandlePointerDown={
                                          orderedFrontFieldIds.length > 1
                                            ? (e) =>
                                                startFieldDrag(e, {
                                                  containerKey,
                                                  side: "front",
                                                  colId: cid,
                                                  layout: "rows2d",
                                                })
                                            : undefined
                                        }
                                        t={t}
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* 底部三个等大图标作答按钮：从左到右 对-闭卷（绿）| 对-开卷（绿）| 错（红） */}
                      <div
                        data-sr-answer-actions={row.uuid}
                        className="border-border/55 mt-auto grid grid-cols-3 gap-2 border-t pt-3"
                      >
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              data-sr-answer-btn="correct_closed"
                              aria-label={t("spacedRepetition.answerCorrectClosed")}
                              aria-pressed={answered?.choice === "correct_closed"}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAnswer(row, "correct_closed");
                              }}
                              className={cn(
                                "flex h-11 w-full cursor-pointer items-center justify-center rounded-lg border transition-all",
                                answered?.choice === "correct_closed"
                                  ? "border-emerald-600 bg-emerald-600 text-white shadow-sm ring-2 ring-emerald-500/35"
                                  : "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 hover:border-emerald-500/60 hover:bg-emerald-500/20 dark:text-emerald-400",
                              )}
                            >
                              <AnswerClosedBookCorrectIcon />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            {t("spacedRepetition.answerCorrectClosedTooltip")}
                          </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              data-sr-answer-btn="correct_open"
                              aria-label={t("spacedRepetition.answerCorrectOpen")}
                              aria-pressed={answered?.choice === "correct_open"}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAnswer(row, "correct_open");
                              }}
                              className={cn(
                                "flex h-11 w-full cursor-pointer items-center justify-center rounded-lg border transition-all",
                                answered?.choice === "correct_open"
                                  ? "border-emerald-600 bg-emerald-600 text-white shadow-sm ring-2 ring-emerald-500/35"
                                  : "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 hover:border-emerald-500/60 hover:bg-emerald-500/20 dark:text-emerald-400",
                              )}
                            >
                              <AnswerOpenBookCorrectIcon />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">
                            {t("spacedRepetition.answerCorrectOpenTooltip")}
                          </TooltipContent>
                        </Tooltip>

                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              data-sr-answer-btn="wrong"
                              aria-label={t("spacedRepetition.answerWrong")}
                              aria-pressed={answered?.choice === "wrong"}
                              onClick={(e) => {
                                e.stopPropagation();
                                handleAnswer(row, "wrong");
                              }}
                              className={cn(
                                "flex h-11 w-full cursor-pointer items-center justify-center rounded-lg border transition-all",
                                answered?.choice === "wrong"
                                  ? "border-rose-600 bg-rose-600 text-white shadow-sm ring-2 ring-rose-500/35"
                                  : "border-rose-500/35 bg-rose-500/10 text-rose-600 hover:border-rose-500/60 hover:bg-rose-500/20 dark:text-rose-400",
                              )}
                            >
                              <AnswerWrongIcon />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="bottom">{t("spacedRepetition.answerWrongTooltip")}</TooltipContent>
                        </Tooltip>
                      </div>
                    </div>
                  ) : (
                    /* ======================== 背面：结构化信息 + 全部字段支持双击调整 ======================== */
                    <div data-sr-back className="flex flex-1 flex-col gap-3 px-4 pt-1 pb-3.5 text-xs">
                      {/* 背面顶部节点标题（双击可编辑） */}
                      <div
                        title={row.editableText ? t("spacedRepetition.doubleClickToEdit") : undefined}
                        onDoubleClick={(e) => {
                          if (!row.editableText) return;
                          e.stopPropagation();
                          setTitleDraft(row.primaryText);
                          setEditingTitleRowId(row.uuid);
                        }}
                        className="border-border/60 border-b pb-2"
                      >
                        {isEditingTitle ? (
                          <Input
                            autoFocus
                            data-sr-title-input={row.uuid}
                            value={titleDraft}
                            onChange={(e) => setTitleDraft(e.target.value)}
                            onBlur={() => commitTitleEdit(row)}
                            onKeyDown={(e) => {
                              e.stopPropagation();
                              if (e.key === "Escape") {
                                e.preventDefault();
                                setEditingTitleRowId(null);
                              } else if (e.key === "Enter") {
                                e.preventDefault();
                                commitTitleEdit(row);
                              }
                            }}
                            className="border-primary/70 h-7 text-xs font-semibold"
                          />
                        ) : (
                          <div
                            className={cn(
                              "line-clamp-2 text-sm font-semibold break-words",
                              titleInfo.isPlaceholder && "text-muted-foreground/60 font-normal",
                            )}
                          >
                            {titleInfo.text}
                          </div>
                        )}
                      </div>

                      {/* 背面弹性多行属性排布：支持上下独立成行或左右并排，每行自动等分填满宽度 */}
                      {orderedBackFieldRows.length > 0 && (
                        <div
                          data-sr-sortable-container={`${row.uuid}:back`}
                          data-sr-back-fields={row.uuid}
                          className="space-y-2"
                        >
                          {orderedBackFieldRows.map((rowFieldIds, rowIdx) => {
                            const containerKey = `${row.uuid}:back`;
                            const rowHasTopDrop =
                              fieldDragState?.containerKey === containerKey &&
                              fieldDragState.position === "top" &&
                              Boolean(fieldDragState.targetColId && rowFieldIds.includes(fieldDragState.targetColId));
                            const rowHasBottomDrop =
                              fieldDragState?.containerKey === containerKey &&
                              fieldDragState.position === "bottom" &&
                              Boolean(fieldDragState.targetColId && rowFieldIds.includes(fieldDragState.targetColId));
                            return (
                              <div
                                key={`${rowIdx}:${rowFieldIds.join(",")}`}
                                data-sr-field-layout-row={rowFieldIds.join(",")}
                                style={{ gridTemplateColumns: `repeat(${rowFieldIds.length}, minmax(0, 1fr))` }}
                                className="relative grid gap-2"
                              >
                                {rowHasTopDrop && (
                                  <div className="bg-primary pointer-events-none absolute -top-1 right-0 left-0 z-20 h-0.5 rounded-full" />
                                )}
                                {rowHasBottomDrop && (
                                  <div className="bg-primary pointer-events-none absolute right-0 -bottom-1 left-0 z-20 h-0.5 rounded-full" />
                                )}
                                {rowFieldIds.map((cid) => {
                                  const customCol = customColumnMap.get(cid);
                                  const isSystemTime = cid === "createdAt" || cid === "updatedAt";
                                  if (!customCol && !isSystemTime) return null;
                                  const isDraggingThis =
                                    fieldDragState?.containerKey === containerKey &&
                                    fieldDragState.draggedColId === cid;
                                  const showDropLeft =
                                    fieldDragState?.containerKey === containerKey &&
                                    fieldDragState.targetColId === cid &&
                                    fieldDragState.position === "left";
                                  const showDropRight =
                                    fieldDragState?.containerKey === containerKey &&
                                    fieldDragState.targetColId === cid &&
                                    fieldDragState.position === "right";
                                  return (
                                    <div
                                      key={cid}
                                      data-sr-sortable-item={cid}
                                      data-sr-back-updated-at={cid === "updatedAt" ? row.uuid : undefined}
                                      className={cn(
                                        "group/srfielditem bg-muted/20 border-border/45 relative min-w-0 rounded-lg border px-2.5 py-0.5 transition-all",
                                        isDraggingThis && "border-primary/50 bg-primary/5 opacity-45",
                                      )}
                                    >
                                      {showDropLeft && (
                                        <div className="bg-primary pointer-events-none absolute top-0.5 bottom-0.5 -left-1.5 z-20 w-1 rounded-full" />
                                      )}
                                      {showDropRight && (
                                        <div className="bg-primary pointer-events-none absolute top-0.5 -right-1.5 bottom-0.5 z-20 w-1 rounded-full" />
                                      )}
                                      <SpacedRepetitionInlineField
                                        project={project}
                                        row={row}
                                        columnId={cid}
                                        customCol={customCol}
                                        label={getColumnLabel(cid)}
                                        onPreviewImage={onPreviewImage}
                                        onOpenFormulaEditor={onOpenFormulaEditor}
                                        multiline={customCol?.protectedRole === "notes"}
                                        onDragHandlePointerDown={
                                          orderedBackFieldIds.length > 1
                                            ? (e) =>
                                                startFieldDrag(e, {
                                                  containerKey,
                                                  side: "back",
                                                  colId: cid,
                                                  layout: "rows2d",
                                                })
                                            : undefined
                                        }
                                        t={t}
                                      />
                                    </div>
                                  );
                                })}
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* 拓扑关系只读摘要（若节点存在关联） */}
                      {(["parents", "children", "outer", "inner"] as const).some((relCol) =>
                        relCol === "outer" ? Boolean(row.outer) : row[relCol].length > 0,
                      ) && (
                        <div className="border-border/50 space-y-1.5 border-t pt-2">
                          {(["parents", "children", "outer", "inner"] as const).map((relCol) => {
                            const hasVal = relCol === "outer" ? Boolean(row.outer) : row[relCol].length > 0;
                            if (!hasVal) return null;
                            return (
                              <div key={relCol} className="space-y-0.5">
                                <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
                                  <StageTableColumnIcon columnId={relCol} className="size-3" />
                                  <span>{getColumnLabel(relCol)}</span>
                                </div>
                                <StageTableFieldValueDisplay
                                  project={project}
                                  row={row}
                                  columnId={relCol}
                                  compact
                                  t={t}
                                />
                              </div>
                            );
                          })}
                        </div>
                      )}

                      {/* 背面底部提示与快速添加背面属性 */}
                      <div className="text-muted-foreground/75 border-border/45 mt-auto flex items-center justify-between gap-2 border-t pt-2 text-[11px]">
                        <AddSpacedRepetitionFieldPopover
                          side="back"
                          onCreate={(name, type) => handleCreateCustomSideField("back", name, type, row.uuid)}
                          t={t}
                          trigger={
                            <button
                              type="button"
                              data-sr-card-add-back-field={row.uuid}
                              onClick={(e) => e.stopPropagation()}
                              className="text-primary hover:bg-accent inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors"
                            >
                              <Plus className="size-3" />
                              <span>{t("spacedRepetition.addBackFieldBtn")}</span>
                            </button>
                          }
                        />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFlip(row.uuid);
                          }}
                          className="text-primary inline-flex cursor-pointer items-center gap-1 hover:underline"
                        >
                          <RotateCw className="size-3" />
                          <span>{t("spacedRepetition.flipToFront")}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
