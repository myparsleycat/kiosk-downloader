import { collectAllPaths, selectExpandedZipEntries, summarizeSelection } from "@renderer/lib/types";
import { useAppNavigation } from "@renderer/stores/app-navigation";
import {
    applyZipEntriesResult,
    getStartableDraftItems,
    itemDisplayTree,
    shouldLoadPastedShare,
    useNewDownloadDraft,
    type NewDownloadItem,
} from "@renderer/stores/new-download-draft";
import { getIpcErrorCause } from "@shared/download-errors";
import {
    EXTENDED_SHARE_PREFIX,
    isAutoCommitShareInput,
    isDownloadShareInput,
    tryDecodeShareUrlBase64,
    tryParseDownloadUrl,
} from "@shared/share-url";
import { DOWNLOAD_PREPARE_CONCURRENCY } from "@shared/types";
import * as React from "react";
import { toast } from "sonner";

export function useNewDownloadSession({ onCreated }: { onCreated: (downloadId: string) => void }) {
    const url = useNewDownloadDraft((state) => state.url);
    const commitRequestedUrl = useNewDownloadDraft((state) => state.commitRequestedUrl);
    const items = useNewDownloadDraft((state) => state.items);
    const setUrl = useNewDownloadDraft((state) => state.setUrl);
    const setSavePath = useNewDownloadDraft((state) => state.setSavePath);
    const setCreateCollectionSubfolder = useNewDownloadDraft(
        (state) => state.setCreateCollectionSubfolder,
    );
    const setAsciiFilenames = useNewDownloadDraft((state) => state.setAsciiFilenames);
    const replaceItems = useNewDownloadDraft((state) => state.replaceItems);
    const appendItems = useNewDownloadDraft((state) => state.appendItems);
    const setItemPreparation = useNewDownloadDraft((state) => state.setItemPreparation);
    const setItemSelected = useNewDownloadDraft((state) => state.setItemSelected);
    const updateItemSelected = useNewDownloadDraft((state) => state.updateItemSelected);
    const setItemZipPassword = useNewDownloadDraft((state) => state.setItemZipPassword);
    const setItemZipLoading = useNewDownloadDraft((state) => state.setItemZipLoading);
    const removeItem = useNewDownloadDraft((state) => state.removeItem);
    const resetDraft = useNewDownloadDraft((state) => state.resetDraft);
    const hydrateSettings = useNewDownloadDraft((state) => state.hydrateSettings);

    const [extendedLoadProgress, setExtendedLoadProgress] = React.useState<
        Record<string, { current: number; total: number }>
    >({});
    const [starting, setStarting] = React.useState(false);
    const [zipPasswordPrompt, setZipPasswordPrompt] = React.useState<{
        itemKey: string;
        path: string;
        fileId: string;
        invalid: boolean;
    } | null>(null);
    const [zipPasswordInput, setZipPasswordInput] = React.useState("");

    const sessionRef = React.useRef(0);
    const commitDiscardRef = React.useRef<Promise<unknown>>(Promise.resolve());
    const loadGenerationRef = React.useRef(new Map<string, number>());

    React.useEffect(() => {
        void hydrateSettings();
    }, [hydrateSettings]);

    React.useEffect(
        () => () => {
            sessionRef.current += 1;
            void window.api.invoke("download:discardDraft", {});
            resetDraft();
        },
        [resetDraft],
    );

    React.useEffect(() => {
        let savePathRequest = 0;
        return window.api.on("setting:update", ({ key, value }) => {
            if (key === "general.createCollectionSubfolder" && typeof value === "boolean") {
                setCreateCollectionSubfolder(value);
                return;
            }
            if (key === "general.asciiFilenames" && typeof value === "boolean") {
                setAsciiFilenames(value);
                return;
            }
            if (key !== "general.defaultDownloadPath" && key !== "general.lastDownloadPath") {
                return;
            }
            // Either key alone cannot tell whether a manual default overrides the last
            // used path, so resolve from both stored values. Only the latest request may
            // apply, since responses to back-to-back updates can arrive out of order.
            const request = ++savePathRequest;
            void window.api
                .invoke("setting:getMany", [
                    "general.defaultDownloadPath",
                    "general.lastDownloadPath",
                ] as const)
                .then((values) => {
                    if (request !== savePathRequest) return;
                    // Never replace a path the user may be reviewing for drafts already in progress.
                    if (useNewDownloadDraft.getState().items.length > 0) return;
                    setSavePath(
                        values["general.defaultDownloadPath"] || values["general.lastDownloadPath"],
                    );
                })
                .catch((error) => {
                    toast.error("저장 경로를 불러오지 못했습니다", {
                        description: getIpcErrorCause(error),
                    });
                });
        });
    }, [setAsciiFilenames, setCreateCollectionSubfolder, setSavePath]);

    React.useEffect(
        () =>
            window.api.on("download:extended-load-progress", (progress) =>
                setExtendedLoadProgress((current) => ({
                    ...current,
                    [progress.url]: { current: progress.current, total: progress.total },
                })),
            ),
        [],
    );

    const loadCollection = React.useCallback(
        async (itemKey: string, trimmedUrl: string, loadPassword?: string) => {
            if (!isDownloadShareInput(trimmedUrl)) {
                return;
            }

            const findItem = () =>
                useNewDownloadDraft.getState().items.find((item) => item.key === itemKey);
            const existing = findItem();
            if (!existing) {
                return;
            }
            const generation = (loadGenerationRef.current.get(itemKey) ?? 0) + 1;
            loadGenerationRef.current.set(itemKey, generation);
            const isCurrentGeneration = () =>
                Boolean(findItem()) && loadGenerationRef.current.get(itemKey) === generation;
            if (existing.preparation.status === "ready") {
                void window.api.invoke("download:discardDraft", {
                    draftId: existing.preparation.draftId,
                });
            }

            const extended = trimmedUrl.startsWith(EXTENDED_SHARE_PREFIX);
            setItemPreparation(itemKey, { status: "preparing" });
            if (extended) {
                setExtendedLoadProgress((current) => ({
                    ...current,
                    [trimmedUrl]: { current: 0, total: 0 },
                }));
            }

            try {
                await hydrateSettings();
                if (!isCurrentGeneration()) {
                    return;
                }
                const headers = findItem()?.headers;
                const result = await window.api.invoke("download:prepare", {
                    url: trimmedUrl,
                    password: loadPassword || undefined,
                    headers:
                        tryParseDownloadUrl(trimmedUrl)?.provider === "direct" && headers
                            ? headers
                            : undefined,
                    asciiFilenames: useNewDownloadDraft.getState().asciiFilenames,
                    correlationId: itemKey,
                });
                if (!isCurrentGeneration()) {
                    if (result.status === "ready") {
                        void window.api.invoke("download:discardDraft", {
                            draftId: result.draftId,
                        });
                    }
                    return;
                }

                if (result.status === "ready") {
                    setItemPreparation(itemKey, result);
                    setItemSelected(itemKey, collectAllPaths(result.collection.tree));
                    return;
                }
                if (result.status === "passwordRequired") {
                    setItemPreparation(itemKey, result);
                    setItemSelected(itemKey, new Set());
                    return;
                }
                setItemPreparation(itemKey, { status: "error", message: result.message });
                setItemSelected(itemKey, new Set());
                toast.error("컬렉션을 불러오지 못했습니다", { description: result.message });
            } catch (error) {
                if (!isCurrentGeneration()) {
                    return;
                }
                const message = getIpcErrorCause(error);
                setItemPreparation(itemKey, { status: "error", message });
                setItemSelected(itemKey, new Set());
                toast.error("컬렉션을 불러오지 못했습니다", { description: message });
            } finally {
                if (extended && loadGenerationRef.current.get(itemKey) === generation) {
                    setExtendedLoadProgress((current) => {
                        if (!(trimmedUrl in current)) {
                            return current;
                        }
                        const next = { ...current };
                        delete next[trimmedUrl];
                        return next;
                    });
                }
            }
        },
        [hydrateSettings, setItemPreparation, setItemSelected],
    );

    const loadItems = React.useCallback(
        async (draftItems: NewDownloadItem[]) => {
            let cursor = 0;
            const workerCount = Math.min(DOWNLOAD_PREPARE_CONCURRENCY, draftItems.length);
            await Promise.all(
                Array.from({ length: workerCount }, async () => {
                    while (true) {
                        const index = cursor++;
                        const item = draftItems[index];
                        if (item === undefined) {
                            return;
                        }
                        await loadCollection(item.key, item.url);
                    }
                }),
            );
        },
        [loadCollection],
    );

    const commitUrls = React.useCallback(
        async (urls: string[]) => {
            const session = ++sessionRef.current;
            const discard = window.api.invoke("download:discardDraft", {});
            commitDiscardRef.current = discard;
            await discard;
            if (session !== sessionRef.current) {
                return;
            }
            replaceItems(urls);
            await loadItems(useNewDownloadDraft.getState().items);
        },
        [loadItems, replaceItems],
    );

    const appendBrowserExtensionRequests = React.useCallback(async () => {
        const requests = await window.api.invoke("browserExtension:takeRequests");
        if (requests.length === 0) {
            return;
        }
        useAppNavigation.getState().setTab("new");
        // A commit in flight replaces the whole list once its discard settles, and the discard
        // aborts app prepares; appending after it keeps these links and their loads intact.
        // A failed discard belongs to that commit; these links are appended regardless.
        await commitDiscardRef.current.catch(() => undefined);
        await loadItems(appendItems(requests));
    }, [appendItems, loadItems]);

    React.useEffect(() => {
        const append = () =>
            void appendBrowserExtensionRequests().catch((error) =>
                toast.error("브라우저 확장 프로그램 요청을 불러오지 못했습니다", {
                    description: getIpcErrorCause(error),
                }),
            );
        append();
        return window.api.on("browserExtension:requestsAvailable", append);
    }, [appendBrowserExtensionRequests]);

    const applyUrlInput = React.useCallback(
        (value: string, options?: { commit?: boolean }) => {
            setUrl(tryDecodeShareUrlBase64(value) ?? value, options);
        },
        [setUrl],
    );

    React.useEffect(() => {
        const trimmed = url.trim();
        const committed =
            isAutoCommitShareInput(trimmed) ||
            (commitRequestedUrl === trimmed && isDownloadShareInput(trimmed));
        if (!committed || !shouldLoadPastedShare(items, trimmed)) {
            return;
        }
        void commitUrls([trimmed]);
    }, [commitRequestedUrl, commitUrls, items, url]);

    const expandZip = React.useCallback(
        async (itemKey: string, zipPath: string, fileId: string, zipPassword?: string) => {
            const item = useNewDownloadDraft
                .getState()
                .items.find((candidate) => candidate.key === itemKey);
            if (!item || item.preparation.status !== "ready") {
                return;
            }
            const requestedDraftId = item.preparation.draftId;
            setItemZipLoading(itemKey, zipPath, true);
            try {
                const result = await window.api.invoke("download:listZipEntries", {
                    draftId: requestedDraftId,
                    fileId,
                    zipPassword,
                });
                const current = useNewDownloadDraft
                    .getState()
                    .items.find((candidate) => candidate.key === itemKey);
                if (!current) {
                    return;
                }
                const applied = applyZipEntriesResult(
                    requestedDraftId,
                    current.preparation,
                    result,
                    fileId,
                );
                if (applied.action === "ignore") {
                    return;
                }
                if (applied.action === "passwordRequired") {
                    setZipPasswordPrompt({
                        itemKey,
                        path: zipPath,
                        fileId,
                        invalid: applied.invalid,
                    });
                    return;
                }
                if (applied.action === "clear") {
                    setItemPreparation(itemKey, {
                        status: "error",
                        message:
                            result.status === "failed" ? result.message : "초안이 만료되었습니다.",
                    });
                    toast.error("ZIP 목록을 불러오지 못했습니다", {
                        description: result.status === "failed" ? result.message : undefined,
                    });
                    return;
                }
                if (applied.action === "failed") {
                    toast.error("ZIP 목록을 불러오지 못했습니다", {
                        description: result.status === "failed" ? result.message : undefined,
                    });
                    return;
                }
                const latest = useNewDownloadDraft
                    .getState()
                    .items.find((candidate) => candidate.key === itemKey);
                if (!latest || latest.preparation.status !== "ready") {
                    return;
                }
                if (zipPassword) {
                    setItemZipPassword(itemKey, fileId, zipPassword);
                }
                setItemPreparation(itemKey, {
                    status: "ready",
                    draftId: requestedDraftId,
                    collection: { ...latest.preparation.collection, tree: applied.nextTree },
                });
                updateItemSelected(itemKey, (prev) =>
                    selectExpandedZipEntries(prev, applied.nextTree, zipPath, fileId),
                );
                setZipPasswordPrompt(null);
                setZipPasswordInput("");
            } catch (error) {
                toast.error("ZIP 목록을 불러오지 못했습니다", {
                    description: getIpcErrorCause(error),
                });
            } finally {
                setItemZipLoading(itemKey, zipPath, false);
            }
        },
        [setItemPreparation, setItemZipLoading, setItemZipPassword, updateItemSelected],
    );

    const handleStart = React.useCallback(async () => {
        if (starting) {
            return;
        }
        const startable = getStartableDraftItems(useNewDownloadDraft.getState().items);
        if (startable.length === 0) {
            return;
        }
        const nextSavePath = useNewDownloadDraft.getState().savePath.trim();
        if (!nextSavePath) {
            return;
        }
        setStarting(true);
        try {
            let lastId: string | undefined;
            let lastDescription: string | undefined;
            let createdCount = 0;
            let pausedCount = 0;
            for (const item of startable) {
                if (item.preparation.status !== "ready") {
                    continue;
                }
                try {
                    const created = await window.api.invoke("download:create", {
                        draftId: item.preparation.draftId,
                        savePath: nextSavePath,
                        selectedPaths: [...item.selected],
                        zipPasswords:
                            Object.keys(item.zipPasswords).length > 0
                                ? item.zipPasswords
                                : undefined,
                        renames: Object.keys(item.renames).length > 0 ? item.renames : undefined,
                        headers:
                            item.preparation.collection.provider === "direct"
                                ? item.headers
                                : undefined,
                    });
                    if (!created) {
                        throw new Error("다운로드 항목을 만들지 못했습니다.");
                    }
                    lastId = created.id;
                    lastDescription = `${item.preparation.collection.name} · ${summarizeSelection(item.selected, itemDisplayTree(item) ?? item.preparation.collection.tree).count}개 파일`;
                    createdCount += 1;
                    if (created.status === "paused") {
                        pausedCount += 1;
                    }
                    removeItem(item.key);
                } catch (error) {
                    toast.error("다운로드를 시작하지 못했습니다", {
                        description: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            const remaining = useNewDownloadDraft.getState().items;
            if (createdCount > 0) {
                const subject = createdCount === 1 ? "다운로드가" : `${createdCount}개 다운로드가`;
                const result = pausedCount === createdCount ? "일시정지 상태로" : "대기열에";
                toast.success(
                    `${subject} ${result} 추가되었습니다`,
                    createdCount === 1 && lastDescription
                        ? { description: lastDescription }
                        : undefined,
                );
            }
            if (remaining.length === 0 && lastId) {
                resetDraft();
                // The view stays mounted, so rehydrate now instead of on the next load, which
                // would overwrite a save path the user edits in the meantime.
                void hydrateSettings();
                onCreated(lastId);
            }
        } finally {
            setStarting(false);
        }
    }, [hydrateSettings, onCreated, removeItem, resetDraft, starting]);

    const handleRemoveItem = React.useCallback(
        (item: NewDownloadItem) => {
            void window.api.invoke("download:discardDraft", { draftId: item.key });
            removeItem(item.key);
            if (useNewDownloadDraft.getState().items.length === 0) {
                sessionRef.current += 1;
                void window.api.invoke("download:discardDraft", {});
            }
        },
        [removeItem],
    );

    return {
        applyUrlInput,
        commitUrls,
        expandZip,
        extendedLoadProgress,
        handleRemoveItem,
        handleStart,
        loadCollection,
        starting,
        zipPasswordInput,
        zipPasswordPrompt,
        setZipPasswordInput,
        setZipPasswordPrompt,
    };
}
