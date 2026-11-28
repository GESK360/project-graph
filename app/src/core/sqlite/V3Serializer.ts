import type { Project } from "@/core/Project";
import { LATEST_PROJECT_VERSION } from "@/core/ProjectFile";
import { ConnectableEntity } from "@/core/stage/stageObject/abstract/ConnectableEntity";
import { Entity } from "@/core/stage/stageObject/abstract/StageEntity";
import { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import { ArcEdge } from "@/core/stage/stageObject/association/ArcEdge";
import { CubicCatmullRomSplineEdge } from "@/core/stage/stageObject/association/CubicCatmullRomSplineEdge";
import { LineEdge } from "@/core/stage/stageObject/association/LineEdge";
import {
  MultiTargetUndirectedEdge,
  type MultiTargetUndirectedEdgeRenderType,
  type UndirectedEdgeArrowShape,
  type UndirectedEdgeArrowType,
  type UndirectedEdgeLineType,
} from "@/core/stage/stageObject/association/MutiTargetUndirectedEdge";
import { SyncAssociation, type SyncableKey } from "@/core/stage/stageObject/association/SyncAssociation";
import { CollisionBox } from "@/core/stage/stageObject/collisionBox/collisionBox";
import { ConnectPoint } from "@/core/stage/stageObject/entity/ConnectPoint";
import { ExtensionEntity } from "@/core/stage/stageObject/entity/ExtensionEntity";
import { ImageNode } from "@/core/stage/stageObject/entity/ImageNode";
import { LatexNode } from "@/core/stage/stageObject/entity/LatexNode";
import { MediaNode, type MediaKind } from "@/core/stage/stageObject/entity/MediaNode";
import { PenStroke, PenStrokeSegment } from "@/core/stage/stageObject/entity/PenStroke";
import { ReferenceBlockNode } from "@/core/stage/stageObject/entity/ReferenceBlockNode";
import { Section } from "@/core/stage/stageObject/entity/Section";
import { SvgNode } from "@/core/stage/stageObject/entity/SvgNode";
import { TextNode } from "@/core/stage/stageObject/entity/TextNode";
import { UrlNode } from "@/core/stage/stageObject/entity/UrlNode";
import type { PrgMetadata } from "@/types/metadata";
import {
  createDefaultTableData,
  normalizeTableData,
  type CustomColumnType,
  type PrgTableData,
  type TableCellValue,
  type TableColumnSchema,
  type TableFields,
  type TableViewSchema,
  type TableViewType,
} from "@/types/table";
import { Color, Vector } from "@graphif/data-structures";
import { Rectangle } from "@graphif/shapes";
import type { Value } from "platejs";
import {
  isPackedV3DocumentOpenResult,
  type V3AnyDocumentOpenResult,
  type V3AssociationRecord,
  type V3CellValueRecord,
  type V3EdgeRecord,
  type V3EntityRecord,
  type V3ImportPayload,
  type V3MultiOptionEntry,
  type V3PackedDocumentOpenResult,
  type V3TableColumnRecord,
  type V3TableViewRecord,
} from "./DocClient";

type SerializedColor = [number, number, number, number];

function encodeColor(color?: Color): SerializedColor {
  if (!color) return [0, 0, 0, 0];
  return [color.r, color.g, color.b, color.a];
}

function decodeColor(raw: unknown): Color {
  if (Array.isArray(raw) && raw.length === 4 && raw.every((n) => typeof n === "number")) {
    return new Color(raw[0], raw[1], raw[2], raw[3]);
  }
  return Color.Transparent.clone();
}

function encodeVector(v?: Vector): [number, number] {
  if (!v) return [0.5, 0.5];
  return [Number.isFinite(v.x) ? v.x : 0.5, Number.isFinite(v.y) ? v.y : 0.5];
}

function decodeVector(raw: unknown, fallbackX = 0.5, fallbackY = 0.5): Vector {
  if (Array.isArray(raw) && raw.length >= 2 && typeof raw[0] === "number" && typeof raw[1] === "number") {
    return new Vector(raw[0], raw[1]);
  }
  return new Vector(fallbackX, fallbackY);
}

/** 轻量级 PlateJS `Value` 纯文本提取器，不实例化重型富文本编辑器，供 SQLite FTS5 索引使用。 */
export function extractPlainTextFromDetails(details: unknown): string {
  if (!Array.isArray(details) || details.length === 0) return "";
  const parts: string[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const rec = node as Record<string, unknown>;
    if (typeof rec.text === "string" && rec.text.length > 0) {
      parts.push(rec.text);
    }
    if (Array.isArray(rec.children)) {
      for (const child of rec.children) walk(child);
      if (typeof rec.type === "string" && parts.length > 0 && parts[parts.length - 1] !== "\n") {
        parts.push("\n");
      }
    }
  };
  for (const item of details) walk(item);
  return parts.join("").trim();
}

import { computeColumnCanonicalKey, decodeV3CellValue } from "./V3CellCodec";

export { computeColumnCanonicalKey, decodeV3CellValue };

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw || raw === "{}" || raw === "[]") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function getEntityGeometryRect(entity: Entity): { x: number; y: number; w: number; h: number } {
  if (entity instanceof Section) {
    const normalBox = (entity as unknown as { _collisionBoxNormal?: CollisionBox })._collisionBoxNormal;
    const rect = normalBox ? normalBox.getRectangle() : entity.rectangle;
    return {
      x: Number.isFinite(rect.location.x) ? rect.location.x : 0,
      y: Number.isFinite(rect.location.y) ? rect.location.y : 0,
      w: Number.isFinite(rect.size.x) ? rect.size.x : Section.MIN_WIDTH,
      h: Number.isFinite(rect.size.y) ? rect.size.y : Section.MIN_HEIGHT,
    };
  }
  if (entity instanceof PenStroke) {
    if (entity.segments.length === 0) {
      return { x: 0, y: 0, w: 0, h: 0 };
    }
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const seg of entity.segments) {
      minX = Math.min(minX, seg.location.x);
      minY = Math.min(minY, seg.location.y);
      maxX = Math.max(maxX, seg.location.x);
      maxY = Math.max(maxY, seg.location.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  const rect = entity.collisionBox.getRectangle();
  return {
    x: Number.isFinite(rect.location.x) ? rect.location.x : 0,
    y: Number.isFinite(rect.location.y) ? rect.location.y : 0,
    w: Number.isFinite(rect.size.x) ? rect.size.x : 0,
    h: Number.isFinite(rect.size.y) ? rect.size.y : 0,
  };
}

export function serializeColumnToV3Record(col: TableColumnSchema, position: number): V3TableColumnRecord {
  const canonicalKey = computeColumnCanonicalKey(col);
  const config: Record<string, unknown> = {};
  if (col.width !== undefined) config.width = col.width;
  if (col.options !== undefined) config.options = col.options;
  if (col.format !== undefined) config.format = col.format;
  if (col.formula !== undefined) config.formula = col.formula;
  if (col.protectedRole !== undefined) config.protectedRole = col.protectedRole;
  if (col.canonicalKey && col.canonicalKey.startsWith("ws:")) config.canonicalKey = col.canonicalKey;
  return {
    id: col.id,
    canonicalKey,
    name: col.name,
    type: col.type,
    position,
    configJson: JSON.stringify(config),
  };
}

export function serializeViewToV3Record(view: TableViewSchema, position: number): V3TableViewRecord {
  const { id, name, type, deletable, ...restConfig } = view;
  return {
    id,
    name,
    type,
    deletable,
    position,
    configJson: JSON.stringify(restConfig),
  };
}

export function serializeTableMetaJson(table: PrgTableData): string {
  return JSON.stringify({
    activeViewId: table.activeViewId,
    systemColumnNames: table.systemColumnNames,
  });
}

export function serializeCellValueToV3Record(
  entityUuid: string,
  col: TableColumnSchema,
  rawVal: TableCellValue,
): V3CellValueRecord | null {
  if (rawVal === null || rawVal === undefined || col.type === "formula") return null;
  const canonicalKey = computeColumnCanonicalKey(col);
  if (col.type === "number") {
    const num = typeof rawVal === "number" ? rawVal : Number(rawVal);
    if (!Number.isFinite(num)) return null;
    return {
      entityUuid,
      colId: col.id,
      canonicalKey,
      valType: "number",
      valText: String(num),
      valNum: num,
      valDate: null,
      valJson: null,
      multiOptions: [],
    };
  }
  if (col.type === "date") {
    const dateStr = String(rawVal);
    if (!dateStr) return null;
    return {
      entityUuid,
      colId: col.id,
      canonicalKey,
      valType: "date",
      valText: dateStr,
      valNum: null,
      valDate: dateStr,
      valJson: null,
      multiOptions: [],
    };
  }
  if (col.type === "select") {
    const optId = String(rawVal);
    if (!optId) return null;
    return {
      entityUuid,
      colId: col.id,
      canonicalKey,
      valType: "select",
      valText: optId,
      valNum: null,
      valDate: null,
      valJson: null,
      multiOptions: [],
    };
  }
  if (col.type === "multi_select") {
    const arr = Array.isArray(rawVal) ? rawVal.filter((v): v is string => typeof v === "string" && v !== "") : [];
    if (arr.length === 0) return null;
    const optionNameById = new Map<string, string>((col.options ?? []).map((opt) => [opt.id, opt.name]));
    const multiOptions: V3MultiOptionEntry[] = [...new Set(arr)].map((optionId) => ({
      optionId,
      optionName: optionNameById.get(optionId) ?? optionId,
    }));
    return {
      entityUuid,
      colId: col.id,
      canonicalKey,
      valType: "multi_select",
      valText: multiOptions.map((o) => o.optionName).join(","),
      valNum: null,
      valDate: null,
      valJson: JSON.stringify(arr),
      multiOptions,
    };
  }
  return {
    entityUuid,
    colId: col.id,
    canonicalKey,
    valType: "text",
    valText: String(rawVal),
    valNum: null,
    valDate: null,
    valJson: null,
    multiOptions: [],
  };
}

export function serializeEntityToV3Record(
  entity: Entity,
  sortOrder: number,
  parentSectionUuid?: string | null,
): V3EntityRecord | null {
  const rect = getEntityGeometryRect(entity);
  const resolvedParent = parentSectionUuid !== undefined ? parentSectionUuid : (entity.parentSection?.uuid ?? null);
  const detailsJson = JSON.stringify(entity.details ?? []);
  const detailsPlain = extractPlainTextFromDetails(entity.details);
  const createdAt = Number.isFinite(entity.createdAt) ? Math.trunc(entity.createdAt) : Date.now();
  const updatedAt = Number.isFinite(entity.updatedAt) ? Math.trunc(entity.updatedAt) : createdAt;

  let kind: V3EntityRecord["kind"];
  let text = "";
  let isRow = true;
  let props: Record<string, unknown>;

  if (entity instanceof TextNode) {
    kind = "text";
    text = entity.text;
    props = {
      color: encodeColor(entity.color),
      fontScaleLevel: entity.fontScaleLevel,
      sizeAdjust: entity.sizeAdjust,
      fontFamily: entity.fontFamily,
      fontWeight: entity.fontWeight,
      borderStyle: entity.borderStyle,
    };
  } else if (entity instanceof Section) {
    kind = "section";
    text = entity.text;
    props = {
      color: encodeColor(entity.color),
      isCollapsed: entity.isCollapsed,
      locked: entity.locked,
      borderStyle: entity.borderStyle,
      sizeAdjust: entity.sizeAdjust,
      childOrder: entity.children.map((c) => c.uuid),
    };
  } else if (entity instanceof ImageNode) {
    kind = "image";
    isRow = false;
    props = {
      attachmentId: entity.attachmentId,
      scale: entity.scale,
      isBackground: entity.isBackground,
    };
  } else if (entity instanceof UrlNode) {
    kind = "url";
    text = entity.title;
    props = {
      title: entity.title,
      url: entity.url,
      color: encodeColor(entity.color),
    };
  } else if (entity instanceof LatexNode) {
    kind = "latex";
    text = entity.latexSource;
    props = {
      latexSource: entity.latexSource,
      color: encodeColor(entity.color),
      fontScaleLevel: entity.fontScaleLevel,
    };
  } else if (entity instanceof MediaNode) {
    kind = "media";
    text = entity.title;
    props = {
      attachmentId: entity.attachmentId,
      mediaKind: entity.mediaKind,
      title: entity.title,
    };
  } else if (entity instanceof SvgNode) {
    kind = "svg";
    props = {
      attachmentId: entity.attachmentId,
      scale: entity.scale,
      color: encodeColor(entity.color),
    };
  } else if (entity instanceof ReferenceBlockNode) {
    kind = "reference";
    text = entity.sectionName ? `[[${entity.fileName}#${entity.sectionName}]]` : `[[${entity.fileName}]]`;
    props = {
      fileName: entity.fileName,
      sectionName: entity.sectionName,
      scale: entity.scale,
      attachmentId: entity.attachmentId,
    };
  } else if (entity instanceof ExtensionEntity) {
    kind = "extension";
    text = entity.typeName;
    props = {
      extensionId: entity.extensionId,
      typeName: entity.typeName,
      customData: entity.customData,
    };
  } else if (entity instanceof ConnectPoint) {
    kind = "connect_point";
    isRow = false;
    props = {};
  } else if (entity instanceof PenStroke) {
    kind = "pen_stroke";
    isRow = false;
    props = {
      color: encodeColor(entity.color),
      width: entity.width,
      segments: entity.segments.map((s) => ({
        x: s.location.x,
        y: s.location.y,
        pressure: s.pressure,
      })),
    };
  } else {
    return null;
  }

  return {
    uuid: entity.uuid,
    kind,
    parentSectionUuid: resolvedParent,
    text,
    detailsJson,
    detailsPlain,
    x: rect.x,
    y: rect.y,
    w: rect.w,
    h: rect.h,
    propsJson: JSON.stringify(props),
    createdAt,
    updatedAt,
    isRow,
    sortOrder,
  };
}

export function serializeEdgeToV3Record(
  obj: LineEdge | ArcEdge | CubicCatmullRomSplineEdge,
  sortOrder: number,
): V3EdgeRecord | null {
  if (obj instanceof LineEdge) {
    if (!obj.source || !obj.target) return null;
    return {
      uuid: obj.uuid,
      kind: "line",
      sourceUuid: obj.source.uuid,
      targetUuid: obj.target.uuid,
      text: obj.text,
      propsJson: JSON.stringify({
        color: encodeColor(obj.color),
        lineType: obj.lineType,
        arrowType: obj.arrowType,
        isBranchCollapsed: obj.isBranchCollapsed,
        sourceRectangleRate: encodeVector(obj.sourceRectangleRate),
        targetRectangleRate: encodeVector(obj.targetRectangleRate),
      }),
      sortOrder,
    };
  }
  if (obj instanceof ArcEdge) {
    if (!obj.source || !obj.target) return null;
    return {
      uuid: obj.uuid,
      kind: "arc",
      sourceUuid: obj.source.uuid,
      targetUuid: obj.target.uuid,
      text: obj.text,
      propsJson: JSON.stringify({
        color: encodeColor(obj.color),
        lineType: obj.lineType,
        arrowType: obj.arrowType,
        offset: obj.offset,
        textPosition: obj.textPosition,
        sourceRectangleRate: encodeVector(obj.sourceRectangleRate),
        targetRectangleRate: encodeVector(obj.targetRectangleRate),
      }),
      sortOrder,
    };
  }
  const sourceUuid = obj.source?.uuid ?? (obj as unknown as { _source?: ConnectableEntity })._source?.uuid;
  const targetUuid = obj.target?.uuid ?? (obj as unknown as { _target?: ConnectableEntity })._target?.uuid;
  if (!sourceUuid || !targetUuid) return null;
  return {
    uuid: obj.uuid,
    kind: "cr_spline",
    sourceUuid,
    targetUuid,
    text: obj.text,
    propsJson: JSON.stringify({
      color: encodeColor(obj.color),
      alpha: obj.alpha,
      tension: obj.tension,
      controlPoints: obj.getControlPoints().map((pt) => [pt.x, pt.y]),
      sourceRectangleRate: encodeVector(obj.sourceRectangleRate),
      targetRectangleRate: encodeVector(obj.targetRectangleRate),
    }),
    sortOrder,
  };
}

export function serializeAssociationToV3Record(
  obj: MultiTargetUndirectedEdge | SyncAssociation,
  sortOrder: number,
): V3AssociationRecord {
  if (obj instanceof MultiTargetUndirectedEdge) {
    return {
      uuid: obj.uuid,
      kind: "multi_target",
      memberUuidsJson: JSON.stringify(obj.associationList.map((m) => m.uuid)),
      propsJson: JSON.stringify({
        text: obj.text,
        color: encodeColor(obj.color),
        rectRates: obj.rectRates.map((r) => [r.x, r.y]),
        centerRate: encodeVector(obj.centerRate),
        arrow: obj.arrow,
        arrowType: obj.arrowType,
        renderType: obj.renderType,
        lineType: obj.lineType,
        padding: obj.padding,
      }),
      sortOrder,
    };
  }
  return {
    uuid: obj.uuid,
    kind: "sync",
    memberUuidsJson: JSON.stringify(obj.associationList.map((m) => m.uuid)),
    propsJson: JSON.stringify({
      keys: obj.keys,
      color: encodeColor(obj.color),
    }),
    sortOrder,
  };
}

export function hydrateTableColumnsFromV3(records: V3TableColumnRecord[]): TableColumnSchema[] {
  return records.map((rec) => {
    const cfg = safeJsonParse<Partial<TableColumnSchema>>(rec.configJson, {});
    return {
      id: rec.id,
      name: rec.name,
      type: rec.type as CustomColumnType,
      ...(cfg.width !== undefined ? { width: cfg.width } : {}),
      ...(cfg.options !== undefined ? { options: cfg.options } : {}),
      ...(cfg.format !== undefined ? { format: cfg.format } : {}),
      ...(cfg.formula !== undefined ? { formula: cfg.formula } : {}),
      ...(cfg.protectedRole !== undefined ? { protectedRole: cfg.protectedRole } : {}),
      ...(rec.canonicalKey && rec.canonicalKey.startsWith("ws:")
        ? { canonicalKey: rec.canonicalKey, isShared: true }
        : cfg.canonicalKey
          ? { canonicalKey: cfg.canonicalKey }
          : {}),
    };
  });
}

export function hydrateTableViewsFromV3(records: V3TableViewRecord[]): TableViewSchema[] {
  return records.map((rec) => {
    const cfg = safeJsonParse<Partial<TableViewSchema>>(rec.configJson, {});
    return {
      ...cfg,
      id: rec.id,
      name: rec.name,
      type: rec.type as TableViewType,
      deletable: rec.deletable,
      visibleColumnIds: Array.isArray(cfg.visibleColumnIds) ? cfg.visibleColumnIds : ["name"],
    };
  });
}

export function instantiateEntityFromV3Record(
  project: Project,
  rec: V3EntityRecord,
  tableFields?: TableFields,
  options?: { deferBitmapLoad?: boolean },
): { entity: Entity; props: Record<string, unknown> } | undefined {
  const props = safeJsonParse<Record<string, unknown>>(rec.propsJson, {});
  const details = safeJsonParse<Value>(rec.detailsJson, []);
  const rect = new Rectangle(new Vector(rec.x, rec.y), new Vector(rec.w, rec.h));
  const collisionBox = new CollisionBox([rect]);

  let entity: Entity | undefined;
  switch (rec.kind) {
    case "text":
      entity = new TextNode(project, {
        uuid: rec.uuid,
        text: rec.text,
        details,
        collisionBox,
        color: decodeColor(props.color),
        fontScaleLevel: typeof props.fontScaleLevel === "number" ? props.fontScaleLevel : 0,
        sizeAdjust: props.sizeAdjust === "manual" ? "manual" : "auto",
        fontFamily: typeof props.fontFamily === "string" ? props.fontFamily : "",
        fontWeight: typeof props.fontWeight === "string" ? props.fontWeight : "",
        borderStyle: props.borderStyle === "dashed" || props.borderStyle === "none" ? props.borderStyle : "solid",
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tableFields,
      });
      break;
    case "section": {
      const normalBox = new CollisionBox(rect.getBoundingLines());
      entity = new Section(project, {
        uuid: rec.uuid,
        text: rec.text,
        details,
        _collisionBoxNormal: normalBox,
        color: decodeColor(props.color),
        isCollapsed: Boolean(props.isCollapsed),
        locked: Boolean(props.locked),
        borderStyle: props.borderStyle === "dashed" || props.borderStyle === "none" ? props.borderStyle : "solid",
        sizeAdjust: props.sizeAdjust === "manual" ? "manual" : "auto",
        children: [],
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tableFields,
      });
      break;
    }
    case "image":
      entity = new ImageNode(project, {
        uuid: rec.uuid,
        details,
        collisionBox,
        attachmentId: typeof props.attachmentId === "string" ? props.attachmentId : "",
        scale: typeof props.scale === "number" ? props.scale : 1,
        isBackground: Boolean(props.isBackground),
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tableFields,
        deferBitmapLoad: options?.deferBitmapLoad,
      });
      break;
    case "url":
      entity = new UrlNode(project, {
        uuid: rec.uuid,
        title: typeof props.title === "string" ? props.title : rec.text,
        url: typeof props.url === "string" ? props.url : "",
        details: details as never,
        collisionBox,
        color: decodeColor(props.color),
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tableFields,
      });
      break;
    case "latex":
      entity = new LatexNode(project, {
        uuid: rec.uuid,
        latexSource: typeof props.latexSource === "string" ? props.latexSource : rec.text,
        details,
        collisionBox,
        color: decodeColor(props.color),
        fontScaleLevel: typeof props.fontScaleLevel === "number" ? props.fontScaleLevel : 0,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tableFields,
      });
      break;
    case "media":
      entity = new MediaNode(project, {
        uuid: rec.uuid,
        details,
        collisionBox,
        attachmentId: typeof props.attachmentId === "string" ? props.attachmentId : "",
        mediaKind: props.mediaKind === "audio" ? "audio" : ("video" as MediaKind),
        title: typeof props.title === "string" ? props.title : rec.text,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tableFields,
      });
      break;
    case "svg":
      entity = new SvgNode(project, {
        uuid: rec.uuid as `${string}-${string}-${string}-${string}-${string}`,
        details: details as never,
        collisionBox,
        attachmentId: typeof props.attachmentId === "string" ? props.attachmentId : "",
        scale: typeof props.scale === "number" ? props.scale : 1,
        color: decodeColor(props.color),
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tableFields,
      });
      break;
    case "reference":
      entity = new ReferenceBlockNode(project, {
        uuid: rec.uuid,
        details: details as never,
        collisionBox,
        fileName: typeof props.fileName === "string" ? props.fileName : "",
        sectionName: typeof props.sectionName === "string" ? props.sectionName : "",
        scale: typeof props.scale === "number" ? props.scale : 1,
        attachmentId: typeof props.attachmentId === "string" ? props.attachmentId : "",
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tableFields,
      });
      break;
    case "extension":
      entity = new ExtensionEntity(project, {
        uuid: rec.uuid,
        details,
        collisionBox,
        extensionId: typeof props.extensionId === "string" ? props.extensionId : "",
        typeName: typeof props.typeName === "string" ? props.typeName : rec.text,
        customData: props.customData ?? {},
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tableFields,
      });
      break;
    case "connect_point":
      entity = new ConnectPoint(project, {
        uuid: rec.uuid,
        details: details as never,
        collisionBox,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tableFields,
      });
      break;
    case "pen_stroke": {
      const rawSegments = Array.isArray(props.segments) ? props.segments : [];
      const segments = rawSegments
        .filter((s): s is { x: number; y: number; pressure?: number } => Boolean(s && typeof s === "object"))
        .map(
          (s) =>
            new PenStrokeSegment(
              new Vector(Number(s.x) || 0, Number(s.y) || 0),
              typeof s.pressure === "number" ? s.pressure : 0.5,
            ),
        );
      entity = new PenStroke(project, {
        uuid: rec.uuid,
        segments,
        color: decodeColor(props.color),
        width: typeof props.width === "number" ? props.width : 5,
        createdAt: rec.createdAt,
        updatedAt: rec.updatedAt,
        tableFields,
      });
      break;
    }
  }
  return entity ? { entity, props } : undefined;
}

export function instantiateEdgeFromV3Record(
  project: Project,
  rec: V3EdgeRecord,
  lookupEntity: (uuid: string) => Entity | undefined,
): LineEdge | ArcEdge | CubicCatmullRomSplineEdge | undefined {
  const props = safeJsonParse<Record<string, unknown>>(rec.propsJson, {});
  const src = lookupEntity(rec.sourceUuid);
  const dst = lookupEntity(rec.targetUuid);
  if (!(src instanceof ConnectableEntity) || !(dst instanceof ConnectableEntity)) return undefined;

  if (rec.kind === "arc") {
    return new ArcEdge(project, {
      uuid: rec.uuid,
      associationList: [src, dst],
      text: rec.text,
      color: decodeColor(props.color),
      lineType: typeof props.lineType === "string" ? props.lineType : "solid",
      arrowType: typeof props.arrowType === "string" ? props.arrowType : "default",
      offset: typeof props.offset === "number" ? props.offset : 0,
      textPosition: typeof props.textPosition === "number" ? props.textPosition : 0.5,
      sourceRectangleRate: decodeVector(props.sourceRectangleRate),
      targetRectangleRate: decodeVector(props.targetRectangleRate),
    });
  }
  if (rec.kind === "cr_spline") {
    const cpRaw = Array.isArray(props.controlPoints) ? props.controlPoints : [];
    const controlPoints: [number, number][] = cpRaw
      .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2)
      .map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]);
    const cr = new CubicCatmullRomSplineEdge(project, {
      uuid: rec.uuid,
      source: src.uuid,
      target: dst.uuid,
      text: rec.text,
      type: "core:cublic_catmull_rom_spline_edge",
      alpha: typeof props.alpha === "number" ? props.alpha : 0.5,
      tension: typeof props.tension === "number" ? props.tension : 0,
      color: Array.isArray(props.color) && props.color.length === 4 ? (props.color as SerializedColor) : [0, 0, 0, 0],
      controlPoints,
      sourceRectRate: encodeVector(decodeVector(props.sourceRectangleRate)),
      targetRectRate: encodeVector(decodeVector(props.targetRectangleRate)),
    });
    cr.associationList = [src, dst];
    return cr;
  }
  return new LineEdge(project, {
    uuid: rec.uuid,
    associationList: [src, dst],
    text: rec.text,
    color: decodeColor(props.color),
    lineType: typeof props.lineType === "string" ? props.lineType : "solid",
    arrowType: typeof props.arrowType === "string" ? props.arrowType : "default",
    isBranchCollapsed: Boolean(props.isBranchCollapsed),
    sourceRectangleRate: decodeVector(props.sourceRectangleRate),
    targetRectangleRate: decodeVector(props.targetRectangleRate),
  });
}

export function instantiateAssociationFromV3Record(
  project: Project,
  rec: V3AssociationRecord,
  lookupObject: (uuid: string) => StageObject | undefined,
): MultiTargetUndirectedEdge | SyncAssociation | undefined {
  const props = safeJsonParse<Record<string, unknown>>(rec.propsJson, {});
  const memberUuids = safeJsonParse<string[]>(rec.memberUuidsJson, []);
  if (rec.kind === "multi_target") {
    const members = memberUuids
      .map((id) => lookupObject(id))
      .filter((m): m is ConnectableEntity => m instanceof ConnectableEntity);
    if (members.length < 2) return undefined;
    const rectRatesRaw = Array.isArray(props.rectRates) ? props.rectRates : [];
    const rectRates =
      rectRatesRaw.length === members.length
        ? rectRatesRaw.map((r) => decodeVector(r))
        : members.map(() => Vector.same(0.5));
    return new MultiTargetUndirectedEdge(project, {
      uuid: rec.uuid,
      associationList: members,
      text: typeof props.text === "string" ? props.text : "",
      color: decodeColor(props.color),
      rectRates,
      centerRate: decodeVector(props.centerRate),
      arrow: (typeof props.arrow === "string" ? props.arrow : "none") as UndirectedEdgeArrowType,
      arrowType: (typeof props.arrowType === "string" ? props.arrowType : "default") as UndirectedEdgeArrowShape,
      renderType: (typeof props.renderType === "string"
        ? props.renderType
        : "line") as MultiTargetUndirectedEdgeRenderType,
      lineType: (typeof props.lineType === "string" ? props.lineType : "solid") as UndirectedEdgeLineType,
      padding: typeof props.padding === "number" ? props.padding : 10,
    });
  }
  if (rec.kind === "sync") {
    const members = memberUuids.map((id) => lookupObject(id)).filter((m): m is StageObject => m !== undefined);
    if (members.length < 2) return undefined;
    const keys = Array.isArray(props.keys)
      ? props.keys.filter((k): k is SyncableKey => k === "text" || k === "color" || k === "details")
      : (["text", "color", "details"] as SyncableKey[]);
    return new SyncAssociation(project, {
      uuid: rec.uuid,
      keys,
      associationList: members,
      color: decodeColor(props.color),
    });
  }
  return undefined;
}

export interface ProjectDataSourceLike {
  docId: string;
  stage: StageObject[];
  tags: string[];
  references: { sections: Record<string, string[]>; files: string[] };
  metadata: PrgMetadata;
  table: PrgTableData;
  readme?: string;
}

/** 将内存中的工程对象树无损编码为 SQLite v3.0.0 结构化快照（不含二进制附件）。 */
export function serializeProjectToV3Payload(source: ProjectDataSourceLike): V3ImportPayload {
  const docId = source.metadata.docId || source.docId;
  const table = normalizeTableData(source.table ?? createDefaultTableData());

  // 收集父 Section 映射（优先依据 Section.children，再回退到运行态 parentSection）
  const parentSectionByChild = new Map<string, string>();
  for (const obj of source.stage) {
    if (obj instanceof Section) {
      for (const child of obj.children) {
        parentSectionByChild.set(child.uuid, obj.uuid);
      }
    }
  }

  const columnById = new Map<string, TableColumnSchema>();
  const canonicalKeyByColId = new Map<string, string>();
  const tableColumns: V3TableColumnRecord[] = table.columns.map((col, position) => {
    const canonicalKey = computeColumnCanonicalKey(col);
    columnById.set(col.id, col);
    canonicalKeyByColId.set(col.id, canonicalKey);
    const config: Record<string, unknown> = {};
    if (col.width !== undefined) config.width = col.width;
    if (col.options !== undefined) config.options = col.options;
    if (col.format !== undefined) config.format = col.format;
    if (col.formula !== undefined) config.formula = col.formula;
    if (col.protectedRole !== undefined) config.protectedRole = col.protectedRole;
    if (col.canonicalKey && col.canonicalKey.startsWith("ws:")) config.canonicalKey = col.canonicalKey;
    return {
      id: col.id,
      canonicalKey,
      name: col.name,
      type: col.type,
      position,
      configJson: JSON.stringify(config),
    };
  });

  const tableViews: V3TableViewRecord[] = table.views.map((view, position) => {
    const { id, name, type, deletable, ...restConfig } = view;
    return {
      id,
      name,
      type,
      deletable,
      position,
      configJson: JSON.stringify(restConfig),
    };
  });

  const entities: V3EntityRecord[] = [];
  const edges: V3EdgeRecord[] = [];
  const associations: V3AssociationRecord[] = [];
  const cellValues: V3CellValueRecord[] = [];
  const seenEntityUuids = new Set<string>();

  const pushEntityRecord = (entity: Entity, sortOrder: number) => {
    if (seenEntityUuids.has(entity.uuid)) return;
    seenEntityUuids.add(entity.uuid);

    const rect = getEntityGeometryRect(entity);
    const parentSectionUuid = parentSectionByChild.get(entity.uuid) ?? entity.parentSection?.uuid ?? null;
    const detailsJson = JSON.stringify(entity.details ?? []);
    const detailsPlain = extractPlainTextFromDetails(entity.details);
    const createdAt = Number.isFinite(entity.createdAt) ? Math.trunc(entity.createdAt) : Date.now();
    const updatedAt = Number.isFinite(entity.updatedAt) ? Math.trunc(entity.updatedAt) : createdAt;

    let kind: V3EntityRecord["kind"];
    let text = "";
    let isRow = true;
    let props: Record<string, unknown>;

    if (entity instanceof TextNode) {
      kind = "text";
      text = entity.text;
      props = {
        color: encodeColor(entity.color),
        fontScaleLevel: entity.fontScaleLevel,
        sizeAdjust: entity.sizeAdjust,
        fontFamily: entity.fontFamily,
        fontWeight: entity.fontWeight,
        borderStyle: entity.borderStyle,
      };
    } else if (entity instanceof Section) {
      kind = "section";
      text = entity.text;
      props = {
        color: encodeColor(entity.color),
        isCollapsed: entity.isCollapsed,
        locked: entity.locked,
        borderStyle: entity.borderStyle,
        sizeAdjust: entity.sizeAdjust,
        childOrder: entity.children.map((c) => c.uuid),
      };
    } else if (entity instanceof ImageNode) {
      kind = "image";
      isRow = false;
      props = {
        attachmentId: entity.attachmentId,
        scale: entity.scale,
        isBackground: entity.isBackground,
      };
    } else if (entity instanceof UrlNode) {
      kind = "url";
      text = entity.title;
      props = {
        title: entity.title,
        url: entity.url,
        color: encodeColor(entity.color),
      };
    } else if (entity instanceof LatexNode) {
      kind = "latex";
      text = entity.latexSource;
      props = {
        latexSource: entity.latexSource,
        color: encodeColor(entity.color),
        fontScaleLevel: entity.fontScaleLevel,
      };
    } else if (entity instanceof MediaNode) {
      kind = "media";
      text = entity.title;
      props = {
        attachmentId: entity.attachmentId,
        mediaKind: entity.mediaKind,
        title: entity.title,
      };
    } else if (entity instanceof SvgNode) {
      kind = "svg";
      props = {
        attachmentId: entity.attachmentId,
        scale: entity.scale,
        color: encodeColor(entity.color),
      };
    } else if (entity instanceof ReferenceBlockNode) {
      kind = "reference";
      text = entity.sectionName ? `[[${entity.fileName}#${entity.sectionName}]]` : `[[${entity.fileName}]]`;
      props = {
        fileName: entity.fileName,
        sectionName: entity.sectionName,
        scale: entity.scale,
        attachmentId: entity.attachmentId,
      };
    } else if (entity instanceof ExtensionEntity) {
      kind = "extension";
      text = entity.typeName;
      props = {
        extensionId: entity.extensionId,
        typeName: entity.typeName,
        customData: entity.customData,
      };
    } else if (entity instanceof ConnectPoint) {
      kind = "connect_point";
      isRow = false;
      props = {};
    } else if (entity instanceof PenStroke) {
      kind = "pen_stroke";
      isRow = false;
      props = {
        color: encodeColor(entity.color),
        width: entity.width,
        segments: entity.segments.map((s) => ({
          x: s.location.x,
          y: s.location.y,
          pressure: s.pressure,
        })),
      };
    } else {
      return;
    }

    entities.push({
      uuid: entity.uuid,
      kind,
      parentSectionUuid,
      text,
      detailsJson,
      detailsPlain,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      propsJson: JSON.stringify(props),
      createdAt,
      updatedAt,
      isRow,
      sortOrder,
    });

    // 拆解实体自定义单元格为类型化 cell_values + cell_multi_options
    if (entity.tableFields && typeof entity.tableFields === "object") {
      for (const [colId, rawVal] of Object.entries(entity.tableFields)) {
        if (rawVal === null || rawVal === undefined) continue;
        const col = columnById.get(colId);
        if (!col || col.type === "formula") continue;
        const canonicalKey = canonicalKeyByColId.get(colId) ?? computeColumnCanonicalKey(col);

        if (col.type === "number") {
          const num = typeof rawVal === "number" ? rawVal : Number(rawVal);
          if (!Number.isFinite(num)) continue;
          cellValues.push({
            entityUuid: entity.uuid,
            colId,
            canonicalKey,
            valType: "number",
            valText: String(num),
            valNum: num,
            valDate: null,
            valJson: null,
            multiOptions: [],
          });
        } else if (col.type === "date") {
          const dateStr = String(rawVal);
          if (!dateStr) continue;
          cellValues.push({
            entityUuid: entity.uuid,
            colId,
            canonicalKey,
            valType: "date",
            valText: dateStr,
            valNum: null,
            valDate: dateStr,
            valJson: null,
            multiOptions: [],
          });
        } else if (col.type === "select") {
          const optId = String(rawVal);
          if (!optId) continue;
          cellValues.push({
            entityUuid: entity.uuid,
            colId,
            canonicalKey,
            valType: "select",
            valText: optId,
            valNum: null,
            valDate: null,
            valJson: null,
            multiOptions: [],
          });
        } else if (col.type === "multi_select") {
          const arr = Array.isArray(rawVal) ? rawVal.filter((v): v is string => typeof v === "string" && v !== "") : [];
          if (arr.length === 0) continue;
          const optionNameById = new Map<string, string>((col.options ?? []).map((opt) => [opt.id, opt.name]));
          const multiOptions: V3MultiOptionEntry[] = [...new Set(arr)].map((optionId) => ({
            optionId,
            optionName: optionNameById.get(optionId) ?? optionId,
          }));
          cellValues.push({
            entityUuid: entity.uuid,
            colId,
            canonicalKey,
            valType: "multi_select",
            valText: multiOptions.map((o) => o.optionName).join(","),
            valNum: null,
            valDate: null,
            valJson: JSON.stringify(arr),
            multiOptions,
          });
        } else {
          const textVal = String(rawVal);
          cellValues.push({
            entityUuid: entity.uuid,
            colId,
            canonicalKey,
            valType: "text",
            valText: textVal,
            valNum: null,
            valDate: null,
            valJson: null,
            multiOptions: [],
          });
        }
      }
    }
  };

  let nextSortOrder = 0;
  for (const obj of source.stage) {
    const sortOrder = nextSortOrder++;
    if (obj instanceof Entity) {
      pushEntityRecord(obj, sortOrder);
    } else if (obj instanceof LineEdge) {
      if (!obj.source || !obj.target) continue;
      edges.push({
        uuid: obj.uuid,
        kind: "line",
        sourceUuid: obj.source.uuid,
        targetUuid: obj.target.uuid,
        text: obj.text,
        propsJson: JSON.stringify({
          color: encodeColor(obj.color),
          lineType: obj.lineType,
          arrowType: obj.arrowType,
          isBranchCollapsed: obj.isBranchCollapsed,
          sourceRectangleRate: encodeVector(obj.sourceRectangleRate),
          targetRectangleRate: encodeVector(obj.targetRectangleRate),
        }),
        sortOrder,
      });
    } else if (obj instanceof ArcEdge) {
      if (!obj.source || !obj.target) continue;
      edges.push({
        uuid: obj.uuid,
        kind: "arc",
        sourceUuid: obj.source.uuid,
        targetUuid: obj.target.uuid,
        text: obj.text,
        propsJson: JSON.stringify({
          color: encodeColor(obj.color),
          lineType: obj.lineType,
          arrowType: obj.arrowType,
          offset: obj.offset,
          textPosition: obj.textPosition,
          sourceRectangleRate: encodeVector(obj.sourceRectangleRate),
          targetRectangleRate: encodeVector(obj.targetRectangleRate),
        }),
        sortOrder,
      });
    } else if (obj instanceof CubicCatmullRomSplineEdge) {
      const sourceUuid = obj.source?.uuid ?? (obj as unknown as { _source?: ConnectableEntity })._source?.uuid;
      const targetUuid = obj.target?.uuid ?? (obj as unknown as { _target?: ConnectableEntity })._target?.uuid;
      if (!sourceUuid || !targetUuid) continue;
      edges.push({
        uuid: obj.uuid,
        kind: "cr_spline",
        sourceUuid,
        targetUuid,
        text: obj.text,
        propsJson: JSON.stringify({
          color: encodeColor(obj.color),
          alpha: obj.alpha,
          tension: obj.tension,
          controlPoints: obj.getControlPoints().map((pt) => [pt.x, pt.y]),
          sourceRectangleRate: encodeVector(obj.sourceRectangleRate),
          targetRectangleRate: encodeVector(obj.targetRectangleRate),
        }),
        sortOrder,
      });
    } else if (obj instanceof MultiTargetUndirectedEdge) {
      associations.push({
        uuid: obj.uuid,
        kind: "multi_target",
        memberUuidsJson: JSON.stringify(obj.associationList.map((m) => m.uuid)),
        propsJson: JSON.stringify({
          text: obj.text,
          color: encodeColor(obj.color),
          rectRates: obj.rectRates.map((r) => [r.x, r.y]),
          centerRate: encodeVector(obj.centerRate),
          arrow: obj.arrow,
          arrowType: obj.arrowType,
          renderType: obj.renderType,
          lineType: obj.lineType,
          padding: obj.padding,
        }),
        sortOrder,
      });
    } else if (obj instanceof SyncAssociation) {
      associations.push({
        uuid: obj.uuid,
        kind: "sync",
        memberUuidsJson: JSON.stringify(obj.associationList.map((m) => m.uuid)),
        propsJson: JSON.stringify({
          keys: obj.keys,
          color: encodeColor(obj.color),
        }),
        sortOrder,
      });
    }
  }

  // 防御性补录仅存在于 Section.children 中但未挂在顶层 stage 数组里的实体
  const walkMissingSectionChildren = (section: Section) => {
    for (const child of section.children) {
      if (!seenEntityUuids.has(child.uuid)) {
        pushEntityRecord(child, nextSortOrder++);
      }
      if (child instanceof Section) {
        walkMissingSectionChildren(child);
      }
    }
  };
  for (const obj of source.stage) {
    if (obj instanceof Section) {
      walkMissingSectionChildren(obj);
    }
  }

  return {
    docId,
    formatVersion: LATEST_PROJECT_VERSION,
    readme: source.readme ?? null,
    tags: [...(source.tags ?? [])],
    references: source.references ?? { sections: {}, files: [] },
    extensionJson: source.metadata.extension ? JSON.stringify(source.metadata.extension) : null,
    tableMetaJson: JSON.stringify({
      activeViewId: table.activeViewId,
      systemColumnNames: table.systemColumnNames,
    }),
    entities,
    edges,
    associations,
    tableColumns,
    tableViews,
    cellValues,
  };
}

export interface HydratedV3Data {
  stage: StageObject[];
  tags: string[];
  references: { sections: Record<string, string[]>; files: string[] };
  metadata: PrgMetadata;
  table: PrgTableData;
  readme?: string;
}

const EMPTY_PROPS: Record<string, unknown> = Object.freeze({});

function instantiateEntityFromHydration(
  project: Project,
  kind: V3EntityRecord["kind"],
  uuid: string,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  createdAt: number,
  updatedAt: number,
  props: Record<string, unknown>,
  details: Value,
  tableFields: TableFields | undefined,
): { entity?: Entity; section?: Section; needsSectionAdjust: boolean } {
  const rect = new Rectangle(new Vector(x, y), new Vector(w, h));
  const collisionBox = new CollisionBox([rect]);
  const hasPersistedSize = w > 0 && h > 0;

  switch (kind) {
    case "text":
      return {
        entity: new TextNode(project, {
          uuid,
          text,
          details,
          collisionBox,
          color: decodeColor(props.color),
          fontScaleLevel: typeof props.fontScaleLevel === "number" ? props.fontScaleLevel : 0,
          sizeAdjust: props.sizeAdjust === "manual" ? "manual" : "auto",
          fontFamily: typeof props.fontFamily === "string" ? props.fontFamily : "",
          fontWeight: typeof props.fontWeight === "string" ? props.fontWeight : "",
          borderStyle: props.borderStyle === "dashed" || props.borderStyle === "none" ? props.borderStyle : "solid",
          createdAt,
          updatedAt,
          tableFields,
          tableFieldsOwned: true,
          skipInitialResize: hasPersistedSize,
        }),
        needsSectionAdjust: false,
      };
    case "section": {
      const normalBox = new CollisionBox(rect.getBoundingLines());
      const section = new Section(project, {
        uuid,
        text,
        details,
        _collisionBoxNormal: normalBox,
        color: decodeColor(props.color),
        isCollapsed: Boolean(props.isCollapsed),
        locked: Boolean(props.locked),
        borderStyle: props.borderStyle === "dashed" || props.borderStyle === "none" ? props.borderStyle : "solid",
        sizeAdjust: props.sizeAdjust === "manual" ? "manual" : "auto",
        children: [],
        createdAt,
        updatedAt,
        tableFields,
        tableFieldsOwned: true,
        skipInitialAdjust: true,
      });
      return { entity: section, section, needsSectionAdjust: !hasPersistedSize };
    }
    case "image":
      return {
        entity: new ImageNode(project, {
          uuid,
          details,
          collisionBox,
          attachmentId: typeof props.attachmentId === "string" ? props.attachmentId : "",
          scale: typeof props.scale === "number" ? props.scale : 1,
          isBackground: Boolean(props.isBackground),
          createdAt,
          updatedAt,
          tableFields,
          deferBitmapLoad: Boolean(project.imageBitmapCache),
        }),
        needsSectionAdjust: false,
      };
    case "url":
      return {
        entity: new UrlNode(project, {
          uuid,
          title: typeof props.title === "string" ? props.title : text,
          url: typeof props.url === "string" ? props.url : "",
          details: details as never,
          collisionBox,
          color: decodeColor(props.color),
          createdAt,
          updatedAt,
          tableFields,
        }),
        needsSectionAdjust: false,
      };
    case "latex":
      return {
        entity: new LatexNode(project, {
          uuid,
          latexSource: typeof props.latexSource === "string" ? props.latexSource : text,
          details,
          collisionBox,
          color: decodeColor(props.color),
          fontScaleLevel: typeof props.fontScaleLevel === "number" ? props.fontScaleLevel : 0,
          createdAt,
          updatedAt,
          tableFields,
          tableFieldsOwned: true,
          deferRender: hasPersistedSize,
        }),
        needsSectionAdjust: false,
      };
    case "media":
      return {
        entity: new MediaNode(project, {
          uuid,
          details,
          collisionBox,
          attachmentId: typeof props.attachmentId === "string" ? props.attachmentId : "",
          mediaKind: props.mediaKind === "audio" ? "audio" : ("video" as MediaKind),
          title: typeof props.title === "string" ? props.title : text,
          createdAt,
          updatedAt,
          tableFields,
        }),
        needsSectionAdjust: false,
      };
    case "svg":
      return {
        entity: new SvgNode(project, {
          uuid: uuid as `${string}-${string}-${string}-${string}-${string}`,
          details: details as never,
          collisionBox,
          attachmentId: typeof props.attachmentId === "string" ? props.attachmentId : "",
          scale: typeof props.scale === "number" ? props.scale : 1,
          color: decodeColor(props.color),
          createdAt,
          updatedAt,
          tableFields,
        }),
        needsSectionAdjust: false,
      };
    case "reference":
      return {
        entity: new ReferenceBlockNode(project, {
          uuid,
          details: details as never,
          collisionBox,
          fileName: typeof props.fileName === "string" ? props.fileName : "",
          sectionName: typeof props.sectionName === "string" ? props.sectionName : "",
          scale: typeof props.scale === "number" ? props.scale : 1,
          attachmentId: typeof props.attachmentId === "string" ? props.attachmentId : "",
          createdAt,
          updatedAt,
          tableFields,
        }),
        needsSectionAdjust: false,
      };
    case "extension":
      return {
        entity: new ExtensionEntity(project, {
          uuid,
          details,
          collisionBox,
          extensionId: typeof props.extensionId === "string" ? props.extensionId : "",
          typeName: typeof props.typeName === "string" ? props.typeName : text,
          customData: props.customData ?? {},
          createdAt,
          updatedAt,
          tableFields,
        }),
        needsSectionAdjust: false,
      };
    case "connect_point":
      return {
        entity: new ConnectPoint(project, {
          uuid,
          details: details as never,
          collisionBox,
          createdAt,
          updatedAt,
          tableFields,
        }),
        needsSectionAdjust: false,
      };
    case "pen_stroke": {
      const rawSegments = Array.isArray(props.segments) ? props.segments : [];
      const segments = rawSegments
        .filter((s): s is { x: number; y: number; pressure?: number } => Boolean(s && typeof s === "object"))
        .map(
          (s) =>
            new PenStrokeSegment(
              new Vector(Number(s.x) || 0, Number(s.y) || 0),
              typeof s.pressure === "number" ? s.pressure : 0.5,
            ),
        );
      return {
        entity: new PenStroke(project, {
          uuid,
          segments,
          color: decodeColor(props.color),
          width: typeof props.width === "number" ? props.width : 5,
          createdAt,
          updatedAt,
          tableFields,
        }),
        needsSectionAdjust: false,
      };
    }
  }
}

function instantiateEdgeFromHydration(
  project: Project,
  kind: "line" | "arc" | "cr_spline",
  uuid: string,
  src: ConnectableEntity,
  dst: ConnectableEntity,
  text: string,
  props: Record<string, unknown>,
): StageObject {
  if (kind === "arc") {
    return new ArcEdge(project, {
      uuid,
      associationList: [src, dst],
      text,
      color: decodeColor(props.color),
      lineType: typeof props.lineType === "string" ? props.lineType : "solid",
      arrowType: typeof props.arrowType === "string" ? props.arrowType : "default",
      offset: typeof props.offset === "number" ? props.offset : 0,
      textPosition: typeof props.textPosition === "number" ? props.textPosition : 0.5,
      sourceRectangleRate: decodeVector(props.sourceRectangleRate),
      targetRectangleRate: decodeVector(props.targetRectangleRate),
    });
  }
  if (kind === "cr_spline") {
    const cpRaw = Array.isArray(props.controlPoints) ? props.controlPoints : [];
    const controlPoints: [number, number][] = cpRaw
      .filter((p): p is [number, number] => Array.isArray(p) && p.length >= 2)
      .map((p) => [Number(p[0]) || 0, Number(p[1]) || 0]);
    const cr = new CubicCatmullRomSplineEdge(project, {
      uuid,
      source: src.uuid,
      target: dst.uuid,
      text,
      type: "core:cublic_catmull_rom_spline_edge",
      alpha: typeof props.alpha === "number" ? props.alpha : 0.5,
      tension: typeof props.tension === "number" ? props.tension : 0,
      color: Array.isArray(props.color) && props.color.length === 4 ? (props.color as SerializedColor) : [0, 0, 0, 0],
      controlPoints,
      sourceRectRate: encodeVector(decodeVector(props.sourceRectangleRate)),
      targetRectRate: encodeVector(decodeVector(props.targetRectangleRate)),
    });
    cr.associationList = [src, dst];
    return cr;
  }
  return new LineEdge(project, {
    uuid,
    associationList: [src, dst],
    text,
    color: decodeColor(props.color),
    lineType: typeof props.lineType === "string" ? props.lineType : "solid",
    arrowType: typeof props.arrowType === "string" ? props.arrowType : "default",
    isBranchCollapsed: Boolean(props.isBranchCollapsed),
    sourceRectangleRate: decodeVector(props.sourceRectangleRate),
    targetRectangleRate: decodeVector(props.targetRectangleRate),
  });
}

function finalizeHydratedSectionsAndStage(
  project: Project,
  orderedEntries: Array<{ sortOrder: number; obj: StageObject }>,
  alreadySorted: boolean,
  sectionRecords: Array<{
    uuid: string;
    parentSectionUuid: string | null;
    props: Record<string, unknown>;
    section: Section;
    needsSectionAdjust: boolean;
  }>,
  entityByUuid: Map<string, Entity>,
  childrenByParentSection: Map<string, Entity[]>,
): StageObject[] {
  let hasAnyCollapsedSection = false;
  let sectionsNeedingAdjust: Array<{ uuid: string; section: Section }> | null = null;

  for (const item of sectionRecords) {
    const { uuid, props, section, needsSectionAdjust } = item;
    if (section.isCollapsed) hasAnyCollapsedSection = true;
    if (needsSectionAdjust) {
      sectionsNeedingAdjust ??= [];
      sectionsNeedingAdjust.push({ uuid, section });
    }
    const rawOrder = Array.isArray(props.childOrder) ? props.childOrder : null;
    const byParent = childrenByParentSection.get(uuid);
    if (!rawOrder || rawOrder.length === 0) {
      section.children = byParent ?? [];
      continue;
    }
    const seen = new Set<string>();
    const children: Entity[] = [];
    for (const childId of rawOrder) {
      if (typeof childId !== "string" || seen.has(childId) || childId === uuid) continue;
      const child = entityByUuid.get(childId);
      if (child) {
        seen.add(childId);
        children.push(child);
      }
    }
    if (byParent) {
      for (const child of byParent) {
        if (seen.has(child.uuid) || child.uuid === uuid) continue;
        seen.add(child.uuid);
        children.push(child);
      }
    }
    section.children = children;
  }

  if (!alreadySorted) {
    orderedEntries.sort((a, b) => a.sortOrder - b.sortOrder);
  }
  const stage = new Array<StageObject>(orderedEntries.length);
  for (let i = 0; i < orderedEntries.length; i++) {
    stage[i] = orderedEntries[i].obj;
  }
  project.stage = stage;

  if ((sectionsNeedingAdjust && sectionsNeedingAdjust.length > 0) || hasAnyCollapsedSection) {
    const prevSuppress = project.docCommandBus?.isSuppressingTracking ?? false;
    project.docCommandBus?.setSuppressTracking(true);
    try {
      if (sectionsNeedingAdjust && sectionsNeedingAdjust.length > 0) {
        const parentUuidBySection = new Map<string, string | null>(
          sectionRecords.map((item) => [item.uuid, item.parentSectionUuid]),
        );
        const sectionDepthOf = (uuid: string): number => {
          let depth = 0;
          let cur = parentUuidBySection.get(uuid) ?? null;
          const guard = new Set<string>([uuid]);
          while (cur && !guard.has(cur)) {
            guard.add(cur);
            depth++;
            cur = parentUuidBySection.get(cur) ?? null;
          }
          return depth;
        };
        sectionsNeedingAdjust.sort((a, b) => sectionDepthOf(b.uuid) - sectionDepthOf(a.uuid));
        for (const { section } of sectionsNeedingAdjust) {
          section.adjustLocationAndSize();
        }
      }
      if (hasAnyCollapsedSection) {
        for (const { parentSectionUuid, section } of sectionRecords) {
          if (!parentSectionUuid) {
            section.adjustChildrenStateByCollapse();
          }
        }
      }
    } finally {
      project.docCommandBus?.setSuppressTracking(prevSuppress);
    }
  }

  return stage;
}

const PACKED_ENTITY_KINDS: readonly V3EntityRecord["kind"][] = [
  "text",
  "section",
  "image",
  "url",
  "latex",
  "media",
  "svg",
  "reference",
  "extension",
  "connect_point",
  "pen_stroke",
];
const PACKED_EDGE_KINDS: readonly ("line" | "arc" | "cr_spline")[] = ["line", "arc", "cr_spline"];

/**
 * 零 `JSON.parse()` 紧凑流式水合器（对应 Rust `doc_open_with_ownership` 直出的 `V3PackedDocumentOpenResult`）。
 */
export function hydrateV3PackedOpenResult(project: Project, opened: V3PackedDocumentOpenResult): HydratedV3Data {
  const tableMeta = (opened.tableMeta ?? {}) as {
    activeViewId?: string;
    systemColumnNames?: PrgTableData["systemColumnNames"];
  };

  const columns: TableColumnSchema[] = opened.tableColumns.map(([id, canonicalKey, name, type, , rawCfg]) => {
    const cfg = (rawCfg && typeof rawCfg === "object" ? rawCfg : EMPTY_PROPS) as Partial<TableColumnSchema>;
    return {
      id,
      name,
      type: type as CustomColumnType,
      ...(cfg.width !== undefined ? { width: cfg.width } : {}),
      ...(cfg.options !== undefined ? { options: cfg.options } : {}),
      ...(cfg.format !== undefined ? { format: cfg.format } : {}),
      ...(cfg.formula !== undefined ? { formula: cfg.formula } : {}),
      ...(cfg.protectedRole !== undefined ? { protectedRole: cfg.protectedRole } : {}),
      ...(canonicalKey && canonicalKey.startsWith("ws:")
        ? { canonicalKey, isShared: true }
        : cfg.canonicalKey
          ? { canonicalKey: cfg.canonicalKey }
          : {}),
    };
  });

  const views: TableViewSchema[] = opened.tableViews.map(([id, name, type, deletableInt, , rawCfg]) => {
    const cfg = (rawCfg && typeof rawCfg === "object" ? rawCfg : EMPTY_PROPS) as Partial<TableViewSchema>;
    return {
      ...cfg,
      id,
      name,
      type: type as TableViewType,
      deletable: deletableInt !== 0,
      visibleColumnIds: Array.isArray(cfg.visibleColumnIds) ? cfg.visibleColumnIds : ["name"],
    };
  });

  const table = normalizeTableData({
    columns,
    views,
    activeViewId: tableMeta.activeViewId,
    systemColumnNames: tableMeta.systemColumnNames,
  });

  const tableFieldsByUuid = new Map<string, TableFields>();
  const packedCells = opened.cellValues;
  for (let i = 0; i < packedCells.length; i++) {
    const [entityUuid, colId, valTypeCode, rawVal] = packedCells[i];
    let fields = tableFieldsByUuid.get(entityUuid);
    if (!fields) {
      fields = {};
      tableFieldsByUuid.set(entityUuid, fields);
    }
    if (valTypeCode === 1) {
      if (typeof rawVal === "number" && Number.isFinite(rawVal)) {
        fields[colId] = rawVal;
      }
    } else if (valTypeCode === 4) {
      fields[colId] = Array.isArray(rawVal) ? rawVal.filter((v): v is string => typeof v === "string") : [];
    } else if (typeof rawVal === "string") {
      fields[colId] = rawVal;
    }
  }

  const totalCount = opened.entities.length + opened.edges.length + opened.associations.length;
  const orderedEntries = new Array<{ sortOrder: number; obj: StageObject }>(totalCount);
  let orderedLen = 0;
  let lastSortOrder = -Infinity;
  let alreadySorted = true;

  const entityByUuid = new Map<string, Entity>();
  const sectionRecords: Array<{
    uuid: string;
    parentSectionUuid: string | null;
    props: Record<string, unknown>;
    section: Section;
    needsSectionAdjust: boolean;
  }> = [];
  const childrenByParentSection = new Map<string, Entity[]>();

  const packedEntities = opened.entities;
  for (let i = 0; i < packedEntities.length; i++) {
    const [uuid, kindCode, parentOr0, text, x, y, w, h, createdAt, updatedAt, sortOrder, rawProps, rawDetails] =
      packedEntities[i];
    const kind = PACKED_ENTITY_KINDS[kindCode];
    if (!kind) continue;
    const props = rawProps && typeof rawProps === "object" ? rawProps : EMPTY_PROPS;
    const details: Value = Array.isArray(rawDetails) ? (rawDetails as Value) : [];
    const tableFields = tableFieldsByUuid.get(uuid);

    const { entity, section, needsSectionAdjust } = instantiateEntityFromHydration(
      project,
      kind,
      uuid,
      text,
      x,
      y,
      w,
      h,
      createdAt,
      updatedAt,
      props,
      details,
      tableFields,
    );
    if (!entity) continue;

    entityByUuid.set(uuid, entity);
    if (sortOrder < lastSortOrder) alreadySorted = false;
    lastSortOrder = sortOrder;
    orderedEntries[orderedLen++] = { sortOrder, obj: entity };

    const parentSectionUuid = typeof parentOr0 === "string" && parentOr0.length > 0 ? parentOr0 : null;
    if (section) {
      sectionRecords.push({ uuid, parentSectionUuid, props, section, needsSectionAdjust });
    }
    if (parentSectionUuid) {
      let list = childrenByParentSection.get(parentSectionUuid);
      if (!list) {
        list = [];
        childrenByParentSection.set(parentSectionUuid, list);
      }
      list.push(entity);
    }
  }

  const hasAssociations = opened.associations.length > 0;
  const objectByUuid = hasAssociations ? new Map<string, StageObject>(entityByUuid) : null;

  const packedEdges = opened.edges;
  for (let i = 0; i < packedEdges.length; i++) {
    const [uuid, kindCode, sourceUuid, targetUuid, text, sortOrder, rawProps] = packedEdges[i];
    const src = entityByUuid.get(sourceUuid);
    const dst = entityByUuid.get(targetUuid);
    if (!(src instanceof ConnectableEntity) || !(dst instanceof ConnectableEntity)) continue;
    const props = rawProps && typeof rawProps === "object" ? rawProps : EMPTY_PROPS;
    const edge = instantiateEdgeFromHydration(
      project,
      PACKED_EDGE_KINDS[kindCode] ?? "line",
      uuid,
      src,
      dst,
      text,
      props,
    );
    if (objectByUuid) objectByUuid.set(uuid, edge);
    if (sortOrder < lastSortOrder) alreadySorted = false;
    lastSortOrder = sortOrder;
    orderedEntries[orderedLen++] = { sortOrder, obj: edge };
  }

  if (hasAssociations && objectByUuid) {
    for (const [uuid, kindCode, memberUuids, rawProps, sortOrder] of opened.associations) {
      const props = rawProps && typeof rawProps === "object" ? rawProps : EMPTY_PROPS;
      const list = Array.isArray(memberUuids) ? memberUuids : [];
      if (kindCode === 0) {
        const members = list
          .map((id) => entityByUuid.get(id))
          .filter((m): m is ConnectableEntity => m instanceof ConnectableEntity);
        if (members.length < 2) continue;
        const rectRatesRaw = Array.isArray(props.rectRates) ? props.rectRates : [];
        const rectRates =
          rectRatesRaw.length === members.length
            ? rectRatesRaw.map((r) => decodeVector(r))
            : members.map(() => Vector.same(0.5));
        const hyper = new MultiTargetUndirectedEdge(project, {
          uuid,
          associationList: members,
          text: typeof props.text === "string" ? props.text : "",
          color: decodeColor(props.color),
          rectRates,
          centerRate: decodeVector(props.centerRate),
          arrow: (typeof props.arrow === "string" ? props.arrow : "none") as UndirectedEdgeArrowType,
          arrowType: (typeof props.arrowType === "string" ? props.arrowType : "default") as UndirectedEdgeArrowShape,
          renderType: (typeof props.renderType === "string"
            ? props.renderType
            : "line") as MultiTargetUndirectedEdgeRenderType,
          lineType: (typeof props.lineType === "string" ? props.lineType : "solid") as UndirectedEdgeLineType,
          padding: typeof props.padding === "number" ? props.padding : 10,
        });
        objectByUuid.set(uuid, hyper);
        if (sortOrder < lastSortOrder) alreadySorted = false;
        lastSortOrder = sortOrder;
        orderedEntries[orderedLen++] = { sortOrder, obj: hyper };
      } else if (kindCode === 1) {
        const members = list.map((id) => objectByUuid.get(id)).filter((m): m is StageObject => m !== undefined);
        if (members.length < 2) continue;
        const keys = Array.isArray(props.keys)
          ? props.keys.filter((k): k is SyncableKey => k === "text" || k === "color" || k === "details")
          : (["text", "color", "details"] as SyncableKey[]);
        const sync = new SyncAssociation(project, {
          uuid,
          keys,
          associationList: members,
          color: decodeColor(props.color),
        });
        objectByUuid.set(uuid, sync);
        if (sortOrder < lastSortOrder) alreadySorted = false;
        lastSortOrder = sortOrder;
        orderedEntries[orderedLen++] = { sortOrder, obj: sync };
      }
    }
  }

  orderedEntries.length = orderedLen;
  const stage = finalizeHydratedSectionsAndStage(
    project,
    orderedEntries,
    alreadySorted,
    sectionRecords,
    entityByUuid,
    childrenByParentSection,
  );

  const extension =
    opened.extension && typeof opened.extension === "object"
      ? (opened.extension as unknown as PrgMetadata["extension"])
      : undefined;
  const metadata: PrgMetadata = {
    version: opened.formatVersion || LATEST_PROJECT_VERSION,
    docId: opened.docId,
    ...(extension ? { extension } : {}),
  };

  return {
    stage,
    tags: opened.tags ?? [],
    references: opened.references ?? { sections: {}, files: [] },
    metadata,
    table,
    readme: opened.readme ?? undefined,
  };
}

/** 将 Rust `doc_open` / `doc_open_with_ownership` 返回的数据还原为内存 `StageObject[]`、`PrgTableData` 与元数据。 */
export function hydrateV3OpenResult(project: Project, opened: V3AnyDocumentOpenResult): HydratedV3Data {
  if (isPackedV3DocumentOpenResult(opened)) {
    return hydrateV3PackedOpenResult(project, opened);
  }

  const tableMeta = safeJsonParse<{ activeViewId?: string; systemColumnNames?: PrgTableData["systemColumnNames"] }>(
    opened.tableMetaJson,
    {},
  );

  const columns: TableColumnSchema[] = opened.tableColumns.map((rec) => {
    const cfg = safeJsonParse<Partial<TableColumnSchema>>(rec.configJson, {});
    return {
      id: rec.id,
      name: rec.name,
      type: rec.type as CustomColumnType,
      ...(cfg.width !== undefined ? { width: cfg.width } : {}),
      ...(cfg.options !== undefined ? { options: cfg.options } : {}),
      ...(cfg.format !== undefined ? { format: cfg.format } : {}),
      ...(cfg.formula !== undefined ? { formula: cfg.formula } : {}),
      ...(cfg.protectedRole !== undefined ? { protectedRole: cfg.protectedRole } : {}),
      ...(rec.canonicalKey && rec.canonicalKey.startsWith("ws:")
        ? { canonicalKey: rec.canonicalKey, isShared: true }
        : cfg.canonicalKey
          ? { canonicalKey: cfg.canonicalKey }
          : {}),
    };
  });

  const views: TableViewSchema[] = opened.tableViews.map((rec) => {
    const cfg = safeJsonParse<Partial<TableViewSchema>>(rec.configJson, {});
    return {
      ...cfg,
      id: rec.id,
      name: rec.name,
      type: rec.type as TableViewType,
      deletable: rec.deletable,
      visibleColumnIds: Array.isArray(cfg.visibleColumnIds) ? cfg.visibleColumnIds : ["name"],
    };
  });

  const table = normalizeTableData({
    columns,
    views,
    activeViewId: tableMeta.activeViewId,
    systemColumnNames: tableMeta.systemColumnNames,
  });

  // 按实体 UUID 重建 tableFields
  const tableFieldsByUuid = new Map<string, TableFields>();
  for (const cell of opened.cellValues) {
    let fields = tableFieldsByUuid.get(cell.entityUuid);
    if (!fields) {
      fields = {};
      tableFieldsByUuid.set(cell.entityUuid, fields);
    }
    let val: TableCellValue;
    if (cell.valType === "number") {
      val = typeof cell.valNum === "number" && Number.isFinite(cell.valNum) ? cell.valNum : null;
    } else if (cell.valType === "date") {
      val = cell.valDate ?? cell.valText ?? null;
    } else if (cell.valType === "multi_select") {
      const parsed = safeJsonParse<unknown>(cell.valJson, []);
      val = Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
    } else {
      val = cell.valText ?? null;
    }
    if (val !== null) {
      fields[cell.colId] = val;
    }
  }

  const orderedEntries: Array<{ sortOrder: number; obj: StageObject }> = [];
  let lastSortOrder = -Infinity;
  let alreadySorted = true;
  const entityByUuid = new Map<string, Entity>();
  const sectionRecords: Array<{
    uuid: string;
    parentSectionUuid: string | null;
    props: Record<string, unknown>;
    section: Section;
    needsSectionAdjust: boolean;
  }> = [];
  const childrenByParentSection = new Map<string, Entity[]>();

  for (const rec of opened.entities) {
    const props = safeJsonParse<Record<string, unknown>>(rec.propsJson, EMPTY_PROPS);
    const details = safeJsonParse<Value>(rec.detailsJson, []);
    const tableFields = tableFieldsByUuid.get(rec.uuid);

    const { entity, section, needsSectionAdjust } = instantiateEntityFromHydration(
      project,
      rec.kind,
      rec.uuid,
      rec.text,
      rec.x,
      rec.y,
      rec.w,
      rec.h,
      rec.createdAt,
      rec.updatedAt,
      props,
      details,
      tableFields,
    );

    if (entity) {
      entityByUuid.set(entity.uuid, entity);
      if (rec.sortOrder < lastSortOrder) alreadySorted = false;
      lastSortOrder = rec.sortOrder;
      orderedEntries.push({ sortOrder: rec.sortOrder, obj: entity });
      if (section) {
        sectionRecords.push({
          uuid: rec.uuid,
          parentSectionUuid: rec.parentSectionUuid,
          props,
          section,
          needsSectionAdjust,
        });
      }
      if (rec.parentSectionUuid) {
        let list = childrenByParentSection.get(rec.parentSectionUuid);
        if (!list) {
          list = [];
          childrenByParentSection.set(rec.parentSectionUuid, list);
        }
        list.push(entity);
      }
    }
  }

  const hasAssociations = opened.associations.length > 0;
  const objectByUuid = hasAssociations ? new Map<string, StageObject>(entityByUuid) : null;

  for (const rec of opened.edges) {
    const src = entityByUuid.get(rec.sourceUuid);
    const dst = entityByUuid.get(rec.targetUuid);
    if (!(src instanceof ConnectableEntity) || !(dst instanceof ConnectableEntity)) continue;
    const props = safeJsonParse<Record<string, unknown>>(rec.propsJson, EMPTY_PROPS);
    const edge = instantiateEdgeFromHydration(project, rec.kind, rec.uuid, src, dst, rec.text, props);
    if (objectByUuid) objectByUuid.set(edge.uuid, edge);
    if (rec.sortOrder < lastSortOrder) alreadySorted = false;
    lastSortOrder = rec.sortOrder;
    orderedEntries.push({ sortOrder: rec.sortOrder, obj: edge });
  }

  if (hasAssociations && objectByUuid) {
    for (const rec of opened.associations) {
      const props = safeJsonParse<Record<string, unknown>>(rec.propsJson, EMPTY_PROPS);
      const memberUuids = safeJsonParse<string[]>(rec.memberUuidsJson, []);
      if (rec.kind === "multi_target") {
        const members = memberUuids
          .map((id) => entityByUuid.get(id))
          .filter((m): m is ConnectableEntity => m instanceof ConnectableEntity);
        if (members.length < 2) continue;
        const rectRatesRaw = Array.isArray(props.rectRates) ? props.rectRates : [];
        const rectRates =
          rectRatesRaw.length === members.length
            ? rectRatesRaw.map((r) => decodeVector(r))
            : members.map(() => Vector.same(0.5));
        const hyper = new MultiTargetUndirectedEdge(project, {
          uuid: rec.uuid,
          associationList: members,
          text: typeof props.text === "string" ? props.text : "",
          color: decodeColor(props.color),
          rectRates,
          centerRate: decodeVector(props.centerRate),
          arrow: (typeof props.arrow === "string" ? props.arrow : "none") as UndirectedEdgeArrowType,
          arrowType: (typeof props.arrowType === "string" ? props.arrowType : "default") as UndirectedEdgeArrowShape,
          renderType: (typeof props.renderType === "string"
            ? props.renderType
            : "line") as MultiTargetUndirectedEdgeRenderType,
          lineType: (typeof props.lineType === "string" ? props.lineType : "solid") as UndirectedEdgeLineType,
          padding: typeof props.padding === "number" ? props.padding : 10,
        });
        objectByUuid.set(hyper.uuid, hyper);
        if (rec.sortOrder < lastSortOrder) alreadySorted = false;
        lastSortOrder = rec.sortOrder;
        orderedEntries.push({ sortOrder: rec.sortOrder, obj: hyper });
      } else if (rec.kind === "sync") {
        const members = memberUuids.map((id) => objectByUuid.get(id)).filter((m): m is StageObject => m !== undefined);
        if (members.length < 2) continue;
        const keys = Array.isArray(props.keys)
          ? props.keys.filter((k): k is SyncableKey => k === "text" || k === "color" || k === "details")
          : (["text", "color", "details"] as SyncableKey[]);
        const sync = new SyncAssociation(project, {
          uuid: rec.uuid,
          keys,
          associationList: members,
          color: decodeColor(props.color),
        });
        objectByUuid.set(sync.uuid, sync);
        if (rec.sortOrder < lastSortOrder) alreadySorted = false;
        lastSortOrder = rec.sortOrder;
        orderedEntries.push({ sortOrder: rec.sortOrder, obj: sync });
      }
    }
  }

  const stage = finalizeHydratedSectionsAndStage(
    project,
    orderedEntries,
    alreadySorted,
    sectionRecords,
    entityByUuid,
    childrenByParentSection,
  );

  const extension = opened.extensionJson
    ? safeJsonParse<PrgMetadata["extension"]>(opened.extensionJson, undefined)
    : undefined;
  const metadata: PrgMetadata = {
    version: opened.formatVersion || LATEST_PROJECT_VERSION,
    docId: opened.docId,
    ...(extension ? { extension } : {}),
  };

  return {
    stage,
    tags: opened.tags ?? [],
    references: opened.references ?? { sections: {}, files: [] },
    metadata,
    table,
    readme: opened.readme ?? undefined,
  };
}
