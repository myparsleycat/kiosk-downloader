import crypto from "node:crypto";

import {
    COLLECTION_INVALID_PASSWORD_ERROR,
    COLLECTION_PASSWORD_REQUIRED_ERROR,
} from "@shared/download-errors";
import { describe, expect, it, vi } from "vitest";

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
    return new WorkuploadApiClient({ http: { request } } as never);
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
        const request = vi.fn(
            async (url: string, options?: { headers?: Headers; body?: unknown }) => {
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
                    return new Response(JSON.stringify({ success: true }), {
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
});
