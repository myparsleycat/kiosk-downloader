import { parentPort } from "node:worker_threads";

import type { PreparationRequest, PreparationWorkerMessage } from "./preparation-protocol";

import { materializePacks, planIntegratedBundle, PlanProgressReporter } from "./preparation-core";

const port = parentPort;
if (!port) {
    throw new Error("preparation-worker must be spawned as a worker_thread");
}

port.on("message", async (request: PreparationRequest) => {
    const reply = (message: PreparationWorkerMessage) => port.postMessage(message);
    try {
        if (request.type === "plan-integrated") {
            const reporter = new PlanProgressReporter((progress) =>
                reply({ type: "progress", taskId: request.taskId, progress }),
            );
            const plan = await planIntegratedBundle(
                request.files,
                request.bundleId,
                request.packDir,
                reporter,
            );
            reply({ type: "result", taskId: request.taskId, result: { kind: "plan", plan } });
            return;
        }
        if (request.type === "materialize-packs") {
            const files = await materializePacks(request.files);
            reply({
                type: "result",
                taskId: request.taskId,
                result: { kind: "materialized", files },
            });
            return;
        }
        throw new Error(`지원하지 않는 worker 요청: ${(request as { type: string }).type}`);
    } catch (error) {
        reply({
            type: "error",
            taskId: request.taskId,
            error: {
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
            },
        });
    }
});
