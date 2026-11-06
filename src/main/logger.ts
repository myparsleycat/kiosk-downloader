import pathModule from "node:path";

import { is } from "@electron-toolkit/utils";
import type { SettingLogLevel } from "@shared/settings";
import { app } from "electron";
import fse from "fs-extra";
import pino, { type Logger as PinoLogger } from "pino";
import { createStream } from "rotating-file-stream";

export async function nahidaLogsPath(): Promise<string> {
    const configPath = pathModule.join(app.getPath("userData"), "logs");

    if (!(await fse.pathExists(configPath))) {
        await fse.mkdir(configPath, {
            recursive: true,
        });
    }

    return configPath;
}

export type LogLevel = SettingLogLevel | "fatal";

export class Logger {
    private logger: PinoLogger | null = null;
    private dest: string | null = null;
    private initPromise: Promise<void> | null = null;
    private isCleaning: boolean = false;
    private readonly disableLogging: boolean;
    private readonly isWorker: boolean;
    private currentLevel: LogLevel = "error";

    public constructor(disableLogging: boolean = false, isWorker: boolean = false) {
        this.disableLogging = disableLogging;
        this.isWorker = isWorker;

        void this.ensureInitialized();
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initPromise) {
            await this.initPromise;
            return;
        }

        this.initPromise = (async () => {
            try {
                await app.whenReady();

                this.dest = pathModule.join(
                    await nahidaLogsPath(),
                    this.isWorker ? "desktop-worker.log" : "desktop.log",
                );

                if (is.dev || this.disableLogging) {
                    return;
                }

                this.logger = pino(
                    {
                        level: this.currentLevel,
                        base: undefined,
                        formatters: {
                            level: (label) => ({ level: label }),
                        },
                    },
                    createStream(pathModule.basename(this.dest), {
                        size: "10M",
                        interval: "7d",
                        compress: "gzip",
                        encoding: "utf-8",
                        maxFiles: 3,
                        path: pathModule.dirname(this.dest),
                    }),
                );
            } catch (e) {
                console.error(e);
            }
        })();

        await this.initPromise;
    }

    private shouldWrite(level: LogLevel): boolean {
        const priorities: Record<LogLevel, number> = {
            trace: 10,
            debug: 20,
            info: 30,
            warn: 40,
            error: 50,
            fatal: 60,
        };

        return priorities[level] >= priorities[this.currentLevel];
    }

    private async writeFallback(level: LogLevel, entry: LogEntry): Promise<void> {
        if (!this.dest || !this.shouldWrite(level)) {
            return;
        }

        const line = JSON.stringify({
            level,
            time: new Date().toISOString(),
            ...entry.fields,
            msg: entry.msg,
        });

        await fse.appendFile(this.dest, `${line}\n`, "utf8");
    }

    public setLevel(level: LogLevel): void {
        this.currentLevel = level;
        if (this.logger) {
            this.logger.level = level;
        }
    }

    public log(level: LogLevel, object?: unknown, where?: string): void {
        if (this.isCleaning || this.disableLogging) {
            return;
        }

        if (is.dev) {
            const consoleArgs = where ? [`[${where}]`, object] : [object];
            if (level === "error" || level === "fatal") {
                console.error(...consoleArgs);
            } else if (level === "warn") {
                console.warn(...consoleArgs);
            } else if (level === "debug" || level === "trace") {
                console.debug(...consoleArgs);
            } else {
                console.log(...consoleArgs);
            }
            return;
        }

        if (!this.shouldWrite(level)) {
            return;
        }

        // Build the entry synchronously so callers that mutate their context object afterwards
        // (e.g. advancing a `stage` field) do not change what gets logged.
        const entry = toLogEntry(object, where);
        void (async () => {
            try {
                await this.ensureInitialized();

                if (!this.logger) {
                    await this.writeFallback(level, entry);
                    return;
                }

                this.logger[level](entry.fields ?? {}, entry.msg);
            } catch (e) {
                console.error(e);
            }
        })();
    }

    public info(object?: unknown, where?: string): void {
        this.log("info", object, where);
    }

    public debug(object?: unknown, where?: string): void {
        this.log("debug", object, where);
    }

    public warn(object?: unknown, where?: string): void {
        this.log("warn", object, where);
    }

    public error(object?: unknown, where?: string): void {
        this.log("error", object, where);
    }

    public trace(object?: unknown, where?: string): void {
        this.log("trace", object, where);
    }

    public fatal(object?: unknown, where?: string): void {
        this.log("fatal", object, where);
    }
}

export default Logger;

interface LogEntry {
    fields?: Record<string, unknown>;
    msg: string;
}

/**
 * Converts a log argument into pino merge fields plus a message. Errors (top-level or nested
 * one level in a context object) keep their name, message, stack and cause, and anything that
 * cannot be JSON-serialized (cycles, BigInt) degrades to a string instead of dropping the line.
 */
export function toLogEntry(object: unknown, where?: string): LogEntry {
    const prefix = where ? `[${where}]` : "";
    if (object === undefined || object === null) return { msg: prefix };
    if (
        typeof object === "string" ||
        typeof object === "number" ||
        typeof object === "boolean" ||
        typeof object === "bigint"
    ) {
        return { msg: prefix ? `${prefix} ${String(object)}` : String(object) };
    }
    if (typeof object !== "object") return { msg: prefix };
    if (object instanceof Error) {
        return { fields: { err: pino.stdSerializers.err(object) }, msg: prefix || object.message };
    }
    const fields = Array.isArray(object)
        ? { value: object }
        : Object.fromEntries(
              Object.entries(object).map(([key, value]) => [
                  key,
                  value instanceof Error ? pino.stdSerializers.err(value) : value,
              ]),
          );
    return { fields: toJsonSafe(fields), msg: prefix };
}

function toJsonSafe(fields: Record<string, unknown>): Record<string, unknown> {
    try {
        return JSON.parse(
            JSON.stringify(fields, (_key, value: unknown) =>
                typeof value === "bigint" ? value.toString() : value,
            ),
        ) as Record<string, unknown>;
    } catch (error) {
        return {
            unserializable: Object.keys(fields).join(","),
            serializeError: error instanceof Error ? error.message : String(error),
        };
    }
}
