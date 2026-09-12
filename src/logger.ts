export type TraceLevel = "error" | "info" | "verbose";

const LEVELS: Record<TraceLevel, number> = { error: 0, info: 1, verbose: 2 };

export class Logger {
  constructor(private pluginId: string, private getLevel: () => TraceLevel) {}

  error(...args: unknown[]): void {
    console.error(`[${this.pluginId}]`, ...args);
  }

  warn(...args: unknown[]): void {
    console.warn(`[${this.pluginId}]`, ...args);
  }

  info(...args: unknown[]): void {
    if (LEVELS[this.getLevel()] >= LEVELS.info) console.log(`[${this.pluginId}]`, ...args);
  }

  verbose(...args: unknown[]): void {
    if (LEVELS[this.getLevel()] >= LEVELS.verbose) console.log(`[${this.pluginId}] [verbose]`, ...args);
  }
}
