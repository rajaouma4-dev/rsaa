export type PreviewPoint = {x: number; y: number};
export type PreviewBounds = {minX: number; maxX: number; minY: number; maxY: number};

export function previewBounds(width: number, height: number, previewWidth: number,
  previewHeight: number, topInset: number, controlsHeight: number): PreviewBounds {
  const minX = 12;
  const maxX = Math.max(minX, width - previewWidth - 12);
  const maxY = Math.max(12, height - controlsHeight - previewHeight - 16);
  return {minX, maxX, minY: Math.min(topInset + 100, maxY), maxY};
}

export function clampPreview(point: PreviewPoint, bounds: PreviewBounds): PreviewPoint {
  return {x: Math.max(bounds.minX, Math.min(bounds.maxX, point.x)),
    y: Math.max(bounds.minY, Math.min(bounds.maxY, point.y))};
}
