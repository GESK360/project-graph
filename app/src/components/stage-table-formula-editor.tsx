import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/utils/cn";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { StageTableRow } from "@/core/service/dataManageService/stageTableService/StageTableService";
import {
  COMMON_FORMULA_IDS,
  FORMULA_CATALOG_ITEMS,
  FORMULA_FORMAT_PRESETS,
  type FormulaCatalogCategory,
  type FormulaCatalogItem,
} from "@/core/service/dataManageService/stageTableService/formulaCatalog";
import {
  FORMULA_TABLE_REF_ID,
  evaluateSingleFormulaPreview,
  normalizeFormulaColumnRefs,
  validateColumnFormula,
} from "@/core/service/dataManageService/stageTableService/formulaEngine";
import type { CustomColumnType, SystemColumnId, TableColumnSchema } from "@/types/table";
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  Calendar as CalendarIcon,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  CircleDot,
  Clock,
  FunctionSquare,
  Hash,
  Image as ImageIcon,
  ListChecks,
  Package,
  Search,
  SquareDashed,
  Table2,
  Type,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface FormulaEditorColumnOption {
  id: string;
  name: string;
  kind: "system" | "custom";
  columnType: SystemColumnId | CustomColumnType;
  isSelf?: boolean;
}

export interface StageTableFormulaEditorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  columnId: string;
  columnName: string;
  initialFormula: string;
  initialFormat?: string;
  tableViewName: string;
  columns: FormulaEditorColumnOption[];
  customColumnSchemas: readonly TableColumnSchema[];
  systemColumnNames?: Partial<Record<SystemColumnId, string>>;
  systemColumnLabels?: Partial<Record<SystemColumnId, string>>;
  rows: readonly StageTableRow[];
  initialPreviewRowUuid?: string | null;
  onSave: (payload: { name: string; formula: string; format: string | null }) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

type SidebarItem =
  | { kind: "column"; id: string; col: FormulaEditorColumnOption }
  | { kind: "table"; id: typeof FORMULA_TABLE_REF_ID }
  | { kind: "catalog"; id: string; section: FormulaCatalogCategory; item: FormulaCatalogItem };

const REF_TOKEN_REGEX = /\{\{([^{}]+)\}\}/g;

function getColumnGlyphText(type: SystemColumnId | CustomColumnType): string {
  switch (type) {
    case "number":
      return "#";
    case "date":
    case "createdAt":
    case "updatedAt":
      return "📅";
    case "formula":
      return "fx";
    case "select":
      return "◉";
    case "multi_select":
      return "☰";
    case "images":
      return "🖼";
    case "parents":
      return "↗";
    case "children":
      return "↙";
    case "outer":
      return "▢";
    case "inner":
      return "▣";
    default:
      return "A";
  }
}

function EditorColumnIcon({ type, className }: { type: SystemColumnId | CustomColumnType; className?: string }) {
  const cls = cn("size-3.5 shrink-0 text-muted-foreground", className);
  switch (type) {
    case "name":
    case "text":
      return <Type className={cls} />;
    case "images":
      return <ImageIcon className={cls} />;
    case "createdAt":
    case "updatedAt":
      return <Clock className={cls} />;
    case "parents":
      return <ArrowUpRight className={cls} />;
    case "children":
      return <ArrowDownLeft className={cls} />;
    case "outer":
      return <SquareDashed className={cls} />;
    case "inner":
      return <Package className={cls} />;
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
  }
}

function serializeFormulaEditorDom(root: HTMLElement): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      out += (node.textContent ?? "").replace(/\u200B/g, "");
      return;
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      const refId = el.dataset.formulaRefId;
      if (refId) {
        out += `{{${refId}}}`;
        return;
      }
      if (el.tagName === "BR") {
        out += "\n";
        return;
      }
      if ((el.tagName === "DIV" || el.tagName === "P") && out.length > 0 && !out.endsWith("\n")) {
        out += "\n";
      }
      for (const child of Array.from(el.childNodes)) {
        walk(child);
      }
    }
  };
  for (const child of Array.from(root.childNodes)) {
    walk(child);
  }
  return out;
}

function createRefPillElement(
  doc: Document,
  refId: string,
  colMap: ReadonlyMap<string, FormulaEditorColumnOption>,
  tableLabel: string,
  deletedLabel: string,
): HTMLSpanElement {
  const pill = doc.createElement("span");
  pill.contentEditable = "false";
  pill.dataset.formulaRefId = refId;
  pill.setAttribute("data-formula-pill", refId);

  const isTable = refId === FORMULA_TABLE_REF_ID;
  const col = colMap.get(refId);
  const isDeleted = !isTable && !col;

  pill.className = cn(
    "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 mx-0.5 align-middle text-[11px] font-medium leading-tight select-none cursor-default",
    isTable
      ? "border-violet-500/45 bg-violet-500/15 text-violet-700 dark:text-violet-300"
      : isDeleted
        ? "border-destructive/50 bg-destructive/15 text-destructive"
        : "border-blue-500/50 bg-blue-500/15 text-blue-700 dark:text-blue-300",
  );

  const badge = doc.createElement("span");
  badge.className = "opacity-75 text-[10px] font-mono leading-none";
  badge.textContent = isTable ? "⊞" : col ? getColumnGlyphText(col.columnType) : "!";

  const label = doc.createElement("span");
  label.className = "max-w-36 truncate";
  label.textContent = isTable ? tableLabel : col ? col.name : deletedLabel;

  pill.appendChild(badge);
  pill.appendChild(label);
  return pill;
}

function renderFormulaIntoDom(
  root: HTMLElement,
  formula: string,
  colMap: ReadonlyMap<string, FormulaEditorColumnOption>,
  tableLabel: string,
  deletedLabel: string,
): void {
  const doc = root.ownerDocument;
  root.innerHTML = "";
  let lastIndex = 0;
  REF_TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = REF_TOKEN_REGEX.exec(formula)) !== null) {
    if (match.index > lastIndex) {
      root.appendChild(doc.createTextNode(formula.slice(lastIndex, match.index)));
    }
    const refId = match[1].trim();
    root.appendChild(createRefPillElement(doc, refId, colMap, tableLabel, deletedLabel));
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < formula.length) {
    root.appendChild(doc.createTextNode(formula.slice(lastIndex)));
  }
}

export function FormulaPillPreview({
  formula,
  colMap,
  tableLabel,
  deletedLabel,
  className,
}: {
  formula: string;
  colMap: ReadonlyMap<string, FormulaEditorColumnOption>;
  tableLabel: string;
  deletedLabel: string;
  className?: string;
}) {
  const parts = useMemo(() => {
    const tokens: Array<{ kind: "text"; text: string } | { kind: "ref"; refId: string }> = [];
    let lastIndex = 0;
    const regex = /\{\{([^{}]+)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(formula)) !== null) {
      if (m.index > lastIndex) {
        tokens.push({ kind: "text", text: formula.slice(lastIndex, m.index) });
      }
      tokens.push({ kind: "ref", refId: m[1].trim() });
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < formula.length) {
      tokens.push({ kind: "text", text: formula.slice(lastIndex) });
    }
    return tokens;
  }, [formula]);

  if (!formula.trim()) {
    return null;
  }

  return (
    <span className={cn("inline-flex flex-wrap items-center gap-0.5 font-mono text-xs", className)}>
      {parts.map((part, idx) => {
        if (part.kind === "text") {
          return (
            <span key={idx} className="whitespace-pre-wrap">
              {part.text}
            </span>
          );
        }
        const isTable = part.refId === FORMULA_TABLE_REF_ID;
        const col = colMap.get(part.refId);
        const isDeleted = !isTable && !col;
        return (
          <span
            key={idx}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.25 font-sans text-[11px] font-medium",
              isTable
                ? "border-violet-500/45 bg-violet-500/15 text-violet-700 dark:text-violet-300"
                : isDeleted
                  ? "border-destructive/50 bg-destructive/15 text-destructive"
                  : "border-blue-500/50 bg-blue-500/15 text-blue-700 dark:text-blue-300",
            )}
          >
            <span>{isTable ? tableLabel : col ? col.name : deletedLabel}</span>
          </span>
        );
      })}
    </span>
  );
}

function getPreviewColumnRawDisplay(row: StageTableRow | undefined, col: FormulaEditorColumnOption): string {
  if (!row) return "-";
  if (col.kind === "system") {
    switch (col.id as SystemColumnId) {
      case "name":
        return row.primaryText || "-";
      case "images":
        return `${row.images.length}`;
      case "createdAt":
        return row.createdAt > 0 ? new Date(row.createdAt).toLocaleString() : "-";
      case "updatedAt":
        return row.updatedAt > 0 ? new Date(row.updatedAt).toLocaleString() : "-";
      case "parents":
        return row.parents.map((p) => p.label).join(", ") || "-";
      case "children":
        return row.children.map((c) => c.label).join(", ") || "-";
      case "outer":
        return row.outer?.label || "-";
      case "inner":
        return row.inner.map((i) => i.label).join(", ") || "-";
    }
  }
  if (col.columnType === "formula") {
    return row.formulaValues[col.id]?.displayText || "-";
  }
  const raw = row.tableFields[col.id];
  if (raw === null || raw === undefined) return "-";
  if (Array.isArray(raw)) return raw.join(", ") || "-";
  return String(raw);
}

export function StageTableFormulaEditorDialog({
  open,
  onOpenChange,
  columnId,
  columnName,
  initialFormula,
  initialFormat,
  tableViewName,
  columns,
  customColumnSchemas,
  systemColumnNames,
  systemColumnLabels,
  rows,
  initialPreviewRowUuid,
  onSave,
  t,
}: StageTableFormulaEditorDialogProps) {
  const [draftName, setDraftName] = useState(columnName);
  const [draftFormula, setDraftFormula] = useState(initialFormula);
  const [draftFormat, setDraftFormat] = useState<string>(initialFormat ?? "");
  const [searchQuery, setSearchQuery] = useState("");
  const [previewRowIdx, setPreviewRowIdx] = useState(0);
  const [activeItemKey, setActiveItemKey] = useState<string>("");

  const editorRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const lastDomSyncedFormulaRef = useRef<string | null>(null);

  const tableLabel = t("formulaEditor.currentTable");
  const deletedLabel = t("formulaEditor.deletedColumn");

  const colMap = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);

  // Reset state whenever dialog opens for a column
  useEffect(() => {
    if (!open) return;
    setDraftName(columnName);
    setDraftFormula(initialFormula);
    setDraftFormat(initialFormat ?? "");
    setSearchQuery("");
    const targetIdx = initialPreviewRowUuid ? rows.findIndex((r) => r.uuid === initialPreviewRowUuid) : 0;
    setPreviewRowIdx(targetIdx >= 0 ? targetIdx : 0);
    lastDomSyncedFormulaRef.current = null;
    savedRangeRef.current = null;

    const firstCol = columns.find((c) => !c.isSelf);
    setActiveItemKey(firstCol ? `col:${firstCol.id}` : `cat:common:IF`);
  }, [open, columnId, columnName, initialFormula, initialFormat, initialPreviewRowUuid]);

  // Populate contenteditable DOM when dialog opens or formula is programmatically synced
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => {
      const el = editorRef.current;
      if (!el) return;
      if (lastDomSyncedFormulaRef.current !== draftFormula) {
        renderFormulaIntoDom(el, draftFormula, colMap, tableLabel, deletedLabel);
        lastDomSyncedFormulaRef.current = draftFormula;
      }
      if (!savedRangeRef.current) {
        el.focus();
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        range.collapse(false);
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(range);
        }
        savedRangeRef.current = range.cloneRange();
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [open, draftFormula, colMap, tableLabel, deletedLabel]);

  const captureCaretRange = useCallback(() => {
    const el = editorRef.current;
    const sel = window.getSelection();
    if (!el || !sel || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    if (el.contains(range.commonAncestorContainer)) {
      savedRangeRef.current = range.cloneRange();
    }
  }, []);

  const syncFromEditorDom = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const serialized = serializeFormulaEditorDom(el);
    lastDomSyncedFormulaRef.current = serialized;
    setDraftFormula(serialized);
  }, []);

  const getActiveInsertionRange = useCallback((): Range | null => {
    const el = editorRef.current;
    if (!el) return null;
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      const liveRange = sel.getRangeAt(0);
      if (el.contains(liveRange.commonAncestorContainer)) {
        return liveRange;
      }
    }
    if (savedRangeRef.current && el.contains(savedRangeRef.current.commonAncestorContainer)) {
      return savedRangeRef.current.cloneRange();
    }
    const endRange = el.ownerDocument.createRange();
    endRange.selectNodeContents(el);
    endRange.collapse(false);
    return endRange;
  }, []);

  const applySelectionRange = useCallback((range: Range) => {
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    if (sel) {
      sel.removeAllRanges();
      sel.addRange(range);
    }
    savedRangeRef.current = range.cloneRange();
  }, []);

  const insertRefPillAtCaret = useCallback(
    (refId: string) => {
      const el = editorRef.current;
      if (!el) return;
      const range = getActiveInsertionRange();
      if (!range) return;

      range.deleteContents();
      const pill = createRefPillElement(el.ownerDocument, refId, colMap, tableLabel, deletedLabel);
      range.insertNode(pill);

      const afterRange = el.ownerDocument.createRange();
      afterRange.setStartAfter(pill);
      afterRange.collapse(true);
      applySelectionRange(afterRange);
      syncFromEditorDom();
    },
    [applySelectionRange, colMap, deletedLabel, getActiveInsertionRange, syncFromEditorDom, tableLabel],
  );

  const insertSnippetAtCaret = useCallback(
    (text: string, cursorBackOffset = 0) => {
      const el = editorRef.current;
      if (!el) return;
      const range = getActiveInsertionRange();
      if (!range) return;

      range.deleteContents();
      const textNode = el.ownerDocument.createTextNode(text);
      range.insertNode(textNode);

      const caretPos = Math.max(0, text.length - cursorBackOffset);
      const afterRange = el.ownerDocument.createRange();
      afterRange.setStart(textNode, caretPos);
      afterRange.collapse(true);
      applySelectionRange(afterRange);
      syncFromEditorDom();
    },
    [applySelectionRange, getActiveInsertionRange, syncFromEditorDom],
  );

  // Build searchable grouped sidebar items (matching screenshots: Columns / Table / Common / Number / Logic / Text / Date / List / Operators)
  const catalogById = useMemo(() => new Map(FORMULA_CATALOG_ITEMS.map((item) => [item.id, item])), []);

  const sidebarSections = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();

    const matchesText = (...texts: Array<string | undefined>) =>
      !q || texts.some((txt) => txt?.toLowerCase().includes(q));

    const columnItems: Array<{ key: string; item: SidebarItem }> = columns
      .filter((col) => !col.isSelf && matchesText(col.name, col.id))
      .map((col) => ({
        key: `col:${col.id}`,
        item: { kind: "column", id: col.id, col },
      }));

    const tableItems: Array<{ key: string; item: SidebarItem }> = matchesText(
      tableLabel,
      "当前表",
      "CURRENT_TABLE",
      "table",
    )
      ? [{ key: `table:${FORMULA_TABLE_REF_ID}`, item: { kind: "table", id: FORMULA_TABLE_REF_ID } }]
      : [];

    const commonItems: Array<{ key: string; item: SidebarItem }> = COMMON_FORMULA_IDS.map((id) => catalogById.get(id))
      .filter((fn): fn is FormulaCatalogItem => Boolean(fn))
      .filter((fn) => matchesText(fn.name, fn.summary, fn.signature))
      .map((fn) => ({
        key: `cat:common:${fn.id}`,
        item: { kind: "catalog", id: fn.id, section: "common", item: fn },
      }));

    const buildCategory = (cat: Exclude<FormulaCatalogCategory, "common">) =>
      FORMULA_CATALOG_ITEMS.filter((fn) => fn.category === cat && matchesText(fn.name, fn.summary, fn.signature)).map(
        (fn) => ({
          key: `cat:${cat}:${fn.id}`,
          item: { kind: "catalog" as const, id: fn.id, section: cat, item: fn },
        }),
      );

    const sections: Array<{
      id: string;
      label: string;
      items: Array<{ key: string; item: SidebarItem }>;
    }> = [
      { id: "columns", label: t("formulaEditor.groups.columns"), items: columnItems },
      { id: "table", label: t("formulaEditor.groups.table"), items: tableItems },
      { id: "common", label: t("formulaEditor.groups.common"), items: commonItems },
      { id: "number", label: t("formulaEditor.groups.number"), items: buildCategory("number") },
      { id: "logic", label: t("formulaEditor.groups.logic"), items: buildCategory("logic") },
      { id: "text", label: t("formulaEditor.groups.text"), items: buildCategory("text") },
      { id: "date", label: t("formulaEditor.groups.date"), items: buildCategory("date") },
      { id: "list", label: t("formulaEditor.groups.list"), items: buildCategory("list") },
      { id: "operator", label: t("formulaEditor.groups.operator"), items: buildCategory("operator") },
    ];

    return sections.filter((s) => s.items.length > 0);
  }, [catalogById, columns, searchQuery, t, tableLabel]);

  const flatSidebarItems = useMemo(() => sidebarSections.flatMap((s) => s.items), [sidebarSections]);

  const activeEntry = useMemo(() => {
    return flatSidebarItems.find((e) => e.key === activeItemKey) ?? flatSidebarItems[0] ?? null;
  }, [activeItemKey, flatSidebarItems]);

  const handleInsertSidebarItem = useCallback(
    (entry: SidebarItem) => {
      if (entry.kind === "column") {
        insertRefPillAtCaret(entry.col.id);
      } else if (entry.kind === "table") {
        insertRefPillAtCaret(FORMULA_TABLE_REF_ID);
      } else {
        insertSnippetAtCaret(entry.item.insertText, entry.item.cursorBackOffset ?? 0);
      }
    },
    [insertRefPillAtCaret, insertSnippetAtCaret],
  );

  // Live normalization, validation, and first-row preview
  const lookup = useMemo(
    () => ({
      columns: customColumnSchemas,
      systemColumnNames,
      systemColumnLabels,
    }),
    [customColumnSchemas, systemColumnLabels, systemColumnNames],
  );

  const normalizedFormula = useMemo(() => normalizeFormulaColumnRefs(draftFormula, lookup), [draftFormula, lookup]);

  const validation = useMemo(
    () => validateColumnFormula(columnId, normalizedFormula, lookup),
    [columnId, lookup, normalizedFormula],
  );

  const safePreviewIdx = rows.length > 0 ? Math.min(previewRowIdx, rows.length - 1) : 0;
  const previewRow = rows[safePreviewIdx];

  const previewResult = useMemo(() => {
    if (!previewRow || !normalizedFormula.trim()) return null;
    return evaluateSingleFormulaPreview(
      columnId,
      normalizedFormula,
      draftFormat || undefined,
      previewRow.uuid,
      rows,
      customColumnSchemas,
      { systemColumnNames, systemColumnLabels },
    );
  }, [
    columnId,
    customColumnSchemas,
    draftFormat,
    normalizedFormula,
    previewRow,
    rows,
    systemColumnLabels,
    systemColumnNames,
  ]);

  const handleConfirmSave = () => {
    const finalFormula = normalizedFormula.trim();
    onSave({
      name: draftName.trim() || columnName,
      formula: finalFormula,
      format: draftFormat.trim() ? draftFormat.trim() : null,
    });
    onOpenChange(false);
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();

    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      handleConfirmSave();
      return;
    }

    if (e.key === "Tab" && activeEntry) {
      e.preventDefault();
      handleInsertSidebarItem(activeEntry.item);
      return;
    }

    // Explicitly handle Backspace right after an atomic pill so deletion is always crisp
    if (e.key === "Backspace") {
      const sel = window.getSelection();
      const el = editorRef.current;
      if (sel && sel.isCollapsed && sel.rangeCount > 0 && el) {
        const range = sel.getRangeAt(0);
        const container = range.startContainer;
        const offset = range.startOffset;
        if (container === el && offset > 0) {
          const prev = el.childNodes[offset - 1];
          if (prev instanceof HTMLElement && prev.dataset.formulaRefId) {
            e.preventDefault();
            prev.remove();
            syncFromEditorDom();
            captureCaretRange();
            return;
          }
        } else if (container.nodeType === Node.TEXT_NODE && offset === 0) {
          const prev = container.previousSibling;
          if (prev instanceof HTMLElement && prev.dataset.formulaRefId) {
            e.preventDefault();
            prev.remove();
            syncFromEditorDom();
            captureCaretRange();
            return;
          }
        }
      }
    }
  };

  const handleEditorPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    e.preventDefault();
    const plain = e.clipboardData.getData("text/plain");
    if (!plain) return;
    const normalizedPaste = normalizeFormulaColumnRefs(plain, lookup);
    const el = editorRef.current;
    if (!el) return;
    const range = getActiveInsertionRange();
    if (!range) return;

    range.deleteContents();
    const frag = el.ownerDocument.createDocumentFragment();
    let lastIndex = 0;
    const regex = /\{\{([^{}]+)\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(normalizedPaste)) !== null) {
      if (m.index > lastIndex) {
        frag.appendChild(el.ownerDocument.createTextNode(normalizedPaste.slice(lastIndex, m.index)));
      }
      frag.appendChild(createRefPillElement(el.ownerDocument, m[1].trim(), colMap, tableLabel, deletedLabel));
      lastIndex = m.index + m[0].length;
    }
    if (lastIndex < normalizedPaste.length) {
      frag.appendChild(el.ownerDocument.createTextNode(normalizedPaste.slice(lastIndex)));
    }
    const lastInserted = frag.lastChild;
    range.insertNode(frag);
    if (lastInserted) {
      const afterRange = el.ownerDocument.createRange();
      afterRange.setStartAfter(lastInserted);
      afterRange.collapse(true);
      applySelectionRange(afterRange);
    }
    syncFromEditorDom();
  };

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/45 backdrop-blur-[1px]" />
        <DialogPrimitive.Content
          data-stage-table-formula-editor
          onOpenAutoFocus={(e) => e.preventDefault()}
          onWheel={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          className="bg-popover text-popover-foreground fixed top-1/2 left-1/2 z-50 flex h-[min(680px,88vh)] w-[min(860px,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border shadow-2xl outline-none"
        >
          {/* 顶部栏：标题 + 字段名 + 格式 + 关闭 */}
          <div className="border-border flex shrink-0 items-center justify-between gap-3 border-b px-4 py-2.5">
            <div className="flex min-w-0 flex-1 items-center gap-2.5">
              <div className="bg-primary/10 text-primary flex size-7 shrink-0 items-center justify-center rounded-md">
                <FunctionSquare className="size-4" />
              </div>
              <DialogPrimitive.Title className="shrink-0 text-sm font-semibold">
                {t("formulaEditor.title")}
              </DialogPrimitive.Title>
              <DialogPrimitive.Description className="sr-only">
                {t("formulaEditor.placeholder")}
              </DialogPrimitive.Description>
              <Input
                data-formula-column-name-input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t("fieldDialog.nameLabel")}
                className="h-7 max-w-48 text-xs"
              />
              <div className="ml-auto flex items-center gap-1.5">
                <span className="text-muted-foreground text-[11px]">{t("formulaEditor.formatLabel")}</span>
                <select
                  data-formula-format-select
                  value={draftFormat}
                  onChange={(e) => setDraftFormat(e.target.value)}
                  className="border-border bg-background text-foreground h-7 rounded-md border px-2 text-xs outline-none"
                >
                  {FORMULA_FORMAT_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.format ?? ""}>
                      {t(preset.labelKey)} ({preset.sample})
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <button
              type="button"
              aria-label={t("fieldDialog.cancel")}
              onClick={() => onOpenChange(false)}
              className="text-muted-foreground hover:bg-accent hover:text-foreground rounded-md p-1 transition-colors"
            >
              <X className="size-4" />
            </button>
          </div>

          {/* 公式输入区（支持原子蓝色列胶囊 + 自动换行） */}
          <div className="border-border bg-muted/20 shrink-0 border-b px-4 py-3">
            <div className="relative">
              <div
                ref={editorRef}
                role="textbox"
                aria-label={t("formulaEditor.inputAria")}
                data-formula-pill-input
                contentEditable
                suppressContentEditableWarning
                spellCheck={false}
                onInput={() => {
                  syncFromEditorDom();
                  captureCaretRange();
                }}
                onKeyDown={handleEditorKeyDown}
                onKeyUp={captureCaretRange}
                onMouseUp={captureCaretRange}
                onBlur={captureCaretRange}
                onPaste={handleEditorPaste}
                className={cn(
                  "border-border bg-background max-h-[140px] min-h-[78px] w-full overflow-y-auto rounded-lg border px-3 py-2 font-mono text-[13px] leading-6 transition-colors outline-none",
                  "focus:border-primary focus:ring-primary/30 focus:ring-2",
                  !validation.valid && "border-destructive/70 focus:border-destructive focus:ring-destructive/25",
                )}
              />
              {!draftFormula && (
                <div className="text-muted-foreground/60 pointer-events-none absolute top-2 left-3 text-xs leading-6 select-none">
                  {t("formulaEditor.placeholder")}
                </div>
              )}
            </div>

            {/* 实时校验与预览行结果条 */}
            <div className="mt-2 flex min-h-6 flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex min-w-0 items-center gap-2">
                {!validation.valid ? (
                  <span
                    data-formula-error-banner
                    className="text-destructive inline-flex items-center gap-1.5 font-medium"
                  >
                    <AlertCircle className="size-3.5 shrink-0" />
                    <span>
                      {validation.errorCode}: {validation.errorMessage}
                    </span>
                  </span>
                ) : draftFormula.trim() ? (
                  <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                    <CheckCircle2 className="size-3.5 shrink-0" />
                    <span>{t("formulaEditor.syntaxValid")}</span>
                  </span>
                ) : (
                  <span className="text-muted-foreground">{t("formulaEditor.tipHint")}</span>
                )}
              </div>

              {rows.length > 0 && (
                <div
                  data-formula-live-preview
                  className="bg-background/80 border-border/70 flex max-w-full items-center gap-2 rounded-md border px-2 py-0.5 text-[11px]"
                >
                  <span className="text-muted-foreground shrink-0">{t("formulaEditor.previewLabel")}</span>
                  {rows.length > 1 && (
                    <div className="flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => setPreviewRowIdx((idx) => (idx - 1 + rows.length) % rows.length)}
                        className="hover:bg-accent rounded p-0.5"
                        aria-label="Prev row"
                      >
                        <ChevronLeft className="size-3" />
                      </button>
                      <span className="text-muted-foreground tabular-nums">
                        {safePreviewIdx + 1}/{rows.length}
                      </span>
                      <button
                        type="button"
                        onClick={() => setPreviewRowIdx((idx) => (idx + 1) % rows.length)}
                        className="hover:bg-accent rounded p-0.5"
                        aria-label="Next row"
                      >
                        <ChevronRight className="size-3" />
                      </button>
                    </div>
                  )}
                  <span className="text-muted-foreground max-w-28 truncate">
                    {previewRow?.primaryText || t("fallbackLabels.unnamedNode")}
                  </span>
                  <span className="text-muted-foreground">=</span>
                  <span
                    data-formula-preview-value
                    className={cn(
                      "max-w-44 truncate font-mono font-semibold",
                      previewResult?.kind === "error" ? "text-destructive" : "text-foreground",
                    )}
                  >
                    {previewResult
                      ? previewResult.kind === "empty"
                        ? t("formulaEditor.emptyPreview")
                        : previewResult.displayText
                      : t("formulaEditor.emptyPreview")}
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* 中部双栏：左栏列/整表/函数/运算符目录 + 右栏实时交互文档（对齐 5 张参考截图） */}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* 左栏 */}
            <div className="border-border flex w-60 shrink-0 flex-col border-r">
              <div className="border-border/60 border-b p-2">
                <div className="relative">
                  <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
                  <Input
                    data-formula-sidebar-search
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (flatSidebarItems.length === 0) return;
                      const currentIdx = flatSidebarItems.findIndex((item) => item.key === activeEntry?.key);
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        const next = flatSidebarItems[(currentIdx + 1) % flatSidebarItems.length];
                        if (next) setActiveItemKey(next.key);
                      } else if (e.key === "ArrowUp") {
                        e.preventDefault();
                        const prev =
                          flatSidebarItems[(currentIdx - 1 + flatSidebarItems.length) % flatSidebarItems.length];
                        if (prev) setActiveItemKey(prev.key);
                      } else if ((e.key === "Enter" || e.key === "Tab") && activeEntry) {
                        e.preventDefault();
                        handleInsertSidebarItem(activeEntry.item);
                      }
                    }}
                    placeholder={t("formulaEditor.searchPlaceholder")}
                    className="h-7 pl-7 text-xs"
                  />
                </div>
              </div>

              <div className="flex-1 overflow-y-auto px-1.5 py-1.5">
                {sidebarSections.length === 0 ? (
                  <div className="text-muted-foreground px-2 py-6 text-center text-xs">
                    {t("formulaEditor.noSearchMatch")}
                  </div>
                ) : (
                  sidebarSections.map((section) => (
                    <div key={section.id} className="mb-2">
                      <div className="bg-muted/50 text-muted-foreground mb-0.5 rounded px-2 py-1 text-[11px] font-medium select-none">
                        {section.label}
                      </div>
                      <div className="flex flex-col gap-0.5">
                        {section.items.map(({ key, item }) => {
                          const isActive = activeEntry?.key === key;
                          return (
                            <button
                              key={key}
                              type="button"
                              data-formula-catalog-item={
                                item.kind === "column"
                                  ? `col:${item.col.id}`
                                  : item.kind === "table"
                                    ? `table:${FORMULA_TABLE_REF_ID}`
                                    : `fn:${item.item.id}`
                              }
                              onMouseEnter={() => setActiveItemKey(key)}
                              onFocus={() => setActiveItemKey(key)}
                              onMouseDown={(e) => {
                                // Keep caret range intact in editor
                                e.preventDefault();
                              }}
                              onClick={() => {
                                setActiveItemKey(key);
                                handleInsertSidebarItem(item);
                              }}
                              className={cn(
                                "flex w-full cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs transition-colors",
                                isActive
                                  ? "bg-primary/15 text-foreground font-medium"
                                  : "text-foreground/85 hover:bg-accent/60",
                              )}
                            >
                              <span className="flex min-w-0 items-center gap-2 truncate">
                                {item.kind === "column" && <EditorColumnIcon type={item.col.columnType} />}
                                {item.kind === "table" && <Table2 className="size-3.5 shrink-0 text-violet-500" />}
                                <span className={cn("truncate", item.kind === "catalog" && "font-mono tracking-tight")}>
                                  {item.kind === "column"
                                    ? item.col.name
                                    : item.kind === "table"
                                      ? tableLabel
                                      : item.item.name}
                                </span>
                              </span>
                              {isActive && (
                                <span className="border-border/80 bg-background/70 text-muted-foreground shrink-0 rounded border px-1 py-0.25 text-[10px]">
                                  Tab
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 右栏：字段 / 函数 / 运算符详细文档 */}
            <div className="flex-1 overflow-y-auto p-5 text-xs">
              {activeEntry?.item.kind === "column" && (
                <div className="space-y-4">
                  <div className="text-foreground text-sm font-semibold">{activeEntry.item.col.name}</div>
                  <p className="text-muted-foreground leading-relaxed">
                    {t("formulaEditor.columnDocPrefix")}{" "}
                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/45 bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
                      <Table2 className="size-3" />
                      {tableViewName}
                    </span>{" "}
                    {t("formulaEditor.columnDocMid")}{" "}
                    <span className="inline-flex items-center gap-1 rounded-full border border-blue-500/45 bg-blue-500/15 px-2 py-0.5 text-[11px] font-medium text-blue-700 dark:text-blue-300">
                      <EditorColumnIcon type={activeEntry.item.col.columnType} className="size-3 text-current" />
                      {activeEntry.item.col.name}
                    </span>
                    {t("formulaEditor.columnDocSuffix")}
                  </p>

                  {previewRow && (
                    <div className="border-border/70 bg-muted/35 rounded-lg border p-3">
                      <div className="text-muted-foreground mb-1 text-[11px]">
                        {t("formulaEditor.currentPreviewRowValue")}
                      </div>
                      <div className="font-mono text-xs font-medium">
                        {getPreviewColumnRawDisplay(previewRow, activeEntry.item.col)}
                      </div>
                    </div>
                  )}

                  {(activeEntry.item.col.id === "parents" ||
                    activeEntry.item.col.id === "children" ||
                    activeEntry.item.col.id === "inner" ||
                    activeEntry.item.col.id === "outer") && (
                    <div className="border-border/70 bg-muted/30 space-y-2 rounded-lg border p-3">
                      <div className="text-foreground font-medium">{t("formulaEditor.relationTipTitle")}</div>
                      <div className="text-muted-foreground space-y-1.5 font-mono text-[11px]">
                        <div>COUNT([{activeEntry.item.col.name}])</div>
                        {activeEntry.item.col.id !== "outer" ? (
                          <>
                            <div>[{activeEntry.item.col.name}].[掌握程度].AVERAGE()</div>
                            <div>
                              [{activeEntry.item.col.name}].FILTER(current.[是否到期] = &quot;待复习&quot;).COUNT()
                            </div>
                          </>
                        ) : (
                          <div>[{activeEntry.item.col.name}].[名称]</div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {activeEntry?.item.kind === "table" && (
                <div className="space-y-4">
                  <div className="text-foreground text-sm font-semibold">{tableLabel}</div>
                  <p className="text-muted-foreground leading-relaxed">{t("formulaEditor.tableRefDoc")}</p>
                  <div className="space-y-2">
                    <div className="text-foreground font-medium">{t("formulaEditor.examplesLabel")}</div>
                    <div className="border-border/70 bg-muted/35 space-y-1 rounded-lg border p-3 font-mono text-[11px]">
                      <div className="text-muted-foreground">{"// 统计整张表中待复习题数"}</div>
                      <div>COUNTIF([当前表].[是否到期], &quot;待复习&quot;)</div>
                    </div>
                    <div className="border-border/70 bg-muted/35 space-y-1 rounded-lg border p-3 font-mono text-[11px]">
                      <div className="text-muted-foreground">{"// 计算整张表的平均掌握程度"}</div>
                      <div>[当前表].[掌握程度].AVERAGE()</div>
                    </div>
                  </div>
                </div>
              )}

              {activeEntry?.item.kind === "catalog" && (
                <div className="space-y-4">
                  <div className="text-foreground font-mono text-sm font-semibold">
                    {activeEntry.item.item.signature}
                  </div>
                  <p className="text-muted-foreground leading-relaxed">{activeEntry.item.item.summary}</p>

                  {activeEntry.item.item.examples.length > 0 && (
                    <div className="space-y-2">
                      <div className="text-foreground font-medium">{t("formulaEditor.examplesLabel")}</div>
                      {activeEntry.item.item.examples.map((ex, idx) => (
                        <div
                          key={idx}
                          className="border-border/70 bg-muted/35 space-y-1 rounded-lg border p-3 font-mono text-[11px]"
                        >
                          {ex.comment && <div className="text-muted-foreground">{`// ${ex.comment}`}</div>}
                          <div className="text-foreground">{ex.expression}</div>
                          <div className="text-muted-foreground">= {ex.result}</div>
                        </div>
                      ))}
                    </div>
                  )}

                  {activeEntry.item.item.params && activeEntry.item.item.params.length > 0 && (
                    <div className="space-y-2.5">
                      {activeEntry.item.item.params.map((param, idx) => (
                        <div key={idx} className="space-y-1">
                          <div className="text-foreground font-medium">
                            {param.required ? `*${param.name}` : param.name}
                          </div>
                          <div className="border-border/70 bg-muted/35 text-muted-foreground rounded-lg border px-3 py-2 leading-relaxed">
                            {param.description}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* 底部按钮栏 */}
          <div className="border-border flex shrink-0 items-center justify-between border-t px-4 py-2.5">
            <div className="text-muted-foreground text-[11px]">{t("formulaEditor.shortcutHint")}</div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={() => onOpenChange(false)}
                className="h-7 px-3 text-xs"
              >
                {t("fieldDialog.cancel")}
              </Button>
              <Button
                type="button"
                size="sm"
                data-formula-editor-save
                disabled={!validation.valid}
                onClick={handleConfirmSave}
                className="h-7 px-3.5 text-xs"
              >
                {t("fieldDialog.confirm")}
              </Button>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
