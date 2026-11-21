const slots = [1, 2, 3, 4, 5, 6, 7, 8, 9];

export const handwritingPresetShortcuts = (["Pen", "Eraser"] as const).flatMap((kind) =>
  slots.map((slot) => ({
    kind,
    slot,
    id: `selectHandwriting${kind}${slot}`,
    defaultKey: `A-${kind === "Pen" ? "p" : "e"}+${slot}`,
  })),
);
