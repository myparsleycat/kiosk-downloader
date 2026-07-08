import ky, { type Options } from "ky";

import type { KioskDownloader } from "../index";

export class HTTP {
    constructor(private readonly kd: KioskDownloader) {}

    public async getHeaders(_url: string) {
        return {
            "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36`,
        };
    }

    public async request(url: string, options?: Options) {
        const resp = await ky(url, {
            ...options,
            throwHttpErrors: false,
            headers: {
                ...(options?.headers instanceof Headers
                    ? Object.fromEntries(options.headers.entries())
                    : (options?.headers as Record<string, string> | undefined)),
                ...(await this.getHeaders(url)),
            },
            timeout: 100000,
            retry: {
                limit: 2,
                statusCodes: [408, 413, 429, 500, 502, 503, 504, 524],
            },
        });

        return resp;
    }
}
