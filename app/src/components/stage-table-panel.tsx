import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  FormulaPillPreview,
  StageTableFormulaEditorDialog,
  type FormulaEditorColumnOption,
} from "@/components/stage-table-formula-editor";
import { ImageLightbox, type ImageLightboxItem } from "@/components/image-lightbox";
import { StageTableCalendarView } from "@/components/stage-table-calendar-view";
import { StageTableFilterToolbarPopover } from "@/components/stage-table-filter-popover";
import { StageTableGalleryView } from "@/components/stage-table-gallery-view";
import { StageTableGanttView } from "@/components/stage-table-gantt-view";
import { StageTableKanbanView } from "@/components/stage-table-kanban-view";
import { StageTableSpacedRepetitionView } from "@/components/stage-table-spaced-repetition-view";
import { StageTableRecordDialog, ViewTypeIcon } from "@/components/stage-table-views-shared";
import { hasVolatileFormulas } from "@/core/service/dataManageService/stageTableService/formulaEngine";
import type { Project } from "@/core/Project";
import type {
  StageTableImageItem,
  StageTableRelationItem,
  StageTableRow,
  StageTableRowKind,
} from "@/core/service/dataManageService/stageTableService/StageTableService";
import {
  ALL_SYSTEM_COLUMN_IDS,
  OPTIONAL_SYSTEM_COLUMN_IDS,
  TABLE_VIEW_TYPES,
  applyTableFiltersAndSort,
  collectColumnFilterBuckets,
  countActiveFilterConditions,
  isFilterConditionActive,
  isProtectedTableColumn,
  pickNextSelectOptionColor,
  type CustomColumnType,
  type SystemColumnId,
  type TableCellValue,
  type TableColumnFilter,
  type TableColumnGroup,
  type TableColumnSchema,
  type TableFilterGroup,
  type TableRowHeight,
  type TableSelectOption,
  type TableSortConfig,
  type TableSortDirection,
  type TableViewSchema,
  type TableViewType,
} from "@/types/table";
import { cn } from "@/utils/cn";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import {
  ArrowDown,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  ArrowUpLeft,
  Box,
  Boxes,
  Calendar as CalendarIcon,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleDot,
  Clock,
  CopyPlus,
  EyeOff,
  FileCode2,
  Film,
  Filter,
  FolderKanban,
  FolderPlus,
  FunctionSquare,
  Hash,
  History,
  Image as ImageIcon,
  Info,
  Link2,
  List,
  ListChecks,
  ListTree,
  Lock,
  MoreVertical,
  Pencil,
  Plus,
  PlusCircle,
  Search,
  Sigma,
  SquareDashed,
  SquarePen,
  Trash2,
  Type,
  UnfoldHorizontal,
  UnfoldVertical,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const INDEX_COLUMN_WIDTH = 44;
const ADD_COLUMN_WIDTH = 40;
const MIN_THUMB_SIZE = 32;

const DEFAULT_SYSTEM_COLUMN_WIDTHS: Record<SystemColumnId, number> = {
  name: 220,
  images: 170,
  createdAt: 164,
  updatedAt: 164,
  parents: 190,
  children: 190,
  outer: 170,
  inner: 190,
};

const DEFAULT_CUSTOM_COLUMN_WIDTHS: Record<CustomColumnType, number> = {
  text: 170,
  number: 130,
  date: 150,
  select: 165,
  multi_select: 195,
  formula: 160,
};

const OPTION_COLOR_CLASSES: Record<string, string> = {
  gray: "bg-zinc-500/25 text-zinc-900 dark:bg-zinc-400/30 dark:text-zinc-100",
  purple: "bg-purple-600/85 text-white dark:bg-purple-500/85 dark:text-white",
  blue: "bg-blue-600/85 text-white dark:bg-blue-500/85 dark:text-white",
  green: "bg-emerald-600/85 text-white dark:bg-emerald-500/85 dark:text-white",
  amber: "bg-amber-500/85 text-white dark:bg-amber-500/85 dark:text-white",
  rose: "bg-rose-600/85 text-white dark:bg-rose-500/85 dark:text-white",
  cyan: "bg-cyan-600/85 text-white dark:bg-cyan-500/85 dark:text-white",
  orange: "bg-orange-600/85 text-white dark:bg-orange-500/85 dark:text-white",
};

function getOptionBadgeClass(color?: string): string {
  return (color && OPTION_COLOR_CLASSES[color]) || OPTION_COLOR_CLASSES.gray;
}

function isSystemColumnId(colId: string): colId is SystemColumnId {
  return (ALL_SYSTEM_COLUMN_IDS as readonly string[]).includes(colId);
}

function formatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  const date = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function formatIsoDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function parseIsoDate(raw: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw.trim());
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

function RowKindIcon({ kind, className }: { kind: StageTableRowKind; className?: string }) {
  const cls = cn("size-3.5 shrink-0 text-muted-foreground", className);
  switch (kind) {
    case "section":
      return <SquareDashed className={cls} />;
    case "image":
      return <ImageIcon className={cls} />;
    case "url":
      return <Link2 className={cls} />;
    case "media":
      return <Film className={cls} />;
    case "latex":
      return <Sigma className={cls} />;
    case "reference":
      return <FolderKanban className={cls} />;
    case "svg":
      return <FileCode2 className={cls} />;
    case "extension":
      return <Box className={cls} />;
    case "text":
    default:
      return <Type className={cls} />;
  }
}

function SystemPropertyIcon({ columnId }: { columnId: SystemColumnId }) {
  const cls = "size-3.5 shrink-0 text-muted-foreground";
  switch (columnId) {
    case "images":
      return <ImageIcon className={cls} />;
    case "createdAt":
      return <Clock className={cls} />;
    case "updatedAt":
      return <History className={cls} />;
    case "parents":
      return <ArrowUpLeft className={cls} />;
    case "children":
      return <ArrowDownRight className={cls} />;
    case "outer":
      return <SquareDashed className={cls} />;
    case "inner":
      return <Boxes className={cls} />;
    case "name":
    default:
      return <Info className={cls} />;
  }
}

function CustomColumnIcon({ type, className }: { type: CustomColumnType; className?: string }) {
  const cls = cn("size-3.5 shrink-0 text-muted-foreground", className);
  switch (type) {
    case "number":
      return <Hash className={cls} />;
    case "date":
      return <CalendarIcon className={cls} />;
    case "select":
      return <CircleDot className={cls} />;
    case "multi_select":
      return <ListChecks className={cls} />;
    case "formula":
      return <FunctionSquare className={cls} />;
    case "text":
    default:
      return <Type className={cls} />;
  }
}

function ColumnIcon({ columnId, customColumn }: { columnId: string; customColumn?: TableColumnSchema }) {
  if (customColumn) {
    return <CustomColumnIcon type={customColumn.type} />;
  }
  if (isSystemColumnId(columnId)) {
    return <SystemPropertyIcon columnId={columnId} />;
  }
  return <Type className="text-muted-foreground size-3.5 shrink-0" />;
}

function getDisplayLabel(
  item: { primaryText?: string; label?: string; kind: StageTableRowKind; uuid: string },
  t: (key: string) => string,
): string {
  const raw = (item.primaryText ?? item.label ?? "").trim();
  if (raw.length > 0) {
    const firstLine = raw.split(/\r?\n/)[0];
    return firstLine.length > 36 ? `${firstLine.slice(0, 36)}…` : firstLine;
  }
  switch (item.kind) {
    case "image":
      return t("fallbackLabels.image");
    case "svg":
      return t("fallbackLabels.svg");
    case "media":
      return t("fallbackLabels.media");
    case "url":
      return t("fallbackLabels.url");
    case "latex":
      return t("fallbackLabels.latex");
    case "reference":
      return t("fallbackLabels.reference");
    case "section":
      return t("fallbackLabels.unnamedSection");
    case "text":
    default:
      return t("fallbackLabels.unnamedNode");
  }
}

function PrimaryTextCell({
  row,
  onCommit,
  onJump,
  canEditOnClick,
  t,
}: {
  row: StageTableRow;
  onCommit: (nextText: string) => void;
  onJump: () => void;
  canEditOnClick?: () => boolean;
  t: (key: string) => string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.primaryText);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(row.primaryText);
    }
  }, [row.primaryText, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const finishEdit = () => {
    setEditing(false);
    if (draft !== row.primaryText) {
      onCommit(draft);
    }
  };

  const displayLabel = getDisplayLabel(row, t);
  const isEmptyText = row.primaryText.trim().length === 0;

  return (
    <div className="group flex h-full min-h-8 w-full items-center justify-between gap-1.5 px-2.5 py-1">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <RowKindIcon kind={row.kind} />
        {editing ? (
          <Input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={finishEdit}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                finishEdit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(row.primaryText);
                setEditing(false);
              }
            }}
            className="h-6 min-w-0 flex-1 px-1.5 py-0 text-xs"
          />
        ) : (
          <button
            type="button"
            disabled={!row.editableText}
            onClick={() => {
              if (row.editableText && (!canEditOnClick || canEditOnClick())) {
                setDraft(row.primaryText);
                setEditing(true);
              }
            }}
            onDoubleClick={() => {
              if (row.editableText) {
                setDraft(row.primaryText);
                setEditing(true);
              }
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

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            data-cell-action
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
        </TooltipTrigger>
        <TooltipContent side="left">{t("jumpToNode")}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function AttachmentThumb({
  project,
  attachmentId,
  className,
  onClick,
}: {
  project: Project;
  attachmentId: string;
  className?: string;
  onClick?: () => void;
}) {
  const blob = project.attachments?.get?.(attachmentId);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!blob || typeof URL.createObjectURL !== "function") {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    setObjectUrl(url);
    return () => {
      URL.revokeObjectURL?.(url);
    };
  }, [blob]);

  if (!objectUrl) {
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
      src={objectUrl}
      alt=""
      onClick={onClick}
      className={cn("border-border/70 size-7 rounded border object-cover", onClick && "cursor-zoom-in", className)}
    />
  );
}

function ImagesCell({
  project,
  images,
  disabled,
  onAddImages,
  onRemoveImage,
  onPreviewImage,
  t,
}: {
  project: Project;
  images: StageTableImageItem[];
  disabled?: boolean;
  onAddImages: (blobs: Blob[]) => void;
  onRemoveImage: (imageNodeUuid: string) => void;
  onPreviewImage: (attachmentId: string) => void;
  t: (key: string) => string;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const selected = Array.from(e.target.files ?? []);
          if (selected.length > 0) {
            onAddImages(selected);
          }
          e.target.value = "";
        }}
      />

      {images.map((item) => (
        <div key={item.uuid} className="group/thumb relative inline-flex shrink-0">
          <AttachmentThumb
            project={project}
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
          fileInputRef.current?.click();
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

function TextCustomCell({
  value,
  onCommit,
  canEditOnClick,
}: {
  value: TableCellValue | undefined;
  onCommit: (val: TableCellValue) => void;
  canEditOnClick?: () => boolean;
}) {
  const strValue = typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(strValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(strValue);
    }
  }, [strValue, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== strValue) {
      onCommit(draft.length > 0 ? draft : null);
    }
  };

  if (editing) {
    return (
      <div className="flex h-full min-h-8 items-center px-1.5 py-0.5">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(strValue);
              setEditing(false);
            }
          }}
          className="h-6 min-w-0 flex-1 px-1.5 py-0 text-xs"
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!canEditOnClick || canEditOnClick()) {
          setDraft(strValue);
          setEditing(true);
        }
      }}
      onDoubleClick={() => {
        setDraft(strValue);
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          setDraft(strValue);
          setEditing(true);
        }
      }}
      className="hover:bg-accent/40 flex h-full min-h-8 w-full cursor-text items-center px-2.5 py-1 text-xs outline-none"
      title={strValue}
    >
      <span className="min-w-0 flex-1 truncate">{strValue}</span>
    </div>
  );
}

function NumberCustomCell({
  value,
  onCommit,
  canEditOnClick,
}: {
  value: TableCellValue | undefined;
  onCommit: (val: TableCellValue) => void;
  canEditOnClick?: () => boolean;
}) {
  const numStr = typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(numStr);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) {
      setDraft(numStr);
    }
  }, [numStr, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (!trimmed) {
      if (numStr !== "") onCommit(null);
      return;
    }
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed) && String(parsed) !== numStr) {
      onCommit(parsed);
    } else {
      setDraft(numStr);
    }
  };

  if (editing) {
    return (
      <div className="flex h-full min-h-8 items-center px-1.5 py-0.5">
        <Input
          ref={inputRef}
          type="number"
          step="any"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setDraft(numStr);
              setEditing(false);
            }
          }}
          className="h-6 min-w-0 flex-1 px-1.5 py-0 text-xs tabular-nums"
        />
      </div>
    );
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => {
        if (!canEditOnClick || canEditOnClick()) {
          setDraft(numStr);
          setEditing(true);
        }
      }}
      onDoubleClick={() => {
        setDraft(numStr);
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          setDraft(numStr);
          setEditing(true);
        }
      }}
      className="hover:bg-accent/40 flex h-full min-h-8 w-full cursor-text items-center px-2.5 py-1 text-xs tabular-nums outline-none"
    >
      <span className="min-w-0 flex-1 truncate">{numStr}</span>
    </div>
  );
}

function DateCustomCell({
  value,
  onCommit,
  t,
}: {
  value: TableCellValue | undefined;
  onCommit: (val: TableCellValue) => void;
  t: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const dateStr = typeof value === "string" ? value : "";
  const selectedDate = useMemo(() => parseIsoDate(dateStr), [dateStr]);
  const [displayMonth, setDisplayMonth] = useState<Date>(() => selectedDate ?? new Date());

  useEffect(() => {
    if (open) {
      setDisplayMonth(selectedDate ?? new Date());
    }
  }, [open, selectedDate]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen(true);
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
                onCommit(null);
              }}
              className="text-muted-foreground hover:text-foreground rounded-xs p-0.5"
            >
              <X className="size-3" />
            </button>
          )}
        </div>
      </PopoverTrigger>
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
                setOpen(false);
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
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

function SelectCustomCell({
  column,
  value,
  onCommit,
  onCreateOrGetOption,
  t,
}: {
  column: TableColumnSchema;
  value: TableCellValue | undefined;
  onCommit: (val: TableCellValue) => void;
  onCreateOrGetOption: (name: string) => TableSelectOption | null;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const isMulti = column.type === "multi_select";
  const [open, setOpen] = useState(false);
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
    if (typeof value === "string" && optionById.has(value)) {
      return [value];
    }
    if (Array.isArray(value) && value.length > 0 && optionById.has(value[0])) {
      return [value[0]];
    }
    return [];
  }, [isMulti, value, optionById]);

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const selectedOptions = useMemo(
    () => selectedIds.map((id) => optionById.get(id)).filter((o): o is TableSelectOption => Boolean(o)),
    [selectedIds, optionById],
  );

  const trimmedQuery = query.trim();
  const filteredOptions = useMemo(() => {
    if (!trimmedQuery) return options;
    const lower = trimmedQuery.toLowerCase();
    return options.filter((opt) => opt.name.toLowerCase().includes(lower));
  }, [options, trimmedQuery]);

  const hasExactOption = useMemo(() => options.some((opt) => opt.name === trimmedQuery), [options, trimmedQuery]);

  const toggleOption = (optionId: string) => {
    if (isMulti) {
      const next = new Set(selectedIds);
      if (next.has(optionId)) {
        next.delete(optionId);
      } else {
        next.add(optionId);
      }
      onCommit(Array.from(next));
    } else {
      if (selectedSet.has(optionId)) {
        onCommit(null);
      } else {
        onCommit(optionId);
        setOpen(false);
      }
    }
  };

  const handleCreateAndSelect = (rawName: string) => {
    const created = onCreateOrGetOption(rawName);
    if (!created) return;
    setQuery("");
    if (isMulti) {
      const next = Array.from(new Set([...selectedIds, created.id]));
      onCommit(next);
    } else {
      onCommit(created.id);
      setOpen(false);
    }
  };

  const previewColor = useMemo(() => pickNextSelectOptionColor(options), [options]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className={cn(
            "hover:bg-accent/40 relative flex h-full min-h-8 w-full cursor-pointer flex-wrap items-center gap-1 px-2 py-1 pr-6 text-xs outline-none",
            open && "ring-primary bg-accent/20 ring-1 ring-inset",
          )}
        >
          {selectedOptions.map((opt) => (
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
                    onCommit(selectedIds.filter((id) => id !== opt.id));
                  } else {
                    onCommit(null);
                  }
                }}
                className="opacity-75 transition-opacity hover:opacity-100"
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))}

          {open && (
            <ChevronUp className="text-muted-foreground pointer-events-none absolute top-1/2 right-2 size-3 -translate-y-1/2" />
          )}
        </div>
      </PopoverTrigger>
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
    </Popover>
  );
}

function MultiRelationCell({
  selectedItems,
  candidates,
  disabled,
  placeholder,
  searchPlaceholder,
  emptyText,
  onChange,
  t,
}: {
  selectedItems: StageTableRelationItem[];
  candidates: StageTableRow[];
  disabled?: boolean;
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  onChange: (nextUUIDs: string[]) => void;
  t: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const selectedIds = useMemo(() => new Set(selectedItems.map((item) => item.uuid)), [selectedItems]);

  const filteredCandidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => getDisplayLabel(c, t).toLowerCase().includes(q));
  }, [candidates, query, t]);

  if (disabled) {
    return <div className="text-muted-foreground/60 flex h-full items-center px-2.5 py-1 text-xs">-</div>;
  }

  const toggleCandidate = (uuid: string) => {
    const next = new Set(selectedIds);
    if (next.has(uuid)) {
      next.delete(uuid);
    } else {
      next.add(uuid);
    }
    onChange(Array.from(next));
  };

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className="hover:bg-accent/40 flex h-full min-h-8 w-full cursor-pointer flex-wrap items-center gap-1 px-2 py-1 text-xs outline-none"
        >
          {selectedItems.length === 0 ? (
            <span className="text-muted-foreground/50 text-xs">{placeholder}</span>
          ) : (
            selectedItems.map((item) => {
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
                      onChange(selectedItems.filter((s) => s.uuid !== item.uuid).map((s) => s.uuid));
                    }}
                    className="text-muted-foreground hover:text-foreground rounded-xs p-0.5"
                  >
                    <X className="size-2.5" />
                  </button>
                </span>
              );
            })
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-60 p-0"
        onWheel={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b p-2">
          <div className="relative flex items-center">
            <Search className="text-muted-foreground pointer-events-none absolute left-2 size-3.5" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={searchPlaceholder}
              className="h-7 pl-7 text-xs"
            />
          </div>
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {filteredCandidates.length === 0 ? (
            <div className="text-muted-foreground px-2 py-4 text-center text-xs">{emptyText}</div>
          ) : (
            filteredCandidates.map((candidate) => {
              const checked = selectedIds.has(candidate.uuid);
              const label = getDisplayLabel(candidate, t);
              return (
                <label
                  key={candidate.uuid}
                  className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-xs"
                >
                  <Checkbox checked={checked} onCheckedChange={() => toggleCandidate(candidate.uuid)} />
                  <RowKindIcon kind={candidate.kind} />
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </label>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SingleRelationCell({
  selectedItem,
  candidates,
  placeholder,
  searchPlaceholder,
  emptyText,
  onChange,
  t,
}: {
  selectedItem: StageTableRelationItem | null;
  candidates: StageTableRow[];
  placeholder: string;
  searchPlaceholder: string;
  emptyText: string;
  onChange: (nextUUID: string | null) => void;
  t: (key: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const filteredCandidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter((c) => getDisplayLabel(c, t).toLowerCase().includes(q));
  }, [candidates, query, t]);

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) setQuery("");
      }}
    >
      <PopoverTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen(true);
            }
          }}
          className="hover:bg-accent/40 flex h-full min-h-8 w-full cursor-pointer items-center gap-1 px-2 py-1 text-xs outline-none"
        >
          {!selectedItem ? (
            <span className="text-muted-foreground/50 text-xs">{placeholder}</span>
          ) : (
            <span className="bg-secondary text-secondary-foreground inline-flex max-w-full items-center gap-1 rounded px-1.5 py-0.5 text-[11px]">
              <RowKindIcon kind={selectedItem.kind} className="size-3" />
              <span className="max-w-28 truncate">{getDisplayLabel(selectedItem, t)}</span>
              <button
                type="button"
                data-cell-action
                aria-label={t("removeRelation")}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
                className="text-muted-foreground hover:text-foreground rounded-xs p-0.5"
              >
                <X className="size-2.5" />
              </button>
            </span>
          )}
        </div>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-60 p-0"
        onWheel={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b p-2">
          <div className="relative flex items-center">
            <Search className="text-muted-foreground pointer-events-none absolute left-2 size-3.5" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.stopPropagation()}
              placeholder={searchPlaceholder}
              className="h-7 pl-7 text-xs"
            />
          </div>
        </div>
        <div className="max-h-56 overflow-y-auto p-1">
          {selectedItem && (
            <button
              type="button"
              onClick={() => {
                onChange(null);
                setOpen(false);
              }}
              className="text-muted-foreground hover:bg-accent hover:text-foreground mb-1 flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs"
            >
              <X className="size-3.5" />
              <span>{t("clearOuter")}</span>
            </button>
          )}
          {filteredCandidates.length === 0 ? (
            <div className="text-muted-foreground px-2 py-4 text-center text-xs">{emptyText}</div>
          ) : (
            filteredCandidates.map((candidate) => {
              const checked = selectedItem?.uuid === candidate.uuid;
              const label = getDisplayLabel(candidate, t);
              return (
                <button
                  key={candidate.uuid}
                  type="button"
                  onClick={() => {
                    onChange(checked ? null : candidate.uuid);
                    setOpen(false);
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
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface ScrollMetrics {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
  vTrackHeight: number;
  hTrackWidth: number;
}

/**
 * 带右侧垂直滑块与底部水平滑块的滚动容器：
 * 支持鼠标拖拽滑块、点击轨道跳转、以及滚轮控制（含底部滑块悬停滚轮与 Shift+滚轮横向滚动）。
 */
function TableScrollContainer({
  children,
  layoutDepsKey,
  externalViewportRef,
}: {
  children: React.ReactNode;
  layoutDepsKey: string;
  externalViewportRef?: React.MutableRefObject<HTMLDivElement | null>;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const assignViewportRef = useCallback(
    (el: HTMLDivElement | null) => {
      viewportRef.current = el;
      if (externalViewportRef) {
        externalViewportRef.current = el;
      }
    },
    [externalViewportRef],
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const vTrackRef = useRef<HTMLDivElement>(null);
  const hTrackRef = useRef<HTMLDivElement>(null);

  const vDragRef = useRef<{
    pointerId: number;
    startY: number;
    startScrollTop: number;
    maxScrollTop: number;
    maxThumbTop: number;
  } | null>(null);

  const hDragRef = useRef<{
    pointerId: number;
    startX: number;
    startScrollLeft: number;
    maxScrollLeft: number;
    maxThumbLeft: number;
  } | null>(null);

  const [metrics, setMetrics] = useState<ScrollMetrics>({
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    clientHeight: 0,
    clientWidth: 0,
    vTrackHeight: 0,
    hTrackWidth: 0,
  });

  const syncMetrics = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const next: ScrollMetrics = {
      scrollTop: vp.scrollTop,
      scrollLeft: vp.scrollLeft,
      scrollHeight: vp.scrollHeight,
      scrollWidth: vp.scrollWidth,
      clientHeight: vp.clientHeight,
      clientWidth: vp.clientWidth,
      vTrackHeight: vTrackRef.current?.clientHeight ?? vp.clientHeight,
      hTrackWidth: hTrackRef.current?.clientWidth ?? vp.clientWidth,
    };
    setMetrics((prev) => {
      if (
        prev.scrollTop === next.scrollTop &&
        prev.scrollLeft === next.scrollLeft &&
        prev.scrollHeight === next.scrollHeight &&
        prev.scrollWidth === next.scrollWidth &&
        prev.clientHeight === next.clientHeight &&
        prev.clientWidth === next.clientWidth &&
        prev.vTrackHeight === next.vTrackHeight &&
        prev.hTrackWidth === next.hTrackWidth
      ) {
        return prev;
      }
      return next;
    });
  }, []);

  useLayoutEffect(() => {
    syncMetrics();
  }, [syncMetrics, layoutDepsKey]);

  useEffect(() => {
    const vp = viewportRef.current;
    const content = contentRef.current;
    const vTrack = vTrackRef.current;
    const hTrack = hTrackRef.current;
    if (!vp || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => syncMetrics());
    observer.observe(vp);
    if (content) observer.observe(content);
    if (vTrack) observer.observe(vTrack);
    if (hTrack) observer.observe(hTrack);
    return () => observer.disconnect();
  }, [syncMetrics]);

  const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  const hasVerticalOverflow = maxScrollTop > 1;
  const vInnerTrack = Math.max(0, metrics.vTrackHeight - 4);
  const vThumbHeight = hasVerticalOverflow
    ? Math.max(
        MIN_THUMB_SIZE,
        Math.min(vInnerTrack, Math.round((metrics.clientHeight / metrics.scrollHeight) * vInnerTrack)),
      )
    : vInnerTrack;
  const maxVThumbTop = Math.max(0, vInnerTrack - vThumbHeight);
  const vThumbTop =
    hasVerticalOverflow && maxVThumbTop > 0
      ? Math.min(maxVThumbTop, (metrics.scrollTop / maxScrollTop) * maxVThumbTop)
      : 0;

  const maxScrollLeft = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  const hasHorizontalOverflow = maxScrollLeft > 1;
  const hInnerTrack = Math.max(0, metrics.hTrackWidth - 4);
  const hThumbWidth = hasHorizontalOverflow
    ? Math.max(
        MIN_THUMB_SIZE,
        Math.min(hInnerTrack, Math.round((metrics.clientWidth / metrics.scrollWidth) * hInnerTrack)),
      )
    : hInnerTrack;
  const maxHThumbLeft = Math.max(0, hInnerTrack - hThumbWidth);
  const hThumbLeft =
    hasHorizontalOverflow && maxHThumbLeft > 0
      ? Math.min(maxHThumbLeft, (metrics.scrollLeft / maxScrollLeft) * maxHThumbLeft)
      : 0;

  const handleViewportWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const vp = viewportRef.current;
    if (!vp) return;
    if (e.shiftKey) {
      e.preventDefault();
      vp.scrollLeft += e.deltaY !== 0 ? e.deltaY : e.deltaX;
      syncMetrics();
      return;
    }
    if (!hasVerticalOverflow && hasHorizontalOverflow && e.deltaX === 0 && e.deltaY !== 0) {
      e.preventDefault();
      vp.scrollLeft += e.deltaY;
      syncMetrics();
    }
  };

  return (
    <div className="grid min-h-0 min-w-0 flex-1 grid-cols-[minmax(0,1fr)_14px] grid-rows-[minmax(0,1fr)_14px] overflow-hidden">
      {/* 主表格视口 */}
      <div
        ref={assignViewportRef}
        data-stage-table-viewport
        onScroll={syncMetrics}
        onWheel={handleViewportWheel}
        className="scrollbar-hide min-h-0 min-w-0 overflow-scroll"
      >
        <div ref={contentRef} className="inline-block min-w-full pr-6 pb-8">
          {children}
        </div>
      </div>

      {/* 右侧垂直滑块 */}
      <div
        ref={vTrackRef}
        data-stage-table-v-scrollbar
        onWheel={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const vp = viewportRef.current;
          if (!vp || !hasVerticalOverflow) return;
          vp.scrollTop += e.deltaY !== 0 ? e.deltaY : e.deltaX;
          syncMetrics();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !hasVerticalOverflow || e.target !== e.currentTarget) return;
          e.preventDefault();
          e.stopPropagation();
          const vp = viewportRef.current;
          const track = vTrackRef.current;
          if (!vp || !track || maxVThumbTop <= 0) return;
          const rect = track.getBoundingClientRect();
          const clickY = e.clientY - rect.top - 2;
          const ratio = Math.max(0, Math.min(1, (clickY - vThumbHeight / 2) / maxVThumbTop));
          vp.scrollTop = ratio * maxScrollTop;
          syncMetrics();
        }}
        className="border-border/60 bg-muted/25 relative h-full w-3.5 touch-none border-l select-none"
      >
        <div
          data-stage-table-v-thumb
          style={{
            top: `${2 + vThumbTop}px`,
            height: `${Math.max(0, vThumbHeight)}px`,
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !hasVerticalOverflow) return;
            e.preventDefault();
            e.stopPropagation();
            const vp = viewportRef.current;
            if (!vp) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            vDragRef.current = {
              pointerId: e.pointerId,
              startY: e.clientY,
              startScrollTop: vp.scrollTop,
              maxScrollTop,
              maxThumbTop: maxVThumbTop,
            };
          }}
          onPointerMove={(e) => {
            const drag = vDragRef.current;
            const vp = viewportRef.current;
            if (!drag || drag.pointerId !== e.pointerId || !vp || drag.maxThumbTop <= 0) return;
            const deltaY = e.clientY - drag.startY;
            vp.scrollTop = drag.startScrollTop + (deltaY / drag.maxThumbTop) * drag.maxScrollTop;
            syncMetrics();
          }}
          onPointerUp={(e) => {
            if (vDragRef.current?.pointerId === e.pointerId) {
              vDragRef.current = null;
            }
          }}
          onLostPointerCapture={(e) => {
            if (vDragRef.current?.pointerId === e.pointerId) {
              vDragRef.current = null;
            }
          }}
          className={cn(
            "absolute right-[2px] left-[2px] rounded-full transition-colors",
            hasVerticalOverflow
              ? "bg-muted-foreground/45 hover:bg-muted-foreground/70 active:bg-primary cursor-grab active:cursor-grabbing"
              : "bg-muted-foreground/15 cursor-default",
          )}
        />
      </div>

      {/* 底部水平滑块 */}
      <div
        ref={hTrackRef}
        data-stage-table-h-scrollbar
        onWheel={(e) => {
          e.preventDefault();
          e.stopPropagation();
          const vp = viewportRef.current;
          if (!vp || !hasHorizontalOverflow) return;
          const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
          vp.scrollLeft += delta;
          syncMetrics();
        }}
        onPointerDown={(e) => {
          if (e.button !== 0 || !hasHorizontalOverflow || e.target !== e.currentTarget) return;
          e.preventDefault();
          e.stopPropagation();
          const vp = viewportRef.current;
          const track = hTrackRef.current;
          if (!vp || !track || maxHThumbLeft <= 0) return;
          const rect = track.getBoundingClientRect();
          const clickX = e.clientX - rect.left - 2;
          const ratio = Math.max(0, Math.min(1, (clickX - hThumbWidth / 2) / maxHThumbLeft));
          vp.scrollLeft = ratio * maxScrollLeft;
          syncMetrics();
        }}
        className="border-border/60 bg-muted/25 relative h-3.5 w-full touch-none border-t select-none"
      >
        <div
          data-stage-table-h-thumb
          style={{
            left: `${2 + hThumbLeft}px`,
            width: `${Math.max(0, hThumbWidth)}px`,
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !hasHorizontalOverflow) return;
            e.preventDefault();
            e.stopPropagation();
            const vp = viewportRef.current;
            if (!vp) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            hDragRef.current = {
              pointerId: e.pointerId,
              startX: e.clientX,
              startScrollLeft: vp.scrollLeft,
              maxScrollLeft,
              maxThumbLeft: maxHThumbLeft,
            };
          }}
          onPointerMove={(e) => {
            const drag = hDragRef.current;
            const vp = viewportRef.current;
            if (!drag || drag.pointerId !== e.pointerId || !vp || drag.maxThumbLeft <= 0) return;
            const deltaX = e.clientX - drag.startX;
            vp.scrollLeft = drag.startScrollLeft + (deltaX / drag.maxThumbLeft) * drag.maxScrollLeft;
            syncMetrics();
          }}
          onPointerUp={(e) => {
            if (hDragRef.current?.pointerId === e.pointerId) {
              hDragRef.current = null;
            }
          }}
          onLostPointerCapture={(e) => {
            if (hDragRef.current?.pointerId === e.pointerId) {
              hDragRef.current = null;
            }
          }}
          className={cn(
            "absolute top-[2px] bottom-[2px] rounded-full transition-colors",
            hasHorizontalOverflow
              ? "bg-muted-foreground/45 hover:bg-muted-foreground/70 active:bg-primary cursor-grab active:cursor-grabbing"
              : "bg-muted-foreground/15 cursor-default",
          )}
        />
      </div>

      {/* 右下角滑块交汇角 */}
      <div className="border-border/60 bg-muted/35 border-t border-l" />
    </div>
  );
}

const FIELD_TYPE_GRID_ORDER: readonly CustomColumnType[] = [
  "text",
  "select",
  "multi_select",
  "number",
  "date",
  "formula",
];

function FreezeColumnIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("size-3.5 shrink-0", className)}
    >
      <rect x="2" y="2" width="12" height="12" rx="2" />
      <line x1="7.5" y1="2" x2="7.5" y2="14" />
      <line x1="2" y1="8" x2="14" y2="8" />
      <line x1="2.6" y1="6.8" x2="6.8" y2="2.6" />
      <line x1="2.6" y1="12.8" x2="6.8" y2="8.6" />
    </svg>
  );
}

/**
 * 图 2 & 图 4 双列字段类型选择面板（支持全部 6 类自定义字段，含公式）
 */
function FieldTypeGridPicker({
  selectedType,
  onSelectType,
  showTabNextHint = false,
  t,
}: {
  selectedType: CustomColumnType;
  onSelectType: (type: CustomColumnType) => void;
  showTabNextHint?: boolean;
  t: (key: string) => string;
}) {
  return (
    <div className="w-60 select-none">
      <div className="text-muted-foreground px-2.5 pt-2 pb-1 text-[11px] font-medium">{t("fieldTypePicker.title")}</div>
      <div className="grid grid-cols-2 gap-1 px-1.5 pb-1.5">
        {FIELD_TYPE_GRID_ORDER.map((type) => {
          const active = selectedType === type;
          return (
            <button
              key={type}
              type="button"
              data-field-type-option={type}
              onClick={() => onSelectType(type)}
              className={cn(
                "hover:bg-accent flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                active && "bg-accent text-accent-foreground font-medium",
              )}
            >
              <CustomColumnIcon type={type} className={cn(active && "text-foreground")} />
              <span className="truncate">{t(`columnTypes.${type}`)}</span>
            </button>
          );
        })}
      </div>
      <div className="border-border/60 text-muted-foreground flex items-center gap-3 border-t px-2.5 py-1.5 text-[11px]">
        <span>↑↓ {t("fieldTypePicker.navHint")}</span>
        <span>↵ {t("fieldTypePicker.confirmHint")}</span>
        {showTabNextHint && <span>Tab {t("fieldTypePicker.tabAddNext")}</span>}
      </div>
    </div>
  );
}

interface SuperHeaderSegment {
  key: string;
  group: TableColumnGroup | null;
  colIds: string[];
  isFrozen: boolean;
  stickyLeftPx?: number;
  isFreezeBoundary: boolean;
}

type TableSelectionMode = "none" | "all" | "rows" | "columns" | "cells";

interface TableSelectionState {
  mode: TableSelectionMode;
  rowIds: Set<string>;
  colIds: Set<string>;
  cells: Set<string>;
  anchorRowId: string | null;
  anchorColId: string | null;
  activeCell: { rowId: string; colId: string } | null;
}

const EMPTY_SELECTION: TableSelectionState = {
  mode: "none",
  rowIds: new Set<string>(),
  colIds: new Set<string>(),
  cells: new Set<string>(),
  anchorRowId: null,
  anchorColId: null,
  activeCell: null,
};

function makeCellKey(rowId: string, colId: string): string {
  return `${rowId}\0${colId}`;
}

function ColumnFilterSortPopoverContent({
  columnId,
  customCol,
  allRows,
  activeSort,
  activeFilter,
  onSetSort,
  onSetFilter,
  t,
}: {
  columnId: string;
  customCol?: TableColumnSchema;
  allRows: StageTableRow[];
  activeSort: TableSortConfig | null;
  activeFilter: TableColumnFilter | null;
  onSetSort: (sort: TableSortConfig | null) => void;
  onSetFilter: (filter: { values: string[]; includeEmpty: boolean } | null) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [search, setSearch] = useState("");
  const { buckets, emptyCount } = useMemo(
    () => collectColumnFilterBuckets(allRows, columnId, customCol),
    [allRows, columnId, customCol],
  );

  const isSortAsc = activeSort?.columnId === columnId && activeSort.direction === "asc";
  const isSortDesc = activeSort?.columnId === columnId && activeSort.direction === "desc";
  const isSortedHere = isSortAsc || isSortDesc;

  const allKeys = useMemo(() => buckets.map((b) => b.key), [buckets]);
  const selectedKeySet = useMemo(() => {
    if (!activeFilter) return new Set(allKeys);
    return new Set(activeFilter.values);
  }, [activeFilter, allKeys]);
  const includeEmpty = activeFilter ? activeFilter.includeEmpty : true;

  const formatBucketLabel = useCallback(
    (key: string, label: string) => {
      if (columnId === "images") {
        return t("imagesCell.countLabel", { count: Number(key) });
      }
      return label;
    },
    [columnId, t],
  );

  const emptyLabel = columnId === "images" ? t("imagesCell.emptyLabel") : t("sortFilter.emptyValue");

  const trimmedSearch = search.trim().toLowerCase();
  const visibleBuckets = useMemo(() => {
    if (!trimmedSearch) return buckets;
    return buckets.filter((b) => formatBucketLabel(b.key, b.label).toLowerCase().includes(trimmedSearch));
  }, [buckets, trimmedSearch, formatBucketLabel]);
  const showEmptyRow = emptyCount > 0 && (!trimmedSearch || emptyLabel.toLowerCase().includes(trimmedSearch));

  const commitFilter = (nextKeys: Set<string>, nextIncludeEmpty: boolean) => {
    const allNonEmptyChecked = allKeys.every((k) => nextKeys.has(k));
    const emptySatisfied = emptyCount === 0 || nextIncludeEmpty;
    if (allNonEmptyChecked && emptySatisfied) {
      onSetFilter(null);
    } else {
      onSetFilter({
        values: allKeys.filter((k) => nextKeys.has(k)),
        includeEmpty: emptyCount > 0 ? nextIncludeEmpty : false,
      });
    }
  };

  const toggleBucket = (key: string) => {
    const next = new Set(selectedKeySet);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    commitFilter(next, includeEmpty);
  };

  const toggleEmpty = () => {
    commitFilter(new Set(selectedKeySet), !includeEmpty);
  };

  const allVisibleChecked = visibleBuckets.every((b) => selectedKeySet.has(b.key)) && (!showEmptyRow || includeEmpty);
  const someVisibleChecked = visibleBuckets.some((b) => selectedKeySet.has(b.key)) || (showEmptyRow && includeEmpty);

  const toggleSelectAllVisible = () => {
    const next = new Set(selectedKeySet);
    let nextEmpty = includeEmpty;
    if (allVisibleChecked) {
      for (const b of visibleBuckets) next.delete(b.key);
      if (showEmptyRow) nextEmpty = false;
    } else {
      for (const b of visibleBuckets) next.add(b.key);
      if (showEmptyRow) nextEmpty = true;
    }
    commitFilter(next, nextEmpty);
  };

  const isOptionType = customCol?.type === "select" || customCol?.type === "multi_select";

  return (
    <div data-col-filter-popover={columnId} className="w-60 p-2 text-xs select-none">
      {/* 排序区：升序 / 降序 */}
      <div className="mb-2 space-y-1">
        <div className="flex items-center justify-between px-0.5">
          <span className="text-muted-foreground text-[11px] font-medium">{t("sortFilter.sortTitle")}</span>
          {isSortedHere && (
            <button
              type="button"
              data-col-clear-sort
              onClick={() => onSetSort(null)}
              className="text-muted-foreground hover:text-foreground cursor-pointer text-[11px] transition-colors"
            >
              {t("sortFilter.clearSort")}
            </button>
          )}
        </div>
        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            data-col-sort-asc
            onClick={() => onSetSort(isSortAsc ? null : { columnId, direction: "asc" })}
            className={cn(
              "flex h-7 cursor-pointer items-center justify-center gap-1 rounded-md border text-xs transition-colors",
              isSortAsc
                ? "border-primary bg-primary/15 text-primary font-medium"
                : "border-border/70 hover:bg-accent text-foreground",
            )}
          >
            <ArrowUp className="size-3.5" />
            <span>{t("sortFilter.sortAsc")}</span>
          </button>
          <button
            type="button"
            data-col-sort-desc
            onClick={() => onSetSort(isSortDesc ? null : { columnId, direction: "desc" })}
            className={cn(
              "flex h-7 cursor-pointer items-center justify-center gap-1 rounded-md border text-xs transition-colors",
              isSortDesc
                ? "border-primary bg-primary/15 text-primary font-medium"
                : "border-border/70 hover:bg-accent text-foreground",
            )}
          >
            <ArrowDown className="size-3.5" />
            <span>{t("sortFilter.sortDesc")}</span>
          </button>
        </div>
      </div>

      {/* 筛选区：值复选列表（类 Windows 文件资源管理器列筛选） */}
      <div className="border-border/60 border-t pt-2">
        <div className="mb-1.5 flex items-center justify-between px-0.5">
          <span className="text-muted-foreground text-[11px] font-medium">{t("sortFilter.filterTitle")}</span>
          {activeFilter && (
            <button
              type="button"
              data-col-clear-filter
              onClick={() => onSetFilter(null)}
              className="text-primary cursor-pointer text-[11px] hover:underline"
            >
              {t("sortFilter.clearFilter")}
            </button>
          )}
        </div>

        <div className="relative mb-1.5 flex items-center">
          <Search className="text-muted-foreground pointer-events-none absolute left-2 size-3.5" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder={t("sortFilter.searchPlaceholder")}
            className="h-7 pl-7 text-xs"
          />
        </div>

        <label className="hover:bg-accent mb-1 flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs font-medium">
          <Checkbox
            checked={allVisibleChecked ? true : someVisibleChecked ? "indeterminate" : false}
            onCheckedChange={toggleSelectAllVisible}
          />
          <span className="truncate">{t("sortFilter.selectAll")}</span>
        </label>

        <div className="max-h-48 space-y-0.5 overflow-y-auto pr-0.5">
          {visibleBuckets.map((bucket) => {
            const checked = selectedKeySet.has(bucket.key);
            const displayLabel = formatBucketLabel(bucket.key, bucket.label);
            return (
              <label
                key={bucket.key}
                data-col-filter-option={bucket.key}
                className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs"
              >
                <Checkbox checked={checked} onCheckedChange={() => toggleBucket(bucket.key)} />
                {isOptionType ? (
                  <span
                    className={cn(
                      "inline-flex max-w-[140px] items-center rounded px-1.5 py-0.5 text-[11px] font-medium",
                      getOptionBadgeClass(bucket.color),
                    )}
                  >
                    <span className="truncate">{displayLabel}</span>
                  </span>
                ) : (
                  <span className="min-w-0 flex-1 truncate" title={displayLabel}>
                    {displayLabel}
                  </span>
                )}
                <span className="text-muted-foreground ml-auto shrink-0 text-[11px] tabular-nums">{bucket.count}</span>
              </label>
            );
          })}

          {showEmptyRow && (
            <label
              data-col-filter-empty
              className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-xs"
            >
              <Checkbox checked={includeEmpty} onCheckedChange={toggleEmpty} />
              <span className="text-muted-foreground min-w-0 flex-1 truncate italic">{emptyLabel}</span>
              <span className="text-muted-foreground ml-auto shrink-0 text-[11px] tabular-nums">{emptyCount}</span>
            </label>
          )}

          {visibleBuckets.length === 0 && !showEmptyRow && (
            <div className="text-muted-foreground py-3 text-center text-xs">{t("noMatchingNodes")}</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function StageTablePanel({ project }: { project: Project }) {
  const { t } = useTranslation("stageTable");
  const [, setRevision] = useState(0);
  const [propertySearch, setPropertySearch] = useState("");
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // 多维表格选中状态（全选 / 行 / 多行 / 列 / 多列 / 单格 / 多格）
  const [selection, setSelection] = useState<TableSelectionState>(EMPTY_SELECTION);
  const selectionRef = useRef<TableSelectionState>(EMPTY_SELECTION);
  selectionRef.current = selection;
  const wasSoleActiveOnDownRef = useRef(false);
  const suppressCellClickRef = useRef(false);
  const lastCanvasSelectedRef = useRef<string[]>([]);

  // 列筛选/排序弹窗状态（Windows 文件管理器风格列头下拉）
  const [filterPopoverColId, setFilterPopoverColId] = useState<string | null>(null);

  // 图 1 + 图 2：右键表头「修改字段」或属性面板「>」触发的字段修改面板状态
  const [editingFieldState, setEditingFieldState] = useState<{
    colId: string;
    anchor: "header" | "floating";
  } | null>(null);
  const [editFieldName, setEditFieldName] = useState("");
  const [editFieldType, setEditFieldType] = useState<CustomColumnType>("text");
  const [editTypeDropdownOpen, setEditTypeDropdownOpen] = useState(false);
  const editNameInputRef = useRef<HTMLInputElement>(null);

  // 公式列编辑器弹窗状态
  const [formulaEditorState, setFormulaEditorState] = useState<{
    colId: string;
    previewRowUuid?: string | null;
  } | null>(null);

  // 图 3 + 图 4：插入字段 / 右侧 + 创建新列后的表头内联标题 + 双列类型面板状态
  const [creatingColState, setCreatingColState] = useState<{
    colId: string;
    draftTitle: string;
    selectedType: CustomColumnType;
  } | null>(null);
  const creatingColStateRef = useRef(creatingColState);
  creatingColStateRef.current = creatingColState;
  const creatingTitleInputRef = useRef<HTMLInputElement>(null);

  // 图 6：顶部分组表头重命名状态
  const [renamingGroupId, setRenamingGroupId] = useState<string | null>(null);
  const [renamingGroupDraft, setRenamingGroupDraft] = useState("");
  const groupRenameInputRef = useRef<HTMLInputElement>(null);

  // 图片放大预览灯箱状态（支持底部缩略图跳转、左右箭头切换与节点/全表作用域）
  const [previewLightboxState, setPreviewLightboxState] = useState<{
    items: ImageLightboxItem[];
    initialIndex: number;
    allItems?: ImageLightboxItem[];
    allInitialIndex?: number;
  } | null>(null);

  // 多视图切换、新建菜单、重命名、指针拖拽排序与记录详情弹窗状态
  const viewBarRef = useRef<HTMLDivElement>(null);
  const suppressViewClickRef = useRef(false);
  const [addViewPopoverOpen, setAddViewPopoverOpen] = useState(false);
  const [viewMenuOpenId, setViewMenuOpenId] = useState<string | null>(null);
  const [renamingViewId, setRenamingViewId] = useState<string | null>(null);
  const [renamingViewDraft, setRenamingViewDraft] = useState("");
  const viewRenameInputRef = useRef<HTMLInputElement>(null);
  const [draggingViewId, setDraggingViewId] = useState<string | null>(null);
  const [dropViewHint, setDropViewHint] = useState<{ targetViewId: string; position: "before" | "after" } | null>(null);
  const [recordDialogRowUuid, setRecordDialogRowUuid] = useState<string | null>(null);

  // 表头拖拽重排状态（首列「名称」固定不可移动）
  const headerRowRef = useRef<HTMLTableRowElement>(null);
  const [draggingColId, setDraggingColId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ targetColId: string; position: "before" | "after" } | null>(null);

  const forceRefresh = useCallback(() => {
    setRevision((v) => v + 1);
  }, []);

  const scrollRowIntoViewIfNeeded = useCallback((rowUuid: string) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const rowEl = Array.from(vp.querySelectorAll<HTMLElement>("tr[data-stage-table-row-id]")).find(
      (el) => el.dataset.stageTableRowId === rowUuid,
    );
    if (!rowEl) return;
    const theadHeight = vp.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    const vpRect = vp.getBoundingClientRect();
    const rowRect = rowEl.getBoundingClientRect();
    const visibleTop = vpRect.top + theadHeight;
    const visibleBottom = vpRect.bottom;
    if (rowRect.top < visibleTop) {
      vp.scrollTop -= visibleTop - rowRect.top + 4;
    } else if (rowRect.bottom > visibleBottom) {
      vp.scrollTop += rowRect.bottom - visibleBottom + 4;
    }
  }, []);

  useEffect(() => {
    if (!project.getService?.("stageTable")) return;
    forceRefresh();
    const unsubTable = project.stageTable.subscribe(forceRefresh);
    const onCommit = () => forceRefresh();
    const onStateChange = () => forceRefresh();
    project.on("stage-commit", onCommit);
    project.on("state-change", onStateChange);

    // 画布选中变化 -> 同步高亮多维表格对应行（单选与多选均适用）
    const applyCanvasSelection = (selectedUUIDs: string[], shouldScroll: boolean) => {
      const prevSet = new Set(lastCanvasSelectedRef.current);
      lastCanvasSelectedRef.current = selectedUUIDs;
      if (selectedUUIDs.length === 0) {
        setSelection((prev) => (prev.mode === "rows" || prev.mode === "all" ? EMPTY_SELECTION : prev));
        return;
      }
      const nextRowSet = new Set(selectedUUIDs);
      setSelection({
        mode: "rows",
        rowIds: nextRowSet,
        colIds: new Set<string>(),
        cells: new Set<string>(),
        anchorRowId: selectedUUIDs[0],
        anchorColId: null,
        activeCell: null,
      });
      if (shouldScroll) {
        const newlySelected = selectedUUIDs.find((id) => !prevSet.has(id)) ?? selectedUUIDs[0];
        requestAnimationFrame(() => scrollRowIntoViewIfNeeded(newlySelected));
      }
    };

    const initialSelected = project.stageTable.getSelectedRowUUIDs?.() ?? [];
    if (initialSelected.length > 0) {
      applyCanvasSelection(initialSelected, true);
    } else {
      lastCanvasSelectedRef.current = [];
      setSelection(EMPTY_SELECTION);
    }

    const unsubSelection = project.stageTable.subscribeSelection?.((uuids) => applyCanvasSelection(uuids, true));

    return () => {
      unsubTable();
      unsubSelection?.();
      project.off("stage-commit", onCommit);
      project.off("state-change", onStateChange);
    };
  }, [project, forceRefresh, scrollRowIntoViewIfNeeded]);

  useEffect(() => {
    if (editingFieldState) {
      const id = requestAnimationFrame(() => {
        editNameInputRef.current?.focus();
        editNameInputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [editingFieldState]);

  useEffect(() => {
    if (creatingColState?.colId) {
      const id = requestAnimationFrame(() => {
        creatingTitleInputRef.current?.focus();
        creatingTitleInputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [creatingColState?.colId]);

  useEffect(() => {
    if (renamingGroupId) {
      const id = requestAnimationFrame(() => {
        groupRenameInputRef.current?.focus();
        groupRenameInputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [renamingGroupId]);

  useEffect(() => {
    if (renamingViewId) {
      const id = requestAnimationFrame(() => {
        viewRenameInputRef.current?.focus();
        viewRenameInputRef.current?.select();
      });
      return () => cancelAnimationFrame(id);
    }
  }, [renamingViewId]);

  const hasVolatileFormulaCols = project.getService?.("stageTable")
    ? hasVolatileFormulas(project.stageTable.getColumns?.() ?? [])
    : false;

  useEffect(() => {
    if (!hasVolatileFormulaCols) return;
    const timer = window.setInterval(() => {
      forceRefresh();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [hasVolatileFormulaCols, forceRefresh]);

  if (!project.getService?.("stageTable")) {
    return null;
  }

  const activeView = project.stageTable.getActiveView();
  const views: TableViewSchema[] = project.stageTable.getViews?.() ?? project.table?.views ?? [activeView];
  const activeViewType: TableViewType = activeView.type ?? "table";
  const tableRowHeight: TableRowHeight = activeView.rowHeight ?? "medium";
  const customColumns = project.stageTable.getColumns?.() ?? [];
  const customColumnMap = new Map<string, TableColumnSchema>(customColumns.map((col) => [col.id, col]));

  const visibleColumnIds: string[] = project.stageTable.getVisibleColumnIds?.() ?? [
    "name",
    ...activeView.visibleColumnIds.filter((colId) => colId !== "name"),
  ];
  const visibleColumnSet = new Set(visibleColumnIds);

  const allRows = project.stageTable.getRows();
  const activeSort: TableSortConfig | null = project.stageTable.getSort?.() ?? activeView.sort ?? null;
  const activeFilters: TableColumnFilter[] = project.stageTable.getFilters?.() ?? activeView.filters ?? [];
  const activeFilterGroup: TableFilterGroup = project.stageTable.getFilterGroup?.() ??
    activeView.filterGroup ?? { conjunction: "and", conditions: [] };
  const activeFilterByColId = new Map<string, TableColumnFilter>(activeFilters.map((f) => [f.columnId, f]));
  const activeFilterGroupColIds = new Set<string>(
    activeFilterGroup.conditions
      .filter((cond) => isFilterConditionActive(cond, customColumnMap.get(cond.columnId)))
      .map((cond) => cond.columnId),
  );
  const activeFilterConditionCount = countActiveFilterConditions(activeFilterGroup, customColumns);
  const hasAnyActiveFilter = activeFilters.length > 0 || activeFilterConditionCount > 0;
  const rows = applyTableFiltersAndSort(allRows, customColumns, activeFilters, activeSort, activeFilterGroup);

  const displayedRowIndexById = new Map<string, number>(rows.map((r, idx) => [r.uuid, idx]));
  const visibleColIndexById = new Map<string, number>(visibleColumnIds.map((c, idx) => [c, idx]));

  const extractRowIdsFromCells = (cells: Iterable<string>): string[] => {
    const ids = new Set<string>();
    for (const key of cells) {
      const sep = key.indexOf("\0");
      if (sep > 0) ids.add(key.slice(0, sep));
    }
    return Array.from(ids);
  };

  const syncSelectedRowsToCanvas = (rowIds: Iterable<string>, focusCamera?: boolean) => {
    const ids = Array.from(rowIds);
    lastCanvasSelectedRef.current = ids;
    if (focusCamera === undefined) {
      project.stageTable.selectRowsOnCanvas?.(ids);
    } else {
      project.stageTable.selectRowsOnCanvas?.(ids, { focusCamera });
    }
  };

  const clearSelection = (clearCanvas = false) => {
    setSelection(EMPTY_SELECTION);
    if (clearCanvas) {
      syncSelectedRowsToCanvas([], false);
    }
  };

  const handleToggleSelectAll = () => {
    if (selection.mode === "all") {
      clearSelection(true);
      return;
    }
    const allIds = rows.map((r) => r.uuid);
    setSelection({
      mode: "all",
      rowIds: new Set(allIds),
      colIds: new Set(visibleColumnIds),
      cells: new Set<string>(),
      anchorRowId: allIds[0] ?? null,
      anchorColId: visibleColumnIds[0] ?? null,
      activeCell: null,
    });
    syncSelectedRowsToCanvas(allIds);
  };

  const selectRowsRange = (startRowId: string, endRowId: string, commitToCanvas: boolean) => {
    const startIdx = displayedRowIndexById.get(startRowId);
    const endIdx = displayedRowIndexById.get(endRowId);
    if (startIdx === undefined || endIdx === undefined) return;
    const lo = Math.min(startIdx, endIdx);
    const hi = Math.max(startIdx, endIdx);
    const nextRowIds = new Set<string>();
    for (let i = lo; i <= hi; i++) {
      nextRowIds.add(rows[i].uuid);
    }
    setSelection({
      mode: "rows",
      rowIds: nextRowIds,
      colIds: new Set<string>(),
      cells: new Set<string>(),
      anchorRowId: startRowId,
      anchorColId: null,
      activeCell: null,
    });
    if (commitToCanvas) {
      syncSelectedRowsToCanvas(nextRowIds);
    }
  };

  const handleRowIndexPointerDown = (rowId: string, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    panelRef.current?.focus({ preventScroll: true });

    const isToggle = event.ctrlKey || event.metaKey;
    const isRange = event.shiftKey;
    const prev = selectionRef.current;

    if (isRange) {
      const anchor = prev.anchorRowId && displayedRowIndexById.has(prev.anchorRowId) ? prev.anchorRowId : rowId;
      selectRowsRange(anchor, rowId, true);
      return;
    }

    if (isToggle) {
      const base =
        prev.mode === "all"
          ? new Set(rows.map((r) => r.uuid))
          : prev.mode === "rows"
            ? new Set(prev.rowIds)
            : new Set<string>();
      if (base.has(rowId)) {
        base.delete(rowId);
      } else {
        base.add(rowId);
      }
      if (base.size === 0) {
        clearSelection(true);
      } else {
        setSelection({
          mode: "rows",
          rowIds: base,
          colIds: new Set<string>(),
          cells: new Set<string>(),
          anchorRowId: rowId,
          anchorColId: null,
          activeCell: null,
        });
        syncSelectedRowsToCanvas(base);
      }
      return;
    }

    // 单击行号立即选中并联动画布；按住向下/向上拖动可连续框选多行
    const initialSet = new Set([rowId]);
    setSelection({
      mode: "rows",
      rowIds: initialSet,
      colIds: new Set<string>(),
      cells: new Set<string>(),
      anchorRowId: rowId,
      anchorColId: null,
      activeCell: null,
    });
    syncSelectedRowsToCanvas(initialSet);

    let lastHoveredId = rowId;
    let draggedMulti = false;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const tr = el?.closest<HTMLElement>("tr[data-stage-table-row-id]");
      const hoveredRowId = tr?.dataset.stageTableRowId;
      if (!hoveredRowId || hoveredRowId === lastHoveredId) return;
      lastHoveredId = hoveredRowId;
      draggedMulti = true;
      selectRowsRange(rowId, hoveredRowId, false);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (draggedMulti) {
        syncSelectedRowsToCanvas(selectionRef.current.rowIds);
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const selectColumnByInteraction = (
    colId: string,
    modifiers: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  ) => {
    panelRef.current?.focus({ preventScroll: true });
    const prev = selectionRef.current;
    const isToggle = modifiers.ctrlKey || modifiers.metaKey;
    const isRange = modifiers.shiftKey;

    if (isRange) {
      const anchor = prev.anchorColId && visibleColIndexById.has(prev.anchorColId) ? prev.anchorColId : colId;
      const startIdx = visibleColIndexById.get(anchor);
      const endIdx = visibleColIndexById.get(colId);
      if (startIdx === undefined || endIdx === undefined) return;
      const lo = Math.min(startIdx, endIdx);
      const hi = Math.max(startIdx, endIdx);
      const nextCols = new Set<string>();
      for (let i = lo; i <= hi; i++) {
        nextCols.add(visibleColumnIds[i]);
      }
      setSelection({
        mode: "columns",
        rowIds: new Set<string>(),
        colIds: nextCols,
        cells: new Set<string>(),
        anchorRowId: null,
        anchorColId: anchor,
        activeCell: null,
      });
      return;
    }

    if (isToggle) {
      const base =
        prev.mode === "all"
          ? new Set(visibleColumnIds)
          : prev.mode === "columns"
            ? new Set(prev.colIds)
            : new Set<string>();
      if (base.has(colId)) {
        base.delete(colId);
      } else {
        base.add(colId);
      }
      if (base.size === 0) {
        setSelection(EMPTY_SELECTION);
      } else {
        setSelection({
          mode: "columns",
          rowIds: new Set<string>(),
          colIds: base,
          cells: new Set<string>(),
          anchorRowId: null,
          anchorColId: colId,
          activeCell: null,
        });
      }
      return;
    }

    setSelection({
      mode: "columns",
      rowIds: new Set<string>(),
      colIds: new Set([colId]),
      cells: new Set<string>(),
      anchorRowId: null,
      anchorColId: colId,
      activeCell: null,
    });
  };

  const buildCellRectSet = (r1: string, c1: string, r2: string, c2: string): Set<string> => {
    const ri1 = displayedRowIndexById.get(r1);
    const ri2 = displayedRowIndexById.get(r2);
    const ci1 = visibleColIndexById.get(c1);
    const ci2 = visibleColIndexById.get(c2);
    if (ri1 === undefined || ri2 === undefined || ci1 === undefined || ci2 === undefined) {
      return new Set([makeCellKey(r2, c2)]);
    }
    const rLo = Math.min(ri1, ri2);
    const rHi = Math.max(ri1, ri2);
    const cLo = Math.min(ci1, ci2);
    const cHi = Math.max(ci1, ci2);
    const result = new Set<string>();
    for (let r = rLo; r <= rHi; r++) {
      for (let c = cLo; c <= cHi; c++) {
        result.add(makeCellKey(rows[r].uuid, visibleColumnIds[c]));
      }
    }
    return result;
  };

  const handleCellPointerDown = (rowId: string, colId: string, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const targetEl = event.target as HTMLElement | null;
    if (
      targetEl?.closest(
        "[data-slot='popover-content'], [role='dialog'], [role='menu'], input, textarea, [data-cell-action]",
      )
    ) {
      return;
    }

    const prev = selectionRef.current;
    const key = makeCellKey(rowId, colId);
    const isToggle = event.ctrlKey || event.metaKey;
    const isRange = event.shiftKey;

    if (isRange) {
      event.preventDefault();
      wasSoleActiveOnDownRef.current = false;
      const anchorRow = prev.anchorRowId && displayedRowIndexById.has(prev.anchorRowId) ? prev.anchorRowId : rowId;
      const anchorCol = prev.anchorColId && visibleColIndexById.has(prev.anchorColId) ? prev.anchorColId : colId;
      const nextCells = buildCellRectSet(anchorRow, anchorCol, rowId, colId);
      setSelection({
        mode: "cells",
        rowIds: new Set<string>(),
        colIds: new Set<string>(),
        cells: nextCells,
        anchorRowId: anchorRow,
        anchorColId: anchorCol,
        activeCell: { rowId, colId },
      });
      syncSelectedRowsToCanvas(extractRowIdsFromCells(nextCells));
      return;
    }

    if (isToggle) {
      event.preventDefault();
      wasSoleActiveOnDownRef.current = false;
      const base = prev.mode === "cells" ? new Set(prev.cells) : new Set<string>();
      if (base.has(key)) {
        base.delete(key);
      } else {
        base.add(key);
      }
      if (base.size === 0) {
        clearSelection(true);
      } else {
        setSelection({
          mode: "cells",
          rowIds: new Set<string>(),
          colIds: new Set<string>(),
          cells: base,
          anchorRowId: rowId,
          anchorColId: colId,
          activeCell: { rowId, colId },
        });
        syncSelectedRowsToCanvas(extractRowIdsFromCells(base));
      }
      return;
    }

    const wasSoleActive =
      prev.mode === "cells" &&
      prev.cells.size === 1 &&
      prev.activeCell?.rowId === rowId &&
      prev.activeCell?.colId === colId;
    wasSoleActiveOnDownRef.current = wasSoleActive;

    setSelection({
      mode: "cells",
      rowIds: new Set<string>(),
      colIds: new Set<string>(),
      cells: new Set([key]),
      anchorRowId: rowId,
      anchorColId: colId,
      activeCell: { rowId, colId },
    });
    syncSelectedRowsToCanvas([rowId]);

    let didDragCells = false;
    let lastHoverKey = key;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const el = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY);
      const td = el?.closest<HTMLElement>("td[data-stage-table-cell]");
      const hoverRowId = td?.dataset.rowId;
      const hoverColId = td?.dataset.colId;
      if (!hoverRowId || !hoverColId) return;
      const hoverKey = makeCellKey(hoverRowId, hoverColId);
      if (hoverKey === lastHoverKey) return;
      lastHoverKey = hoverKey;
      didDragCells = true;
      wasSoleActiveOnDownRef.current = false;
      setSelection({
        mode: "cells",
        rowIds: new Set<string>(),
        colIds: new Set<string>(),
        cells: buildCellRectSet(rowId, colId, hoverRowId, hoverColId),
        anchorRowId: rowId,
        anchorColId: colId,
        activeCell: { rowId: hoverRowId, colId: hoverColId },
      });
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (didDragCells) {
        syncSelectedRowsToCanvas(extractRowIdsFromCells(selectionRef.current.cells));
        suppressCellClickRef.current = true;
        queueMicrotask(() => {
          suppressCellClickRef.current = false;
        });
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const getCellCopyText = (row: StageTableRow, colId: string): string => {
    switch (colId) {
      case "name":
        return row.primaryText;
      case "images":
        return row.images.length > 0 ? t("imagesCell.countLabel", { count: row.images.length }) : "";
      case "createdAt":
        return formatTimestamp(row.createdAt);
      case "updatedAt":
        return formatTimestamp(row.updatedAt);
      case "parents":
        return row.parents.map((i) => getDisplayLabel(i, t)).join(", ");
      case "children":
        return row.children.map((i) => getDisplayLabel(i, t)).join(", ");
      case "outer":
        return row.outer ? getDisplayLabel(row.outer, t) : "";
      case "inner":
        return row.inner.map((i) => getDisplayLabel(i, t)).join(", ");
      default: {
        const customCol = customColumnMap.get(colId);
        const val = row.tableFields?.[colId];
        if (!customCol || val === undefined || val === null) return "";
        if (customCol.type === "select" || customCol.type === "multi_select") {
          const optMap = new Map((customCol.options ?? []).map((o) => [o.id, o.name]));
          const ids = Array.isArray(val) ? val : [String(val)];
          return ids
            .map((id) => optMap.get(id))
            .filter(Boolean)
            .join(", ");
        }
        return Array.isArray(val) ? val.join(", ") : String(val);
      }
    }
  };

  const handlePanelKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest("input, textarea, [contenteditable='true']")) return;

    if (e.key === "Escape" && selection.mode !== "none") {
      e.preventDefault();
      e.stopPropagation();
      clearSelection(selection.mode === "rows" || selection.mode === "all" || selection.mode === "cells");
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      e.preventDefault();
      e.stopPropagation();
      const allIds = rows.map((r) => r.uuid);
      setSelection({
        mode: "all",
        rowIds: new Set(allIds),
        colIds: new Set(visibleColumnIds),
        cells: new Set<string>(),
        anchorRowId: allIds[0] ?? null,
        anchorColId: visibleColumnIds[0] ?? null,
        activeCell: null,
      });
      syncSelectedRowsToCanvas(allIds);
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "c" && selection.mode !== "none") {
      const nativeSelected = window.getSelection()?.toString();
      if (nativeSelected) return;
      const selectedRowsList =
        selection.mode === "all" || selection.mode === "columns"
          ? rows
          : selection.mode === "rows"
            ? rows.filter((r) => selection.rowIds.has(r.uuid))
            : rows.filter((r) => visibleColumnIds.some((c) => selection.cells.has(makeCellKey(r.uuid, c))));
      const selectedColsList =
        selection.mode === "all" || selection.mode === "rows"
          ? visibleColumnIds
          : selection.mode === "columns"
            ? visibleColumnIds.filter((c) => selection.colIds.has(c))
            : visibleColumnIds.filter((c) => selectedRowsList.some((r) => selection.cells.has(makeCellKey(r.uuid, c))));
      if (selectedRowsList.length > 0 && selectedColsList.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        const tsv = selectedRowsList
          .map((row) =>
            selectedColsList
              .map((colId) =>
                selection.mode === "cells" && !selection.cells.has(makeCellKey(row.uuid, colId))
                  ? ""
                  : getCellCopyText(row, colId).replace(/\t|\r?\n/g, " "),
              )
              .join("\t"),
          )
          .join("\n");
        void navigator.clipboard?.writeText(tsv);
      }
      return;
    }

    if (
      selection.mode === "cells" &&
      selection.activeCell &&
      (e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight")
    ) {
      const curRowIdx = displayedRowIndexById.get(selection.activeCell.rowId);
      const curColIdx = visibleColIndexById.get(selection.activeCell.colId);
      if (curRowIdx === undefined || curColIdx === undefined) return;
      e.preventDefault();
      e.stopPropagation();
      const nextRowIdx =
        e.key === "ArrowUp"
          ? Math.max(0, curRowIdx - 1)
          : e.key === "ArrowDown"
            ? Math.min(rows.length - 1, curRowIdx + 1)
            : curRowIdx;
      const nextColIdx =
        e.key === "ArrowLeft"
          ? Math.max(0, curColIdx - 1)
          : e.key === "ArrowRight"
            ? Math.min(visibleColumnIds.length - 1, curColIdx + 1)
            : curColIdx;
      const nextRowId = rows[nextRowIdx]?.uuid;
      const nextColId = visibleColumnIds[nextColIdx];
      if (!nextRowId || !nextColId) return;
      if (e.shiftKey) {
        const anchorRow = selection.anchorRowId ?? selection.activeCell.rowId;
        const anchorCol = selection.anchorColId ?? selection.activeCell.colId;
        const nextCells = buildCellRectSet(anchorRow, anchorCol, nextRowId, nextColId);
        setSelection({
          mode: "cells",
          rowIds: new Set<string>(),
          colIds: new Set<string>(),
          cells: nextCells,
          anchorRowId: anchorRow,
          anchorColId: anchorCol,
          activeCell: { rowId: nextRowId, colId: nextColId },
        });
        syncSelectedRowsToCanvas(extractRowIdsFromCells(nextCells));
      } else {
        setSelection({
          mode: "cells",
          rowIds: new Set<string>(),
          colIds: new Set<string>(),
          cells: new Set([makeCellKey(nextRowId, nextColId)]),
          anchorRowId: nextRowId,
          anchorColId: nextColId,
          activeCell: { rowId: nextRowId, colId: nextColId },
        });
        syncSelectedRowsToCanvas([nextRowId]);
      }
      scrollRowIntoViewIfNeeded(nextRowId);
    }
  };

  const getColumnLabel = (colId: string): string => {
    const customCol = customColumnMap.get(colId);
    if (customCol) {
      return customCol.name;
    }
    if (isSystemColumnId(colId)) {
      const override = project.stageTable.getSystemColumnCustomName?.(colId);
      return override || t(`columns.${colId}`);
    }
    return colId;
  };

  const getColumnTypeName = (colId: string): string => {
    const customCol = customColumnMap.get(colId);
    if (customCol) {
      return t(`columnTypes.${customCol.type}`);
    }
    if (isSystemColumnId(colId)) {
      return t(`columns.${colId}`);
    }
    return "";
  };

  const getColumnWidth = (colId: string): number => {
    const saved = activeView.columnWidths?.[colId];
    if (typeof saved === "number" && Number.isFinite(saved)) {
      return saved;
    }
    const customCol = customColumnMap.get(colId);
    if (customCol) {
      return customCol.width ?? DEFAULT_CUSTOM_COLUMN_WIDTHS[customCol.type];
    }
    if (isSystemColumnId(colId)) {
      return DEFAULT_SYSTEM_COLUMN_WIDTHS[colId];
    }
    return 160;
  };

  const buildUniqueDefaultColumnName = (type: CustomColumnType, excludeColId?: string): string => {
    const base = t(`columnTypes.${type}`);
    const existingNames = new Set(
      (project.stageTable.getColumns?.() ?? []).filter((c) => c.id !== excludeColId).map((c) => c.name),
    );
    if (!existingNames.has(base)) return base;
    let suffix = 2;
    while (existingNames.has(`${base} ${suffix}`)) {
      suffix++;
    }
    return `${base} ${suffix}`;
  };

  const startColumnResize = (columnId: string, currentWidth: number, event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const startX = event.clientX;

    const onPointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.max(80, Math.min(600, currentWidth + (moveEvent.clientX - startX)));
      project.stageTable.setColumnWidth(columnId, nextWidth);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const startColumnDragReorder = (colId: string, event: React.PointerEvent) => {
    if (event.button !== 0 || creatingColState?.colId === colId) return;
    const targetEl = event.target as HTMLElement | null;
    if (targetEl?.closest("[data-col-resizer], [data-col-filter-trigger], [data-col-sort-indicator], input, button")) {
      return;
    }

    const modifiers = { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey };
    if (colId === "name" || modifiers.shiftKey || modifiers.ctrlKey || modifiers.metaKey) {
      selectColumnByInteraction(colId, modifiers);
      return;
    }

    const startX = event.clientX;
    let isDragging = false;
    let latestHint: { targetColId: string; position: "before" | "after" } | null = null;

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!isDragging) {
        if (Math.abs(moveEvent.clientX - startX) < 5) return;
        isDragging = true;
        setDraggingColId(colId);
      }

      const rowEl = headerRowRef.current;
      if (!rowEl) return;
      const thNodes = Array.from(rowEl.querySelectorAll<HTMLElement>("[data-table-col-id]"));
      let matched: { targetColId: string; position: "before" | "after" } | null = null;

      for (const th of thNodes) {
        const thColId = th.dataset.tableColId;
        if (!thColId || thColId === colId) continue;
        const rect = th.getBoundingClientRect();
        if (moveEvent.clientX >= rect.left && moveEvent.clientX <= rect.right) {
          if (thColId === "name") {
            matched = { targetColId: "name", position: "after" };
          } else {
            const mid = rect.left + rect.width / 2;
            matched = { targetColId: thColId, position: moveEvent.clientX < mid ? "before" : "after" };
          }
          break;
        }
      }

      if (!matched && thNodes.length > 0) {
        const firstNonSelf = thNodes.find((n) => n.dataset.tableColId && n.dataset.tableColId !== colId);
        const lastNonSelf = [...thNodes].reverse().find((n) => n.dataset.tableColId && n.dataset.tableColId !== colId);
        if (firstNonSelf && moveEvent.clientX < firstNonSelf.getBoundingClientRect().left) {
          const id = firstNonSelf.dataset.tableColId!;
          matched = { targetColId: id, position: id === "name" ? "after" : "before" };
        } else if (lastNonSelf && moveEvent.clientX > lastNonSelf.getBoundingClientRect().right) {
          matched = { targetColId: lastNonSelf.dataset.tableColId!, position: "after" };
        }
      }

      latestHint = matched;
      setDropHint(matched);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (isDragging && latestHint) {
        project.stageTable.reorderColumn?.(colId, latestHint.targetColId, latestHint.position);
      } else if (!isDragging) {
        selectColumnByInteraction(colId, modifiers);
      }
      setDraggingColId(null);
      setDropHint(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  // 打开图 1「修改字段」面板（从表头右键打开时锚定在对应表头下方；从属性面板打开隐藏列时居中悬浮）
  const openEditFieldPanel = (colId: string, preferredAnchor: "header" | "floating" = "header") => {
    const customCol = customColumnMap.get(colId);
    const effectiveAnchor = preferredAnchor === "header" && visibleColumnSet.has(colId) ? "header" : "floating";
    setCreatingColState(null);
    setEditFieldName(getColumnLabel(colId));
    setEditFieldType(customCol ? customCol.type : "text");
    setEditTypeDropdownOpen(false);
    setEditingFieldState({ colId, anchor: effectiveAnchor });
  };

  const openFormulaEditorForColumn = (colId: string, previewRowUuid?: string | null) => {
    setCreatingColState(null);
    setEditTypeDropdownOpen(false);
    setEditingFieldState(null);
    setFormulaEditorState({ colId, previewRowUuid: previewRowUuid ?? null });
  };

  const handleSaveEditField = () => {
    if (!editingFieldState) return;
    const { colId } = editingFieldState;
    const existingCol = customColumnMap.get(colId);
    const isCustom = Boolean(existingCol);
    const switchedToNewFormula = isCustom && existingCol?.type !== "formula" && editFieldType === "formula";
    project.stageTable.updateColumn?.(colId, {
      name: editFieldName,
      ...(isCustom ? { type: editFieldType } : {}),
    });
    setEditTypeDropdownOpen(false);
    setEditingFieldState(null);
    if (switchedToNewFormula) {
      setFormulaEditorState({ colId, previewRowUuid: null });
    }
  };

  // 提交图 4「插入字段 / 新建字段」内联编辑状态
  const commitCreatingColumn = (explicitType?: CustomColumnType, options?: { openFormulaEditor?: boolean }) => {
    const current = creatingColStateRef.current;
    if (!current) return null;
    const chosenType = explicitType ?? current.selectedType;
    const finalName = current.draftTitle.trim() || buildUniqueDefaultColumnName(chosenType, current.colId);
    project.stageTable.updateColumn?.(current.colId, {
      name: finalName,
      type: chosenType,
    });
    const finishedColId = current.colId;
    setCreatingColState(null);
    if (chosenType === "formula" && (options?.openFormulaEditor ?? true)) {
      setFormulaEditorState({ colId: finishedColId, previewRowUuid: null });
    }
    return finishedColId;
  };

  // 在目标列左侧/右侧（或表格最右侧 +）插入新自定义列并进入图 4 内联编辑态
  const triggerInsertNewColumn = (targetColumnId?: string, side?: "left" | "right") => {
    if (creatingColStateRef.current) {
      commitCreatingColumn();
    }
    setEditingFieldState(null);
    const defaultName = buildUniqueDefaultColumnName("text");
    const created =
      project.stageTable.insertCustomColumn?.({
        name: defaultName,
        type: "text",
        targetColumnId,
        side,
      }) ??
      project.stageTable.addCustomColumn?.({
        name: defaultName,
        type: "text",
      });
    if (!created) return;
    setCreatingColState({
      colId: created.id,
      draftTitle: "",
      selectedType: "text",
    });
  };

  const scheduleAfterContextMenu = (fn: () => void) => {
    setTimeout(fn, 0);
  };

  const handleCreateTitleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (!creatingColState) return;
    const currentIdx = FIELD_TYPE_GRID_ORDER.indexOf(creatingColState.selectedType);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const nextIdx = Math.min(FIELD_TYPE_GRID_ORDER.length - 1, currentIdx + 2);
      setCreatingColState({ ...creatingColState, selectedType: FIELD_TYPE_GRID_ORDER[nextIdx] });
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const nextIdx = Math.max(0, currentIdx - 2);
      setCreatingColState({ ...creatingColState, selectedType: FIELD_TYPE_GRID_ORDER[nextIdx] });
    } else if (e.key === "ArrowRight" && e.currentTarget.selectionStart === e.currentTarget.value.length) {
      const nextIdx = Math.min(FIELD_TYPE_GRID_ORDER.length - 1, currentIdx + 1);
      if (nextIdx !== currentIdx) {
        e.preventDefault();
        setCreatingColState({ ...creatingColState, selectedType: FIELD_TYPE_GRID_ORDER[nextIdx] });
      }
    } else if (e.key === "ArrowLeft" && e.currentTarget.selectionStart === 0) {
      const nextIdx = Math.max(0, currentIdx - 1);
      if (nextIdx !== currentIdx) {
        e.preventDefault();
        setCreatingColState({ ...creatingColState, selectedType: FIELD_TYPE_GRID_ORDER[nextIdx] });
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      commitCreatingColumn();
    } else if (e.key === "Tab") {
      e.preventDefault();
      const prevId = commitCreatingColumn(undefined, { openFormulaEditor: false });
      if (prevId) {
        triggerInsertNewColumn(prevId, "right");
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      commitCreatingColumn(undefined, { openFormulaEditor: false });
    }
  };

  const allPropertyIds: string[] = ["name", ...OPTIONAL_SYSTEM_COLUMN_IDS, ...customColumns.map((col) => col.id)];
  const originalTableView = views.find((v) => !v.deletable) ?? views[0] ?? activeView;
  const validPropertyIdSet = new Set<string>(allPropertyIds);
  const filterableColumnIds: string[] = Array.from(
    new Set([
      "name",
      ...(originalTableView.visibleColumnIds ?? []).filter(
        (colId) => colId !== "name" && validPropertyIdSet.has(colId),
      ),
    ]),
  );
  const filterColumnGroups: TableColumnGroup[] = originalTableView.columnGroups ?? [];

  const filteredPropertyIds = allPropertyIds.filter((colId) => {
    const q = propertySearch.trim().toLowerCase();
    if (!q) return true;
    return getColumnLabel(colId).toLowerCase().includes(q);
  });

  const getOuterCandidatesForRow = (row: StageTableRow): StageTableRow[] => {
    return allRows.filter((candidate) => {
      if (candidate.uuid === row.uuid) return false;
      if (candidate.kind !== "section" && candidate.kind !== "text") return false;
      if (row.kind === "section" && project.sectionMethods.isEntityInSection(candidate.entity, row.entity as any)) {
        return false;
      }
      return true;
    });
  };

  const getInnerCandidatesForRow = (row: StageTableRow): StageTableRow[] => {
    return allRows.filter((candidate) => {
      if (candidate.uuid === row.uuid) return false;
      if (
        candidate.kind === "section" &&
        project.sectionMethods.isEntityInSection(row.entity, candidate.entity as any)
      ) {
        return false;
      }
      return true;
    });
  };

  // 冻结列计算（冻结从左侧行号列起至 frozenColumnId 为止的全部列）
  const frozenColumnId: string | null =
    project.stageTable.getFrozenColumnId?.() ??
    (activeView.frozenColumnId && visibleColumnSet.has(activeView.frozenColumnId) ? activeView.frozenColumnId : null);
  const frozenEndIndex = frozenColumnId ? visibleColumnIds.indexOf(frozenColumnId) : -1;

  const columnLeftOffsets: number[] = [];
  let runningLeft = INDEX_COLUMN_WIDTH;
  for (const colId of visibleColumnIds) {
    columnLeftOffsets.push(runningLeft);
    runningLeft += getColumnWidth(colId);
  }

  // 图 6：跨列分组表头（columnGroups）连续区间计算
  const columnGroups: TableColumnGroup[] = project.stageTable.getColumnGroups?.() ?? activeView.columnGroups ?? [];
  const groupByColId = new Map<string, TableColumnGroup>();
  for (const grp of columnGroups) {
    for (const cid of grp.columnIds) {
      if (visibleColumnSet.has(cid) && !groupByColId.has(cid)) {
        groupByColId.set(cid, grp);
      }
    }
  }
  const hasVisibleColumnGroups = groupByColId.size > 0;

  const superHeaderSegments: SuperHeaderSegment[] = [];
  if (hasVisibleColumnGroups) {
    visibleColumnIds.forEach((colId, idx) => {
      const grp = groupByColId.get(colId) ?? null;
      const isFrozen = idx <= frozenEndIndex;
      const prev = superHeaderSegments[superHeaderSegments.length - 1];
      if (prev && prev.group?.id === grp?.id && prev.isFrozen === isFrozen) {
        prev.colIds.push(colId);
        prev.isFreezeBoundary = idx === frozenEndIndex;
      } else {
        superHeaderSegments.push({
          key: `${grp?.id ?? "ungrouped"}:${idx}`,
          group: grp,
          colIds: [colId],
          isFrozen,
          stickyLeftPx: isFrozen ? columnLeftOffsets[idx] : undefined,
          isFreezeBoundary: idx === frozenEndIndex,
        });
      }
    });
  }

  const totalTableWidth = runningLeft + ADD_COLUMN_WIDTH;

  const layoutDepsKey = `${project.uri?.toString?.() ?? ""}:${rows.length}:${activeSort ? `${activeSort.columnId}:${activeSort.direction}` : ""}:${activeFilters.length}:${activeFilterConditionCount}:${frozenColumnId ?? ""}:${hasVisibleColumnGroups ? 1 : 0}:${visibleColumnIds.map((c) => `${c}=${getColumnWidth(c)}`).join(",")}`;

  const selectionSummaryText =
    selection.mode === "all"
      ? t("selection.allSelected", { count: rows.length })
      : selection.mode === "rows" && selection.rowIds.size > 0
        ? t("selection.rowsCount", { count: selection.rowIds.size })
        : selection.mode === "columns" && selection.colIds.size > 0
          ? t("selection.colsCount", { count: selection.colIds.size })
          : selection.mode === "cells" && selection.cells.size > 0
            ? t("selection.cellsCount", { count: selection.cells.size })
            : null;

  const systemColumnLabels: Partial<Record<SystemColumnId, string>> = {
    name: t("columns.name"),
    images: t("columns.images"),
    createdAt: t("columns.createdAt"),
    updatedAt: t("columns.updatedAt"),
    parents: t("columns.parents"),
    children: t("columns.children"),
    outer: t("columns.outer"),
    inner: t("columns.inner"),
  };

  const formulaEditorColumnOptions: FormulaEditorColumnOption[] = [
    ...ALL_SYSTEM_COLUMN_IDS.map((sysId) => ({
      id: sysId,
      name: getColumnLabel(sysId),
      kind: "system" as const,
      columnType: sysId,
    })),
    ...customColumns.map((col) => ({
      id: col.id,
      name: col.name,
      kind: "custom" as const,
      columnType: col.type,
      isSelf: col.id === formulaEditorState?.colId,
    })),
  ];

  const formulaEditorColOptionMap = new Map(formulaEditorColumnOptions.map((item) => [item.id, item]));

  const renderEditFieldFormContent = (colId: string) => {
    const customCol = customColumnMap.get(colId);
    const isCustom = Boolean(customCol);
    const isProtectedCol = isProtectedTableColumn(customCol);
    const isTypeLockedCol = Boolean(customCol?.protectedRole);
    return (
      <div data-stage-table-edit-field-panel className="w-64 p-3 text-xs select-none">
        {/* 第一行：字段名称输入框（自动聚焦全选，蓝框高亮，对应图 1） */}
        <Input
          ref={editNameInputRef}
          value={editFieldName}
          onChange={(e) => setEditFieldName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") {
              e.preventDefault();
              handleSaveEditField();
            } else if (e.key === "Escape") {
              e.preventDefault();
              setEditingFieldState(null);
            }
          }}
          className="border-primary/80 focus-visible:ring-primary/50 h-8 text-xs"
        />

        {/* 第二行：字段类型下拉选择（点击展开图 2 双列面板；系统属性与间隔重复核心列锁定类型） */}
        <div className="mt-2.5">
          {isCustom && !isTypeLockedCol ? (
            <Popover open={editTypeDropdownOpen} onOpenChange={setEditTypeDropdownOpen}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-edit-field-type-trigger
                  className="border-border bg-background/60 hover:bg-accent/50 flex h-8 w-full cursor-pointer items-center justify-between rounded-md border px-2.5 text-xs transition-colors"
                >
                  <span className="flex items-center gap-2 truncate">
                    <CustomColumnIcon type={editFieldType} />
                    <span className="truncate">{t(`columnTypes.${editFieldType}`)}</span>
                  </span>
                  <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                sideOffset={4}
                className="w-auto p-0"
                onWheel={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <FieldTypeGridPicker
                  selectedType={editFieldType}
                  onSelectType={(nextType) => {
                    setEditFieldType(nextType);
                    setEditTypeDropdownOpen(false);
                  }}
                  t={t}
                />
              </PopoverContent>
            </Popover>
          ) : (
            <div className="border-border/70 bg-muted/40 text-muted-foreground flex h-8 w-full items-center justify-between rounded-md border px-2.5 text-xs">
              <span className="flex items-center gap-2 truncate">
                <ColumnIcon columnId={colId} customColumn={customCol} />
                <span className="truncate">{getColumnTypeName(colId)}</span>
              </span>
              {isTypeLockedCol ? (
                <Lock className="size-3.5 shrink-0 opacity-60" />
              ) : (
                <ChevronDown className="size-3.5 shrink-0 opacity-40" />
              )}
            </div>
          )}
          {isProtectedCol && (
            <div className="text-muted-foreground mt-1.5 text-[11px] leading-snug">
              {isTypeLockedCol
                ? t("fieldDialog.spacedRepetitionLocked")
                : t("fieldDialog.spacedRepetitionCustomLocked")}
            </div>
          )}
        </div>

        {/* 公式表达式预览与编辑入口 */}
        {isCustom && editFieldType === "formula" && (
          <div className="mt-2.5 space-y-1.5">
            <button
              type="button"
              data-open-formula-editor
              onClick={() => {
                project.stageTable.updateColumn?.(colId, {
                  name: editFieldName,
                  type: "formula",
                });
                openFormulaEditorForColumn(colId);
              }}
              className="border-border bg-muted/35 hover:bg-accent/50 flex min-h-9 w-full cursor-pointer flex-col items-start justify-center rounded-md border px-2.5 py-1.5 text-left transition-colors"
            >
              {customCol?.formula?.trim() ? (
                <FormulaPillPreview
                  formula={customCol.formula}
                  colMap={formulaEditorColOptionMap}
                  tableLabel={t("formulaEditor.currentTable")}
                  deletedLabel={t("formulaEditor.deletedColumn")}
                  className="max-h-14 overflow-hidden"
                />
              ) : (
                <span className="text-muted-foreground text-[11px]">{t("formulaEditor.clickToSetFormula")}</span>
              )}
            </button>
          </div>
        )}

        {/* 从公式转为静态列时的固化提示 */}
        {isCustom && customCol?.type === "formula" && editFieldType !== "formula" && (
          <div className="text-muted-foreground bg-muted/40 mt-2 rounded-md px-2 py-1.5 text-[11px] leading-snug">
            {t("formulaEditor.solidifyHint")}
          </div>
        )}

        {/* 底部操作区：确定 / 取消（对应图 1） */}
        <div className="border-border/60 mt-3 flex items-center justify-end gap-2 border-t pt-2.5">
          <Button type="button" size="sm" onClick={handleSaveEditField} className="h-7 px-3 text-xs">
            {t("fieldDialog.confirm")}
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              setEditTypeDropdownOpen(false);
              setEditingFieldState(null);
            }}
            className="h-7 px-3 text-xs"
          >
            {t("fieldDialog.cancel")}
          </Button>
        </div>
      </div>
    );
  };

  const selectedRowIdsForViews = new Set<string>(
    selection.mode === "all"
      ? rows.map((r) => r.uuid)
      : selection.mode === "rows"
        ? selection.rowIds
        : selection.mode === "cells"
          ? extractRowIdsFromCells(selection.cells)
          : [],
  );

  const handleViewSelectRows = (uuids: string[], focusCamera?: boolean) => {
    if (uuids.length === 0) {
      clearSelection(true);
      return;
    }
    setSelection({
      mode: "rows",
      rowIds: new Set(uuids),
      colIds: new Set<string>(),
      cells: new Set<string>(),
      anchorRowId: uuids[0],
      anchorColId: null,
      activeCell: null,
    });
    syncSelectedRowsToCanvas(uuids, focusCamera);
  };

  const commitRenameView = (viewId: string) => {
    const trimmed = renamingViewDraft.trim();
    if (trimmed) {
      project.stageTable.renameView?.(viewId, trimmed);
    }
    setRenamingViewId(null);
  };

  const handleCreateView = (type: TableViewType) => {
    project.stageTable.createView?.({
      type,
      name: t(`views.defaultName_${type}`),
    });
    setAddViewPopoverOpen(false);
    setSelection(EMPTY_SELECTION);
  };

  const handleTableAddRow = () => {
    const created = project.stageTable.createRow?.({ text: "" });
    if (created) {
      handleViewSelectRows([created.uuid], false);
      requestAnimationFrame(() => scrollRowIntoViewIfNeeded(created.uuid));
    }
  };

  const tableRowHeightClass = tableRowHeight === "compact" ? "h-8" : tableRowHeight === "tall" ? "h-14" : "h-10";

  const openImagePreview = (attachmentId: string, sourceRowUuid?: string) => {
    const allTableImages: ImageLightboxItem[] = [];
    for (const r of rows) {
      const label = getDisplayLabel(r, t);
      for (const img of r.images ?? []) {
        allTableImages.push({
          attachmentId: img.attachmentId,
          label,
          rowUuid: r.uuid,
          imageNodeUuid: img.uuid,
        });
      }
    }

    const findIdx = (list: ImageLightboxItem[]) => {
      const exact = sourceRowUuid
        ? list.findIndex((item) => item.attachmentId === attachmentId && item.rowUuid === sourceRowUuid)
        : -1;
      if (exact >= 0) return exact;
      const byAtt = list.findIndex((item) => item.attachmentId === attachmentId);
      return byAtt >= 0 ? byAtt : 0;
    };

    const sourceRow = sourceRowUuid ? rows.find((r) => r.uuid === sourceRowUuid) : undefined;
    const rowImages: ImageLightboxItem[] = sourceRow
      ? (sourceRow.images ?? []).map((img) => ({
          attachmentId: img.attachmentId,
          label: getDisplayLabel(sourceRow, t),
          rowUuid: sourceRow.uuid,
          imageNodeUuid: img.uuid,
        }))
      : [];

    if (rowImages.length > 1) {
      setPreviewLightboxState({
        items: rowImages,
        initialIndex: findIdx(rowImages),
        allItems: allTableImages.length > rowImages.length ? allTableImages : undefined,
        allInitialIndex: allTableImages.length > rowImages.length ? findIdx(allTableImages) : undefined,
      });
      return;
    }

    if (allTableImages.length > 0) {
      setPreviewLightboxState({
        items: allTableImages,
        initialIndex: findIdx(allTableImages),
      });
      return;
    }

    setPreviewLightboxState({
      items: [{ attachmentId }],
      initialIndex: 0,
    });
  };

  const startViewTabDragReorder = (viewId: string, event: React.PointerEvent) => {
    if (event.button !== 0 || renamingViewId === viewId) return;
    const targetEl = event.target as HTMLElement | null;
    if (targetEl?.closest("[data-view-tab-menu-trigger], input, button")) {
      return;
    }

    const startX = event.clientX;
    let isDragging = false;
    let latestHint: { targetViewId: string; position: "before" | "after" } | null = null;

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (!isDragging) {
        if (Math.abs(moveEvent.clientX - startX) < 5) return;
        isDragging = true;
        setDraggingViewId(viewId);
      }

      const barEl = viewBarRef.current;
      if (!barEl) return;
      const tabNodes = Array.from(barEl.querySelectorAll<HTMLElement>("[data-stage-table-view-tab]"));
      let matched: { targetViewId: string; position: "before" | "after" } | null = null;

      for (const tabEl of tabNodes) {
        const tabId = tabEl.dataset.stageTableViewTab;
        if (!tabId || tabId === viewId) continue;
        const rect = tabEl.getBoundingClientRect();
        if (moveEvent.clientX >= rect.left && moveEvent.clientX <= rect.right) {
          const mid = rect.left + rect.width / 2;
          matched = { targetViewId: tabId, position: moveEvent.clientX < mid ? "before" : "after" };
          break;
        }
      }

      if (!matched && tabNodes.length > 0) {
        const firstOther = tabNodes.find((n) => n.dataset.stageTableViewTab && n.dataset.stageTableViewTab !== viewId);
        const lastOther = [...tabNodes]
          .reverse()
          .find((n) => n.dataset.stageTableViewTab && n.dataset.stageTableViewTab !== viewId);
        if (firstOther && moveEvent.clientX < firstOther.getBoundingClientRect().left) {
          matched = { targetViewId: firstOther.dataset.stageTableViewTab!, position: "before" };
        } else if (lastOther && moveEvent.clientX > lastOther.getBoundingClientRect().right) {
          matched = { targetViewId: lastOther.dataset.stageTableViewTab!, position: "after" };
        }
      }

      latestHint = matched;
      setDropViewHint(matched);
    };

    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      if (isDragging) {
        suppressViewClickRef.current = true;
        queueMicrotask(() => {
          suppressViewClickRef.current = false;
        });
        if (latestHint) {
          project.stageTable.reorderViews?.(viewId, latestHint.targetViewId, latestHint.position);
        }
      }
      setDraggingViewId(null);
      setDropViewHint(null);
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const recordDialogRow = recordDialogRowUuid ? (allRows.find((r) => r.uuid === recordDialogRowUuid) ?? null) : null;

  return (
    <div
      ref={panelRef}
      tabIndex={-1}
      data-stage-table-panel
      onKeyDown={handlePanelKeyDown}
      onWheel={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseUp={(e) => e.stopPropagation()}
      className="bg-background relative flex size-full min-h-0 min-w-0 flex-col overflow-hidden outline-none"
    >
      {/* 第一行：顶部多视图标签栏（支持多视图创建、切换、重命名、复制、删除、指针拖拽排序） */}
      <div
        ref={viewBarRef}
        data-stage-table-view-bar
        className="border-border/60 flex h-10 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 pt-1 [scrollbar-width:none]"
      >
        {views.map((view) => {
          const isActive = view.id === activeView.id;
          const isRenaming = renamingViewId === view.id;
          const canDelete = view.deletable && views.length > 1;
          const showBefore = dropViewHint?.targetViewId === view.id && dropViewHint.position === "before";
          const showAfter = dropViewHint?.targetViewId === view.id && dropViewHint.position === "after";

          return (
            <ContextMenu key={view.id}>
              <ContextMenuTrigger asChild>
                <div
                  data-stage-table-view-tab={view.id}
                  data-view-type={view.type}
                  data-view-active={isActive ? "true" : undefined}
                  onPointerDown={(e) => startViewTabDragReorder(view.id, e)}
                  onClick={() => {
                    if (suppressViewClickRef.current) return;
                    if (!isActive && !isRenaming) {
                      project.stageTable.setActiveView?.(view.id);
                      setSelection(EMPTY_SELECTION);
                    }
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    setRenamingViewId(view.id);
                    setRenamingViewDraft(view.name);
                  }}
                  className={cn(
                    "relative inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-xs transition-colors select-none",
                    !isRenaming ? "cursor-grab active:cursor-grabbing" : "cursor-text",
                    isActive
                      ? "bg-accent text-accent-foreground font-medium"
                      : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                    draggingViewId === view.id && "opacity-50",
                  )}
                >
                  {showBefore && (
                    <div className="bg-primary pointer-events-none absolute top-1 bottom-1 left-0 w-0.5 rounded-full" />
                  )}
                  {showAfter && (
                    <div className="bg-primary pointer-events-none absolute top-1 right-0 bottom-1 w-0.5 rounded-full" />
                  )}

                  <ViewTypeIcon type={view.type} />

                  {isRenaming ? (
                    <Input
                      ref={viewRenameInputRef}
                      data-view-rename-input
                      value={renamingViewDraft}
                      onChange={(e) => setRenamingViewDraft(e.target.value)}
                      onBlur={() => commitRenameView(view.id)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") {
                          e.preventDefault();
                          commitRenameView(view.id);
                        } else if (e.key === "Escape") {
                          e.preventDefault();
                          setRenamingViewId(null);
                        }
                      }}
                      className="h-5 w-24 px-1.5 py-0 text-xs"
                    />
                  ) : (
                    <span className="max-w-32 truncate">{view.name || t("defaultViewName")}</span>
                  )}

                  {isActive && !isRenaming && (
                    <Popover
                      open={viewMenuOpenId === view.id}
                      onOpenChange={(open) => setViewMenuOpenId(open ? view.id : null)}
                    >
                      <PopoverTrigger asChild>
                        <button
                          type="button"
                          data-view-tab-menu-trigger={view.id}
                          aria-label={t("views.manageView")}
                          onClick={(e) => e.stopPropagation()}
                          className="text-muted-foreground hover:bg-background/70 hover:text-foreground -mr-1 flex size-4 cursor-pointer items-center justify-center rounded transition-colors"
                        >
                          <MoreVertical className="size-3 shrink-0" />
                        </button>
                      </PopoverTrigger>
                      <PopoverContent
                        align="start"
                        className="w-40 p-1 text-xs select-none"
                        onWheel={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <button
                          type="button"
                          data-view-action-rename
                          onClick={() => {
                            setViewMenuOpenId(null);
                            setRenamingViewId(view.id);
                            setRenamingViewDraft(view.name);
                          }}
                          className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left"
                        >
                          <Pencil className="size-3.5" />
                          <span>{t("views.renameView")}</span>
                        </button>
                        <button
                          type="button"
                          data-view-action-duplicate
                          onClick={() => {
                            setViewMenuOpenId(null);
                            project.stageTable.duplicateView?.(view.id, t("headerMenu.copySuffix"));
                          }}
                          className="hover:bg-accent flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left"
                        >
                          <CopyPlus className="size-3.5" />
                          <span>{t("views.duplicateView")}</span>
                        </button>
                        <div className="bg-border/70 my-1 h-px" />
                        <button
                          type="button"
                          data-view-action-delete
                          disabled={!canDelete}
                          onClick={() => {
                            setViewMenuOpenId(null);
                            project.stageTable.deleteView?.(view.id);
                          }}
                          className="text-destructive hover:bg-destructive/12 flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left disabled:pointer-events-none disabled:opacity-40"
                        >
                          <Trash2 className="size-3.5" />
                          <span>{t("views.deleteView")}</span>
                        </button>
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent
                className="w-40"
                onWheel={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <ContextMenuItem
                  onSelect={() =>
                    scheduleAfterContextMenu(() => {
                      setRenamingViewId(view.id);
                      setRenamingViewDraft(view.name);
                    })
                  }
                  className="text-xs"
                >
                  <Pencil className="size-3.5" />
                  <span>{t("views.renameView")}</span>
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => project.stageTable.duplicateView?.(view.id, t("headerMenu.copySuffix"))}
                  className="text-xs"
                >
                  <CopyPlus className="size-3.5" />
                  <span>{t("views.duplicateView")}</span>
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem
                  variant="destructive"
                  disabled={!canDelete}
                  onSelect={() => project.stageTable.deleteView?.(view.id)}
                  className="text-xs"
                >
                  <Trash2 className="size-3.5" />
                  <span>{t("views.deleteView")}</span>
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}

        <div className="bg-border mx-1 h-3.5 w-px shrink-0" />

        {/* 新建视图菜单（表格视图 / 看板视图 / 甘特视图 / 画册视图 / 日历视图） */}
        <Popover open={addViewPopoverOpen} onOpenChange={setAddViewPopoverOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-stage-table-add-view-btn
              aria-label={t("addViewPlaceholder")}
              className="text-muted-foreground hover:bg-accent hover:text-foreground data-[state=open]:bg-accent flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors"
            >
              <Plus className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            data-stage-table-add-view-menu
            className="w-44 p-1.5 text-xs select-none"
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="text-muted-foreground mb-1 flex items-center gap-1 px-2 py-1 text-[11px] font-medium">
              <span>{t("views.createViewTitle")}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex cursor-help items-center">
                    <Info className="size-3 opacity-75" />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="right" className="max-w-52 text-xs">
                  {t("views.createViewHint")}
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="space-y-0.5">
              {TABLE_VIEW_TYPES.map((viewType) => (
                <button
                  key={viewType}
                  type="button"
                  data-create-view-option={viewType}
                  onClick={() => handleCreateView(viewType)}
                  className="hover:bg-accent text-foreground flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs transition-colors"
                >
                  <ViewTypeIcon type={viewType} className="size-4" />
                  <span>{t(`views.type_${viewType}`)}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
      </div>

      {/* 按当前激活视图类型渲染功能栏与主体 */}
      {activeViewType === "kanban" && (
        <StageTableKanbanView
          project={project}
          activeView={activeView}
          allRows={allRows}
          rows={rows}
          allColumnIds={allPropertyIds}
          filterableColumnIds={filterableColumnIds}
          filterColumnGroups={filterColumnGroups}
          visibleColumnIds={visibleColumnIds}
          customColumns={customColumns}
          customColumnMap={customColumnMap}
          activeFilters={activeFilters}
          activeFilterGroup={activeFilterGroup}
          activeSort={activeSort}
          selectedRowIds={selectedRowIdsForViews}
          getColumnLabel={getColumnLabel}
          onSelectRows={handleViewSelectRows}
          onOpenRecord={(uuid) => setRecordDialogRowUuid(uuid)}
          onPreviewImage={(attId, rowUuid) => openImagePreview(attId, rowUuid)}
          t={t}
        />
      )}

      {activeViewType === "gantt" && (
        <StageTableGanttView
          project={project}
          activeView={activeView}
          allRows={allRows}
          rows={rows}
          allColumnIds={allPropertyIds}
          filterableColumnIds={filterableColumnIds}
          filterColumnGroups={filterColumnGroups}
          visibleColumnIds={visibleColumnIds}
          customColumns={customColumns}
          customColumnMap={customColumnMap}
          activeFilters={activeFilters}
          activeFilterGroup={activeFilterGroup}
          activeSort={activeSort}
          selectedRowIds={selectedRowIdsForViews}
          getColumnLabel={getColumnLabel}
          onSelectRows={handleViewSelectRows}
          onOpenRecord={(uuid) => setRecordDialogRowUuid(uuid)}
          onPreviewImage={(attId, rowUuid) => openImagePreview(attId, rowUuid)}
          t={t}
        />
      )}

      {activeViewType === "gallery" && (
        <StageTableGalleryView
          project={project}
          activeView={activeView}
          allRows={allRows}
          rows={rows}
          allColumnIds={allPropertyIds}
          filterableColumnIds={filterableColumnIds}
          filterColumnGroups={filterColumnGroups}
          visibleColumnIds={visibleColumnIds}
          customColumns={customColumns}
          customColumnMap={customColumnMap}
          activeFilters={activeFilters}
          activeFilterGroup={activeFilterGroup}
          activeSort={activeSort}
          selectedRowIds={selectedRowIdsForViews}
          getColumnLabel={getColumnLabel}
          onSelectRows={handleViewSelectRows}
          onOpenRecord={(uuid) => setRecordDialogRowUuid(uuid)}
          onPreviewImage={(attId, rowUuid) => openImagePreview(attId, rowUuid)}
          t={t}
        />
      )}

      {activeViewType === "calendar" && (
        <StageTableCalendarView
          project={project}
          activeView={activeView}
          allRows={allRows}
          rows={rows}
          allColumnIds={allPropertyIds}
          filterableColumnIds={filterableColumnIds}
          filterColumnGroups={filterColumnGroups}
          visibleColumnIds={visibleColumnIds}
          customColumns={customColumns}
          customColumnMap={customColumnMap}
          activeFilters={activeFilters}
          activeFilterGroup={activeFilterGroup}
          activeSort={activeSort}
          selectedRowIds={selectedRowIdsForViews}
          getColumnLabel={getColumnLabel}
          onSelectRows={handleViewSelectRows}
          onOpenRecord={(uuid) => setRecordDialogRowUuid(uuid)}
          onPreviewImage={(attId, rowUuid) => openImagePreview(attId, rowUuid)}
          t={t}
        />
      )}

      {activeViewType === "spaced_repetition" && (
        <StageTableSpacedRepetitionView
          project={project}
          activeView={activeView}
          allRows={allRows}
          rows={rows}
          allColumnIds={allPropertyIds}
          filterableColumnIds={filterableColumnIds}
          filterColumnGroups={filterColumnGroups}
          customColumns={customColumns}
          customColumnMap={customColumnMap}
          activeFilters={activeFilters}
          activeFilterGroup={activeFilterGroup}
          activeSort={activeSort}
          selectedRowIds={selectedRowIdsForViews}
          getColumnLabel={getColumnLabel}
          onSelectRows={handleViewSelectRows}
          onOpenRecord={(uuid) => setRecordDialogRowUuid(uuid)}
          onPreviewImage={(attId, rowUuid) => openImagePreview(attId, rowUuid)}
          onOpenFormulaEditor={(colId, rowUuid) => openFormulaEditorForColumn(colId, rowUuid)}
          t={t}
        />
      )}

      {activeViewType === "table" && (
        <>
          {/* 第二行：表格视图功能区 */}
          <div className="border-border/60 flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b px-3 text-xs [scrollbar-width:none]">
            <button
              type="button"
              data-stage-table-add-row
              onClick={handleTableAddRow}
              className="text-primary hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 font-medium transition-colors"
            >
              <PlusCircle className="size-3.5" />
              <span>{t("toolbar.addRow")}</span>
            </button>

            <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

            {/* 功能区 - 属性弹窗（含系统列 + 自定义列显隐与编辑入口） */}
            <Popover
              onOpenChange={(open) => {
                if (!open) setPropertySearch("");
              }}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="text-foreground hover:bg-accent data-[state=open]:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors"
                >
                  <List className="size-3.5" />
                  <span>{t("toolbar.properties")}</span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-60 p-0"
                onWheel={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="border-b p-2">
                  <div className="relative flex items-center">
                    <Search className="text-muted-foreground pointer-events-none absolute left-2 size-3.5" />
                    <Input
                      value={propertySearch}
                      onChange={(e) => setPropertySearch(e.target.value)}
                      onKeyDown={(e) => e.stopPropagation()}
                      placeholder={t("propertiesPopover.searchPlaceholder")}
                      className="h-7 pl-7 text-xs"
                    />
                  </div>
                </div>
                <div className="max-h-72 overflow-y-auto p-1">
                  {filteredPropertyIds.map((colId) => {
                    const isPrimary = colId === "name";
                    const checked = project.stageTable.isColumnVisible(colId);
                    const customCol = customColumnMap.get(colId);
                    return (
                      <div
                        key={colId}
                        className={cn(
                          "hover:bg-accent flex items-center gap-2 rounded-sm px-2 py-1.5 text-xs select-none",
                          isPrimary && "opacity-85",
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          disabled={isPrimary}
                          onCheckedChange={(val) => {
                            if (!isPrimary) {
                              project.stageTable.setColumnVisible(colId, Boolean(val));
                            }
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => {
                            if (!isPrimary) {
                              project.stageTable.setColumnVisible(colId, !checked);
                            }
                          }}
                          className={cn(
                            "flex min-w-0 flex-1 items-center gap-2 text-left",
                            isPrimary ? "cursor-default" : "cursor-pointer",
                          )}
                        >
                          <ColumnIcon columnId={colId} customColumn={customCol} />
                          <span className="min-w-0 flex-1 truncate">{getColumnLabel(colId)}</span>
                        </button>
                        <button
                          type="button"
                          aria-label={t("headerMenu.editField")}
                          onClick={(e) => {
                            e.stopPropagation();
                            openEditFieldPanel(colId, "floating");
                          }}
                          className="text-muted-foreground/70 hover:bg-background hover:text-foreground rounded p-0.5"
                        >
                          <ChevronRight className="size-3.5 shrink-0" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>

            <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

            <StageTableFilterToolbarPopover
              filterableColumnIds={filterableColumnIds}
              columnGroups={filterColumnGroups}
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

            <button
              type="button"
              className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-6 shrink-0 items-center gap-1 rounded px-2 transition-colors"
            >
              <ListTree className="size-3.5" />
              <span>{t("toolbar.group")}</span>
            </button>

            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-stage-table-sort-toolbar
                  className={cn(
                    "hover:bg-accent inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors",
                    activeSort
                      ? "bg-primary/15 text-primary font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <ArrowUpDown className="size-3.5" />
                  <span>
                    {activeSort
                      ? `${t("toolbar.sort")}: ${getColumnLabel(activeSort.columnId)} ${activeSort.direction === "asc" ? "↑" : "↓"}`
                      : t("toolbar.sort")}
                  </span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-64 p-2 text-xs select-none"
                onWheel={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="mb-1.5 flex items-center justify-between px-1">
                  <span className="text-muted-foreground text-[11px] font-medium">{t("sortFilter.sortTitle")}</span>
                  {activeSort && (
                    <button
                      type="button"
                      onClick={() => project.stageTable.setSort?.(null)}
                      className="text-primary cursor-pointer text-[11px] hover:underline"
                    >
                      {t("sortFilter.clearSort")}
                    </button>
                  )}
                </div>
                <div className="max-h-56 space-y-0.5 overflow-y-auto">
                  {visibleColumnIds.map((cid) => {
                    const isAsc = activeSort?.columnId === cid && activeSort.direction === "asc";
                    const isDesc = activeSort?.columnId === cid && activeSort.direction === "desc";
                    return (
                      <div
                        key={cid}
                        className="hover:bg-accent/60 flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs"
                      >
                        <ColumnIcon columnId={cid} customColumn={customColumnMap.get(cid)} />
                        <span
                          className={cn("min-w-0 flex-1 truncate", (isAsc || isDesc) && "text-primary font-medium")}
                        >
                          {getColumnLabel(cid)}
                        </span>
                        <button
                          type="button"
                          aria-label={t("sortFilter.sortAsc")}
                          onClick={() =>
                            project.stageTable.setSort?.(isAsc ? null : { columnId: cid, direction: "asc" })
                          }
                          className={cn(
                            "flex size-6 cursor-pointer items-center justify-center rounded border transition-colors",
                            isAsc
                              ? "border-primary bg-primary/15 text-primary"
                              : "text-muted-foreground hover:bg-background hover:text-foreground border-transparent",
                          )}
                        >
                          <ArrowUp className="size-3" />
                        </button>
                        <button
                          type="button"
                          aria-label={t("sortFilter.sortDesc")}
                          onClick={() =>
                            project.stageTable.setSort?.(isDesc ? null : { columnId: cid, direction: "desc" })
                          }
                          className={cn(
                            "flex size-6 cursor-pointer items-center justify-center rounded border transition-colors",
                            isDesc
                              ? "border-primary bg-primary/15 text-primary"
                              : "text-muted-foreground hover:bg-background hover:text-foreground border-transparent",
                          )}
                        >
                          <ArrowDown className="size-3" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>

            <div className="bg-border mx-0.5 h-3.5 w-px shrink-0" />

            <Popover>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  data-stage-table-row-height
                  className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded px-2 transition-colors"
                >
                  <UnfoldVertical className="size-3.5" />
                  <span>{t("toolbar.rowHeight")}</span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-32 p-1 text-xs select-none"
                onWheel={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {(["compact", "medium", "tall"] as const).map((h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => project.stageTable.updateActiveViewConfig?.({ rowHeight: h })}
                    className="hover:bg-accent flex w-full cursor-pointer items-center justify-between rounded px-2 py-1.5"
                  >
                    <span>{t(`calendar.height_${h}`)}</span>
                    {tableRowHeight === h && <Check className="text-primary size-3.5" />}
                  </button>
                ))}
              </PopoverContent>
            </Popover>

            {selectionSummaryText && (
              <div
                data-stage-table-selection-badge
                className="bg-primary/12 text-primary ml-auto inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium select-none"
              >
                <span>{selectionSummaryText}</span>
                <button
                  type="button"
                  aria-label={t("dateCell.clear")}
                  onClick={() =>
                    clearSelection(selection.mode === "rows" || selection.mode === "all" || selection.mode === "cells")
                  }
                  className="hover:bg-primary/20 cursor-pointer rounded-full p-0.5 transition-colors"
                >
                  <X className="size-3" />
                </button>
              </div>
            )}
          </div>

          {/* 表格主体（tableLayout: fixed + 精确总像素宽，确保调整单列宽度时其它列绝不自动伸缩） */}
          <TableScrollContainer layoutDepsKey={layoutDepsKey} externalViewportRef={viewportRef}>
            <table
              data-stage-table-grid
              style={{ width: `${totalTableWidth}px`, tableLayout: "fixed" }}
              className="border-collapse text-left text-xs"
            >
              <colgroup>
                <col style={{ width: `${INDEX_COLUMN_WIDTH}px` }} />
                {visibleColumnIds.map((colId) => (
                  <col key={colId} style={{ width: `${getColumnWidth(colId)}px` }} />
                ))}
                <col style={{ width: `${ADD_COLUMN_WIDTH}px` }} />
              </colgroup>

              <thead className="bg-muted sticky top-0 z-20">
                {/* 图 6：跨列合并的顶部分组表头（如「基础信息 / 自我理解 / 后台数据」） */}
                {hasVisibleColumnGroups && (
                  <tr data-stage-table-group-row className="border-border/60 border-b">
                    <th
                      style={frozenEndIndex >= 0 ? { left: "0px" } : undefined}
                      className={cn(
                        "border-border/50 bg-muted h-7 border-r p-0 select-none",
                        frozenEndIndex >= 0 && "sticky z-30",
                      )}
                    />
                    {superHeaderSegments.map((seg) => {
                      const grp = seg.group;
                      const isRenamingThis = grp && renamingGroupId === grp.id;
                      return (
                        <th
                          key={seg.key}
                          colSpan={seg.colIds.length}
                          style={seg.isFrozen ? { left: `${seg.stickyLeftPx ?? 0}px` } : undefined}
                          className={cn(
                            "border-border/50 bg-muted relative h-7 border-r px-2 font-medium select-none",
                            seg.isFrozen && "sticky z-30",
                            seg.isFreezeBoundary && "border-r-primary/45 border-r-2",
                          )}
                        >
                          {grp ? (
                            isRenamingThis ? (
                              <Input
                                ref={groupRenameInputRef}
                                value={renamingGroupDraft}
                                onChange={(e) => setRenamingGroupDraft(e.target.value)}
                                onBlur={() => {
                                  if (renamingGroupDraft.trim()) {
                                    project.stageTable.renameColumnGroup?.(grp.id, renamingGroupDraft);
                                  }
                                  setRenamingGroupId(null);
                                }}
                                onKeyDown={(e) => {
                                  e.stopPropagation();
                                  if (e.key === "Enter") {
                                    e.preventDefault();
                                    if (renamingGroupDraft.trim()) {
                                      project.stageTable.renameColumnGroup?.(grp.id, renamingGroupDraft);
                                    }
                                    setRenamingGroupId(null);
                                  } else if (e.key === "Escape") {
                                    e.preventDefault();
                                    setRenamingGroupId(null);
                                  }
                                }}
                                className="h-5 px-1.5 py-0 text-center text-[11px]"
                              />
                            ) : (
                              <div
                                onDoubleClick={() => {
                                  setRenamingGroupId(grp.id);
                                  setRenamingGroupDraft(grp.name);
                                }}
                                className="flex h-full w-full items-center justify-center gap-1"
                              >
                                <span className="text-foreground/90 truncate text-[11px] font-medium">{grp.name}</span>
                                <Popover>
                                  <PopoverTrigger asChild>
                                    <button
                                      type="button"
                                      data-column-group-menu-trigger={grp.id}
                                      aria-label={t("columnGroups.manageGroup")}
                                      className="text-muted-foreground hover:bg-accent hover:text-foreground absolute right-1.5 flex size-4 items-center justify-center rounded-xs transition-colors"
                                    >
                                      <ChevronDown className="size-3" />
                                    </button>
                                  </PopoverTrigger>
                                  <PopoverContent
                                    align="end"
                                    className="w-56 p-2"
                                    onWheel={(e) => e.stopPropagation()}
                                    onMouseDown={(e) => e.stopPropagation()}
                                  >
                                    <div className="mb-2 space-y-1">
                                      <div className="text-muted-foreground px-1 text-[11px] font-medium">
                                        {t("columnGroups.groupNameLabel")}
                                      </div>
                                      <Input
                                        defaultValue={grp.name}
                                        onBlur={(e) => {
                                          if (e.target.value.trim()) {
                                            project.stageTable.renameColumnGroup?.(grp.id, e.target.value);
                                          }
                                        }}
                                        onKeyDown={(e) => {
                                          e.stopPropagation();
                                          if (e.key === "Enter") {
                                            e.preventDefault();
                                            const val = (e.currentTarget as HTMLInputElement).value;
                                            if (val.trim()) {
                                              project.stageTable.renameColumnGroup?.(grp.id, val);
                                            }
                                          }
                                        }}
                                        className="h-7 text-xs"
                                      />
                                    </div>
                                    <div className="text-muted-foreground mb-1 px-1 text-[11px] font-medium">
                                      {t("columnGroups.includedColumns")}
                                    </div>
                                    <div className="max-h-44 space-y-0.5 overflow-y-auto">
                                      {visibleColumnIds.map((cid) => {
                                        const inThisGroup = grp.columnIds.includes(cid);
                                        return (
                                          <label
                                            key={cid}
                                            className="hover:bg-accent flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-xs"
                                          >
                                            <Checkbox
                                              checked={inThisGroup}
                                              onCheckedChange={(checked) => {
                                                project.stageTable.setColumnInGroup?.(cid, checked ? grp.id : null);
                                              }}
                                            />
                                            <ColumnIcon columnId={cid} customColumn={customColumnMap.get(cid)} />
                                            <span className="truncate">{getColumnLabel(cid)}</span>
                                          </label>
                                        );
                                      })}
                                    </div>
                                    <div className="border-border/60 mt-2 border-t pt-1.5">
                                      <Button
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => project.stageTable.dissolveColumnGroup?.(grp.id)}
                                        className="text-destructive hover:text-destructive h-7 w-full justify-start gap-1.5 px-2 text-xs"
                                      >
                                        <Trash2 className="size-3.5" />
                                        <span>{t("columnGroups.dissolveGroup")}</span>
                                      </Button>
                                    </div>
                                  </PopoverContent>
                                </Popover>
                              </div>
                            )
                          ) : (
                            <div className="group/ungrp flex h-full w-full items-center justify-center">
                              <button
                                type="button"
                                onClick={() => {
                                  const createdGrp = project.stageTable.createColumnGroup?.(
                                    t("columnGroups.defaultName"),
                                    seg.colIds,
                                  );
                                  if (createdGrp) {
                                    setRenamingGroupId(createdGrp.id);
                                    setRenamingGroupDraft(createdGrp.name);
                                  }
                                }}
                                className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px] opacity-0 transition-opacity group-hover/ungrp:opacity-100"
                              >
                                <Plus className="size-3" />
                                <span>{t("columnGroups.createGroup")}</span>
                              </button>
                            </div>
                          )}
                        </th>
                      );
                    })}
                    <th className="bg-muted h-7 p-0" />
                  </tr>
                )}

                <tr ref={headerRowRef} className="border-border/60 border-b">
                  {/* 行计数表头（点击全选/取消全选） */}
                  <th
                    data-stage-table-select-all
                    title={t("selection.selectAllAria")}
                    onClick={handleToggleSelectAll}
                    style={frozenEndIndex >= 0 ? { left: "0px" } : undefined}
                    className={cn(
                      "border-border/50 bg-muted hover:bg-accent/70 h-9 cursor-pointer border-r px-1 text-center text-[11px] font-medium transition-colors select-none",
                      selection.mode === "all"
                        ? "text-primary after:bg-primary/18 font-semibold after:pointer-events-none after:absolute after:inset-0"
                        : "text-muted-foreground/70",
                      frozenEndIndex >= 0 ? "sticky z-30" : "relative",
                    )}
                  >
                    #
                  </th>

                  {/* 数据列表头 */}
                  {visibleColumnIds.map((colId, colIdx) => {
                    const width = getColumnWidth(colId);
                    const customCol = customColumnMap.get(colId);
                    const isNameCol = colId === "name";
                    const isDraggingThis = draggingColId === colId;
                    const showDropBefore = dropHint?.targetColId === colId && dropHint.position === "before";
                    const showDropAfter = dropHint?.targetColId === colId && dropHint.position === "after";
                    const isFrozen = colIdx <= frozenEndIndex;
                    const isFreezeBoundary = colIdx === frozenEndIndex;
                    const isFrozenTarget = frozenColumnId === colId;
                    const isHeaderEditing = editingFieldState?.colId === colId && editingFieldState.anchor === "header";
                    const isCreatingThis = creatingColState?.colId === colId;
                    const currentGroup = groupByColId.get(colId);
                    const isColSelected =
                      selection.mode === "all" || (selection.mode === "columns" && selection.colIds.has(colId));
                    const colSortDir: TableSortDirection | null =
                      activeSort?.columnId === colId ? activeSort.direction : null;
                    const colFilter = activeFilterByColId.get(colId) ?? null;
                    const isColFiltered = colFilter !== null || activeFilterGroupColIds.has(colId);
                    const isFilterMenuOpen = filterPopoverColId === colId;

                    return (
                      <th
                        key={colId}
                        data-table-col-id={colId}
                        data-col-selected={isColSelected ? "true" : undefined}
                        data-col-sort={colSortDir ?? undefined}
                        data-col-filtered={isColFiltered ? "true" : undefined}
                        style={isFrozen ? { left: `${columnLeftOffsets[colIdx]}px` } : undefined}
                        onPointerDown={(e) => startColumnDragReorder(colId, e)}
                        className={cn(
                          "group/th border-border/50 bg-muted text-muted-foreground h-9 border-r p-0 font-medium select-none",
                          !isNameCol && !isCreatingThis ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                          isDraggingThis && "bg-accent/60 opacity-60",
                          isFrozen ? "sticky z-30" : "relative",
                          isFreezeBoundary && "border-r-primary/45 border-r-2",
                          (colSortDir || isColFiltered) && "text-foreground",
                          isColSelected &&
                            "text-foreground after:bg-primary/15 after:border-b-primary after:pointer-events-none after:absolute after:inset-0 after:border-b-2",
                          !isColSelected &&
                            (colSortDir || isColFiltered || isFilterMenuOpen) &&
                            "after:bg-primary/10 after:pointer-events-none after:absolute after:inset-0",
                        )}
                      >
                        {/* 锚定在当前列表头下方的图 1「修改字段」或图 4「新建/插入字段」浮层 */}
                        <Popover
                          open={isHeaderEditing || isCreatingThis}
                          onOpenChange={(open) => {
                            if (!open) {
                              if (isHeaderEditing) {
                                setEditTypeDropdownOpen(false);
                                setEditingFieldState(null);
                              }
                              if (isCreatingThis) {
                                commitCreatingColumn();
                              }
                            }
                          }}
                        >
                          <PopoverAnchor asChild>
                            <div data-col-popover-anchor={colId} className="size-full">
                              {isCreatingThis ? (
                                /* 图 4：创建/插入字段后的表头内联标题输入框（蓝底线高亮） */
                                <div className="border-b-primary bg-background/90 flex h-full w-full items-center border-b-2 px-2">
                                  <input
                                    ref={creatingTitleInputRef}
                                    data-creating-col-title-input
                                    value={creatingColState.draftTitle}
                                    onChange={(e) =>
                                      setCreatingColState({ ...creatingColState, draftTitle: e.target.value })
                                    }
                                    onKeyDown={handleCreateTitleKeyDown}
                                    placeholder={t("insertFieldPopover.titlePlaceholder")}
                                    className="text-foreground placeholder:text-muted-foreground h-full w-full bg-transparent text-center text-xs outline-none"
                                  />
                                </div>
                              ) : (
                                <ContextMenu>
                                  <ContextMenuTrigger asChild>
                                    <div
                                      onDoubleClick={(e) => {
                                        const targetEl = e.target as HTMLElement | null;
                                        if (targetEl?.closest("[data-col-filter-trigger], [data-col-sort-indicator]")) {
                                          return;
                                        }
                                        e.stopPropagation();
                                        project.stageTable.toggleColumnSort?.(colId);
                                      }}
                                      className="hover:bg-accent/40 relative flex h-full w-full items-stretch"
                                    >
                                      {/* Windows 文件管理器风格顶部居中排序小箭头（向上升序 / 向下排序） */}
                                      {colSortDir && (
                                        <button
                                          type="button"
                                          data-col-sort-indicator={colId}
                                          data-sort-direction={colSortDir}
                                          aria-label={t("sortFilter.toggleSortAria")}
                                          title={
                                            colSortDir === "asc" ? t("sortFilter.sortAsc") : t("sortFilter.sortDesc")
                                          }
                                          onPointerDown={(e) => e.stopPropagation()}
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            project.stageTable.toggleColumnSort?.(
                                              colId,
                                              colSortDir === "asc" ? "desc" : "asc",
                                            );
                                          }}
                                          className="text-primary hover:bg-primary/15 absolute top-0 left-1/2 z-10 flex h-3.5 w-6 -translate-x-1/2 cursor-pointer items-center justify-center rounded-b transition-colors"
                                        >
                                          {colSortDir === "asc" ? (
                                            <ChevronUp className="size-3 stroke-[2.25]" />
                                          ) : (
                                            <ChevronDown className="size-3 stroke-[2.25]" />
                                          )}
                                        </button>
                                      )}

                                      {/* 列标题主体 */}
                                      <div
                                        className={cn(
                                          "flex min-w-0 flex-1 items-center gap-1.5 truncate pr-1 pl-2.5",
                                          colSortDir && "pt-1.5",
                                        )}
                                      >
                                        <ColumnIcon columnId={colId} customColumn={customCol} />
                                        <span className="truncate">{getColumnLabel(colId)}</span>
                                      </div>

                                      {/* 右侧分隔下拉按钮（类 Windows 文件管理器列筛选/排序下拉） */}
                                      <Popover
                                        open={isFilterMenuOpen}
                                        onOpenChange={(open) => setFilterPopoverColId(open ? colId : null)}
                                      >
                                        <PopoverTrigger asChild>
                                          <button
                                            type="button"
                                            data-col-filter-trigger={colId}
                                            aria-label={t("sortFilter.columnFilterAria")}
                                            onPointerDown={(e) => e.stopPropagation()}
                                            onClick={(e) => e.stopPropagation()}
                                            className={cn(
                                              "relative mr-1 flex w-6 shrink-0 cursor-pointer items-center justify-center border-l transition-all",
                                              isColFiltered || colSortDir || isFilterMenuOpen
                                                ? "border-border/70 bg-primary/10 text-primary opacity-100"
                                                : "text-muted-foreground/80 group-hover/th:border-border/60 hover:bg-accent hover:text-foreground border-transparent opacity-45 group-hover/th:opacity-100",
                                            )}
                                          >
                                            <ChevronDown className="size-3" />
                                            {isColFiltered && (
                                              <span className="bg-primary absolute top-1 right-1 size-1.5 rounded-full" />
                                            )}
                                          </button>
                                        </PopoverTrigger>
                                        <PopoverContent
                                          align="end"
                                          sideOffset={4}
                                          className="w-auto p-0"
                                          onWheel={(e) => e.stopPropagation()}
                                          onMouseDown={(e) => e.stopPropagation()}
                                          onPointerDown={(e) => e.stopPropagation()}
                                        >
                                          <ColumnFilterSortPopoverContent
                                            columnId={colId}
                                            customCol={customCol}
                                            allRows={allRows}
                                            activeSort={activeSort}
                                            activeFilter={colFilter}
                                            onSetSort={(nextSort) => project.stageTable.setSort?.(nextSort)}
                                            onSetFilter={(nextFlt) =>
                                              project.stageTable.setColumnFilter?.(colId, nextFlt)
                                            }
                                            t={t}
                                          />
                                        </PopoverContent>
                                      </Popover>
                                    </div>
                                  </ContextMenuTrigger>

                                  {/* 表头右键菜单（整合图 1 修改字段 + 图 3 左右插入子菜单 + 图 6 字段编组 + 图 5 底部五图标栏） */}
                                  <ContextMenuContent
                                    className="w-52"
                                    onWheel={(e) => e.stopPropagation()}
                                    onMouseDown={(e) => e.stopPropagation()}
                                  >
                                    <ContextMenuItem
                                      onSelect={() =>
                                        scheduleAfterContextMenu(() => openEditFieldPanel(colId, "header"))
                                      }
                                      className="text-xs"
                                    >
                                      <SquarePen className="size-3.5" />
                                      <span>{t("headerMenu.editField")}</span>
                                      <span className="text-muted-foreground ml-auto pl-4 text-[11px]">
                                        {getColumnTypeName(colId)}
                                      </span>
                                    </ContextMenuItem>

                                    {customCol?.type === "formula" && (
                                      <ContextMenuItem
                                        onSelect={() =>
                                          scheduleAfterContextMenu(() => openFormulaEditorForColumn(colId))
                                        }
                                        className="text-xs"
                                      >
                                        <FunctionSquare className="size-3.5" />
                                        <span>{t("formulaEditor.editFormula")}</span>
                                      </ContextMenuItem>
                                    )}

                                    {/* 图 3：插入字段 -> 向左插入 / 向右插入 */}
                                    <ContextMenuSub>
                                      <ContextMenuSubTrigger inset className="text-xs">
                                        <span>{t("headerMenu.insertField")}</span>
                                      </ContextMenuSubTrigger>
                                      <ContextMenuSubContent
                                        className="w-36"
                                        onWheel={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => e.stopPropagation()}
                                      >
                                        <ContextMenuItem
                                          disabled={isNameCol}
                                          onSelect={() =>
                                            scheduleAfterContextMenu(() => triggerInsertNewColumn(colId, "left"))
                                          }
                                          className="text-xs"
                                        >
                                          <ArrowLeft className="size-3.5" />
                                          <span>{t("headerMenu.insertLeft")}</span>
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                          onSelect={() =>
                                            scheduleAfterContextMenu(() => triggerInsertNewColumn(colId, "right"))
                                          }
                                          className="text-xs"
                                        >
                                          <ArrowRight className="size-3.5" />
                                          <span>{t("headerMenu.insertRight")}</span>
                                        </ContextMenuItem>
                                      </ContextMenuSubContent>
                                    </ContextMenuSub>

                                    {/* 图 6：跨列分组表头（字段编组）管理入口 */}
                                    <ContextMenuSub>
                                      <ContextMenuSubTrigger className="text-xs">
                                        <FolderPlus className="size-3.5" />
                                        <span>{t("columnGroups.menuLabel")}</span>
                                      </ContextMenuSubTrigger>
                                      <ContextMenuSubContent
                                        className="w-44"
                                        onWheel={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => e.stopPropagation()}
                                      >
                                        <ContextMenuItem
                                          onSelect={() =>
                                            scheduleAfterContextMenu(() => {
                                              const grp = project.stageTable.createColumnGroup?.(
                                                t("columnGroups.defaultName"),
                                                [colId],
                                              );
                                              if (grp) {
                                                setRenamingGroupId(grp.id);
                                                setRenamingGroupDraft(grp.name);
                                              }
                                            })
                                          }
                                          className="text-xs"
                                        >
                                          <Plus className="size-3.5" />
                                          <span>{t("columnGroups.createGroup")}</span>
                                        </ContextMenuItem>

                                        {columnGroups.length > 0 && <ContextMenuSeparator />}

                                        {columnGroups.map((grp) => {
                                          const active = currentGroup?.id === grp.id;
                                          return (
                                            <ContextMenuItem
                                              key={grp.id}
                                              onSelect={() =>
                                                project.stageTable.setColumnInGroup?.(colId, active ? null : grp.id)
                                              }
                                              className="text-xs"
                                            >
                                              <span className="flex size-3.5 shrink-0 items-center justify-center">
                                                {active && <Check className="text-primary size-3.5" />}
                                              </span>
                                              <span className="truncate">{grp.name}</span>
                                            </ContextMenuItem>
                                          );
                                        })}

                                        {currentGroup && (
                                          <>
                                            <ContextMenuSeparator />
                                            <ContextMenuItem
                                              onSelect={() => project.stageTable.setColumnInGroup?.(colId, null)}
                                              className="text-xs"
                                            >
                                              <X className="size-3.5" />
                                              <span>{t("columnGroups.removeFromGroup")}</span>
                                            </ContextMenuItem>
                                            <ContextMenuItem
                                              variant="destructive"
                                              onSelect={() => project.stageTable.dissolveColumnGroup?.(currentGroup.id)}
                                              className="text-xs"
                                            >
                                              <Trash2 className="size-3.5" />
                                              <span>{t("columnGroups.dissolveGroup")}</span>
                                            </ContextMenuItem>
                                          </>
                                        )}
                                      </ContextMenuSubContent>
                                    </ContextMenuSub>

                                    <ContextMenuSeparator />

                                    <ContextMenuItem
                                      onSelect={() => scheduleAfterContextMenu(() => setFilterPopoverColId(colId))}
                                      className="text-xs"
                                    >
                                      <Filter className="size-3.5" />
                                      <span>{t("toolbar.filter")}</span>
                                    </ContextMenuItem>

                                    <ContextMenuItem className="text-xs">
                                      <ListTree className="size-3.5" />
                                      <span>{t("toolbar.group")}</span>
                                    </ContextMenuItem>

                                    <ContextMenuSub>
                                      <ContextMenuSubTrigger className="text-xs">
                                        <ArrowUpDown className="size-3.5" />
                                        <span>{t("toolbar.sort")}</span>
                                      </ContextMenuSubTrigger>
                                      <ContextMenuSubContent
                                        className="w-36"
                                        onWheel={(e) => e.stopPropagation()}
                                        onMouseDown={(e) => e.stopPropagation()}
                                      >
                                        <ContextMenuItem
                                          onSelect={() =>
                                            project.stageTable.setSort?.({ columnId: colId, direction: "asc" })
                                          }
                                          className="text-xs"
                                        >
                                          <ArrowUp className="size-3.5" />
                                          <span>{t("sortFilter.sortAsc")}</span>
                                          {colSortDir === "asc" && <Check className="text-primary ml-auto size-3.5" />}
                                        </ContextMenuItem>
                                        <ContextMenuItem
                                          onSelect={() =>
                                            project.stageTable.setSort?.({ columnId: colId, direction: "desc" })
                                          }
                                          className="text-xs"
                                        >
                                          <ArrowDown className="size-3.5" />
                                          <span>{t("sortFilter.sortDesc")}</span>
                                          {colSortDir === "desc" && <Check className="text-primary ml-auto size-3.5" />}
                                        </ContextMenuItem>
                                        {colSortDir && (
                                          <>
                                            <ContextMenuSeparator />
                                            <ContextMenuItem
                                              onSelect={() => project.stageTable.setSort?.(null)}
                                              className="text-xs"
                                            >
                                              <X className="size-3.5" />
                                              <span>{t("sortFilter.clearSort")}</span>
                                            </ContextMenuItem>
                                          </>
                                        )}
                                      </ContextMenuSubContent>
                                    </ContextMenuSub>

                                    <ContextMenuSeparator />

                                    {/* 图 5：底部五图标栏（复制 | 自适应列宽 | 冻结 | 隐藏 | 分隔竖线 | 删除） */}
                                    <div
                                      data-header-menu-bottom-actions
                                      className="flex items-center justify-between gap-0.5 px-1 py-0.5"
                                    >
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <ContextMenuPrimitive.Item
                                            disabled={!customCol}
                                            aria-label={t("headerMenu.duplicate")}
                                            onSelect={() =>
                                              project.stageTable.duplicateCustomColumn?.(
                                                colId,
                                                t("headerMenu.copySuffix"),
                                              )
                                            }
                                            className="text-muted-foreground hover:bg-accent hover:text-foreground focus:bg-accent focus:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-35"
                                          >
                                            <CopyPlus className="size-3.5" />
                                          </ContextMenuPrimitive.Item>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">{t("headerMenu.duplicate")}</TooltipContent>
                                      </Tooltip>

                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <ContextMenuPrimitive.Item
                                            aria-label={t("headerMenu.autoFitWidth")}
                                            onSelect={() =>
                                              project.stageTable.autoFitColumnWidth?.(colId, getColumnLabel(colId))
                                            }
                                            className="text-muted-foreground hover:bg-accent hover:text-foreground focus:bg-accent focus:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md outline-none"
                                          >
                                            <UnfoldHorizontal className="size-3.5" />
                                          </ContextMenuPrimitive.Item>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">{t("headerMenu.autoFitWidth")}</TooltipContent>
                                      </Tooltip>

                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <ContextMenuPrimitive.Item
                                            aria-label={
                                              isFrozenTarget ? t("headerMenu.unfreeze") : t("headerMenu.freeze")
                                            }
                                            onSelect={() => project.stageTable.toggleFreezeUpToColumn?.(colId)}
                                            className={cn(
                                              "hover:bg-accent hover:text-foreground focus:bg-accent focus:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md outline-none",
                                              isFrozenTarget ? "bg-accent text-primary" : "text-muted-foreground",
                                            )}
                                          >
                                            <FreezeColumnIcon />
                                          </ContextMenuPrimitive.Item>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">
                                          {isFrozenTarget ? t("headerMenu.unfreeze") : t("headerMenu.freeze")}
                                        </TooltipContent>
                                      </Tooltip>

                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <ContextMenuPrimitive.Item
                                            disabled={isNameCol}
                                            aria-label={t("headerMenu.hide")}
                                            onSelect={() => project.stageTable.setColumnVisible(colId, false)}
                                            className="text-muted-foreground hover:bg-accent hover:text-foreground focus:bg-accent focus:text-foreground flex size-7 cursor-pointer items-center justify-center rounded-md outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-35"
                                          >
                                            <EyeOff className="size-3.5" />
                                          </ContextMenuPrimitive.Item>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">{t("headerMenu.hide")}</TooltipContent>
                                      </Tooltip>

                                      <div className="bg-border mx-0.5 h-4 w-px shrink-0" />

                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <ContextMenuPrimitive.Item
                                            disabled={!customCol || isProtectedTableColumn(customCol)}
                                            aria-label={
                                              isProtectedTableColumn(customCol)
                                                ? t("headerMenu.protectedCannotDelete")
                                                : t("headerMenu.delete")
                                            }
                                            onSelect={() => project.stageTable.deleteCustomColumn?.(colId)}
                                            className="text-muted-foreground hover:bg-destructive/15 hover:text-destructive focus:bg-destructive/15 focus:text-destructive flex size-7 cursor-pointer items-center justify-center rounded-md outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-35"
                                          >
                                            <Trash2 className="size-3.5" />
                                          </ContextMenuPrimitive.Item>
                                        </TooltipTrigger>
                                        <TooltipContent side="bottom">
                                          {isProtectedTableColumn(customCol)
                                            ? t("headerMenu.protectedCannotDelete")
                                            : t("headerMenu.delete")}
                                        </TooltipContent>
                                      </Tooltip>
                                    </div>
                                  </ContextMenuContent>
                                </ContextMenu>
                              )}
                            </div>
                          </PopoverAnchor>

                          <PopoverContent
                            align="start"
                            sideOffset={2}
                            className="w-auto p-0"
                            onOpenAutoFocus={(e) => e.preventDefault()}
                            onFocusOutside={(e) => {
                              const target = e.target as Element | null;
                              if (target?.closest?.(`[data-col-popover-anchor="${colId}"]`)) {
                                e.preventDefault();
                              }
                            }}
                            onPointerDownOutside={(e) => {
                              const target = e.target as Element | null;
                              if (
                                target?.closest?.(`[data-col-popover-anchor="${colId}"]`) ||
                                target?.closest?.("[data-stage-table-add-col]")
                              ) {
                                e.preventDefault();
                              }
                            }}
                            onWheel={(e) => e.stopPropagation()}
                            onMouseDown={(e) => e.stopPropagation()}
                          >
                            {isHeaderEditing && renderEditFieldFormContent(colId)}
                            {isCreatingThis && creatingColState && (
                              <FieldTypeGridPicker
                                selectedType={creatingColState.selectedType}
                                onSelectType={(chosenType) => commitCreatingColumn(chosenType)}
                                showTabNextHint
                                t={t}
                              />
                            )}
                          </PopoverContent>
                        </Popover>

                        {/* 拖拽落点高亮指示线 */}
                        {showDropBefore && (
                          <div className="bg-primary pointer-events-none absolute top-0 bottom-0 left-0 z-30 w-0.5" />
                        )}
                        {showDropAfter && (
                          <div className="bg-primary pointer-events-none absolute top-0 right-0 bottom-0 z-30 w-0.5" />
                        )}

                        {/* 列宽拖拽手柄 */}
                        <div
                          role="separator"
                          data-col-resizer={colId}
                          aria-orientation="vertical"
                          onPointerDown={(e) => startColumnResize(colId, width, e)}
                          className="hover:bg-primary/60 absolute top-0 -right-0.5 bottom-0 z-20 w-1.5 cursor-col-resize"
                        />
                      </th>
                    );
                  })}

                  {/* 列最右侧 + 号：点击新建自定义列并直接进入图 4 内联标题 + 双列类型选择 */}
                  <th className="border-border/50 bg-muted h-9 p-0 text-center select-none">
                    <button
                      type="button"
                      data-stage-table-add-col
                      aria-label={t("addColumnPopover.triggerAria")}
                      onClick={() => triggerInsertNewColumn()}
                      className="text-muted-foreground hover:bg-accent hover:text-foreground flex size-full items-center justify-center transition-colors"
                    >
                      <Plus className="size-3.5" />
                    </button>
                  </th>
                </tr>
              </thead>

              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td
                      colSpan={visibleColumnIds.length + 2}
                      className="text-muted-foreground py-12 text-center text-xs"
                    >
                      {allRows.length > 0 && hasAnyActiveFilter ? (
                        <div className="flex flex-col items-center gap-2">
                          <span>{t("sortFilter.noFilterMatch")}</span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => project.stageTable.clearAllFilters?.()}
                            className="h-7 px-3 text-xs"
                          >
                            {t("sortFilter.clearAllFilters")}
                          </Button>
                        </div>
                      ) : (
                        t("emptyCanvas")
                      )}
                    </td>
                  </tr>
                ) : (
                  rows.map((row, rowIndex) => {
                    const isRowSelected =
                      selection.mode === "all" || (selection.mode === "rows" && selection.rowIds.has(row.uuid));
                    return (
                      <tr
                        key={row.uuid}
                        data-stage-table-row-id={row.uuid}
                        data-row-selected={isRowSelected ? "true" : undefined}
                        className={cn(
                          "group/row border-border/40 border-b transition-colors",
                          tableRowHeightClass,
                          !isRowSelected && "hover:bg-muted/30",
                        )}
                      >
                        {/* 从上到下 1, 2, 3... 行计数（点击/Shift/Ctrl/拖动选中单行或多行并同步画布） */}
                        <td
                          data-stage-table-row-index
                          data-row-id={row.uuid}
                          onPointerDown={(e) => handleRowIndexPointerDown(row.uuid, e)}
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
                          const customCol = customColumnMap.get(colId);
                          const isFrozen = colIdx <= frozenEndIndex;
                          const isFreezeBoundary = colIdx === frozenEndIndex;
                          const isColSelected =
                            selection.mode === "all" || (selection.mode === "columns" && selection.colIds.has(colId));
                          const isCellSelected =
                            selection.mode === "cells" && selection.cells.has(makeCellKey(row.uuid, colId));
                          const isActiveCell =
                            selection.mode === "cells" &&
                            selection.activeCell?.rowId === row.uuid &&
                            selection.activeCell?.colId === colId;
                          const isSelectedAny = isRowSelected || isColSelected || isCellSelected;

                          return (
                            <td
                              key={colId}
                              data-stage-table-cell
                              data-row-id={row.uuid}
                              data-col-id={colId}
                              data-cell-selected={isSelectedAny ? "true" : undefined}
                              data-cell-active={isActiveCell ? "true" : undefined}
                              onPointerDown={(e) => handleCellPointerDown(row.uuid, colId, e)}
                              onClickCapture={(e) => {
                                if (suppressCellClickRef.current || e.shiftKey || e.ctrlKey || e.metaKey) {
                                  e.preventDefault();
                                  e.stopPropagation();
                                }
                              }}
                              style={isFrozen ? { left: `${columnLeftOffsets[colIdx]}px` } : undefined}
                              className={cn(
                                "border-border/40 overflow-hidden border-r p-0 align-middle",
                                isFrozen ? "bg-background sticky z-10" : "relative",
                                isFrozen && !isSelectedAny && "group-hover/row:bg-muted",
                                isFreezeBoundary && "border-r-primary/45 border-r-2",
                                isSelectedAny &&
                                  "after:bg-primary/12 after:pointer-events-none after:absolute after:inset-0",
                                isActiveCell && "after:ring-primary after:ring-2 after:ring-inset",
                              )}
                            >
                              {colId === "name" && (
                                <PrimaryTextCell
                                  row={row}
                                  t={t}
                                  canEditOnClick={() => wasSoleActiveOnDownRef.current}
                                  onCommit={(nextText) => project.stageTable.updateRowPrimaryText(row.uuid, nextText)}
                                  onJump={() => project.stageTable.focusRowOnCanvas(row.uuid)}
                                />
                              )}

                              {colId === "images" && (
                                <ImagesCell
                                  project={project}
                                  images={row.images ?? []}
                                  disabled={row.canEditImages === false}
                                  onAddImages={(blobs) => {
                                    void project.stageTable.addRowImages?.(row.uuid, blobs);
                                  }}
                                  onRemoveImage={(imgUuid) => {
                                    project.stageTable.removeRowImage?.(row.uuid, imgUuid);
                                  }}
                                  onPreviewImage={(attachmentId) => openImagePreview(attachmentId, row.uuid)}
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

                              {colId === "parents" && (
                                <MultiRelationCell
                                  selectedItems={row.parents}
                                  candidates={allRows.filter((c) => c.uuid !== row.uuid)}
                                  placeholder={t("relationPlaceholder")}
                                  searchPlaceholder={t("searchNodePlaceholder")}
                                  emptyText={t("noMatchingNodes")}
                                  onChange={(nextIds) => project.stageTable.setRowParents(row.uuid, nextIds)}
                                  t={t}
                                />
                              )}

                              {colId === "children" && (
                                <MultiRelationCell
                                  selectedItems={row.children}
                                  candidates={allRows.filter((c) => c.uuid !== row.uuid)}
                                  placeholder={t("relationPlaceholder")}
                                  searchPlaceholder={t("searchNodePlaceholder")}
                                  emptyText={t("noMatchingNodes")}
                                  onChange={(nextIds) => project.stageTable.setRowChildren(row.uuid, nextIds)}
                                  t={t}
                                />
                              )}

                              {colId === "outer" && (
                                <SingleRelationCell
                                  selectedItem={row.outer}
                                  candidates={getOuterCandidatesForRow(row)}
                                  placeholder={t("relationPlaceholder")}
                                  searchPlaceholder={t("searchNodePlaceholder")}
                                  emptyText={t("noMatchingNodes")}
                                  onChange={(nextId) => project.stageTable.setRowOuter(row.uuid, nextId)}
                                  t={t}
                                />
                              )}

                              {colId === "inner" && (
                                <MultiRelationCell
                                  selectedItems={row.inner}
                                  candidates={getInnerCandidatesForRow(row)}
                                  disabled={!row.canEditInner}
                                  placeholder={t("relationPlaceholder")}
                                  searchPlaceholder={t("searchNodePlaceholder")}
                                  emptyText={t("noMatchingNodes")}
                                  onChange={(nextIds) => project.stageTable.setRowInner(row.uuid, nextIds)}
                                  t={t}
                                />
                              )}

                              {customCol && customCol.type === "text" && (
                                <TextCustomCell
                                  value={row.tableFields?.[customCol.id]}
                                  canEditOnClick={() => wasSoleActiveOnDownRef.current}
                                  onCommit={(nextVal) =>
                                    project.stageTable.updateRowCustomField(row.uuid, customCol.id, nextVal)
                                  }
                                />
                              )}

                              {customCol && customCol.type === "number" && (
                                <NumberCustomCell
                                  value={row.tableFields?.[customCol.id]}
                                  canEditOnClick={() => wasSoleActiveOnDownRef.current}
                                  onCommit={(nextVal) =>
                                    project.stageTable.updateRowCustomField(row.uuid, customCol.id, nextVal)
                                  }
                                />
                              )}

                              {customCol && customCol.type === "date" && (
                                <DateCustomCell
                                  value={row.tableFields?.[customCol.id]}
                                  onCommit={(nextVal) =>
                                    project.stageTable.updateRowCustomField(row.uuid, customCol.id, nextVal)
                                  }
                                  t={t}
                                />
                              )}

                              {customCol && (customCol.type === "select" || customCol.type === "multi_select") && (
                                <SelectCustomCell
                                  column={customCol}
                                  value={row.tableFields?.[customCol.id]}
                                  onCommit={(nextVal) =>
                                    project.stageTable.updateRowCustomField(row.uuid, customCol.id, nextVal)
                                  }
                                  onCreateOrGetOption={(optName) =>
                                    project.stageTable.createOrGetSelectOption?.(customCol.id, optName) ?? null
                                  }
                                  t={t}
                                />
                              )}

                              {customCol &&
                                customCol.type === "formula" &&
                                (() => {
                                  const evaluated = row.formulaValues?.[customCol.id];
                                  const hasFormulaExpr = Boolean(customCol.formula?.trim());
                                  return (
                                    <div
                                      data-formula-cell={customCol.id}
                                      onDoubleClick={(e) => {
                                        e.stopPropagation();
                                        openFormulaEditorForColumn(customCol.id, row.uuid);
                                      }}
                                      title={
                                        evaluated?.kind === "error"
                                          ? `${evaluated.errorCode}: ${evaluated.errorMessage ?? ""}`
                                          : evaluated?.displayText ||
                                            (hasFormulaExpr ? "" : t("formulaEditor.doubleClickHint"))
                                      }
                                      className="flex h-full min-h-8 w-full cursor-default items-center px-2.5 py-1 text-xs select-none"
                                    >
                                      {evaluated?.kind === "error" ? (
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <span className="bg-destructive/15 text-destructive inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 font-mono text-[11px] font-medium">
                                              {evaluated.errorCode ?? "#ERROR!"}
                                            </span>
                                          </TooltipTrigger>
                                          <TooltipContent side="top" className="max-w-72 text-xs">
                                            {evaluated.errorMessage || evaluated.errorCode}
                                          </TooltipContent>
                                        </Tooltip>
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
                                      ) : evaluated?.kind === "list" &&
                                        evaluated.listItems &&
                                        evaluated.listItems.length > 0 ? (
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
                                        <span
                                          className={cn(
                                            "truncate",
                                            (evaluated.kind === "number" || evaluated.kind === "date") &&
                                              "tabular-nums",
                                          )}
                                        >
                                          {evaluated.displayText}
                                        </span>
                                      ) : !hasFormulaExpr ? (
                                        <span className="text-muted-foreground/45 truncate text-[11px] italic">
                                          {t("formulaEditor.unsetFormula")}
                                        </span>
                                      ) : null}
                                    </div>
                                  );
                                })()}
                            </td>
                          );
                        })}

                        {/* + 列对应的右侧占位单元格 */}
                        <td className="p-0" />
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </TableScrollContainer>
        </>
      )}

      {/* 记录详情编辑弹窗（供看板 / 甘特 / 画册 / 日历视图快捷编辑全部字段） */}
      <StageTableRecordDialog
        project={project}
        row={recordDialogRow}
        customColumns={customColumns}
        getColumnLabel={getColumnLabel}
        onClose={() => setRecordDialogRowUuid(null)}
        onPreviewImage={(attId, rowUuid) => openImagePreview(attId, rowUuid)}
        onOpenFormulaEditor={(colId, rowUuid) => {
          setRecordDialogRowUuid(null);
          openFormulaEditorForColumn(colId, rowUuid);
        }}
        t={t}
      />

      {/* 当从顶部「属性」面板编辑一个当前隐藏列时的悬浮图 1 面板兜底 */}
      <DialogPrimitive.Root
        open={editingFieldState !== null && editingFieldState.anchor === "floating"}
        onOpenChange={(open) => {
          if (!open) {
            setEditTypeDropdownOpen(false);
            setEditingFieldState(null);
          }
        }}
      >
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/25" />
          <DialogPrimitive.Content
            onOpenAutoFocus={(e) => e.preventDefault()}
            onWheel={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            className="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-50 -translate-x-1/2 -translate-y-1/2 rounded-xl border shadow-xl outline-none"
          >
            <DialogPrimitive.Title className="sr-only">{t("headerMenu.editField")}</DialogPrimitive.Title>
            {editingFieldState && renderEditFieldFormContent(editingFieldState.colId)}
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>

      {/* 公式编辑器弹窗（高配版：蓝色列胶囊 + 双栏函数文档 + 实时首行预览） */}
      {(() => {
        const targetCol = formulaEditorState ? customColumnMap.get(formulaEditorState.colId) : undefined;
        return (
          <StageTableFormulaEditorDialog
            open={Boolean(formulaEditorState && targetCol)}
            onOpenChange={(open) => {
              if (!open) setFormulaEditorState(null);
            }}
            columnId={targetCol?.id ?? ""}
            columnName={targetCol?.name ?? ""}
            initialFormula={targetCol?.formula ?? ""}
            initialFormat={targetCol?.format}
            tableViewName={activeView.name || t("defaultViewName")}
            columns={formulaEditorColumnOptions}
            customColumnSchemas={customColumns}
            systemColumnNames={project.table?.systemColumnNames}
            systemColumnLabels={systemColumnLabels}
            rows={allRows}
            initialPreviewRowUuid={formulaEditorState?.previewRowUuid ?? null}
            onSave={({ name, formula, format }) => {
              if (!targetCol) return;
              project.stageTable.updateColumn?.(targetCol.id, {
                name,
                type: "formula",
                formula,
                format,
              });
            }}
            t={t}
          />
        );
      })()}

      {/* 升级版图片大图灯箱（左右箭头切换 + 底部缩略图预览跳转） */}
      <ImageLightbox
        project={project}
        open={previewLightboxState !== null}
        items={previewLightboxState?.items ?? []}
        initialIndex={previewLightboxState?.initialIndex ?? 0}
        allItems={previewLightboxState?.allItems}
        allInitialIndex={previewLightboxState?.allInitialIndex}
        onClose={() => setPreviewLightboxState(null)}
      />
    </div>
  );
}
