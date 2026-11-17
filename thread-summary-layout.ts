export interface SummaryPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

/** Leave breathing room on both sides without ever moving the transcript. */
export function summaryPosition(
  pane: { left: number; top: number; bottom: number },
  columnLeft: number,
): SummaryPosition | null {
  const gap = 24;
  const width = Math.min(288, columnLeft - pane.left - gap * 2);
  const maxHeight = pane.bottom - pane.top - gap * 2;
  if (width < 220 || maxHeight < 120) return null;
  return { left: pane.left + gap, top: pane.top + gap, width, maxHeight };
}
