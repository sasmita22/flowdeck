export type WindowGuardOptions = { appUrl: string };

export type SenderFrame = { url: string; parent: unknown } | null;

export type IpcEvent = { senderFrame: SenderFrame };

export type WindowGuard = {
  isAppFrame(frame: SenderFrame): boolean;
  allowsNavigation(url: string): boolean;
  denyWindowOpen(): { action: "deny" };
  handle<A extends unknown[], R>(fn: (...args: A) => R): (event: IpcEvent, ...args: A) => R;
  listen<A extends unknown[]>(fn: (...args: A) => void): (event: IpcEvent, ...args: A) => void;
};

function parse(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

function withoutHash(url: URL): string {
  const copy = new URL(url.href);
  copy.hash = "";
  return copy.href;
}

export function createWindowGuard(options: WindowGuardOptions): WindowGuard {
  const app = new URL(options.appUrl);

  const matchesApp = (url: string): boolean => {
    const candidate = parse(url);
    if (!candidate) return false;
    if (app.protocol === "file:") return withoutHash(candidate) === withoutHash(app);
    return candidate.origin === app.origin;
  };

  const isAppFrame = (frame: SenderFrame): boolean =>
    frame !== null && frame.parent === null && matchesApp(frame.url);

  return {
    isAppFrame,
    allowsNavigation: matchesApp,
    denyWindowOpen: () => ({ action: "deny" }),
    handle(fn) {
      return (event, ...args) => {
        if (!isAppFrame(event.senderFrame)) throw new Error("IPC sender is not the app page");
        return fn(...args);
      };
    },
    listen(fn) {
      return (event, ...args) => {
        if (!isAppFrame(event.senderFrame)) return;
        fn(...args);
      };
    },
  };
}
