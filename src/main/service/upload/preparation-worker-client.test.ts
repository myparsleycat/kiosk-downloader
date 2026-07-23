import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../logger";

// Stub for the electron-vite `?nodeWorker` import. Each call to the factory
// returns a fresh mock worker whose message/error/exit behavior the test
// controls via the `currentWorker` handle.
let currentWorker: MockWorker;

class MockWorker extends EventEmitter {
    posted: unknown[] = [];
    terminated = false;

    postMessage(message: unknown) {
        this.posted.push(message);
    }

    terminate() {
        this.terminated = true;
        return Promise.resolve();
    }
}

vi.mock("./preparation-worker?nodeWorker", () => ({
    default: () => {
        currentWorker = new MockWorker();
        return currentWorker;
    },
}));

const { PreparationWorkerClient } = await import("./preparation-worker-client");

function createLogger() {
    return { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as Logger;
}

function emitResult(worker: MockWorker, taskId: string, result: unknown) {
    worker.emit("message", { type: "result", taskId, result });
}

function emitError(worker: MockWorker, taskId: string, message: string) {
    worker.emit("message", {
        type: "error",
        taskId,
        error: { name: "Error", message, stack: undefined },
    });
}

describe("PreparationWorkerClient", () => {
    let client: InstanceType<typeof PreparationWorkerClient>;

    beforeEach(() => {
        client = new PreparationWorkerClient(createLogger());
    });

    it("serializes two concurrent materialize requests in FIFO order", async () => {
        const first = client.materializePacks([]);
        const second = client.materializePacks([]);

        // The first request spawns a worker immediately.
        const firstWorker = currentWorker;
        expect(firstWorker.posted).toHaveLength(1);
        const firstTaskId = (firstWorker.posted[0] as { taskId: string }).taskId;

        // While the first is still in-flight, the second request is queued but
        // no second worker has been spawned yet.
        expect(second).toEqual(expect.any(Promise));

        emitResult(firstWorker, firstTaskId, { kind: "materialized", files: [] });
        await expect(first).resolves.toEqual([]);
        expect(firstWorker.terminated).toBe(true);

        // After the first completes, the second request's worker spawns.
        const secondTaskId = (currentWorker.posted[0] as { taskId: string }).taskId;
        expect(secondTaskId).not.toBe(firstTaskId);
        emitResult(currentWorker, secondTaskId, { kind: "materialized", files: [] });

        await expect(second).resolves.toEqual([]);
    });

    it("starts a queued task after the active one resolves", async () => {
        const first = client.materializePacks([]);
        const second = client.materializePacks([]);

        const firstTaskId = (currentWorker.posted[0] as { taskId: string }).taskId;
        // Even if the first fails, the second should still run.
        emitError(currentWorker, firstTaskId, "first failed");

        await expect(first).rejects.toThrow("first failed");

        const secondTaskId = (currentWorker.posted[0] as { taskId: string }).taskId;
        emitResult(currentWorker, secondTaskId, { kind: "materialized", files: [] });

        await expect(second).resolves.toEqual([]);
    });

    it("rejects the active promise when the worker exits abnormally", async () => {
        const task = client.materializePacks([]);

        currentWorker.emit("exit", 1);

        await expect(task).rejects.toThrow("비정상 종료");
    });

    it("rejects both active and queued tasks on destroy", async () => {
        const first = client.materializePacks([]);
        const second = client.materializePacks([]);

        client.destroy();

        await expect(first).rejects.toThrow("destroyed");
        await expect(second).rejects.toThrow("destroyed");
    });

    it("delivers progress callbacks to the registered handler", async () => {
        const progressSpy = vi.fn();
        const task = client.planIntegrated(
            { bundleId: "b1", packDir: "/packs", files: [] },
            progressSpy,
        );

        const taskId = (currentWorker.posted[0] as { taskId: string }).taskId;
        const progressPayload = { stage: "hashing", current: 1, total: 5 };
        currentWorker.emit("message", { type: "progress", taskId, progress: progressPayload });

        expect(progressSpy).toHaveBeenCalledWith(progressPayload);

        emitResult(currentWorker, taskId, { kind: "plan", plan: { collections: [] } });
        await expect(task).resolves.toEqual({ collections: [] });
    });

    it("rejects new tasks queued after destroy", async () => {
        client.destroy();
        await expect(client.materializePacks([])).rejects.toThrow("destroyed");
    });
});
