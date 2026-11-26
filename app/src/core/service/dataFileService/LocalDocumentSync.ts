import type { Project, ProjectState } from "@/core/Project";
import type { StageObject } from "@/core/stage/stageObject/abstract/StageObject";
import type { PrgMetadata } from "@/types/metadata";
import type { PrgTableData } from "@/types/table";
import { deserialize, serialize } from "@graphif/serializer";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

const PROJECT_STATE_SAVED = 0 as ProjectState;

function hasTauriWindow(): boolean {
  return isTauri() && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function isEditingTextNode(obj: StageObject): boolean {
  return "isEditing" in obj && (obj as { isEditing?: unknown }).isEditing === true;
}

function isImageNodeObject(obj: StageObject): boolean {
  return "attachmentId" in obj && "bitmap" in obj;
}

function hasSectionChildren(obj: StageObject): obj is StageObject & { children: StageObject[] } {
  return "children" in obj && Array.isArray((obj as { children?: unknown }).children);
}

function hasAssociationList(obj: StageObject): obj is StageObject & { associationList: StageObject[] } {
  return "associationList" in obj && Array.isArray((obj as { associationList?: unknown }).associationList);
}

export interface UuidStageDoc {
  objects: Record<string, Record<string, unknown>>;
  order: string[];
}

export interface SerializedAttachment {
  id: string;
  mimeType: string;
  base64: string;
}

export interface DocumentSnapshot {
  stageDoc: UuidStageDoc;
  table: PrgTableData;
  tags: string[];
  references: Project["references"];
  metadata: PrgMetadata;
  readme?: string;
  attachments: SerializedAttachment[];
  projectState: ProjectState;
  docIdNeedsSave: boolean;
}

export interface DocumentPatch {
  upserted?: Record<string, Record<string, unknown>>;
  removed?: string[];
  order?: string[];
  table?: PrgTableData;
  tags?: string[];
  references?: Project["references"];
  metadata?: PrgMetadata;
  readme?: string | null;
  newAttachments?: SerializedAttachment[];
  projectState: ProjectState;
  docIdNeedsSave?: boolean;
}

interface IncomingPatchEvent {
  canonicalPath: string;
  sourceWindow: string;
  revision: number;
  patch: DocumentPatch;
}

interface IncomingSavedEvent {
  canonicalPath: string;
  sourceWindow: string;
  revision: number;
  docId?: string | null;
}

interface IncomingSnapshotRequestEvent {
  requestId: string;
  canonicalPath: string;
  requesterWindow: string;
}

interface IncomingPeersChangedEvent {
  canonicalPath: string;
  peerCount: number;
}

function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSerializedStageItem(value: unknown): value is Record<string, unknown> & { _: string; uuid: string } {
  return isPlainObject(value) && typeof value._ === "string" && typeof value.uuid === "string";
}

function indexSerializedPaths(value: unknown, path: string, map: Map<string, unknown>): void {
  map.set(path || "/", value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      indexSerializedPaths(value[i], `${path}/${i}`, map);
    }
    return;
  }
  if (!isPlainObject(value)) return;
  if ("$" in value && Object.keys(value).length === 1) return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "_") continue;
    indexSerializedPaths(child, `${path}/${key}`, map);
  }
}

/**
 * 将 serializer 输出的 stage 数组转为按顶层 uuid 索引的文档，并把内部 { $: "/idx" } 引用改为 { $u: uuid }。
 * 因为 serialize() 本身已经产出全新对象树，这里只做单遍重写、避免冗余 structuredClone。
 */
export function serializedStageArrayToUuidDoc(serializedStage: unknown[]): UuidStageDoc {
  const objects: Record<string, Record<string, unknown>> = {};
  const order: string[] = [];
  const orderedUuids = new Set<string>();
  const indexToUuid = new Map<string, string>();
  const pathToValue = new Map<string, unknown>();

  let pathsIndexed = false;
  const resolveSerializedPath = (refPath: string): unknown => {
    if (!pathsIndexed) {
      indexSerializedPaths(serializedStage, "", pathToValue);
      pathsIndexed = true;
    }
    const normalized = refPath.startsWith("/") ? refPath : `/${refPath}`;
    return pathToValue.get(normalized) ?? pathToValue.get(refPath);
  };

  const resolveStageItem = (value: unknown): (Record<string, unknown> & { _: string; uuid: string }) | undefined => {
    let candidate = value;
    const visited = new Set<object>();
    while (
      isPlainObject(candidate) &&
      "$" in candidate &&
      typeof candidate.$ === "string" &&
      Object.keys(candidate).length === 1
    ) {
      if (visited.has(candidate)) return undefined;
      visited.add(candidate);
      candidate = resolveSerializedPath(candidate.$);
    }
    return isSerializedStageItem(candidate) ? candidate : undefined;
  };

  for (let i = 0; i < serializedStage.length; i++) {
    const item = resolveStageItem(serializedStage[i]);
    if (!item) continue;
    if (!orderedUuids.has(item.uuid)) {
      order.push(item.uuid);
      orderedUuids.add(item.uuid);
    }
    indexToUuid.set(`/${i}`, item.uuid);
    indexToUuid.set(`${i}`, item.uuid);
  }

  const resolveRefUuid = (refPath: string): string | undefined => {
    const fast = indexToUuid.get(refPath);
    if (fast) return fast;
    return resolveStageItem(resolveSerializedPath(refPath))?.uuid;
  };

  const rewrite = (value: unknown, rootUuid: string): unknown => {
    if (Array.isArray(value)) {
      return value.map((child) => rewrite(child, rootUuid));
    }
    if (!isPlainObject(value)) return value;
    if (isSerializedStageItem(value) && value.uuid !== rootUuid && orderedUuids.has(value.uuid)) {
      return { $u: value.uuid };
    }
    if ("$" in value && typeof value.$ === "string" && Object.keys(value).length === 1) {
      const uuid = resolveRefUuid(value.$);
      return uuid ? { $u: uuid } : value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = rewrite(child, rootUuid);
    }
    return out;
  };

  for (const value of serializedStage) {
    const item = resolveStageItem(value);
    if (!item) continue;
    objects[item.uuid] = rewrite(item, item.uuid) as Record<string, unknown>;
  }

  return { objects, order };
}

export function serializeStageToUuidDoc(stage: StageObject[]): UuidStageDoc {
  return serializedStageArrayToUuidDoc(serialize(stage) as unknown[]);
}

/**
 * 将按 uuid 索引的文档还原为 @graphif/serializer 可反序列化的数组（含全新深拷贝，防止 deserialize 就地修改缓存）。
 */
export function uuidDocToSerializerArray(doc: UuidStageDoc): Record<string, unknown>[] {
  const order = doc.order.filter((uuid) => uuid in doc.objects);
  const seen = new Set(order);
  for (const uuid of Object.keys(doc.objects)) {
    if (!seen.has(uuid)) {
      order.push(uuid);
      seen.add(uuid);
    }
  }

  const uuidToIndex = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    uuidToIndex.set(order[i], i);
  }

  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(rewrite);
    }
    if (!isPlainObject(value)) return value;
    if ("$u" in value && typeof value.$u === "string" && Object.keys(value).length === 1) {
      const idx = uuidToIndex.get(value.$u);
      if (idx === undefined) {
        return value;
      }
      return { $: `/${idx}` };
    }
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = rewrite(child);
    }
    return out;
  };

  return order.map((uuid) => rewrite(doc.objects[uuid]) as Record<string, unknown>);
}

export function computeUuidStageDiff(
  prevStrings: Map<string, string>,
  prevOrder: string[],
  nextDoc: UuidStageDoc,
): {
  upserted: Record<string, Record<string, unknown>>;
  removed: string[];
  orderChanged: boolean;
  nextStrings: Map<string, string>;
} {
  const upserted: Record<string, Record<string, unknown>> = {};
  const nextStrings = new Map<string, string>();

  for (const uuid of nextDoc.order) {
    const obj = nextDoc.objects[uuid];
    if (!obj) continue;
    const serialized = JSON.stringify(obj);
    nextStrings.set(uuid, serialized);
    if (prevStrings.get(uuid) !== serialized) {
      upserted[uuid] = obj;
    }
  }

  const removed: string[] = [];
  for (const uuid of prevStrings.keys()) {
    if (!nextStrings.has(uuid)) {
      removed.push(uuid);
    }
  }

  const orderChanged =
    prevOrder.length !== nextDoc.order.length || prevOrder.some((uuid, index) => uuid !== nextDoc.order[index]);

  return { upserted, removed, orderChanged, nextStrings };
}

export function applyUuidStagePatch(
  currentDoc: UuidStageDoc,
  patch: Pick<DocumentPatch, "upserted" | "removed" | "order">,
): { nextDoc: UuidStageDoc; dirtyUuids: Set<string> } {
  const objects: Record<string, Record<string, unknown>> = { ...currentDoc.objects };
  const dirtyUuids = new Set<string>();

  if (patch.removed) {
    for (const uuid of patch.removed) {
      delete objects[uuid];
      dirtyUuids.add(uuid);
    }
  }
  if (patch.upserted) {
    for (const [uuid, obj] of Object.entries(patch.upserted)) {
      objects[uuid] = obj;
      dirtyUuids.add(uuid);
    }
  }

  let order: string[];
  if (patch.order) {
    order = patch.order.filter((uuid) => uuid in objects);
  } else {
    const removedSet = new Set(patch.removed ?? []);
    order = currentDoc.order.filter((uuid) => !removedSet.has(uuid) && uuid in objects);
    if (patch.upserted) {
      const existing = new Set(order);
      for (const uuid of Object.keys(patch.upserted)) {
        if (!existing.has(uuid)) {
          order.push(uuid);
          existing.add(uuid);
        }
      }
    }
  }

  return { nextDoc: { objects, order }, dirtyUuids };
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType || "application/octet-stream" });
}

/**
 * 将合并后的 UuidStageDoc 安全落地到当前窗口的 Project 实例：
 * - 保留每个窗口独立的相机视野与选中状态；
 * - 保留未变更的 ImageNode 实例（避免重复解码 ImageBitmap 引发图片闪烁）；
 * - 保留当前正在打字编辑中的 TextNode 实例（防止打断输入框）。
 */
export function reconcileProjectStage(project: Project, nextDoc: UuidStageDoc, dirtyUuids: Set<string>): void {
  const prevStage = project.stage;
  const selectedUuids = new Set<string>();
  const preservedByUuid = new Map<string, StageObject>();

  for (const obj of prevStage) {
    if (obj.isSelected) {
      selectedUuids.add(obj.uuid);
    }
    if (isEditingTextNode(obj) && obj.uuid in nextDoc.objects) {
      preservedByUuid.set(obj.uuid, obj);
      continue;
    }
    if (isImageNodeObject(obj) && !dirtyUuids.has(obj.uuid) && obj.uuid in nextDoc.objects) {
      preservedByUuid.set(obj.uuid, obj);
    }
  }

  const nextStage = deserialize(uuidDocToSerializerArray(nextDoc), project) as StageObject[];
  const redundantNewObjects: StageObject[] = [];

  if (preservedByUuid.size > 0) {
    for (let i = 0; i < nextStage.length; i++) {
      const candidate = nextStage[i];
      const preserved = preservedByUuid.get(candidate.uuid);
      if (preserved) {
        redundantNewObjects.push(candidate);
        nextStage[i] = preserved;
      }
    }

    for (const obj of nextStage) {
      if (hasSectionChildren(obj)) {
        for (let i = 0; i < obj.children.length; i++) {
          const preserved = preservedByUuid.get(obj.children[i].uuid);
          if (preserved) {
            obj.children[i] = preserved;
          }
        }
      } else if (hasAssociationList(obj)) {
        for (let i = 0; i < obj.associationList.length; i++) {
          const preserved = preservedByUuid.get(obj.associationList[i].uuid);
          if (preserved) {
            obj.associationList[i] = preserved;
          }
        }
      }
    }
  }

  for (const obj of nextStage) {
    obj.isSelected = selectedUuids.has(obj.uuid);
  }

  project.stage = nextStage;

  for (const oldObj of prevStage) {
    if (preservedByUuid.get(oldObj.uuid) !== oldObj) {
      void oldObj.dispose?.();
    }
  }
  for (const redundant of redundantNewObjects) {
    void redundant.dispose?.();
  }

  if (project.getService?.("stageManager")) {
    project.stageManager.updateReferences();
  }
}

export async function exportLiveDocumentSnapshot(project: Project): Promise<DocumentSnapshot> {
  if (project.getService?.("stageTable")) {
    project.stageTable.flushPendingTimestamps();
  }
  const stageDoc = serializeStageToUuidDoc(project.stage);
  const attachments: SerializedAttachment[] = [];
  for (const [id, blob] of project.attachments.entries()) {
    attachments.push({
      id,
      mimeType: blob.type || "application/octet-stream",
      base64: await blobToBase64(blob),
    });
  }
  return {
    stageDoc,
    table: structuredClone(project.table),
    tags: [...project.tags],
    references: structuredClone(project.references),
    metadata: structuredClone(project.metadata),
    readme: project.readme,
    attachments,
    projectState: project.projectState,
    docIdNeedsSave: project.docIdNeedsSave,
  };
}

export function hydrateProjectFromSnapshot(project: Project, snapshot: DocumentSnapshot): void {
  project.attachments.clear();
  for (const att of snapshot.attachments) {
    project.attachments.set(att.id, base64ToBlob(att.base64, att.mimeType));
  }
  project.stage = deserialize(uuidDocToSerializerArray(snapshot.stageDoc), project) as StageObject[];
  project.table = structuredClone(snapshot.table);
  project.tags = [...snapshot.tags];
  project.references = structuredClone(snapshot.references);
  project.metadata = structuredClone(snapshot.metadata);
  project.readme = snapshot.readme;
  project.docIdNeedsSave = snapshot.docIdNeedsSave;
  project.projectState = snapshot.projectState;

  if (project.getService?.("stageManager")) {
    project.stageManager.updateReferences();
  }
  if (project.getService?.("tagManager")) {
    project.tagManager.reset(project.tags);
  }
  if (project.getService?.("stageTable")) {
    project.stageTable.resetAfterStageRestore();
  }
}

interface AttachedDocumentEntry {
  project: Project;
  canonicalPath: string;
  pathKey: string;
  shadowDoc: UuidStageDoc;
  shadowStrings: Map<string, string>;
  lastTableJson: string;
  lastTagsJson: string;
  lastRefsJson: string;
  lastMetaJson: string;
  lastReadme: string | undefined;
  knownAttachmentIds: Set<string>;
  lastAppliedRevision: number;
  peerCount: number;
  shadowReady: boolean;
  applyingRemote: boolean;
  debounceTimer?: ReturnType<typeof setTimeout>;
  sendQueue: Promise<void>;
  onStageCommit: () => void;
  onDebouncedCommit: () => void;
  onAttachmentAdd: (payload: { id: string; data: Blob }) => void;
}

class LocalDocumentSyncManager {
  private readonly entriesByPath = new Map<string, AttachedDocumentEntry>();
  private readonly entriesByProject = new WeakMap<Project, AttachedDocumentEntry>();
  private listenersReady: Promise<void> | null = null;

  public async ensureListeners(): Promise<void> {
    if (!hasTauriWindow()) return;
    if (this.listenersReady) return this.listenersReady;
    this.listenersReady = (async () => {
      const currentWindow = getCurrentWindow();
      await currentWindow.listen<IncomingPatchEvent>("pg-doc-patch", ({ payload }) => {
        this.handleIncomingPatch(payload);
      });
      await currentWindow.listen<IncomingSavedEvent>("pg-doc-saved", ({ payload }) => {
        this.handleIncomingSaved(payload);
      });
      await currentWindow.listen<IncomingSnapshotRequestEvent>("pg-doc-snapshot-request", ({ payload }) => {
        void this.handleSnapshotRequest(payload);
      });
      await currentWindow.listen<IncomingPeersChangedEvent>("pg-doc-peers-changed", ({ payload }) => {
        this.handlePeersChanged(payload);
      });
    })();
    return this.listenersReady;
  }

  public attach(project: Project, canonicalPath: string, initialPeerCount = 0): void {
    if (!hasTauriWindow() || !canonicalPath) return;
    void this.ensureListeners();
    this.detach(project);

    const pathKey = normalizePathKey(canonicalPath);
    const hasPeers = initialPeerCount > 0;
    const shadowDoc: UuidStageDoc = hasPeers ? serializeStageToUuidDoc(project.stage) : { objects: {}, order: [] };
    const shadowStrings = new Map<string, string>();
    if (hasPeers) {
      for (const uuid of shadowDoc.order) {
        const obj = shadowDoc.objects[uuid];
        if (obj) shadowStrings.set(uuid, JSON.stringify(obj));
      }
    }

    const entry: AttachedDocumentEntry = {
      project,
      canonicalPath,
      pathKey,
      shadowDoc,
      shadowStrings,
      lastTableJson: hasPeers ? JSON.stringify(project.table) : "",
      lastTagsJson: hasPeers ? JSON.stringify(project.tags) : "",
      lastRefsJson: hasPeers ? JSON.stringify(project.references) : "",
      lastMetaJson: hasPeers ? JSON.stringify(project.metadata) : "",
      lastReadme: project.readme,
      knownAttachmentIds: new Set(project.attachments.keys()),
      lastAppliedRevision: 0,
      peerCount: initialPeerCount,
      shadowReady: hasPeers,
      applyingRemote: false,
      sendQueue: Promise.resolve(),
      onStageCommit: () => {
        this.scheduleFlush(entry, 0);
      },
      onDebouncedCommit: () => {
        this.scheduleFlush(entry, 250);
      },
      onAttachmentAdd: () => {
        this.scheduleFlush(entry, 120);
      },
    };

    project.on("stage-commit", entry.onStageCommit);
    project.on("document-commit", entry.onStageCommit);
    project.on("document-commit-debounced", entry.onDebouncedCommit);
    project.on("attachment-add", entry.onAttachmentAdd);

    this.entriesByPath.set(pathKey, entry);
    this.entriesByProject.set(project, entry);
  }

  public rebind(project: Project, nextCanonicalPath: string): void {
    const entry = this.entriesByProject.get(project);
    if (!entry) {
      this.attach(project, nextCanonicalPath);
      return;
    }
    const nextKey = normalizePathKey(nextCanonicalPath);
    if (nextKey === entry.pathKey) return;
    if (this.entriesByPath.get(entry.pathKey) === entry) {
      this.entriesByPath.delete(entry.pathKey);
    }
    entry.canonicalPath = nextCanonicalPath;
    entry.pathKey = nextKey;
    this.entriesByPath.set(nextKey, entry);
  }

  public async flushAndDetach(project: Project): Promise<void> {
    const entry = this.entriesByProject.get(project);
    if (!entry) return;
    if (entry.debounceTimer !== undefined) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = undefined;
      this.enqueueFlush(entry);
    }
    await entry.sendQueue;
    this.detach(project);
  }

  public detach(project: Project): void {
    const entry = this.entriesByProject.get(project);
    if (!entry) return;
    if (entry.debounceTimer !== undefined) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = undefined;
    }
    project.off("stage-commit", entry.onStageCommit);
    project.off("document-commit", entry.onStageCommit);
    project.off("document-commit-debounced", entry.onDebouncedCommit);
    project.off("attachment-add", entry.onAttachmentAdd);
    if (this.entriesByPath.get(entry.pathKey) === entry) {
      this.entriesByPath.delete(entry.pathKey);
    }
    this.entriesByProject.delete(project);
  }

  public async notifySaved(project: Project): Promise<void> {
    if (!hasTauriWindow()) return;
    const entry = this.entriesByProject.get(project);
    if (!entry || entry.peerCount === 0) return;
    if (entry.debounceTimer !== undefined) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = undefined;
    }
    this.enqueueFlush(entry);
    await entry.sendQueue;
    await invoke<number>("broadcast_document_saved", {
      canonicalPath: entry.canonicalPath,
      docId: project.metadata.docId ?? null,
    });
  }

  public async requestPeerSnapshot(canonicalPath: string, peerWindowLabel: string): Promise<DocumentSnapshot | null> {
    if (!hasTauriWindow()) return null;
    const snapshot = await invoke<DocumentSnapshot | null>("request_peer_document_snapshot", {
      canonicalPath,
      peerWindowLabel,
    });
    return snapshot ?? null;
  }

  private ensureShadowBaseline(entry: AttachedDocumentEntry): void {
    if (entry.shadowReady) return;
    const { project } = entry;
    const shadowDoc = serializeStageToUuidDoc(project.stage);
    const shadowStrings = new Map<string, string>();
    for (const uuid of shadowDoc.order) {
      const obj = shadowDoc.objects[uuid];
      if (obj) shadowStrings.set(uuid, JSON.stringify(obj));
    }
    entry.shadowDoc = shadowDoc;
    entry.shadowStrings = shadowStrings;
    entry.lastTableJson = JSON.stringify(project.table);
    entry.lastTagsJson = JSON.stringify(project.tags);
    entry.lastRefsJson = JSON.stringify(project.references);
    entry.lastMetaJson = JSON.stringify(project.metadata);
    entry.lastReadme = project.readme;
    entry.knownAttachmentIds = new Set(project.attachments.keys());
    entry.shadowReady = true;
  }

  private handlePeersChanged(event: IncomingPeersChangedEvent): void {
    const entry = this.entriesByPath.get(normalizePathKey(event.canonicalPath));
    if (!entry || entry.project.closing) return;
    const prevPeers = entry.peerCount;
    entry.peerCount = event.peerCount;
    if (event.peerCount > 0 && prevPeers === 0) {
      entry.shadowReady = false;
      this.ensureShadowBaseline(entry);
    } else if (event.peerCount === 0) {
      entry.shadowReady = false;
    }
  }

  private scheduleFlush(entry: AttachedDocumentEntry, delayMs: number): void {
    if (entry.applyingRemote || entry.project.closing || entry.peerCount === 0) return;
    if (entry.debounceTimer !== undefined) {
      clearTimeout(entry.debounceTimer);
      entry.debounceTimer = undefined;
    }
    if (delayMs <= 0) {
      this.enqueueFlush(entry);
      return;
    }
    entry.debounceTimer = setTimeout(() => {
      entry.debounceTimer = undefined;
      this.enqueueFlush(entry);
    }, delayMs);
  }

  private enqueueFlush(entry: AttachedDocumentEntry): void {
    entry.sendQueue = entry.sendQueue
      .then(() => this.flushDiff(entry))
      .catch((error) => {
        console.error("[LocalDocumentSync] flush failed", error);
      });
  }

  private async flushDiff(entry: AttachedDocumentEntry): Promise<void> {
    if (entry.applyingRemote || entry.project.closing || entry.peerCount === 0) return;
    this.ensureShadowBaseline(entry);
    const { project } = entry;

    const nextDoc = serializeStageToUuidDoc(project.stage);
    const { upserted, removed, orderChanged, nextStrings } = computeUuidStageDiff(
      entry.shadowStrings,
      entry.shadowDoc.order,
      nextDoc,
    );

    const hasStageChanges = Object.keys(upserted).length > 0 || removed.length > 0 || orderChanged;
    const nextTableJson = JSON.stringify(project.table);
    const nextTagsJson = JSON.stringify(project.tags);
    const nextRefsJson = JSON.stringify(project.references);
    const nextMetaJson = JSON.stringify(project.metadata);

    const tableChanged = nextTableJson !== entry.lastTableJson;
    const tagsChanged = nextTagsJson !== entry.lastTagsJson;
    const refsChanged = nextRefsJson !== entry.lastRefsJson;
    const metaChanged = nextMetaJson !== entry.lastMetaJson;
    const readmeChanged = project.readme !== entry.lastReadme;

    const newAttachments: SerializedAttachment[] = [];
    for (const [id, blob] of project.attachments.entries()) {
      if (!entry.knownAttachmentIds.has(id)) {
        newAttachments.push({
          id,
          mimeType: blob.type || "application/octet-stream",
          base64: await blobToBase64(blob),
        });
        entry.knownAttachmentIds.add(id);
      }
    }

    if (
      !hasStageChanges &&
      !tableChanged &&
      !tagsChanged &&
      !refsChanged &&
      !metaChanged &&
      !readmeChanged &&
      newAttachments.length === 0
    ) {
      return;
    }

    const patch: DocumentPatch = {
      projectState: project.projectState,
      docIdNeedsSave: project.docIdNeedsSave,
    };
    if (Object.keys(upserted).length > 0) patch.upserted = upserted;
    if (removed.length > 0) patch.removed = removed;
    if (orderChanged) patch.order = nextDoc.order;
    if (tableChanged) patch.table = structuredClone(project.table);
    if (tagsChanged) patch.tags = [...project.tags];
    if (refsChanged) patch.references = structuredClone(project.references);
    if (metaChanged) patch.metadata = structuredClone(project.metadata);
    if (readmeChanged) patch.readme = project.readme ?? null;
    if (newAttachments.length > 0) patch.newAttachments = newAttachments;

    entry.shadowDoc = nextDoc;
    entry.shadowStrings = nextStrings;
    entry.lastTableJson = nextTableJson;
    entry.lastTagsJson = nextTagsJson;
    entry.lastRefsJson = nextRefsJson;
    entry.lastMetaJson = nextMetaJson;
    entry.lastReadme = project.readme;

    const revision = await invoke<number>("broadcast_document_patch", {
      canonicalPath: entry.canonicalPath,
      patch,
    });
    entry.lastAppliedRevision = Math.max(entry.lastAppliedRevision, revision);
  }

  private handleIncomingPatch(event: IncomingPatchEvent): void {
    const pathKey = normalizePathKey(event.canonicalPath);
    const entry = this.entriesByPath.get(pathKey);
    if (!entry || entry.project.closing) return;
    if (event.revision <= entry.lastAppliedRevision) return;

    const { project } = entry;
    const { patch } = event;
    if (entry.peerCount === 0) entry.peerCount = 1;
    this.ensureShadowBaseline(entry);

    entry.applyingRemote = true;
    try {
      if (patch.newAttachments) {
        for (const att of patch.newAttachments) {
          if (!project.attachments.has(att.id)) {
            project.attachments.set(att.id, base64ToBlob(att.base64, att.mimeType));
          }
          entry.knownAttachmentIds.add(att.id);
        }
      }

      if (patch.table !== undefined) {
        project.table = structuredClone(patch.table);
        entry.lastTableJson = JSON.stringify(project.table);
      }
      if (patch.tags !== undefined) {
        project.tags = [...patch.tags];
        entry.lastTagsJson = JSON.stringify(project.tags);
        if (project.getService?.("tagManager")) {
          project.tagManager.reset(project.tags);
        }
      }
      if (patch.references !== undefined) {
        project.references = structuredClone(patch.references);
        entry.lastRefsJson = JSON.stringify(project.references);
      }
      if (patch.metadata !== undefined) {
        project.metadata = structuredClone(patch.metadata);
        entry.lastMetaJson = JSON.stringify(project.metadata);
      }
      if (patch.readme !== undefined) {
        project.readme = patch.readme === null ? undefined : patch.readme;
        entry.lastReadme = project.readme;
      }
      if (patch.docIdNeedsSave !== undefined) {
        project.docIdNeedsSave = patch.docIdNeedsSave;
      }

      const hasStageChanges =
        Boolean(patch.upserted && Object.keys(patch.upserted).length > 0) ||
        Boolean(patch.removed && patch.removed.length > 0) ||
        patch.order !== undefined;

      if (hasStageChanges) {
        const { nextDoc, dirtyUuids } = applyUuidStagePatch(entry.shadowDoc, patch);
        reconcileProjectStage(project, nextDoc, dirtyUuids);
        entry.shadowDoc = nextDoc;
        if (patch.removed) {
          for (const uuid of patch.removed) {
            entry.shadowStrings.delete(uuid);
          }
        }
        if (patch.upserted) {
          for (const [uuid, obj] of Object.entries(patch.upserted)) {
            entry.shadowStrings.set(uuid, JSON.stringify(obj));
          }
        }
        if (project.getService?.("historyManager")) {
          project.historyManager.recordExternalStage(patch.projectState);
        }
      }

      project.projectState = patch.projectState;

      if (project.getService?.("stageTable")) {
        if (hasStageChanges) {
          project.stageTable.resetAfterStageRestore();
        }
        project.stageTable.notifyChange({ emitSync: false });
      }

      // 即便本窗口当前未聚焦或渲染循环处于暂停态，也强制重绘一帧让新笔迹/文字立即可见
      if (project.getService?.("renderer")) {
        project.renderer.tick();
      }
      project.loop();
      entry.lastAppliedRevision = event.revision;
    } finally {
      entry.applyingRemote = false;
    }
  }

  private handleIncomingSaved(event: IncomingSavedEvent): void {
    const pathKey = normalizePathKey(event.canonicalPath);
    const entry = this.entriesByPath.get(pathKey);
    if (!entry || entry.project.closing) return;
    if (event.revision < entry.lastAppliedRevision) return;
    entry.applyingRemote = true;
    try {
      if (event.docId && !entry.project.metadata.docId) {
        entry.project.metadata = { ...entry.project.metadata, docId: event.docId };
        entry.lastMetaJson = JSON.stringify(entry.project.metadata);
      }
      entry.project.docIdNeedsSave = false;
      entry.project.projectState = PROJECT_STATE_SAVED;
    } finally {
      entry.applyingRemote = false;
    }
  }

  private async handleSnapshotRequest(event: IncomingSnapshotRequestEvent): Promise<void> {
    const pathKey = normalizePathKey(event.canonicalPath);
    const entry = this.entriesByPath.get(pathKey);
    if (!entry || entry.project.closing) {
      await invoke("respond_peer_document_snapshot", {
        requestId: event.requestId,
        snapshot: null,
      });
      return;
    }
    try {
      const snapshot = await exportLiveDocumentSnapshot(entry.project);
      await invoke("respond_peer_document_snapshot", {
        requestId: event.requestId,
        snapshot,
      });
    } catch {
      await invoke("respond_peer_document_snapshot", {
        requestId: event.requestId,
        snapshot: null,
      });
    }
  }
}

export const LocalDocumentSync = new LocalDocumentSyncManager();
