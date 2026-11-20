// @vitest-environment jsdom

import type { Project } from "@/core/Project";
import { expect, it, vi } from "vitest";

vi.mock("@/core/Project", () => ({ Project: class {}, service: () => () => undefined }));
vi.mock("@/core/service/Settings", () => ({ Settings: { antialiasing: "disabled" } }));
vi.mock("@/state", () => ({}));

import { Canvas } from "./Canvas";

it("repaints the canvas when its container expands without waiting for the render loop", () => {
  let resize!: () => void;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const element = document.createElement("canvas");
  vi.spyOn(element, "getContext").mockReturnValue({} as CanvasRenderingContext2D);
  const resizeWindow = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false);
  const tick = vi.fn();
  const canvas = new Canvas({ renderer: { resizeWindow, tick } } as unknown as Project, element);

  try {
    const wrapper = document.createElement("div");
    document.body.append(wrapper);
    let width = 760;
    vi.spyOn(wrapper, "clientWidth", "get").mockImplementation(() => width);
    vi.spyOn(wrapper, "clientHeight", "get").mockReturnValue(600);
    canvas.mount(wrapper);
    expect(resizeWindow).toHaveBeenLastCalledWith(760, 600);
    expect(tick).toHaveBeenCalledExactlyOnceWith(true);

    width = 1024;
    resize();
    expect(resizeWindow).toHaveBeenLastCalledWith(1024, 600);
    expect(tick).toHaveBeenCalledTimes(2);

    resize();
    width = 0;
    resize();
    expect(resizeWindow).toHaveBeenCalledTimes(3);
    expect(tick).toHaveBeenCalledTimes(2);
  } finally {
    canvas.dispose();
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  }
});
