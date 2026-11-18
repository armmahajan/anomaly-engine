import { parentPort, workerData } from "node:worker_threads";
import { buildPreview, type ProjectSpec } from "@anomaly/core";

// Builds the live preview of the world off the server's main thread (geometry proves every room).
parentPort!.postMessage(buildPreview(workerData as ProjectSpec));
