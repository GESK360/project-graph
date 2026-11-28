// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { ImageBitmapLruCache, DEFAULT_IMAGE_BITMAP_CACHE_MAX_BYTES } from "./ImageBitmapLruCache";

function makeFakeBitmap(width: number, height: number) {
  return {
    width,
    height,
    close: vi.fn(),
  } as unknown as ImageBitmap & { close: ReturnType<typeof vi.fn> };
}

describe("ImageBitmapLruCache", () => {
  it("defaults to 256 MB GPU memory budget", () => {
    expect(DEFAULT_IMAGE_BITMAP_CACHE_MAX_BYTES).toBe(256 * 1024 * 1024);
  });

  it("evicts off-screen LRU bitmaps via bitmap.close() while pinning active viewport bitmaps, and re-decodes on return", async () => {
    // 1000x1000 RGBA = 4,000,000 bytes (~4 MB) per bitmap; budget = 10 MB -> fits 2 bitmaps
    const cache = new ImageBitmapLruCache(10_000_000);
    const bitmaps = new Map<string, ReturnType<typeof makeFakeBitmap>>();
    const evictedEvents: string[] = [];

    const makeConsumer = (id: string) => ({
      onBitmapEvicted: (attId: string) => {
        evictedEvents.push(`${id}:${attId}`);
      },
    });

    const c1 = makeConsumer("node-1");
    const c2 = makeConsumer("node-2");
    const c3 = makeConsumer("node-3");

    const decode = (id: string) => async () => {
      const bm = makeFakeBitmap(1000, 1000);
      bitmaps.set(id, bm);
      return bm;
    };

    // Frame 1: node-1 and node-2 are visible
    const bm1 = await cache.acquire("att-1", decode("att-1"), c1, 1);
    const bm2 = await cache.acquire("att-2", decode("att-2"), c2, 1);
    expect(bm1).toBe(bitmaps.get("att-1"));
    expect(bm2).toBe(bitmaps.get("att-2"));
    expect(cache.getStats().totalBytes).toBe(8_000_000);
    expect(cache.getStats().entryCount).toBe(2);

    // Frame 2: node-1 scrolls off-screen, node-2 & node-3 are visible (total 12MB > 10MB budget)
    cache.markVisible("att-2", 2);
    const bm3 = await cache.acquire("att-3", decode("att-3"), c3, 2);
    expect(bm3).toBe(bitmaps.get("att-3"));
    cache.evictIfOverBudget(2);

    // att-1 was off-screen in frame 2 -> evicted & bitmap.close() called
    expect(bitmaps.get("att-1")!.close).toHaveBeenCalledOnce();
    expect(evictedEvents).toEqual(["node-1:att-1"]);
    // att-2 & att-3 are pinned on screen in frame 2 -> untouched
    expect(bitmaps.get("att-2")!.close).not.toHaveBeenCalled();
    expect(bitmaps.get("att-3")!.close).not.toHaveBeenCalled();
    expect(cache.getStats().entryCount).toBe(2);
    expect(cache.getStats().totalBytes).toBe(8_000_000);

    // Frame 3: node-1 returns into viewport -> re-decoded on demand cleanly
    const bm1Reloaded = await cache.acquire("att-1", decode("att-1-v2"), c1, 3);
    expect(bm1Reloaded).toBe(bitmaps.get("att-1-v2"));
    cache.evictIfOverBudget(3);
    expect(bitmaps.get("att-2")!.close).toHaveBeenCalledOnce();

    // Dispose closes all remaining cached bitmaps
    cache.dispose();
    expect(bitmaps.get("att-1-v2")!.close).toHaveBeenCalledOnce();
    expect(bitmaps.get("att-3")!.close).toHaveBeenCalledOnce();
    expect(cache.getStats().entryCount).toBe(0);
    expect(cache.getStats().totalBytes).toBe(0);
  });
});
