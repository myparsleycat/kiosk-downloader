export function trimTrailingNul(value: string) {
    let end = value.length;

    while (end > 0 && value.charCodeAt(end - 1) === 0) {
        end--;
    }

    return value.slice(0, end);
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
