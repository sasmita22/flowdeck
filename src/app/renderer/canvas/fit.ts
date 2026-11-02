import { getViewportForBounds, type Rect } from "@xyflow/react";

export type Viewport = { x: number; y: number; zoom: number };

export const startViewport: Viewport = { x: 24, y: 56, zoom: 1 };

export const dotGap = 18;

const onGrid = (value: number, origin: number) =>
  origin + Math.round((value - origin) / dotGap) * dotGap;

export const snappedToDots = (viewport: Viewport): Viewport =>
  viewport.zoom !== 1
    ? viewport
    : {
        x: onGrid(viewport.x, startViewport.x),
        y: onGrid(viewport.y, startViewport.y),
        zoom: 1,
      };

const fitPadding = 0.1;
const minZoom = 0.5;

const showsAtStart = ({ x, y, width, height }: Rect, size: { width: number; height: number }) =>
  x + startViewport.x >= 0 &&
  y + startViewport.y >= 0 &&
  x + width + startViewport.x <= size.width &&
  y + height + startViewport.y <= size.height;

export const openingViewport = (bounds: Rect, size: { width: number; height: number }): Viewport =>
  showsAtStart(bounds, size)
    ? startViewport
    : snappedToDots(getViewportForBounds(bounds, size.width, size.height, minZoom, 1, fitPadding));
