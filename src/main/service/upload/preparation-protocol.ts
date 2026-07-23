import type { UploadPlanProgress } from "@shared/types";

import type { PersistedBundleFile, PersistedBundlePlan } from "./small-file-pack";
import type { UploadSourceFile } from "./types";

export type PreparationRequest =
    | {
          type: "plan-integrated";
          taskId: string;
          bundleId: string;
          packDir: string;
          files: UploadSourceFile[];
      }
    | {
          type: "materialize-packs";
          taskId: string;
          files: PersistedBundleFile[];
      };

export type PreparationWorkerMessage =
    | {
          type: "progress";
          taskId: string;
          progress: UploadPlanProgress;
      }
    | {
          type: "result";
          taskId: string;
          result: PreparationResult;
      }
    | {
          type: "error";
          taskId: string;
          error: { name: string; message: string; stack?: string };
      };

export type PreparationResult =
    | { kind: "plan"; plan: PersistedBundlePlan }
    | { kind: "materialized"; files: UploadSourceFile[] };

export type PreparationProgressHandler = (progress: UploadPlanProgress) => void;
