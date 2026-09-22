import type { Vault } from "obsidian";

export const DEBUG_LOG_PATH = "together-debug.log";

type ConsoleFn = (...args: unknown[]) => void;

function serializeArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return arg.stack ?? `${arg.name}: ${arg.message}`;
  try { return JSON.stringify(arg); }
  catch { return String(arg); }
}

export class FileLogger {
  private vault: Vault | null = null;
  private pendingLines: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private readonly origLog: ConsoleFn;
  private readonly origInfo: ConsoleFn;
  private readonly origWarn: ConsoleFn;
  private readonly origError: ConsoleFn;

  // Stable references required for removeEventListener
  private readonly onErrorHandler = (ev: ErrorEvent): void => {
    const detail = ev.error?.stack ?? `${ev.message} (${ev.filename}:${ev.lineno}:${ev.colno})`;
    this.writeLine(`UNCAUGHT ${detail}`);
  };

  private readonly onRejectionHandler = (ev: PromiseRejectionEvent): void => {
    const reason = ev.reason instanceof Error
      ? (ev.reason.stack ?? `${ev.reason.name}: ${ev.reason.message}`)
      : String(ev.reason);
    this.writeLine(`UNHANDLED_REJECTION ${reason}`);
  };

  constructor() {
    this.origLog   = console.log.bind(console);
    this.origInfo  = console.info.bind(console);
    this.origWarn  = console.warn.bind(console);
    this.origError = console.error.bind(console);
  }

  start(): void {
    // Intercept console.* (originals still called — no log loss)
    const capture = (level: string, orig: ConsoleFn, args: unknown[]): void => {
      orig(...args);
      this.writeLine(`${level} ${args.map(serializeArg).join(" ")}`);
    };
    console.log   = (...args) => capture("LOG  ", this.origLog,   args);
    console.info  = (...args) => capture("INFO ", this.origInfo,  args);
    console.warn  = (...args) => capture("WARN ", this.origWarn,  args);
    console.error = (...args) => capture("ERROR", this.origError, args);

    // addEventListener coexists with Obsidian's own handlers; property assignment would clobber them
    window.addEventListener("error", this.onErrorHandler);
    window.addEventListener("unhandledrejection", this.onRejectionHandler);
  }

  stop(): void {
    console.log   = this.origLog;
    console.info  = this.origInfo;
    console.warn  = this.origWarn;
    console.error = this.origError;
    window.removeEventListener("error", this.onErrorHandler);
    window.removeEventListener("unhandledrejection", this.onRejectionHandler);
    if (this.flushTimer !== null) { clearInterval(this.flushTimer); this.flushTimer = null; }
  }

  attachVault(vault: Vault): void {
    this.vault = vault;
    void this.flushToFile();
    this.flushTimer = setInterval(() => void this.flushToFile(), 1000);
  }

  async clearLog(): Promise<void> {
    this.pendingLines = [];
    if (!this.vault) return;
    try {
      if (await this.vault.adapter.exists(DEBUG_LOG_PATH)) {
        await this.vault.adapter.write(DEBUG_LOG_PATH, "");
      }
    } catch { /* ignore */ }
  }

  getBufferedContent(): string {
    return this.pendingLines.join("\n");
  }

  private writeLine(message: string): void {
    const line = `${new Date().toISOString()} ${message}`;
    this.pendingLines.push(line);
    if (this.pendingLines.length > 3000) this.pendingLines.shift();
  }

  private async flushToFile(): Promise<void> {
    if (!this.vault || !this.pendingLines.length) return;
    const content = this.pendingLines.join("\n") + "\n";
    this.pendingLines = [];
    try {
      const adapter = this.vault.adapter;
      if (await adapter.exists(DEBUG_LOG_PATH)) {
        await adapter.append(DEBUG_LOG_PATH, content);
      } else {
        await adapter.write(DEBUG_LOG_PATH, content);
      }
    } catch { /* ignore */ }
  }
}
