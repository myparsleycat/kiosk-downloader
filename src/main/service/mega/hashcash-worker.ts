import { parentPort, workerData } from "node:worker_threads";

import { solveHashcashChallenge } from "./hashcash";

const port = parentPort;
if (!port) {
    throw new Error("hashcash-worker must be spawned as a worker_thread");
}

try {
    port.postMessage({ ok: true, header: solveHashcashChallenge(String(workerData)) });
} catch (error) {
    port.postMessage({
        ok: false,
        message: error instanceof Error ? error.message : String(error),
    });
}
