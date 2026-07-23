export type CompatShareTextOptions = {
    title: string;
    urls: readonly string[];
    expiresAt: number;
    password?: string;
};

export function formatCompatShareText(options: CompatShareTextOptions) {
    if (options.urls.length === 0 || options.urls.some((url) => !url.trim())) {
        throw new Error("Compatibility share URLs must not be empty.");
    }

    const expiresAt = new Date(options.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
        throw new Error("Compatibility share expiration must be a valid timestamp.");
    }

    const lines = [
        options.title,
        "",
        ...options.urls.map((url, index) => `${index + 1}/${options.urls.length} ${url}`),
        "",
        `만료 시각: ${expiresAt.toISOString()}`,
    ];

    if (options.password) {
        lines.push(`비밀번호: ${options.password}`);
    }

    return lines.join("\n");
}
