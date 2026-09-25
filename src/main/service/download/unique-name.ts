import path from "node:path";

export function allocateUniqueName(name: string, used: Set<string>, keepExtension = true) {
    if (!used.has(name.toLowerCase())) {
        used.add(name.toLowerCase());
        return name;
    }

    const extension = keepExtension ? path.extname(name) : "";
    const stem = extension ? name.slice(0, -extension.length) : name;
    for (let suffix = 2; ; suffix += 1) {
        const candidate = `${stem} (${suffix})${extension}`;
        const key = candidate.toLowerCase();
        if (!used.has(key)) {
            used.add(key);
            return candidate;
        }
    }
}
