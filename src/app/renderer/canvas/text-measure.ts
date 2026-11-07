interface TextContext {
  font: string;
  measureText(text: string): { width: number };
}

interface Page {
  document?: {
    documentElement: object;
    createElement(tag: "canvas"): { getContext(kind: "2d"): TextContext | null };
  };
  getComputedStyle?(element: object): { getPropertyValue(name: string): string };
}

const page = globalThis as Page;

const widths = new Map<string, number>();

let context: TextContext | null = null;

const canvasContext = (): TextContext | null => {
  if (context === null && page.document !== undefined) {
    context = page.document.createElement("canvas").getContext("2d");
  }
  return context;
};

const resolvedFont = (font: string): string | undefined => {
  const root = page.document?.documentElement;
  const style = root === undefined ? undefined : page.getComputedStyle?.(root);
  if (style === undefined) return undefined;
  let unset = false;
  const resolved = font.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
    const value = style.getPropertyValue(name).trim();
    if (value === "") unset = true;
    return value;
  });
  return unset ? undefined : resolved;
};

export const renderedWidth = (text: string, font: string): number | undefined => {
  const canvas = canvasContext();
  if (canvas === null) return undefined;
  const resolved = resolvedFont(font);
  if (resolved === undefined) return undefined;
  const key = `${resolved}\n${text}`;
  const cached = widths.get(key);
  if (cached !== undefined) return cached;
  canvas.font = resolved;
  const width = Math.ceil(canvas.measureText(text).width);
  widths.set(key, width);
  return width;
};
