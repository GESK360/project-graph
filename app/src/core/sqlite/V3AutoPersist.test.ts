// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { buildFluxMediaUrl } from "./DocClient";
import { V3AutoPersistController } from "./V3AutoPersist";

const mockPutAttachment = vi.fn<
  (
    docId: string,
    attachmentId: string,
    mimeType: string,
    bytes: Uint8Array,
  ) => Promise<{
    id: string;
    mime: string;
    width: number;
    height: number;
    sizeBytes: number;
    hasThumb: boolean;
  }>
>(async () => ({
  id: "att-new",
  mime: "image/png",
  width: 64,
  height: 64,
  sizeBytes: 4,
  hasThumb: true,
}));

vi.mock("./DocClient", async () => {
  const actual = await vi.importActual<typeof import("./DocClient")>("./DocClient");
  return {
    ...actual,
    DocClient: {
      ...actual.DocClient,
      putAttachment: (docId: string, attachmentId: string, mimeType: string, bytes: Uint8Array) =>
        mockPutAttachment(docId, attachmentId, mimeType, bytes),
    },
  };
});

describe("M2 SQLite DocClient URL & V3AutoPersist (attachment streaming only)", () => {
  beforeEach(() => {
    mockPutAttachment.mockClear();
  });

  it("formats flux-media URL with optional thumb query", () => {
    const full = buildFluxMediaUrl("doc-123", "att-456");
    const thumb = buildFluxMediaUrl("doc-123", "att-456", { thumb: true });
    expect(full).toContain("/doc/doc-123/att-456");
    expect(full).not.toContain("thumb=1");
    expect(thumb).toContain("/doc/doc-123/att-456?thumb=1");
  });

  it("persists binary attachments directly to SQLite, frees JS Blob, and flushes docCommandBus", async () => {
    const attachments = new Map<string, Blob>();
    const registeredMetas: unknown[] = [];
    const flushCommandBus = vi.fn(async () => {});

    const mockProject: any = {
      isSqliteV3: true,
      v3DocId: "doc-auto-1",
      docId: "doc-auto-1",
      attachments,
      docCommandBus: { flush: flushCommandBus },
      registerV3AttachmentMeta: (meta: unknown) => registeredMetas.push(meta),
    };

    const controller = new V3AutoPersistController(mockProject);

    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });
    attachments.set("att-new", blob);
    await controller.enqueueAttachmentPersist("att-new", blob);
    expect(mockPutAttachment).toHaveBeenCalledOnce();
    expect(registeredMetas).toHaveLength(1);
    expect(attachments.has("att-new")).toBe(false);

    await controller.flush();
    expect(flushCommandBus).toHaveBeenCalledOnce();

    await controller.dispose();
    expect(flushCommandBus).toHaveBeenCalledTimes(2);
  });
});
