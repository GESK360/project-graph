import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import type { Project } from "@/core/Project";
import type {
  StageTableImageItem,
  StageTableRelationItem,
  StageTableRow,
  StageTableRowKind,
} from "@/core/service/dataManageService/stageTableService/StageTableService";
import type {
  RelationColumnKind,
  TableDataSource,
} from "@/core/service/dataManageService/stageTableService/TableDataSource";
import {
  pickNextSelectOptionColor,
  type FormulaEvaluatedCell,
  type TableCellValue,
  type TableColumnSchema,
  type TableSelectOption,
} from "@/types/table";
import { cn } from "@/utils/cn";
import {
  ArrowRight,
  Box,
  Boxes,
  Check,
  ChevronUp,
  FileCode2,
  FileText,
  Film,
  Folder,
  Image as ImageIcon,
  Link2,
  Plus,
  Search,
  Sigma,
  SquareDashed,
  X,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useCellSelectionMask, useIsRowSelected, type StageTableSelectionStore } from "./stage-table-selection-store";

export const OPTION_COLOR_CLASSES: Record<string, string> = {
  gray: "bg-zinc-500/25 text-zinc-900 dark:bg-zinc-400/30 dark:text-zinc-100",
  purple: "bg-purple-600/85 text-white dark:bg-purple-500/85 dark:text-white",
  blue: "bg-blue-600/85 text-white dark:bg-blue-500/85 dark:text-white",
  green: "bg-emerald-600/85 text-white dark:bg-emerald-500/85 dark:text-white",
  amber: "bg-amber-500/85 text-white dark:bg-amber-500/85 dark:text-white",
  rose: "bg-rose-600/85 text-white dark:bg-rose-500/85 dark:text-white",
  cyan: "bg-cyan-600/85 text-white dark:bg-cyan-500/85 dark:text-white",
  orange: "bg-orange-600/85 text-white dark:bg-orange-500/85 dark:text-white",
};

export function getOptionBadgeClass(color?: string): string {
  return (color && OPTION_COLOR_CLASSES[color]) || OPTION_COLOR_CLASSES.gray;
}

export function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatIsoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseIsoDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const dt = new Date(year, month, day);
  if (dt.getFullYear() !== year || dt.getMonth() !== month || dt.getDate() !== day) {
    return undefined;
  }
  return dt;
}

export function RowKindIcon({ kind, className }: { kind: StageTableRowKind; className?: string }) {
  const cls = cn("size-3.5 shrink-0 text-muted-foreground", className);
  switch (kind) {
    case "section":
      return <Boxes className={cls} />;
    case "url":
      return <Link2 className={cls} />;
    case "media":
      return <Film className={cls} />;
    case "latex":
      return <Sigma className={cls} />;
    case "reference":
      return <FileCode2 className={cls} />;
    case "image":
      return <ImageIcon className={cls} />;
    case "svg":
      return <SquareDashed className={cls} />;
    case "text":
    default:
      return <Box className={cls} />;
  }
}

export function getDisplayLabel(
  row: { primaryText?: string; label?: string; kind: StageTableRowKind; uuid: string },
  t: (key: string) => string,
): string {
  const text = (row.primaryText ?? row.label ?? "").trim();
  if (text.length > 0) {
    return text.replace(/\r?\n/g, " ");
  }
  switch (row.kind) {
    case "section":
      return t("untitledSection");
    case "image":
      return t("untitledImage");
    case "url":
      return t("untitledUrl");
    case "media":
      return t("untitledMedia");
    case "latex":
      return t("untitledLatex");
    case "svg":
      return t("untitledSvg");
    case "reference":
      return t("untitledReference");
    default:
      return t("untitledNode");
  }
}

export function AttachmentThumb({
  project,
  dataSource,
  docId,
  attachmentId,
  className,
  onClick,
}: {
  project?: Project | null;
  dataSource?: TableDataSource;
  docId?: string | null;
  attachmentId: string;
  className?: string;
  onClick?: () => void;
}) {
  const mediaUrl =
    dataSource?.getMediaUrl(docId ?? null, attachmentId, { thumb: true }) ??
    project?.getAttachmentMediaUrl?.(attachmentId, { thumb: true }) ??
    null;
  const blob = mediaUrl ? undefined : project?.attachments?.get?.(attachmentId);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (mediaUrl || !blob || typeof URL.createObjectURL !== "function") {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL?.(url);
    };
  }, [mediaUrl, blob]);

  const resolvedUrl = mediaUrl ?? objectUrl;
  if (!resolvedUrl) {
    return (
      <div
        onClick={onClick}
        className={cn(
          "bg-muted text-muted-foreground flex size-7 items-center justify-center rounded border",
          className,
        )}
      >
        <ImageIcon className="size-3.5" />
      </div>
    );
  }

  return (
    <img
      src={resolvedUrl}
      alt=""
      loading="lazy"
      decoding="async"
      onClick={onClick}
      className={cn("border-border/70 size-7 rounded border object-cover", onClick && "cursor-zoom-in", className)}
    />
  );
}

// ============================================================================
// 单例单元格浮层编辑器状态与 Portal 组件
// ============================================================================

export interface ActiveCellEditorAnchor {
  top: number;
  left: number;
  width: number;
  height: number;
}

export type ActiveCellEditorState =
  | { kind: "inline_text"; rowUuid: string; docId?: string; colId: string }
  | { kind: "date"; rowUuid: string; docId?: string; colId: string; anchor: ActiveCellEditorAnchor }
  | { kind: "select"; rowUuid: string; docId?: string; colId: string; anchor: ActiveCellEditorAnchor }
  | {
      kind: "relation";
      rowUuid: string;
      docId?: string;
      colId: string;
      relationKind: RelationColumnKind;
      anchor: ActiveCellEditorAnchor;
    };

export function captureAnchorRect(el: HTMLElement): ActiveCellEditorAnchor {
  const rect = el.getBoundingClientRect();
  return {
    top: rect.top,
    left: rect.left,
    width: Math.max(rect.width, 40),
    height: Math.max(rect.height, 28),
  };
}

/**
 * 表级唯一共享单元格浮层编辑器（日期日历 / 单选多选 / 关系异步搜索）：
 * 普通态单元格不挂载任何 Radix Popover/Calendar/候选过滤逻辑，仅在用户点击编辑时挂载此单例浮层。
 */
export function StageTableCellEditorPortal({
  activeEditor,
  row,
  customCol,
  dataSource,
  onClose,
  onCommitCustomField,
  onCreateOrGetOption,
  onCommitRelation,
  t,
}: {
  activeEditor: ActiveCellEditorState | null;
  row: StageTableRow | null;
  customCol?: TableColumnSchema;
  dataSource: TableDataSource;
  onClose: () => void;
  onCommitCustomField: (rowUuid: string, colId: string, val: TableCellValue, docId?: string) => void;
  onCreateOrGetOption: (colId: string, name: string) => TableSelectOption | null;
  onCommitRelation: (
    rowUuid: string,
    relationKind: RelationColumnKind,
    nextIds: string[] | string | null,
    docId?: string,
  ) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const isPortalKind =
    activeEditor !== null &&
    (activeEditor.kind === "date" || activeEditor.kind === "select" || activeEditor.kind === "relation");

  if (!isPortalKind || !row) {
    return null;
  }

  return (
    <Popover
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <PopoverAnchor asChild>
        <div
          aria-hidden
          style={{
            position: "fixed",
            top: `${activeEditor.anchor.top}px`,
            left: `${activeEditor.anchor.left}px`,
            width: `${activeEditor.anchor.width}px`,
            height: `${activeEditor.anchor.height}px`,
            pointerEvents: "none",
          }}
        />
      </PopoverAnchor>

      {activeEditor.kind === "date" && (
        <DateEditorPopoverContent
          value={row.tableFields?.[activeEditor.colId]}
          onCommit={(nextVal) => onCommitCustomField(row.uuid, activeEditor.colId, nextVal, row.docId)}
          onClose={onClose}
          t={t}
        />
      )}

      {activeEditor.kind === "select" && customCol && (
        <SelectEditorPopoverContent
          column={customCol}
          value={row.tableFields?.[customCol.id]}
          onCommit={(nextVal) => onCommitCustomField(row.uuid, customCol.id, nextVal, row.docId)}
          onCreateOrGetOption={(optName) => onCreateOrGetOption(customCol.id, optName)}
          onClose={onClose}
          t={t}
        />
      )}

      {activeEditor.kind === "relation" && (
        <RelationEditorPopoverContent
          row={row}
          relationKind={activeEditor.relationKind}
          dataSource={dataSource}
          onChange={(nextIds) => onCommitRelation(row.uuid, activeEditor.relationKind, nextIds, row.docId)}
          onClose={onClose}
          t={t}
        />
      )}
    </Popover>
  );
}

function DateEditorPopoverContent({
  value,
  onCommit,
  onClose,
  t,
}: {
  value: TableCellValue | undefined;
  onCommit: (val: TableCellValue) => void;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const dateStr = typeof value === "string" ? value : "";
  const selectedDate = useMemo(() => parseIsoDate(dateStr), [dateStr]);
  const [displayMonth, setDisplayMonth] = useState<Date>(() => selectedDate ?? new Date());

  useEffect(() => {
    setDisplayMonth(selectedDate ?? new Date());
  }, [selectedDate]);

  return (
    <PopoverContent
      align="start"
      className="w-auto p-2"
      onWheel={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-1.5">
        <Input
          type="date"
          value={dateStr}
          onChange={(e) => {
            const next = e.target.value.trim();
            onCommit(next || null);
          }}
          onKeyDown={(e) => e.stopPropagation()}
          className="h-7 flex-1 text-xs tabular-nums"
        />
        {dateStr && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              onCommit(null);
              onClose();
            }}
            className="h-7 px-2 text-xs"
          >
            {t("dateCell.clear")}
          </Button>
        )}
      </div>
      <Calendar
        mode="single"
        month={displayMonth}
        onMonthChange={setDisplayMonth}
        selected={selectedDate}
        onSelect={(date) => {
          if (date) {
            onCommit(formatIsoDate(date));
          }
          onClose();
        }}
      />
    </PopoverContent>
  );
}

function SelectEditorPopoverContent({
  column,
  value,
  onCommit,
  onCreateOrGetOption,
  onClose,
  t,
}: {
  column: TableColumnSchema;
  value: TableCellValue | undefined;
  onCommit: (val: TableCellValue) => void;
  onCreateOrGetOption: (name: string) => TableSelectOption | null;
  onClose: () => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const isMulti = column.type === "multi_select";
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const options = column.options ?? [];
  const optionById = useMemo(() => new Map(options.map((opt) => [opt.id, opt])), [options]);

  const selectedIds = useMemo<string[]>(() => {
    if (isMulti) {
      if (Array.isArray(value)) return value.filter((id) => optionById.has(id));
      if (typeof value === "string" && optionById.has(value)) return [value];
      return [];
    }
    if (typeof value === "string" && optionById.has(value)) return [value];
    if (Array.isArray(value) && value.length > 0 && optionById.has(value[0])) return [value[0]];
    return [];
  }, [isMulti, value, optionById]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const trimmedQuery = query.trim();
  const filteredOptions = useMemo(() => {
    if (!trimmedQuery) return options;
    const lower = trimmedQuery.toLowerCase();
    return options.filter((opt) => opt.name.toLowerCase().includes(lower));
  }, [options, trimmedQuery]);
  const hasExactOption = useMemo(() => options.some((opt) => opt.name === trimmedQuery), [options, trimmedQuery]);
  const previewColor = useMemo(() => pickNextSelectOptionColor(options), [options]);

  const toggleOption = (optionId: string) => {
    if (isMulti) {
      const next = new Set(selectedIds);
      if (next.has(optionId)) next.delete(optionId);
      else next.add(optionId);
      onCommit(Array.from(next));
    } else {
      if (selectedSet.has(optionId)) {
        onCommit(null);
      } else {
        onCommit(optionId);
        onClose();
      }
    }
  };

  const handleCreateAndSelect = (rawName: string) => {
    const created = onCreateOrGetOption(rawName);
    if (!created) return;
    setQuery("");
    if (isMulti) {
      onCommit(Array.from(new Set([...selectedIds, created.id])));
    } else {
      onCommit(created.id);
      onClose();
    }
  };

  return (
    <PopoverContent
      align="start"
      className="w-56 p-0"
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        inputRef.current?.focus();
      }}
      onWheel={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="border-b p-2">
        <Input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter" && trimmedQuery) {
              e.preventDefault();
              const exact = options.find((opt) => opt.name === trimmedQuery);
              if (exact) {
                toggleOption(exact.id);
                setQuery("");
              } else {
                handleCreateAndSelect(trimmedQuery);
              }
            }
          }}
          placeholder={t("selectCell.searchOrAddPlaceholder")}
          className="h-7 px-2 text-xs"
        />
      </div>
      <div className="text-muted-foreground px-2.5 pt-2 pb-1 text-[11px] font-medium select-none">
        {isMulti ? t("columnTypes.multi_select") : t("columnTypes.select")}
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {filteredOptions.map((opt) => {
          const checked = selectedSet.has(opt.id);
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => toggleOption(opt.id)}
              className={cn(
                "hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
                checked && "bg-accent/50",
              )}
            >
              <span className="flex size-3.5 shrink-0 items-center justify-center">
                {checked && <Check className="text-primary size-3.5" />}
              </span>
              <span
                className={cn(
                  "inline-flex max-w-full items-center rounded px-2 py-0.5 text-[11px] font-medium",
                  getOptionBadgeClass(opt.color),
                )}
              >
                <span className="truncate">{opt.name}</span>
              </span>
            </button>
          );
        })}

        {trimmedQuery && !hasExactOption && (
          <button
            type="button"
            onClick={() => handleCreateAndSelect(trimmedQuery)}
            className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs"
          >
            <span className="text-muted-foreground text-[11px]">{t("selectCell.createPrefix")}</span>
            <span
              className={cn(
                "inline-flex max-w-full items-center rounded px-2 py-0.5 text-[11px] font-medium",
                getOptionBadgeClass(previewColor),
              )}
            >
              <span className="truncate">{trimmedQuery}</span>
            </span>
          </button>
        )}

        {filteredOptions.length === 0 && !trimmedQuery && (
          <div className="text-muted-foreground px-2 py-3 text-center text-xs">{t("selectCell.emptyHint")}</div>
        )}
      </div>
    </PopoverContent>
  );
}

function RelationEditorPopoverContent({
  row,
  relationKind,
  dataSource,
  onChange,
  onClose,
  t,
}: {
  row: StageTableRow;
  relationKind: RelationColumnKind;
  dataSource: TableDataSource;
  onChange: (nextIds: string[] | string | null) => void;
  onClose: () => void;
  t: (key: string) => string;
}) {
  const isSingle = relationKind === "outer";
  const [query, setQuery] = useState("");
  const [candidates, setCandidates] = useState<StageTableRelationItem[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedItems = useMemo<StageTableRelationItem[]>(() => {
    if (relationKind === "outer") return row.outer ? [row.outer] : [];
    if (relationKind === "parents") return row.parents;
    if (relationKind === "children") return row.children;
    return row.inner;
  }, [row, relationKind]);

  const selectedIds = useMemo(() => new Set(selectedItems.map((i) => i.uuid)), [selectedItems]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void dataSource
      .queryRelationCandidates({
        docId: row.docId ?? dataSource.getDocId(),
        rowUuid: row.uuid,
        relationKind,
        search: query,
        limit: 50,
      })
      .then((res) => {
        if (cancelled) return;
        setCandidates(res.candidates);
        setHasMore(res.hasMore);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dataSource, row.docId, row.uuid, relationKind, query]);

  const toggleMulti = (uuid: string) => {
    const next = new Set(selectedIds);
    if (next.has(uuid)) next.delete(uuid);
    else next.add(uuid);
    onChange(Array.from(next));
  };

  return (
    <PopoverContent
      align="start"
      data-relation-editor-popover={relationKind}
      className="w-60 p-0"
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        inputRef.current?.focus();
      }}
      onWheel={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="border-b p-2">
        <div className="relative flex items-center">
          <Search className="text-muted-foreground pointer-events-none absolute left-2 size-3.5" />
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={t("searchNodePlaceholder")}
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>
      <div className="max-h-56 overflow-y-auto p-1">
        {isSingle && row.outer && (
          <button
            type="button"
            onClick={() => {
              onChange(null);
              onClose();
            }}
            className="text-muted-foreground hover:bg-accent hover:text-foreground mb-1 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs"
          >
            <X className="size-3.5" />
            <span>{t("clearOuter")}</span>
          </button>
        )}

        {loading && candidates.length === 0 ? (
          <div className="text-muted-foreground px-2 py-4 text-center text-xs">...</div>
        ) : candidates.length === 0 ? (
          <div className="text-muted-foreground px-2 py-4 text-center text-xs">{t("noMatchingNodes")}</div>
        ) : isSingle ? (
          candidates.map((candidate) => {
            const checked = row.outer?.uuid === candidate.uuid;
            const label = getDisplayLabel(candidate, t);
            return (
              <button
                key={candidate.uuid}
                type="button"
                onClick={() => {
                  onChange(checked ? null : candidate.uuid);
                  onClose();
                }}
                className={cn(
                  "hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
                  checked && "bg-accent/60 font-medium",
                )}
              >
                <RowKindIcon kind={candidate.kind} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </button>
            );
          })
        ) : (
          candidates.map((candidate) => {
            const checked = selectedIds.has(candidate.uuid);
            const label = getDisplayLabel(candidate, t);
            return (
              <label
                key={candidate.uuid}
                className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs"
              >
                <Checkbox checked={checked} onCheckedChange={() => toggleMulti(candidate.uuid)} />
                <RowKindIcon kind={candidate.kind} />
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </label>
            );
          })
        )}

        {hasMore && (
          <div className="text-muted-foreground/70 border-border/40 mt-1 border-t px-2 py-1 text-center text-[10px]">
            {t("searchNodePlaceholder")}
          </div>
        )}
      </div>
    </PopoverContent>
  );
}

// ============================================================================
// 轻量级内联文本/数字编辑输入（仅挂载于当前唯一编辑格）
// ============================================================================

function InlineCellInput({
  initialValue,
  type,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  type: "text" | "number";
  onCommit: (nextRaw: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  return (
    <Input
      ref={inputRef}
      type={type}
      step={type === "number" ? "any" : undefined}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          onCommit(draft);
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      className={cn("h-6 min-w-0 flex-1 px-1.5 py-0 text-xs", type === "number" && "tabular-nums")}
    />
  );
}

// ============================================================================
// 虚拟化表格行与原子化选中单元格（React.memo + 零冗余 Popover/Tooltip）
// ============================================================================

export interface StageTableVirtualRowCallbacks {
  onRowIndexPointerDown: (rowId: string, e: React.PointerEvent) => void;
  onCellPointerDown: (rowId: string, colId: string, e: React.PointerEvent) => void;
  shouldSuppressCellClick: () => boolean;
  canEditOnClick: () => boolean;
  onStartInlineEdit: (rowId: string, colId: string, docId?: string) => void;
  onCloseEditor: () => void;
  onOpenPopoverEditor: (state: ActiveCellEditorState) => void;
  onCommitPrimaryText: (rowId: string, nextText: string, docId?: string) => void;
  onCommitCustomField: (rowId: string, colId: string, val: TableCellValue, docId?: string) => void;
  onJumpToRow: (rowId: string, docId?: string) => void;
  onRequestUploadImages: (rowId: string, docId?: string) => void;
  onAddImages: (rowId: string, blobs: Blob[], docId?: string) => void;
  onRemoveImage: (rowId: string, imgUuid: string, docId?: string) => void;
  onPreviewImage: (attachmentId: string, rowUuid: string, docId?: string) => void;
  onRemoveRelationItem: (rowId: string, kind: RelationColumnKind, nextIds: string[] | null, docId?: string) => void;
  onOpenFormulaEditor: (colId: string, rowId: string) => void;
}

const StageTableVirtualCell = React.memo(function StageTableVirtualCell({
  project,
  dataSource,
  row,
  colId,
  colIdx,
  customCol,
  isFrozen,
  isFreezeBoundary,
  stickyLeftPx,
  isActiveEditorHere,
  isInlineEditingHere,
  selectionStore,
  callbacks,
  t,
}: {
  project?: Project | null;
  dataSource?: TableDataSource;
  row: StageTableRow;
  colId: string;
  colIdx: number;
  customCol?: TableColumnSchema;
  isFrozen: boolean;
  isFreezeBoundary: boolean;
  stickyLeftPx: number;
  isActiveEditorHere: boolean;
  isInlineEditingHere: boolean;
  selectionStore: StageTableSelectionStore;
  callbacks: StageTableVirtualRowCallbacks;
  t: (key: string) => string;
}) {
  const mask = useCellSelectionMask(selectionStore, row.uuid, colId);
  const isSelectedAny = (mask & 1) !== 0;
  const isActiveCell = (mask & 2) !== 0;

  return (
    <td
      data-stage-table-cell
      data-row-id={row.uuid}
      data-col-id={colId}
      data-col-idx={colIdx}
      data-cell-selected={isSelectedAny ? "true" : undefined}
      data-cell-active={isActiveCell ? "true" : undefined}
      onPointerDown={(e) => callbacks.onCellPointerDown(row.uuid, colId, e)}
      onClickCapture={(e) => {
        if (callbacks.shouldSuppressCellClick() || e.shiftKey || e.ctrlKey || e.metaKey) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
      style={isFrozen ? { left: `var(--col-left-${colIdx}, ${stickyLeftPx}px)` } : undefined}
      className={cn(
        "border-border/40 overflow-hidden border-r p-0 align-middle",
        isFrozen ? "bg-background sticky z-10" : "relative",
        isFrozen && !isSelectedAny && "group-hover/row:bg-muted",
        isFreezeBoundary && "border-r-primary/45 border-r-2",
        isSelectedAny && "after:bg-primary/12 after:pointer-events-none after:absolute after:inset-0",
        isActiveCell && "after:ring-primary after:ring-2 after:ring-inset",
      )}
    >
      {colId === "name" && (
        <PrimaryTextCellView
          row={row}
          editing={isInlineEditingHere}
          canEditOnClick={callbacks.canEditOnClick}
          onStartEdit={() => callbacks.onStartInlineEdit(row.uuid, "name", row.docId)}
          onCommit={(nextText) => {
            callbacks.onCloseEditor();
            if (nextText !== row.primaryText) {
              callbacks.onCommitPrimaryText(row.uuid, nextText, row.docId);
            }
          }}
          onCancel={callbacks.onCloseEditor}
          onJump={() => callbacks.onJumpToRow(row.uuid, row.docId)}
          t={t}
        />
      )}

      {colId === "sourceFile" && (
        <div className="flex h-full min-h-8 w-full items-center px-2 py-1 select-none">
          {row.sourceFile ? (
            <button
              type="button"
              data-cell-action
              title={row.sourceRelPath || row.sourceFile}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                callbacks.onJumpToRow(row.uuid, row.docId);
              }}
              className="bg-muted/75 hover:bg-accent text-foreground inline-flex max-w-full cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors"
            >
              <FileText className="text-muted-foreground size-3 shrink-0" />
              <span className="truncate">{row.sourceFile}</span>
            </button>
          ) : (
            <span className="text-muted-foreground/50 text-xs">-</span>
          )}
        </div>
      )}

      {colId === "sourceFolder" && (
        <div
          title={row.sourceFolder || "/"}
          className="text-muted-foreground flex h-full min-h-8 w-full items-center gap-1 truncate px-2.5 py-1 text-[11px] select-none"
        >
          <Folder className="size-3 shrink-0 opacity-70" />
          <span className="truncate">{row.sourceFolder || "/"}</span>
        </div>
      )}

      {colId === "images" && (
        <ImagesCellView
          project={project}
          dataSource={dataSource}
          docId={row.docId}
          images={row.images ?? []}
          disabled={row.canEditImages === false}
          onRequestUpload={() => callbacks.onRequestUploadImages(row.uuid, row.docId)}
          onAddImages={(blobs) => callbacks.onAddImages(row.uuid, blobs, row.docId)}
          onRemoveImage={(imgUuid) => callbacks.onRemoveImage(row.uuid, imgUuid, row.docId)}
          onPreviewImage={(attId) => callbacks.onPreviewImage(attId, row.uuid, row.docId)}
          t={t}
        />
      )}

      {colId === "createdAt" && (
        <div className="text-muted-foreground truncate px-2.5 py-1.5 text-[11px] tabular-nums select-none">
          {formatTimestamp(row.createdAt)}
        </div>
      )}

      {colId === "updatedAt" && (
        <div className="text-muted-foreground truncate px-2.5 py-1.5 text-[11px] tabular-nums select-none">
          {formatTimestamp(row.updatedAt)}
        </div>
      )}

      {(colId === "parents" || colId === "children" || colId === "inner") && (
        <MultiRelationCellView
          items={colId === "parents" ? row.parents : colId === "children" ? row.children : row.inner}
          disabled={colId === "inner" && !row.canEditInner}
          open={isActiveEditorHere}
          placeholder={t("relationPlaceholder")}
          onOpen={(el) =>
            callbacks.onOpenPopoverEditor({
              kind: "relation",
              rowUuid: row.uuid,
              docId: row.docId,
              colId,
              relationKind: colId,
              anchor: captureAnchorRect(el),
            })
          }
          onRemove={(removeUuid) => {
            const list = colId === "parents" ? row.parents : colId === "children" ? row.children : row.inner;
            callbacks.onRemoveRelationItem(
              row.uuid,
              colId,
              list.filter((item) => item.uuid !== removeUuid).map((item) => item.uuid),
              row.docId,
            );
          }}
          t={t}
        />
      )}

      {colId === "outer" && (
        <SingleRelationCellView
          item={row.outer}
          open={isActiveEditorHere}
          placeholder={t("relationPlaceholder")}
          onOpen={(el) =>
            callbacks.onOpenPopoverEditor({
              kind: "relation",
              rowUuid: row.uuid,
              docId: row.docId,
              colId: "outer",
              relationKind: "outer",
              anchor: captureAnchorRect(el),
            })
          }
          onClear={() => callbacks.onRemoveRelationItem(row.uuid, "outer", null, row.docId)}
          t={t}
        />
      )}

      {customCol && customCol.type === "text" && (
        <TextCellView
          value={row.tableFields?.[customCol.id]}
          editing={isInlineEditingHere}
          canEditOnClick={callbacks.canEditOnClick}
          onStartEdit={() => callbacks.onStartInlineEdit(row.uuid, customCol.id, row.docId)}
          onCommit={(nextVal) => {
            callbacks.onCloseEditor();
            callbacks.onCommitCustomField(row.uuid, customCol.id, nextVal, row.docId);
          }}
          onCancel={callbacks.onCloseEditor}
        />
      )}

      {customCol && customCol.type === "number" && (
        <NumberCellView
          value={row.tableFields?.[customCol.id]}
          editing={isInlineEditingHere}
          canEditOnClick={callbacks.canEditOnClick}
          onStartEdit={() => callbacks.onStartInlineEdit(row.uuid, customCol.id, row.docId)}
          onCommit={(nextVal) => {
            callbacks.onCloseEditor();
            callbacks.onCommitCustomField(row.uuid, customCol.id, nextVal, row.docId);
          }}
          onCancel={callbacks.onCloseEditor}
        />
      )}

      {customCol && customCol.type === "date" && (
        <DateCellView
          value={row.tableFields?.[customCol.id]}
          open={isActiveEditorHere}
          onOpen={(el) =>
            callbacks.onOpenPopoverEditor({
              kind: "date",
              rowUuid: row.uuid,
              docId: row.docId,
              colId: customCol.id,
              anchor: captureAnchorRect(el),
            })
          }
          onClear={() => callbacks.onCommitCustomField(row.uuid, customCol.id, null, row.docId)}
          t={t}
        />
      )}

      {customCol && (customCol.type === "select" || customCol.type === "multi_select") && (
        <SelectCellView
          column={customCol}
          value={row.tableFields?.[customCol.id]}
          open={isActiveEditorHere}
          onOpen={(el) =>
            callbacks.onOpenPopoverEditor({
              kind: "select",
              rowUuid: row.uuid,
              docId: row.docId,
              colId: customCol.id,
              anchor: captureAnchorRect(el),
            })
          }
          onCommit={(nextVal) => callbacks.onCommitCustomField(row.uuid, customCol.id, nextVal, row.docId)}
          t={t}
        />
      )}

      {customCol && customCol.type === "formula" && (
        <FormulaCellView
          column={customCol}
          evaluated={row.formulaValues?.[customCol.id]}
          onDoubleClick={() => callbacks.onOpenFormulaEditor(customCol.id, row.uuid)}
          t={t}
        />
      )}
    </td>
  );
});

export const StageTableVirtualRow = React.memo(function StageTableVirtualRow({
  project,
  dataSource,
  row,
  rowIndex,
  visibleColumnIds,
  customColumnMap,
  frozenEndIndex,
  columnLeftOffsets,
  tableRowHeightClass,
  activeEditor,
  selectionStore,
  callbacks,
  t,
}: {
  project?: Project | null;
  dataSource?: TableDataSource;
  row: StageTableRow;
  rowIndex: number;
  visibleColumnIds: readonly string[];
  customColumnMap: ReadonlyMap<string, TableColumnSchema>;
  frozenEndIndex: number;
  columnLeftOffsets: readonly number[];
  tableRowHeightClass: string;
  activeEditor: ActiveCellEditorState | null;
  selectionStore: StageTableSelectionStore;
  callbacks: StageTableVirtualRowCallbacks;
  t: (key: string) => string;
}) {
  const isRowSelected = useIsRowSelected(selectionStore, row.uuid);
  const editorForThisRow =
    activeEditor?.rowUuid === row.uuid && (!activeEditor.docId || !row.docId || activeEditor.docId === row.docId)
      ? activeEditor
      : null;

  return (
    <tr
      data-stage-table-row-id={row.uuid}
      data-row-selected={isRowSelected ? "true" : undefined}
      className={cn(
        "group/row border-border/40 border-b transition-colors",
        tableRowHeightClass,
        !isRowSelected && "hover:bg-muted/30",
      )}
    >
      <td
        data-stage-table-row-index
        data-row-id={row.uuid}
        onPointerDown={(e) => callbacks.onRowIndexPointerDown(row.uuid, e)}
        style={frozenEndIndex >= 0 ? { left: "0px" } : undefined}
        className={cn(
          "border-border/40 hover:bg-accent/60 cursor-pointer border-r px-1 py-1 text-center text-[11px] tabular-nums transition-colors select-none",
          frozenEndIndex >= 0 ? "bg-background sticky z-10" : "relative",
          frozenEndIndex >= 0 && !isRowSelected && "group-hover/row:bg-muted",
          isRowSelected
            ? "text-primary after:bg-primary/18 font-semibold shadow-[inset_3px_0_0_var(--primary)] after:pointer-events-none after:absolute after:inset-0"
            : "text-muted-foreground",
        )}
      >
        {rowIndex + 1}
      </td>

      {visibleColumnIds.map((colId, colIdx) => {
        const isEditorHere = editorForThisRow?.colId === colId;
        return (
          <StageTableVirtualCell
            key={colId}
            project={project}
            dataSource={dataSource}
            row={row}
            colId={colId}
            colIdx={colIdx}
            customCol={customColumnMap.get(colId)}
            isFrozen={colIdx <= frozenEndIndex}
            isFreezeBoundary={colIdx === frozenEndIndex}
            stickyLeftPx={columnLeftOffsets[colIdx] ?? 0}
            isActiveEditorHere={Boolean(isEditorHere && editorForThisRow?.kind !== "inline_text")}
            isInlineEditingHere={Boolean(isEditorHere && editorForThisRow?.kind === "inline_text")}
            selectionStore={selectionStore}
            callbacks={callbacks}
            t={t}
          />
        );
      })}

      <td className="p-0" />
    </tr>
  );
});

// ============================================================================
// 极简纯 HTML 单元格展示视图（无每格 Popover / Tooltip / 全表过滤）
// ============================================================================

function PrimaryTextCellView({
  row,
  editing,
  canEditOnClick,
  onStartEdit,
  onCommit,
  onCancel,
  onJump,
  t,
}: {
  row: StageTableRow;
  editing: boolean;
  canEditOnClick: () => boolean;
  onStartEdit: () => void;
  onCommit: (nextText: string) => void;
  onCancel: () => void;
  onJump: () => void;
  t: (key: string) => string;
}) {
  const displayLabel = getDisplayLabel(row, t);
  const isEmptyText = row.primaryText.trim().length === 0;

  return (
    <div className="group flex h-full min-h-8 w-full items-center justify-between gap-1.5 px-2.5 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <RowKindIcon kind={row.kind} />
        {editing ? (
          <InlineCellInput initialValue={row.primaryText} type="text" onCommit={onCommit} onCancel={onCancel} />
        ) : (
          <button
            type="button"
            disabled={!row.editableText}
            onClick={() => {
              if (row.editableText && canEditOnClick()) {
                onStartEdit();
              }
            }}
            onDoubleClick={() => {
              if (row.editableText) onStartEdit();
            }}
            className={cn(
              "min-w-0 flex-1 truncate text-left text-xs outline-none",
              row.editableText ? "hover:text-foreground cursor-text" : "cursor-default",
              isEmptyText ? "text-muted-foreground italic" : "text-foreground",
            )}
            title={row.primaryText || displayLabel}
          >
            {displayLabel}
          </button>
        )}
      </div>

      <button
        type="button"
        data-cell-action
        title={t("jumpToNode")}
        aria-label={t("jumpToNode")}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onJump();
        }}
        className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-5 shrink-0 items-center justify-center rounded transition-colors"
      >
        <ArrowRight className="size-3.5" />
      </button>
    </div>
  );
}

function ImagesCellView({
  project,
  dataSource,
  docId,
  images,
  disabled,
  onRequestUpload,
  onAddImages,
  onRemoveImage,
  onPreviewImage,
  t,
}: {
  project?: Project | null;
  dataSource?: TableDataSource;
  docId?: string | null;
  images: StageTableImageItem[];
  disabled?: boolean;
  onRequestUpload: () => void;
  onAddImages: (blobs: Blob[]) => void;
  onRemoveImage: (imageNodeUuid: string) => void;
  onPreviewImage: (attachmentId: string) => void;
  t: (key: string) => string;
}) {
  if (disabled) {
    return <div className="text-muted-foreground/60 flex h-full items-center px-2.5 py-1 text-xs">-</div>;
  }

  return (
    <div
      tabIndex={0}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
        if (files.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          onAddImages(files);
        }
      }}
      className="group/imgcell flex h-full min-h-8 w-full flex-wrap items-center gap-1.5 px-2 py-1 outline-none"
    >
      {images.map((item) => (
        <div key={item.uuid} className="group/thumb relative inline-flex shrink-0">
          <AttachmentThumb
            project={project}
            dataSource={dataSource}
            docId={docId}
            attachmentId={item.attachmentId}
            onClick={() => onPreviewImage(item.attachmentId)}
          />
          <button
            type="button"
            aria-label={t("imagesCell.remove")}
            onClick={(e) => {
              e.stopPropagation();
              onRemoveImage(item.uuid);
            }}
            className="bg-background/90 text-muted-foreground hover:bg-destructive hover:text-destructive-foreground border-border absolute -top-1 -right-1 flex size-3.5 items-center justify-center rounded-full border opacity-0 shadow-xs transition-opacity group-hover/thumb:opacity-100 focus:opacity-100"
          >
            <X className="size-2.5" />
          </button>
        </div>
      ))}

      <button
        type="button"
        aria-label={t("imagesCell.add")}
        onClick={(e) => {
          e.stopPropagation();
          onRequestUpload();
        }}
        className={cn(
          "border-border/70 text-muted-foreground hover:border-primary/60 hover:bg-accent hover:text-foreground inline-flex h-6 items-center gap-1 rounded border border-dashed px-1.5 text-[11px] transition-opacity",
          images.length > 0 ? "opacity-0 group-hover/imgcell:opacity-100 focus:opacity-100" : "opacity-80",
        )}
      >
        <Plus className="size-3" />
        {images.length === 0 && <span>{t("imagesCell.add")}</span>}
      </button>
    </div>
  );
}

function TextCellView({
  value,
  editing,
  canEditOnClick,
  onStartEdit,
  onCommit,
  onCancel,
}: {
  value: TableCellValue | undefined;
  editing: boolean;
  canEditOnClick: () => boolean;
  onStartEdit: () => void;
  onCommit: (val: TableCellValue) => void;
  onCancel: () => void;
}) {
  const strValue = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);

  if (editing) {
    return (
      <div className="flex h-full min-h-8 items-center px-1.5 py-0.5">
        <InlineCellInput
          initialValue={strValue}
          type="text"
          onCommit={(draft) => {
            if (draft !== strValue) {
              onCommit(draft.length > 0 ? draft : null);
            } else {
              onCancel();
            }
          }}
          onCancel={onCancel}
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (canEditOnClick()) onStartEdit();
      }}
      onDoubleClick={onStartEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onStartEdit();
        }
      }}
      className="hover:bg-accent/40 flex h-full min-h-8 w-full cursor-text items-center px-2.5 py-1 text-xs outline-none"
      title={strValue}
    >
      <span className="min-w-0 flex-1 truncate">{strValue}</span>
    </div>
  );
}

function NumberCellView({
  value,
  editing,
  canEditOnClick,
  onStartEdit,
  onCommit,
  onCancel,
}: {
  value: TableCellValue | undefined;
  editing: boolean;
  canEditOnClick: () => boolean;
  onStartEdit: () => void;
  onCommit: (val: TableCellValue) => void;
  onCancel: () => void;
}) {
  const numStr = typeof value === "number" && Number.isFinite(value) ? String(value) : "";

  if (editing) {
    return (
      <div className="flex h-full min-h-8 items-center px-1.5 py-0.5">
        <InlineCellInput
          initialValue={numStr}
          type="number"
          onCommit={(draft) => {
            const trimmed = draft.trim();
            if (!trimmed) {
              if (numStr !== "") onCommit(null);
              else onCancel();
              return;
            }
            const parsed = Number(trimmed);
            if (Number.isFinite(parsed) && String(parsed) !== numStr) {
              onCommit(parsed);
            } else {
              onCancel();
            }
          }}
          onCancel={onCancel}
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (canEditOnClick()) onStartEdit();
      }}
      onDoubleClick={onStartEdit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onStartEdit();
        }
      }}
      className="hover:bg-accent/40 flex h-full min-h-8 w-full cursor-text items-center px-2.5 py-1 text-xs tabular-nums outline-none"
    >
      <span className="min-w-0 flex-1 truncate">{numStr}</span>
    </div>
  );
}

function DateCellView({
  value,
  open,
  onOpen,
  onClear,
  t,
}: {
  value: TableCellValue | undefined;
  open: boolean;
  onOpen: (el: HTMLElement) => void;
  onClear: () => void;
  t: (key: string) => string;
}) {
  const dateStr = typeof value === "string" ? value : "";
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => onOpen(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(e.currentTarget);
        }
      }}
      className={cn(
        "hover:bg-accent/40 flex h-full min-h-8 w-full cursor-pointer items-center justify-between gap-1 px-2.5 py-1 text-xs tabular-nums outline-none",
        open && "ring-primary bg-accent/25 ring-1 ring-inset",
      )}
    >
      <span className="truncate">{dateStr}</span>
      {dateStr && (
        <button
          type="button"
          data-cell-action
          aria-label={t("dateCell.clear")}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="text-muted-foreground hover:text-foreground rounded-xs p-0.5"
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  );
}

function SelectCellView({
  column,
  value,
  open,
  onOpen,
  onCommit,
  t,
}: {
  column: TableColumnSchema;
  value: TableCellValue | undefined;
  open: boolean;
  onOpen: (el: HTMLElement) => void;
  onCommit: (val: TableCellValue) => void;
  t: (key: string) => string;
}) {
  const isMulti = column.type === "multi_select";
  const options = column.options ?? [];
  const optionById = useMemo(() => new Map(options.map((opt) => [opt.id, opt])), [options]);
  const selectedIds = useMemo<string[]>(() => {
    if (isMulti) {
      if (Array.isArray(value)) return value.filter((id) => optionById.has(id));
      if (typeof value === "string" && optionById.has(value)) return [value];
      return [];
    }
    if (typeof value === "string" && optionById.has(value)) return [value];
    if (Array.isArray(value) && value.length > 0 && optionById.has(value[0])) return [value[0]];
    return [];
  }, [isMulti, value, optionById]);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => onOpen(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(e.currentTarget);
        }
      }}
      className={cn(
        "hover:bg-accent/40 relative flex h-full min-h-8 w-full cursor-pointer flex-wrap items-center gap-1 px-2 py-1 pr-6 text-xs outline-none",
        open && "ring-primary bg-accent/20 ring-1 ring-inset",
      )}
    >
      {selectedIds.map((id) => {
        const opt = optionById.get(id);
        if (!opt) return null;
        return (
          <span
            key={opt.id}
            className={cn(
              "inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium",
              getOptionBadgeClass(opt.color),
            )}
          >
            <span className="max-w-28 truncate">{opt.name}</span>
            <button
              type="button"
              data-cell-action
              aria-label={t("selectCell.removeOption")}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                if (isMulti) {
                  onCommit(selectedIds.filter((cur) => cur !== opt.id));
                } else {
                  onCommit(null);
                }
              }}
              className="leading-none opacity-75 transition-opacity hover:opacity-100"
            >
              ×
            </button>
          </span>
        );
      })}
      {open && (
        <ChevronUp className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2" />
      )}
    </div>
  );
}

function MultiRelationCellView({
  items,
  disabled,
  open,
  placeholder,
  onOpen,
  onRemove,
  t,
}: {
  items: readonly StageTableRelationItem[];
  disabled?: boolean;
  open: boolean;
  placeholder: string;
  onOpen: (el: HTMLElement) => void;
  onRemove: (uuid: string) => void;
  t: (key: string) => string;
}) {
  if (disabled) {
    return <div className="text-muted-foreground/60 flex h-full items-center px-2.5 py-1 text-xs">-</div>;
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => onOpen(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(e.currentTarget);
        }
      }}
      className={cn(
        "hover:bg-accent/40 flex h-full min-h-8 w-full cursor-pointer flex-wrap items-center gap-1 px-2 py-1 text-xs outline-none",
        open && "ring-primary bg-accent/20 ring-1 ring-inset",
      )}
    >
      {items.length === 0 ? (
        <span className="text-muted-foreground/50 text-xs">{placeholder}</span>
      ) : (
        items.map((item) => {
          const label = getDisplayLabel(item, t);
          return (
            <span
              key={item.uuid}
              className="bg-secondary text-secondary-foreground inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px]"
            >
              <RowKindIcon kind={item.kind} className="size-3" />
              <span className="max-w-28 truncate">{label}</span>
              <button
                type="button"
                data-cell-action
                aria-label={t("removeRelation")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemove(item.uuid);
                }}
                className="text-muted-foreground hover:text-foreground rounded-xs px-0.5 leading-none"
              >
                ×
              </button>
            </span>
          );
        })
      )}
    </div>
  );
}

function SingleRelationCellView({
  item,
  open,
  placeholder,
  onOpen,
  onClear,
  t,
}: {
  item: StageTableRelationItem | null;
  open: boolean;
  placeholder: string;
  onOpen: (el: HTMLElement) => void;
  onClear: () => void;
  t: (key: string) => string;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => onOpen(e.currentTarget)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(e.currentTarget);
        }
      }}
      className={cn(
        "hover:bg-accent/40 flex h-full min-h-8 w-full cursor-pointer items-center gap-1 px-2 py-1 text-xs outline-none",
        open && "ring-primary bg-accent/20 ring-1 ring-inset",
      )}
    >
      {!item ? (
        <span className="text-muted-foreground/50 text-xs">{placeholder}</span>
      ) : (
        <span className="bg-secondary text-secondary-foreground inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px]">
          <RowKindIcon kind={item.kind} className="size-3" />
          <span className="max-w-28 truncate">{getDisplayLabel(item, t)}</span>
          <button
            type="button"
            data-cell-action
            aria-label={t("removeRelation")}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            className="text-muted-foreground hover:text-foreground rounded-xs px-0.5 leading-none"
          >
            ×
          </button>
        </span>
      )}
    </div>
  );
}

function FormulaCellView({
  column,
  evaluated,
  onDoubleClick,
  t,
}: {
  column: TableColumnSchema;
  evaluated?: FormulaEvaluatedCell;
  onDoubleClick: () => void;
  t: (key: string) => string;
}) {
  const hasFormulaExpr = Boolean(column.formula?.trim());
  const titleText =
    evaluated?.kind === "error"
      ? `${evaluated.errorCode}: ${evaluated.errorMessage ?? ""}`
      : evaluated?.displayText || (hasFormulaExpr ? "" : t("formulaEditor.doubleClickHint"));

  return (
    <div
      data-formula-cell={column.id}
      onDoubleClick={(e) => {
        e.stopPropagation();
        onDoubleClick();
      }}
      title={titleText}
      className="flex h-full min-h-8 w-full cursor-default items-center px-2.5 py-1 text-xs select-none"
    >
      {evaluated?.kind === "error" ? (
        <span
          title={evaluated.errorMessage || evaluated.errorCode}
          className="bg-destructive/15 text-destructive inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 font-mono text-[11px] font-medium"
        >
          {evaluated.errorCode ?? "#ERROR!"}
        </span>
      ) : evaluated?.kind === "boolean" ? (
        <span
          className={cn(
            "inline-flex items-center rounded px-1.5 py-0.5 font-mono text-[11px] font-medium",
            evaluated.booleanValue
              ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
              : "bg-muted text-muted-foreground",
          )}
        >
          {evaluated.displayText}
        </span>
      ) : evaluated?.kind === "list" && evaluated.listItems && evaluated.listItems.length > 0 ? (
        <div className="flex max-w-full items-center gap-1 overflow-hidden">
          {evaluated.listItems.map((item, idx) => (
            <span
              key={`${idx}-${item}`}
              className="bg-muted/80 text-foreground inline-flex max-w-28 shrink-0 truncate rounded px-1.5 py-0.5 text-[11px]"
            >
              {item}
            </span>
          ))}
        </div>
      ) : evaluated && evaluated.kind !== "empty" ? (
        <span className={cn("truncate", (evaluated.kind === "number" || evaluated.kind === "date") && "tabular-nums")}>
          {evaluated.displayText}
        </span>
      ) : !hasFormulaExpr ? (
        <span className="text-muted-foreground/45 truncate text-[11px] italic">{t("formulaEditor.unsetFormula")}</span>
      ) : null}
    </div>
  );
}
