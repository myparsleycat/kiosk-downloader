import { formatDuration, intervalToDuration } from "date-fns";
import { enUS, ko, zhCN } from "date-fns/locale";
import { isNil } from "es-toolkit";
import { type FilesizeOptions, filesize } from "filesize";

export function toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

const MIB = 1024 * 1024;

export function formatSize(size?: number | null, options?: FilesizeOptions) {
    if (isNil(size)) return "0 B";
    if (!Number.isFinite(size)) return "--";
    const jedec = { standard: "jedec" as const, ...options };
    if (size >= 1000 * MIB && jedec.exponent === undefined) {
        return filesize(size, { ...jedec, exponent: 3 });
    }
    return filesize(size, jedec);
}

export function formatSpeed(bytesPerSecond?: number | null) {
    if (isNil(bytesPerSecond) || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) {
        return null;
    }
    return `${formatSize(bytesPerSecond, { standard: "iec" })}/s`;
}

export function resolveDateFnsLocale(lang?: string | null) {
    if (lang?.startsWith("ko")) return ko;
    if (lang?.startsWith("zh")) return zhCN;
    return enUS;
}

export function formatTime(seconds: number, lang?: string | null): string {
    if (!Number.isFinite(seconds) || seconds < 0) {
        return "--";
    }

    const locale = resolveDateFnsLocale(lang);
    const duration = intervalToDuration({
        start: 0,
        end: Math.ceil(seconds) * 1000,
    });

    return (
        formatDuration(duration, {
            format: ["hours", "minutes", "seconds"],
            locale,
        }) || formatDuration({ seconds: 0 }, { format: ["seconds"], zero: true, locale })
    );
}

export function normalizePath(path: string) {
    return path.replace(/\\/g, "/").replace(/^\/|\/$/g, "");
}
