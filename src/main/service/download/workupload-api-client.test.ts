import crypto from "node:crypto";

import {
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
import { describe, expect, it, vi } from "vitest";

import { HTTP, TimeoutError, type HttpRequestOptions } from "../../lib/http";
import {
    WorkuploadApiClient,
    parseWorkuploadArchiveManifest,
    parseWorkuploadArchivePage,
    parseWorkuploadFileMetadata,
    parseWorkuploadInput,
} from "./workupload-api-client";

const FILE_HTML = `
<table>
  <tr><td>Filename:&nbsp;</td><td>Tom &amp; Jerry &#039;final&#039;.mp4</td></tr>
  <tr><td>Filesize:&nbsp;</td><td>42 (Byte)</td></tr>
  <tr><td>Checksum:&nbsp;</td><td>${"a".repeat(64)} (SHA256)</td></tr>
</table>`;

const ARCHIVE_HTML = `
<table>
  <tr><td><b>one &amp; only.jpg</b></td><td><a href="/file/ChildOne">Download</a></td></tr>
  <tr><td><b>two.png</b></td><td><a href="/file/ChildTwo">Download</a></td></tr>
</table>
<script>body: '<table><tr><td>Archive name:&nbsp;</td><td>Album &amp; More</td></tr><tr><td>Archive size:&nbsp;</td><td>42 (byte)</td></tr></table>'</script>`;

function fileHtml(fileName: string, size: number, hashCharacter: string) {
    return `<table>
      <tr><td>Filename:&nbsp;</td><td>${fileName}</td></tr>
      <tr><td>Filesize:&nbsp;</td><td>${size} (Byte)</td></tr>
      <tr><td>Checksum:&nbsp;</td><td>${hashCharacter.repeat(64)} (SHA256)</td></tr>
    </table>`;
}

function passwordForm(kind: "file" | "archive", key: string, invalid = false) {
    const name = `passwordprotected_${kind}`;
    return `<form name="${name}" method="post">
      ${invalid ? "<div>The password you entered is incorrect.</div>" : ""}
      <input type="password" name="${name}[password]">
      <button name="${name}[submit]">Confirm</button>
      <input type="hidden" name="${name}[key]" value="${key}">
    </form>`;
}

function createClient(request: ReturnType<typeof vi.fn>) {
    return new WorkuploadApiClient({
        http: { request },
        logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never);
}

describe("Workupload parsers", () => {
    it.each([
        [
            "https://workupload.com/file/AbC123",
            "file",
            "AbC123",
            "https://workupload.com/file/AbC123",
        ],
        [
            "https://www.workupload.com/start/AbC123/",
            "file",
            "AbC123",
            "https://workupload.com/file/AbC123",
        ],
        [
            "https://workupload.com/archive/Archive9",
            "archive",
            "Archive9",
            "https://workupload.com/archive/Archive9",
        ],
    ])("normalizes %s", (url, kind, key, sourceUrl) => {
        expect(parseWorkuploadInput(url)).toEqual({ kind, key, sourceUrl });
    });

    it.each([
        "http://workupload.com/file/AbC123",
        "https://evil.example/file/AbC123",
        "https://workupload.com/file/Ab-C123",
        "https://workupload.com/file/AbC123/extra",
        "https://workupload.com/file/AbC123?download=1",
        "https://workupload.com/file/AbC123#download",
        "https://user@workupload.com/file/AbC123",
        "https://workupload.com:444/file/AbC123",
        "https://workupload.com/archive/AbC123/other",
        "https://workupload.com/archive/AbC123/start",
    ])("rejects unsupported URL %s", (url) => {
        expect(() => parseWorkuploadInput(url)).toThrow();
    });

    it("parses and decodes exact file metadata", () => {
        expect(parseWorkuploadFileMetadata(FILE_HTML, "Key1")).toEqual({
            fileKey: "Key1",
            filename: "Tom & Jerry 'final'.mp4",
            size: 42,
            sha256: "a".repeat(64),
        });
    });

    it("preserves a zero-byte file size", () => {
        const html = FILE_HTML.replace("42 (Byte)", "0 (Byte)");
        expect(parseWorkuploadFileMetadata(html, "EmptyKey").size).toBe(0);
    });

    it("parses archive overview and isolates the strict kas assignment", () => {
        expect(parseWorkuploadArchivePage(ARCHIVE_HTML, "Archive9")).toEqual({
            archiveKey: "Archive9",
            name: "Album & More",
            size: 42,
            files: [
                { fileKey: "ChildOne", filename: "one & only.jpg" },
                { fileKey: "ChildTwo", filename: "two.png" },
            ],
        });
        expect(
            parseWorkuploadArchiveManifest(
                `<script>var noise = ["captcha_999"];</script>
                 <script>var kas = ["ChildOne_12", "ChildTwo_30"];</script>`,
                "Archive9",
            ),
        ).toEqual([
            { fileKey: "ChildOne", size: 12 },
            { fileKey: "ChildTwo", size: 30 },
        ]);
    });

    it.each([
        `var kas = ["ChildOne_bad"];`,
        `var kas = ["ChildOne_1", "ChildOne_2"];`,
        `var kas = [];`,
        `var kas = notJson;`,
    ])("rejects an invalid archive manifest: %s", (html) => {
        expect(() => parseWorkuploadArchiveManifest(html, "Archive9")).toThrow();
    });
});

describe("WorkuploadApiClient", () => {
    it("scopes host-only, domain, path, same-name, and deleted cookies by request URL", async () => {
        const initialHeaders = new Headers();
        initialHeaders.append("Set-Cookie", "control=host-only; Path=/; Secure");
        initialHeaders.append(
            "Set-Cookie",
            "shared=domain-wide; Domain=.workupload.com; Path=/; Secure",
        );
        initialHeaders.append("Set-Cookie", "same=root; Domain=.workupload.com; Path=/; Secure");
        initialHeaders.append(
            "Set-Cookie",
            "same=file-path; Domain=.workupload.com; Path=/file; Secure",
        );
        initialHeaders.append(
            "Set-Cookie",
            "expired=alive; Domain=.workupload.com; Path=/; Secure",
        );
        initialHeaders.append(
            "Set-Cookie",
            "date-expired=gone; Domain=.workupload.com; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        );
        initialHeaders.append("Set-Cookie", "foreign=bad; Domain=.com; Path=/; Secure");
        let fileRequests = 0;
        let startRequests = 0;
        const request = vi.fn(async (url: string, options?: { headers?: Headers }) => {
            if (url.endsWith("/file/FileKey")) {
                fileRequests += 1;
                if (fileRequests === 1) {
                    return new Response(FILE_HTML, { headers: initialHeaders });
                }
                const cookie = options?.headers?.get("cookie") ?? "";
                expect(cookie).toContain("same=file-path");
                expect(cookie).toContain("same=root");
                expect(cookie.indexOf("same=file-path")).toBeLessThan(cookie.indexOf("same=root"));
                expect(cookie).not.toContain("expired=");
                return new Response(FILE_HTML);
            }
            if (url.endsWith("/start/FileKey")) {
                startRequests += 1;
                if (startRequests === 1) {
                    return new Response("", {
                        headers: {
                            "Set-Cookie":
                                "expired=; Domain=.workupload.com; Path=/; Max-Age=0; Secure",
                        },
                    });
                }
                return new Response("/api/file/getDownloadServer/FileKey");
            }
            if (url.endsWith("/api/file/getDownloadServer/FileKey")) {
                expect(options?.headers?.get("cookie")).toContain("control=host-only");
                return new Response(
                    JSON.stringify({
                        success: true,
                        data: { url: "https://f12.workupload.com/download/FileKey" },
                    }),
                );
            }
            if (url === "https://f12.workupload.com/download/FileKey") {
                const cookie = options?.headers?.get("cookie") ?? "";
                expect(cookie).toContain("shared=domain-wide");
                expect(cookie).toContain("same=root");
                expect(cookie).not.toContain("control=host-only");
                expect(cookie).not.toContain("same=file-path");
                expect(cookie).not.toContain("expired=");
                expect(cookie).not.toContain("date-expired=");
                expect(cookie).not.toContain("foreign=");
                return new Response("bytes");
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        const session = await createClient(request).createSession(
            "https://workupload.com/file/FileKey",
        );
        await expect(session.requestDownload("FileKey")).resolves.toMatchObject({
            response: expect.objectContaining({ status: 200 }),
        });
    });

    it("loads an archive and cross-checks child filename, size, and SHA metadata", async () => {
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/archive/Archive9")) return new Response(ARCHIVE_HTML);
            if (url.endsWith("/archive/Archive9/start")) {
                return new Response(`<script>var kas = ["ChildOne_12", "ChildTwo_30"];</script>`);
            }
            if (url.endsWith("/file/ChildOne")) {
                return new Response(fileHtml("one &amp; only.jpg", 12, "b"));
            }
            if (url.endsWith("/file/ChildTwo")) {
                return new Response(fileHtml("two.png", 30, "c"));
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        const session = await createClient(request).createSession(
            "https://workupload.com/archive/Archive9",
        );

        expect(session.source).toEqual({
            kind: "archive",
            key: "Archive9",
            name: "Album & More",
            size: 42,
            files: [
                {
                    fileKey: "ChildOne",
                    filename: "one & only.jpg",
                    size: 12,
                    sha256: "b".repeat(64),
                },
                {
                    fileKey: "ChildTwo",
                    filename: "two.png",
                    size: 30,
                    sha256: "c".repeat(64),
                },
            ],
        });
    });

    it("refreshes only the requested archive child while retaining manifest resolver access", async () => {
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/archive/Archive9")) return new Response(ARCHIVE_HTML);
            if (url.endsWith("/archive/Archive9/start")) {
                return new Response(`<script>var kas = ["ChildOne_12", "ChildTwo_30"];</script>`);
            }
            if (url.endsWith("/file/ChildOne")) {
                return new Response(fileHtml("one &amp; only.jpg", 12, "b"));
            }
            if (url.endsWith("/file/ChildTwo")) {
                throw new Error("Unselected child metadata must not be requested.");
            }
            if (url.endsWith("/api/file/getDownloadServer/ChildTwo")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        data: { url: "https://f12.workupload.com/download/ChildTwo" },
                    }),
                );
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        const session = await createClient(request).createSession(
            "https://workupload.com/archive/Archive9",
            { requestedFileKey: "ChildOne" },
        );

        expect(session.source.files.map((file) => file.fileKey)).toEqual(["ChildOne"]);
        await expect(session.resolveDownloadUrl("ChildTwo")).resolves.toBe(
            "https://f12.workupload.com/download/ChildTwo",
        );
        expect(request).not.toHaveBeenCalledWith(
            "https://workupload.com/file/ChildTwo",
            expect.anything(),
        );
    });

    it("rejects archive metadata that differs from the exact manifest", async () => {
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/archive/Archive9")) return new Response(ARCHIVE_HTML);
            if (url.endsWith("/archive/Archive9/start")) {
                return new Response(`<script>var kas = ["ChildOne_13", "ChildTwo_30"];</script>`);
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        await expect(
            createClient(request).createSession("https://workupload.com/archive/Archive9"),
        ).rejects.toThrow("total size does not match");
    });

    it("probes password-protected resources without submitting a password", async () => {
        const request = vi.fn(async () => new Response(passwordForm("archive", "Archive9")));

        await expect(
            createClient(request).probeCollection({
                url: "https://workupload.com/archive/Archive9",
            }),
        ).resolves.toEqual({ passwordRequired: true });
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("reports an unprotected resource from probe", async () => {
        const request = vi.fn(async () => new Response(FILE_HTML));

        await expect(
            createClient(request).probeCollection({
                url: "https://workupload.com/file/FileKey",
            }),
        ).resolves.toEqual({ passwordRequired: false });
    });

    it("requires a password before requesting an archive manifest", async () => {
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/archive/Archive9")) {
                return new Response(passwordForm("archive", "Archive9"));
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        await expect(
            createClient(request).createSession("https://workupload.com/archive/Archive9"),
        ).rejects.toThrow(COLLECTION_PASSWORD_REQUIRED_ERROR);
        expect(request).toHaveBeenCalledTimes(1);
    });

    it("submits the exact archive password form and preserves the unlocked session", async () => {
        const request = vi.fn(
            async (
                url: string,
                options?: { method?: string; headers?: Headers; body?: unknown },
            ) => {
                if (url.endsWith("/archive/Archive9") && options?.method !== "POST") {
                    return new Response(passwordForm("archive", "Archive9"), {
                        headers: { "Set-Cookie": "token=challenge; Path=/" },
                    });
                }
                if (url.endsWith("/archive/Archive9") && options?.method === "POST") {
                    expect(options.headers?.get("content-type")).toBe(
                        "application/x-www-form-urlencoded",
                    );
                    expect(options.headers?.get("cookie")).toContain("token=challenge");
                    expect(String(options.body)).toBe(
                        "passwordprotected_archive%5Bpassword%5D=correct+horse&" +
                            "passwordprotected_archive%5Bsubmit%5D=&" +
                            "passwordprotected_archive%5Bkey%5D=Archive9",
                    );
                    return new Response(ARCHIVE_HTML, {
                        headers: { "Set-Cookie": "token=unlocked; Path=/" },
                    });
                }
                if (url.endsWith("/archive/Archive9/start")) {
                    expect(options?.headers?.get("cookie")).toContain("token=unlocked");
                    return new Response(
                        `<script>var kas = ["ChildOne_12", "ChildTwo_30"];</script>`,
                    );
                }
                if (url.endsWith("/file/ChildOne")) {
                    return new Response(fileHtml("one &amp; only.jpg", 12, "b"));
                }
                if (url.endsWith("/file/ChildTwo")) {
                    return new Response(fileHtml("two.png", 30, "c"));
                }
                throw new Error(`Unexpected request: ${url}`);
            },
        );

        const session = await createClient(request).createSession(
            "https://workupload.com/archive/Archive9",
            { password: "correct horse" },
        );

        expect(session.passwordProtected).toBe(true);
        expect(session.source.files).toHaveLength(2);
    });

    it("maps a repeated password form to the invalid-password sentinel", async () => {
        const request = vi.fn(
            async (url: string, options?: { method?: string }) =>
                new Response(passwordForm("archive", "Archive9", options?.method === "POST")),
        );

        await expect(
            createClient(request).createSession("https://workupload.com/archive/Archive9", {
                password: "wrong",
            }),
        ).rejects.toThrow(COLLECTION_INVALID_PASSWORD_ERROR);
    });

    it("unlocks a password-protected file before activating its download session", async () => {
        const request = vi.fn(
            async (
                url: string,
                options?: { method?: string; headers?: Headers; body?: unknown },
            ) => {
                if (url.endsWith("/file/FileKey") && options?.method !== "POST") {
                    return new Response(passwordForm("file", "FileKey"));
                }
                if (url.endsWith("/file/FileKey") && options?.method === "POST") {
                    expect(String(options.body)).toContain(
                        "passwordprotected_file%5Bpassword%5D=file-secret",
                    );
                    return new Response(FILE_HTML);
                }
                if (url.endsWith("/start/FileKey")) {
                    return new Response("/api/file/getDownloadServer/FileKey");
                }
                throw new Error(`Unexpected request: ${url}`);
            },
        );

        const loaded = await createClient(request).loadCollection({
            url: "https://workupload.com/file/FileKey",
            password: "file-secret",
        });

        expect(loaded.passwordProtected).toBe(true);
        expect(loaded.collection.passwordProtected).toBe(true);
        expect(loaded.files[0]?.fileKey).toBe("FileKey");
    });

    it("solves the proof-of-work, preserves cookies, validates CDN, and sends Range", async () => {
        const target = crypto.createHash("sha256").update("puzzle1").digest("hex");
        let fileRequests = 0;
        let downloadSignal: AbortSignal | undefined;
        const request = vi.fn(
            async (
                url: string,
                options?: { headers?: Headers; body?: unknown; signal?: AbortSignal },
            ) => {
                if (url.endsWith("/file/FileKey")) {
                    fileRequests += 1;
                    if (fileRequests === 1) {
                        return new Response(`<script>fetch('/puzzle')</script>`);
                    }
                    return new Response(FILE_HTML);
                }
                if (url.endsWith("/puzzle")) {
                    return new Response(
                        JSON.stringify({
                            success: true,
                            data: { puzzle: "puzzle", range: 3, find: [target] },
                        }),
                        { headers: { "Set-Cookie": "captcha=proof; Path=/" } },
                    );
                }
                if (url.endsWith("/captcha")) {
                    expect(String(options?.body)).toBe("captcha=1+");
                    expect(options?.headers?.get("cookie")).toContain("captcha=proof");
                    return new Response("", {
                        headers: { "Set-Cookie": "token=session; Domain=.workupload.com" },
                    });
                }
                if (url.endsWith("/start/FileKey")) {
                    expect(options?.headers?.get("cookie")).toContain("token=session");
                    return new Response("/api/file/getDownloadServer/FileKey");
                }
                if (url.endsWith("/api/file/getDownloadServer/FileKey")) {
                    return new Response(
                        JSON.stringify({
                            success: true,
                            data: { url: "https://f12.workupload.com/download/FileKey" },
                        }),
                    );
                }
                if (url === "https://f12.workupload.com/download/FileKey") {
                    downloadSignal = options?.signal;
                    expect(options?.headers?.get("range")).toBe("bytes=4-9");
                    expect(options?.headers?.get("cookie")).toContain("token=session");
                    return new Response("bytes", { status: 206 });
                }
                throw new Error(`Unexpected request: ${url}`);
            },
        );
        const client = createClient(request);
        const session = await client.createSession("https://workupload.com/file/FileKey");
        const result = await session.requestDownload("FileKey", { start: 4, end: 9 });
        expect(result.url).toBe("https://f12.workupload.com/download/FileKey");
        expect(result.response.status).toBe(206);
        expect(downloadSignal?.aborted).toBe(false);
        result.abort();
        expect(downloadSignal?.aborted).toBe(true);
    });

    it("aborts an unmatched proof-of-work search after yielding", async () => {
        const controller = new AbortController();
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/file/FileKey")) {
                return new Response(`<script>fetch('/puzzle')</script>`);
            }
            if (url.endsWith("/puzzle")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        data: { puzzle: "puzzle", range: 1_000_000, find: ["f".repeat(64)] },
                    }),
                );
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        const session = createClient(request).createSession("https://workupload.com/file/FileKey", {
            signal: controller.signal,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        controller.abort();

        await expect(session).rejects.toMatchObject({ name: "AbortError" });
        expect(request).not.toHaveBeenCalledWith(
            "https://workupload.com/captcha",
            expect.anything(),
        );
    });

    it("retries the security check when the page still shows the puzzle after captcha", async () => {
        const target = crypto.createHash("sha256").update("puzzle1").digest("hex");
        let fileRequests = 0;
        let captchaRequests = 0;
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/file/FileKey")) {
                fileRequests += 1;
                if (fileRequests <= 2) {
                    return new Response(`<script>fetch('/puzzle')</script>`);
                }
                return new Response(FILE_HTML);
            }
            if (url.endsWith("/puzzle")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        data: { puzzle: "puzzle", range: 3, find: [target] },
                    }),
                );
            }
            if (url.endsWith("/captcha")) {
                captchaRequests += 1;
                return new Response("");
            }
            if (url.endsWith("/start/FileKey")) {
                return new Response("/api/file/getDownloadServer/FileKey");
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        const session = await createClient(request).createSession(
            "https://workupload.com/file/FileKey",
        );
        expect(session.source.files[0]?.filename).toBe("Tom & Jerry 'final'.mp4");
        expect(fileRequests).toBe(3);
        expect(captchaRequests).toBe(2);
    });

    it("retries a rejected captcha with a fresh puzzle before succeeding", async () => {
        vi.useFakeTimers();
        const target = crypto.createHash("sha256").update("puzzle1").digest("hex");
        let captchaRequests = 0;
        let puzzleRequests = 0;
        let captchaOk = false;
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/file/FileKey")) {
                return new Response(captchaOk ? FILE_HTML : `<script>fetch('/puzzle')</script>`);
            }
            if (url.endsWith("/puzzle")) {
                puzzleRequests += 1;
                return new Response(
                    JSON.stringify({
                        success: true,
                        data: { puzzle: "puzzle", range: 3, find: [target] },
                    }),
                );
            }
            if (url.endsWith("/captcha")) {
                captchaRequests += 1;
                if (captchaRequests === 1) {
                    return new Response("<html>Are you a human?</html>");
                }
                captchaOk = true;
                return new Response("");
            }
            if (url.endsWith("/start/FileKey")) {
                return new Response("/api/file/getDownloadServer/FileKey");
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        try {
            const pending = createClient(request).createSession(
                "https://workupload.com/file/FileKey",
            );
            await vi.advanceTimersByTimeAsync(2_000);
            const session = await pending;
            expect(session.source.files[0]?.filename).toBe("Tom & Jerry 'final'.mp4");
            expect(captchaRequests).toBe(2);
            expect(puzzleRequests).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it.each(["puzzle", "captcha"])(
        "retries a %s header timeout with a fresh puzzle before succeeding",
        async (timeoutStage) => {
            vi.useFakeTimers();
            const target = crypto.createHash("sha256").update("puzzle1").digest("hex");
            let timedOut = false;
            let unlocked = false;
            let puzzleRequests = 0;
            const request = vi.fn(async (url: string) => {
                if (url.endsWith("/file/FileKey")) {
                    return new Response(unlocked ? FILE_HTML : `<script>fetch('/puzzle')</script>`);
                }
                if (url.endsWith("/puzzle")) {
                    puzzleRequests += 1;
                    if (timeoutStage === "puzzle" && !timedOut) {
                        timedOut = true;
                        throw new TimeoutError(new Request(url));
                    }
                    return new Response(
                        JSON.stringify({
                            success: true,
                            data: { puzzle: "puzzle", range: 3, find: [target] },
                        }),
                    );
                }
                if (url.endsWith("/captcha")) {
                    if (timeoutStage === "captcha" && !timedOut) {
                        timedOut = true;
                        throw new TimeoutError(new Request(url));
                    }
                    unlocked = true;
                    return new Response("");
                }
                if (url.endsWith("/start/FileKey")) {
                    return new Response("/api/file/getDownloadServer/FileKey");
                }
                throw new Error(`Unexpected request: ${url}`);
            });

            try {
                const pending = createClient(request).createSession(
                    "https://workupload.com/file/FileKey",
                );
                await vi.advanceTimersByTimeAsync(2_000);

                const session = await pending;
                expect(session.source.files[0]?.filename).toBe("Tom & Jerry 'final'.mp4");
                expect(puzzleRequests).toBe(2);
            } finally {
                vi.useRealTimers();
            }
        },
    );

    it("gives up after repeated security-check timeouts", async () => {
        vi.useFakeTimers();
        let puzzleRequests = 0;
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/file/FileKey")) {
                return new Response(`<script>fetch('/puzzle')</script>`);
            }
            if (url.endsWith("/puzzle")) {
                puzzleRequests += 1;
                throw new TimeoutError(new Request(url));
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        try {
            const pending = expect(
                createClient(request).createSession("https://workupload.com/file/FileKey"),
            ).rejects.toThrow(/still shows the security check after 3 attempts/);
            await vi.advanceTimersByTimeAsync(10_000);

            await pending;
            expect(puzzleRequests).toBe(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("propagates abort while waiting to retry a security-check timeout", async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/file/FileKey")) {
                return new Response(`<script>fetch('/puzzle')</script>`);
            }
            if (url.endsWith("/puzzle")) {
                throw new TimeoutError(new Request(url));
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        try {
            const pending = createClient(request).createSession(
                "https://workupload.com/file/FileKey",
                { signal: controller.signal },
            );
            await vi.advanceTimersByTimeAsync(0);
            controller.abort();

            await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        } finally {
            vi.useRealTimers();
        }
    });

    it("gives up after repeated captcha rejections", async () => {
        vi.useFakeTimers();
        const target = crypto.createHash("sha256").update("puzzle1").digest("hex");
        let captchaRequests = 0;
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/file/FileKey")) {
                return new Response(`<script>fetch('/puzzle')</script>`);
            }
            if (url.endsWith("/puzzle")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        data: { puzzle: "puzzle", range: 3, find: [target] },
                    }),
                );
            }
            if (url.endsWith("/captcha")) {
                captchaRequests += 1;
                return new Response("<html>Are you a human?</html>");
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        try {
            const pending = expect(
                createClient(request).createSession("https://workupload.com/file/FileKey"),
            ).rejects.toThrow(/still shows the security check after 3 attempts/);
            await vi.advanceTimersByTimeAsync(10_000);
            await pending;
            expect(captchaRequests).toBe(3);
        } finally {
            vi.useRealTimers();
        }
    });

    it("fails after the security check retry limit", async () => {
        const target = crypto.createHash("sha256").update("puzzle1").digest("hex");
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/file/FileKey")) {
                return new Response(`<script>fetch('/puzzle')</script>`);
            }
            if (url.endsWith("/puzzle")) {
                return new Response(
                    JSON.stringify({
                        success: true,
                        data: { puzzle: "puzzle", range: 3, find: [target] },
                    }),
                );
            }
            if (url.endsWith("/captcha")) {
                return new Response("");
            }
            throw new Error(`Unexpected request: ${url}`);
        });

        await expect(
            createClient(request).createSession("https://workupload.com/file/FileKey"),
        ).rejects.toThrow(/still shows the security check/);
    });

    it.each([
        "http://f12.workupload.com/download/FileKey",
        "https://evil.example/download/FileKey",
        "https://f12.workupload.com/download/OtherKey",
        "https://f12.workupload.com/download/FileKey?token=x",
    ])("rejects unsafe resolver URL %s", async (cdnUrl) => {
        const request = vi.fn(async (url: string) => {
            if (url.endsWith("/file/FileKey")) return new Response(FILE_HTML);
            if (url.endsWith("/start/FileKey")) {
                return new Response("/api/file/getDownloadServer/FileKey");
            }
            if (url.endsWith("/api/file/getDownloadServer/FileKey")) {
                return new Response(JSON.stringify({ success: true, data: { url: cdnUrl } }));
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        const session = await createClient(request).createSession(
            "https://workupload.com/file/FileKey",
        );
        await expect(session.resolveDownloadUrl("FileKey")).rejects.toThrow(
            "Unexpected Workupload CDN URL",
        );
    });

    it("times out a CDN download that never sends response headers", async () => {
        vi.useFakeTimers();
        const fileRequests = vi.fn(async () => new Response(FILE_HTML));
        const startRequests = vi.fn(
            async () => new Response("/api/file/getDownloadServer/FileKey"),
        );
        const resolverRequests = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        success: true,
                        data: { url: "https://f12.workupload.com/download/FileKey" },
                    }),
                ),
        );
        let downloadSignal: AbortSignal | undefined;
        const downloadRequests = vi.fn(async () => new Promise<Response>(() => undefined));
        const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
            const url =
                typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
            if (url.endsWith("/file/FileKey")) return fileRequests();
            if (url.endsWith("/start/FileKey")) return startRequests();
            if (url.endsWith("/api/file/getDownloadServer/FileKey")) return resolverRequests();
            if (url === "https://f12.workupload.com/download/FileKey") {
                downloadSignal =
                    input instanceof Request ? input.signal : (init?.signal ?? undefined);
                return downloadRequests();
            }
            throw new Error(`Unexpected request: ${url}`);
        });
        const http = new HTTP({} as never);
        const client = new WorkuploadApiClient({
            http: {
                request: (url: string, options: HttpRequestOptions = {}) =>
                    http.request(url, { ...options, fetch: fetchStub as typeof fetch }),
            },
        } as never);

        try {
            const session = await client.createSession("https://workupload.com/file/FileKey");
            const pending = expect(session.requestDownload("FileKey")).rejects.toThrow(
                /timed out/i,
            );
            await vi.advanceTimersByTimeAsync(30_000);

            await pending;
            expect(downloadSignal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });
});
