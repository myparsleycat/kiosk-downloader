import { fileURLToPath } from "node:url";

export function filePathsFromUriList(uriList: string) {
    const paths: string[] = [];
    for (const line of uriList.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("file://")) continue;
        try {
            paths.push(fileURLToPath(trimmed));
        } catch {
            // Skip malformed file URIs from the OS clipboard list.
        }
    }
    return paths;
}

export async function processChunked<T>(
    items: T[],
    processor: (item: T) => void,
    size = 1000,
    signal?: AbortSignal,
) {
    const CHUNK_SIZE = size;
    for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        if (signal?.aborted) return;
        const end = Math.min(i + CHUNK_SIZE, items.length);
        for (let j = i; j < end; j++) {
            processor(items[j]);
        }
        if (i + CHUNK_SIZE < items.length) {
            await new Promise((resolve) => setImmediate(resolve));
        }
    }
}
