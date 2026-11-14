import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import electron from "electron";
import { build } from "vite";
import { expect, it } from "vitest";

it("keeps text buttons in sync with real DOM mutations and preserves anchor buttons", async () => {
    const directory = await mkdtemp(join(tmpdir(), "kioex-content-"));
    try {
        const bundle = await build({
            root: directory,
            configFile: false,
            envFile: false,
            publicDir: false,
            logLevel: "silent",
            resolve: {
                alias: {
                    "@ext": resolve(import.meta.dirname, ".."),
                    "@shared": resolve(import.meta.dirname, "../../../src/shared"),
                },
            },
            build: {
                write: false,
                minify: false,
                lib: {
                    entry: resolve(import.meta.dirname, "index.ts"),
                    formats: ["iife"],
                    name: "ContentTest",
                },
            },
        });
        const output = Array.isArray(bundle) ? bundle[0] : bundle;
        if (!output || !("output" in output)) throw new Error("Expected a bundle");
        const script = output.output.find((entry) => entry.type === "chunk");
        if (!script || script.type !== "chunk") throw new Error("Missing content script");
        const runner = join(directory, "runner.cjs");
        await writeFile(
            runner,
            `const { app, BrowserWindow } = require("electron");
app.disableHardwareAcceleration();
app.setPath("userData", ${JSON.stringify(join(directory, "profile"))});
app.whenReady().then(async () => {
    const window = new BrowserWindow({ show: false, webPreferences: { partition: "content-test" } });
    try {
        await window.loadURL("data:text/html,<body></body>");
        await window.webContents.executeJavaScript(${JSON.stringify(`(${preparePage.toString()})()`)});
        await window.webContents.executeJavaScript(${JSON.stringify(script.code)});
        const result = await window.webContents.executeJavaScript(${JSON.stringify(`(${exercisePage.toString()})()`)});
        console.log(result);
        app.exit(0);
    } catch (error) {
        console.error(error);
        app.exit(1);
    }
}).catch(error => { console.error(error); app.exit(1); });`,
        );
        const environment = { ...process.env };
        delete environment.ELECTRON_RUN_AS_NODE;
        if (process.platform === "linux") {
            delete environment.DISPLAY;
            delete environment.WAYLAND_DISPLAY;
            delete environment.WAYLAND_SOCKET;
        }
        // Ozone selects the display backend before the app's main script runs.
        const result = await promisify(execFile)(
            electron as unknown as string,
            process.platform === "linux" ? ["--ozone-platform=headless", runner] : [runner],
            { env: environment, windowsHide: true, timeout: 20000 },
        );
        expect(result.stdout).toContain("content lifecycle assertions passed");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}, 30000);

function preparePage() {
    const messages: unknown[] = [];
    Object.assign(window, {
        sentMessages: messages,
        chrome: {
            storage: {
                sync: { get: async () => ({}) },
                onChanged: { addListener: () => {} },
            },
            runtime: {
                sendMessage: async (message: unknown) => {
                    messages.push(message);
                    return { ok: true };
                },
            },
        },
    });
    const container = document.createElement("div");
    container.id = "text";
    container.append(document.createTextNode(btoa("https://files.example/first.zip")));
    const anchor = document.createElement("a");
    anchor.id = "anchor";
    anchor.href = "https://files.example/anchor.zip";
    anchor.textContent = btoa("https://files.example/ignored.zip");
    document.body.append(container, anchor);
}

async function exercisePage() {
    const messages = (window as unknown as { sentMessages: { urls: string[] }[] }).sentMessages;
    const container = document.querySelector("#text")!;
    const node = container.firstChild as Text;
    const anchor = document.querySelector<HTMLAnchorElement>("#anchor")!;
    const hosts = (root: ParentNode = container) =>
        root.querySelectorAll<HTMLElement>("[data-kioex]");
    const settle = () => new Promise((done) => window.setTimeout(done, 350));
    const check = (condition: boolean, message: string) => {
        if (!condition) throw new Error(message);
    };
    const click = (host: HTMLElement, url: string) => {
        const count = messages.length;
        host.click();
        check(messages.length === count + 1, "Each click must send exactly one message");
        check(
            messages.at(-1)?.urls[0] === url,
            `Expected click to send ${url}, got ${JSON.stringify(messages.at(-1))}`,
        );
    };

    await settle();
    check(hosts().length === 1, "Expected initial text button");
    click(hosts()[0]!, "https://files.example/first.zip");
    const anchorHost = anchor.nextElementSibling as HTMLElement;
    check(hosts(anchor).length === 0, "Supported anchor must not get a text button");

    node.data = btoa("https://files.example/second.zip");
    await settle();
    check(container.firstChild === node, "Text node identity must survive rescanning");
    check(hosts().length === 1, "URL replacement must leave exactly one button");
    click(hosts()[0]!, "https://files.example/second.zip");
    check(anchor.nextElementSibling === anchorHost, "Text updates must preserve anchor buttons");

    node.data = `${btoa("https://files.example/third.zip")} ${btoa("https://files.example/fourth.zip")}`;
    await settle();
    check(hosts().length === 2, "Expected one button per current candidate");
    click(hosts()[0]!, "https://files.example/third.zip");
    click(hosts()[1]!, "https://files.example/fourth.zip");

    node.data = "short";
    await settle();
    check(hosts().length === 0, "Short text must remove all old buttons");
    node.data = "This is ordinary text without a downloadable URL.";
    await settle();
    check(hosts().length === 0, "Non-candidate text must have no buttons");
    node.data = btoa("https://files.example/fifth.zip");
    await settle();
    check(hosts().length === 1, "Previously rejected text must be rescanned");
    click(hosts()[0]!, "https://files.example/fifth.zip");

    node.remove();
    await settle();
    check(hosts().length === 0, "Removing only the text must remove its sibling buttons");
    container.append(node);
    await settle();
    check(hosts().length === 1, "Reinserted text must get a button");

    container.remove();
    await settle();
    check(hosts().length === 0, "Removed subtrees must release text buttons");
    document.body.append(container);
    await settle();
    check(hosts().length === 1, "Reattached subtree must get exactly one button");

    const destination = document.createElement("div");
    document.body.append(destination);
    destination.append(node);
    await settle();
    check(hosts().length === 0, "Moved text must not leave orphan buttons");
    check(hosts(destination).length === 1, "Moved text must get a button at its new location");
    click(hosts(destination)[0]!, "https://files.example/fifth.zip");

    anchor.append(node);
    await settle();
    check(hosts(destination).length === 0, "Moving into an anchor must clear old text buttons");
    check(
        hosts(anchor).length === 0,
        "Moving into a supported anchor must not duplicate its button",
    );
    click(anchorHost, "https://files.example/anchor.zip");
    anchor.href = "https://files.example/updated-anchor.zip";
    await settle();
    check(!anchorHost.isConnected, "Changed href must replace the old anchor button");
    click(anchor.nextElementSibling as HTMLElement, "https://files.example/updated-anchor.zip");

    const updatedHost = anchor.nextElementSibling as HTMLElement;
    anchor.remove();
    await settle();
    check(!updatedHost.isConnected, "Removing only the anchor must remove its sibling button");
    destination.append(anchor);
    await settle();
    check(
        anchor.nextElementSibling?.hasAttribute("data-kioex") === true,
        "Reinserted anchor must get a button at its new location",
    );
    return "content lifecycle assertions passed";
}
