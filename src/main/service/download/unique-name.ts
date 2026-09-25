import path from "node:path";

// Keys are lowercased names already taken; values are the next suffix to try when that
// name is requested again, so repeated duplicates don't rescan every earlier suffix.
export function allocateUniqueName(name: string, used: Map<string, number>, keepExtension = true) {
    const key = name.toLowerCase();
    const nextSuffix = used.get(key);
    if (nextSuffix === undefined) {
        used.set(key, 2);
        return name;
    }

    const extension = keepExtension ? path.extname(name) : "";
    const stem = extension ? name.slice(0, -extension.length) : name;
    for (let suffix = nextSuffix; ; suffix += 1) {
        const candidate = `${stem} (${suffix})${extension}`;
        const candidateKey = candidate.toLowerCase();
        if (!used.has(candidateKey)) {
            used.set(key, suffix + 1);
            used.set(candidateKey, 2);
            return candidate;
        }
    }
}
