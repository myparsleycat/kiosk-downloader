import { format, formatDuration, intervalToDuration } from "date-fns";
import { enUS, ko, zhCN } from "date-fns/locale";
import { isNil } from "es-toolkit";
import { type FilesizeOptions, filesize } from "filesize";

export interface TextureResizeCandidate {
    width: number;
    height: number;
}

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

export const formatDate = (date: Date | string, lang?: string | null, formatStr?: string) => {
    return format(date, formatStr || "PPpp", {
        locale: resolveDateFnsLocale(lang),
    });
};

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
        }) || formatDuration({ seconds: 0 }, { format: ["seconds"], locale })
    );
}

export function normalizePath(path: string) {
    return path.replace(/\\/g, "/").replace(/^\/|\/$/g, "");
}

export function getRandInt(min: number, max: number) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function getRandFloat(min: number, max: number): number {
    return Math.random() * (max - min) + min;
}

export function getTextureResizeCandidates(
    width: number,
    height: number,
    minDimension = 1024,
    dimensionStep = 1024,
): TextureResizeCandidate[] {
    if (width < minDimension || height < minDimension) {
        return [];
    }

    const divisor = gcd(width, height);
    const ratioWidth = width / divisor;
    const ratioHeight = height / divisor;

    if (ratioWidth === 0 || ratioHeight === 0) {
        return [];
    }

    const maxScale = Math.min(
        Math.floor(width / (ratioWidth * dimensionStep)),
        Math.floor(height / (ratioHeight * dimensionStep)),
    );

    if (maxScale === 0) {
        return [];
    }

    const candidates: TextureResizeCandidate[] = [];
    for (let scale = 1; scale <= maxScale; scale += 1) {
        const candidate = {
            width: ratioWidth * dimensionStep * scale,
            height: ratioHeight * dimensionStep * scale,
        };

        if (candidate.width < width || candidate.height < height) {
            candidates.push(candidate);
        }
    }

    return candidates;
}

export function pickTextureResizeCandidate(
    candidates: TextureResizeCandidate[],
    maxWidth: number,
    maxHeight: number,
): TextureResizeCandidate | null {
    let selected: TextureResizeCandidate | null = null;

    for (const candidate of candidates) {
        if (candidate.width > maxWidth || candidate.height > maxHeight) {
            continue;
        }

        if (!selected || candidate.width * candidate.height > selected.width * selected.height) {
            selected = candidate;
        }
    }

    return selected;
}

function gcd(left: number, right: number): number {
    let currentLeft = left;
    let currentRight = right;

    while (currentRight !== 0) {
        const remainder = currentLeft % currentRight;
        currentLeft = currentRight;
        currentRight = remainder;
    }

    return currentLeft;
}
