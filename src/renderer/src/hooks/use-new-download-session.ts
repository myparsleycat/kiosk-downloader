import { collectAllPaths, selectExpandedZipEntries, summarizeSelection } from "@renderer/lib/types";
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
    isDownloadShareInput,
    tryDecodeShareUrlBase64,
} from "@shared/share-url";
import * as React from "react";
import { toast } from "sonner";

export function useNewDownloadSession({ onCreated }: { onCreated: (downloadId: string) => void }) {
    const url = useNewDownloadDraft((state) => state.url);
    const items = useNewDownloadDraft((state) => state.items);
    const setUrl = useNewDownloadDraft((state) => state.setUrl);
    const replaceItems = useNewDownloadDraft((state) => state.replaceItems);
    const setItemPreparation = useNewDownloadDraft((state) => state.setItemPreparation);
    const setItemSelected = useNewDownloadDraft((state) => state.setItemSelected);
    const updateItemSelected = useNewDownloadDraft((state) => state.updateItemSelected);
    const setItemZipPassword = useNewDownloadDraft((state) => state.setItemZipPassword);
    const setItemZipLoading = useNewDownloadDraft((state) => state.setItemZipLoading);
    const removeItem = useNewDownloadDraft((state) => state.removeItem);
    const resetDraft = useNewDownloadDraft((state) => state.resetDraft);
    const hydrateSettings = useNewDownloadDraft((state) => state.hydrateSettings);

    const [extendedLoadProgress, setExtendedLoadProgress] = React.useState<{
        url: string;
        current: number;
        total: number;
    } | null>(null);
    const [starting, setStarting] = React.useState(false);
    const [zipPasswordPrompt, setZipPasswordPrompt] = React.useState<{
        itemKey: string;
        path: string;
        fileId: string;
        invalid: boolean;
    } | null>(null);
    const [zipPasswordInput, setZipPasswordInput] = React.useState("");

    const sessionRef = React.useRef(0);

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

    React.useEffect(
        () =>
            window.api.on("download:extended-load-progress", (progress) =>
                setExtendedLoadProgress(progress),
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
            const isCurrent = () => Boolean(findItem());
            const existing = findItem();
            if (!existing) {
                return;
            }
            if (existing.preparation.status === "ready") {
                void window.api.invoke("download:discardDraft", {
                    draftId: existing.preparation.draftId,
                });
            }

            const extended = trimmedUrl.startsWith(EXTENDED_SHARE_PREFIX);
            setItemPreparation(itemKey, { status: "preparing" });
            if (extended) {
                setExtendedLoadProgress({ url: trimmedUrl, current: 0, total: 0 });
            }

            try {
                await hydrateSettings();
                if (!isCurrent()) {
                    return;
                }
                const result = await window.api.invoke("download:prepare", {
                    url: trimmedUrl,
                    password: loadPassword || undefined,
                    asciiFilenames: useNewDownloadDraft.getState().asciiFilenames,
                });
                if (!isCurrent()) {
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
                if (!isCurrent()) {
                    return;
                }
                const message = getIpcErrorCause(error);
                setItemPreparation(itemKey, { status: "error", message });
                setItemSelected(itemKey, new Set());
                toast.error("컬렉션을 불러오지 못했습니다", { description: message });
            } finally {
                if (extended) {
                    setExtendedLoadProgress((current) =>
                        current?.url === trimmedUrl ? null : current,
                    );
                }
            }
        },
        [hydrateSettings, setItemPreparation, setItemSelected],
    );

    const commitUrls = React.useCallback(
        async (urls: string[]) => {
            const session = ++sessionRef.current;
            await window.api.invoke("download:discardDraft", {});
            if (session !== sessionRef.current) {
                return;
            }
            replaceItems(urls);
            await Promise.all(
                useNewDownloadDraft
                    .getState()
                    .items.map((item) => loadCollection(item.key, item.url)),
            );
        },
        [loadCollection, replaceItems],
    );

    const applyUrlInput = React.useCallback(
        (value: string) => {
            setUrl(tryDecodeShareUrlBase64(value) ?? value);
        },
        [setUrl],
    );

    React.useEffect(() => {
        const trimmed = url.trim();
        if (!isDownloadShareInput(trimmed) || !shouldLoadPastedShare(items, trimmed)) {
            return;
        }
        void commitUrls([trimmed]);
    }, [commitUrls, items, url]);

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
                    });
                    if (!created) {
                        throw new Error("다운로드 항목을 만들지 못했습니다.");
                    }
                    lastId = created.id;
                    lastDescription = `${item.preparation.collection.name} · ${summarizeSelection(item.selected, itemDisplayTree(item) ?? item.preparation.collection.tree).count}개 파일`;
                    createdCount += 1;
                    removeItem(item.key);
                } catch (error) {
                    toast.error("다운로드를 시작하지 못했습니다", {
                        description: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            const remaining = useNewDownloadDraft.getState().items;
            if (createdCount > 0) {
                toast.success(
                    createdCount === 1
                        ? "다운로드가 대기열에 추가되었습니다"
                        : `${createdCount}개 다운로드가 대기열에 추가되었습니다`,
                    createdCount === 1 && lastDescription
                        ? { description: lastDescription }
                        : undefined,
                );
            }
            if (remaining.length === 0 && lastId) {
                resetDraft();
                onCreated(lastId);
            }
        } finally {
            setStarting(false);
        }
    }, [onCreated, removeItem, resetDraft, starting]);

    const handleRemoveItem = React.useCallback(
        (item: NewDownloadItem) => {
            if (item.preparation.status === "ready") {
                void window.api.invoke("download:discardDraft", {
                    draftId: item.preparation.draftId,
                });
            }
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
