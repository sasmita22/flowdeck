export type Rect = { x: number; y: number; width: number; height: number };

export type Size = { width: number; height: number };

const share = 0.8;
const minimum: Size = { width: 960, height: 640 };

export const minimumWindowSize = (workArea: Rect): Size => ({
  width: Math.min(minimum.width, workArea.width),
  height: Math.min(minimum.height, workArea.height),
});

export const defaultWindowBounds = (workArea: Rect): Rect => {
  const floor = minimumWindowSize(workArea);
  const width = Math.max(Math.round(workArea.width * share), floor.width);
  const height = Math.max(Math.round(workArea.height * share), floor.height);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
};
