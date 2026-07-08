import type { KioskDownloader } from "@/main";

type StartupCleanupTask = {
    name: string;
    run: () => Promise<void>;
};

export class StartupCleanupService {
    private readonly tasks = new Map<string, StartupCleanupTask>();

    constructor(private readonly kd: KioskDownloader) {}

    public register(task: StartupCleanupTask) {
        this.tasks.set(task.name, task);
    }

    public async runAll() {
        for (const task of this.tasks.values()) {
            try {
                await task.run();
            } catch (error) {
                this.kd.logger.error(error, `StartupCleanup:${task.name}`);
            }
        }
    }
}
