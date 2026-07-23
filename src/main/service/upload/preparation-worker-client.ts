import { randomUUID } from "node:crypto";
import type { Worker } from "node:worker_threads";

import type { Logger } from "../../logger";
import type {
    PreparationProgressHandler,
    PreparationRequest,
    PreparationResult,
    PreparationWorkerMessage,
} from "./preparation-protocol";
import type { PersistedBundleFile, PersistedBundlePlan } from "./small-file-pack";
import type { UploadSourceFile } from "./types";

// electron-vite rewrites this into a Worker factory in the bundled main process.
import createWorker from "./preparation-worker?nodeWorker";

type QueuedTask = {
    request: PreparationRequest;
    onProgress?: PreparationProgressHandler;
    resolve: (result: PreparationResult) => void;
    reject: (error: unknown) => void;
};

type ActiveTask = {
    worker: Worker;
    resolve: (result: PreparationResult) => void;
    reject: (error: unknown) => void;
};

export class PreparationWorkerClient {
    private active: ActiveTask | null = null;
    private readonly pending: QueuedTask[] = [];
    private destroyed = false;

    constructor(private readonly logger: Logger) {}

    async planIntegrated(
        request: Omit<Extract<PreparationRequest, { type: "plan-integrated" }>, "type" | "taskId">,
        onProgress: PreparationProgressHandler,
    ): Promise<PersistedBundlePlan> {
        const result = await this.run(
            { type: "plan-integrated", taskId: randomUUID(), ...request },
            onProgress,
        );
        if (result.kind !== "plan") {
            throw new Error("preparation worker returned unexpected result kind for plan request");
        }
        return result.plan;
    }

    async materializePacks(files: PersistedBundleFile[]): Promise<UploadSourceFile[]> {
        const result = await this.run(
            { type: "materialize-packs", taskId: randomUUID(), files },
            undefined,
        );
        if (result.kind !== "materialized") {
            throw new Error(
                "preparation worker returned unexpected result kind for materialize request",
            );
        }
        return result.files;
    }

    destroy() {
        this.destroyed = true;
        for (const task of this.pending.splice(0)) {
            task.reject(new Error("preparation worker destroyed"));
        }
        if (this.active) {
            this.active.reject(new Error("preparation worker destroyed"));
            void this.active.worker.terminate().catch(() => {});
            this.active = null;
        }
    }

    private run(
        request: PreparationRequest,
        onProgress?: PreparationProgressHandler,
    ): Promise<PreparationResult> {
        return new Promise<PreparationResult>((resolve, reject) => {
            if (this.destroyed) {
                reject(new Error("preparation worker destroyed"));
                return;
            }
            this.pending.push({ request, onProgress, resolve, reject });
            void this.drain();
        });
    }

    private async drain() {
        if (this.active || this.destroyed) return;
        const task = this.pending.shift();
        if (!task) return;
        await this.execute(task);
        void this.drain();
    }

    private execute(task: QueuedTask): Promise<void> {
        const { request, onProgress, resolve, reject } = task;
        const worker = createWorker({});
        return new Promise<void>((done) => {
            this.active = {
                worker,
                resolve: (result) => {
                    resolve(result);
                    done();
                },
                reject: (error) => {
                    reject(error);
                    done();
                },
            };

            const cleanup = () => {
                worker.removeAllListeners();
                this.active = null;
            };

            worker.on("message", (message: PreparationWorkerMessage) => {
                if (message.taskId !== request.taskId) return;
                if (message.type === "progress") {
                    onProgress?.(message.progress);
                    return;
                }
                if (message.type === "result") {
                    cleanup();
                    void worker.terminate().catch(() => {});
                    resolve(message.result);
                    done();
                    return;
                }
                cleanup();
                void worker.terminate().catch(() => {});
                reject(
                    Object.assign(new Error(message.error.message || "preparation worker failed"), {
                        name: message.error.name,
                        stack: message.error.stack,
                    }),
                );
                done();
            });

            worker.on("error", (error: Error) => {
                this.logger.error(
                    {
                        action: "upload-preparation-worker-error",
                        taskId: request.taskId,
                        requestType: request.type,
                        message: error.message,
                    },
                    "PreparationWorkerClient:error",
                );
                cleanup();
                reject(error);
                done();
            });

            worker.on("exit", (code: number) => {
                if (!this.active) return;
                this.logger.error(
                    {
                        action: "upload-preparation-worker-exit",
                        taskId: request.taskId,
                        requestType: request.type,
                        exitCode: code,
                    },
                    "PreparationWorkerClient:exit",
                );
                cleanup();
                reject(
                    new Error(`업로드 준비 worker가 비정상 종료되었습니다 (exit code ${code}).`),
                );
                done();
            });

            worker.postMessage(request);
        });
    }
}
