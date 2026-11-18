import { accessSync, constants } from "node:fs";

/**
 * Chromium flags for WebGL in headless browsers (the e2e studio pages and the art renderer).
 * Rendering the Godot runtime in software (SwiftShader) is what makes those slow, so a usable
 * GPU (a DRI render node we can open) is used through ANGLE's GL-ES backend. ANOMALY_GL=software
 * forces SwiftShader (deterministic pixels, or a machine whose GPU misbehaves); ANOMALY_GL=gpu
 * forces the GPU.
 */
export function browserGlArgs(env: Record<string, string | undefined> = process.env): string[] {
  const mode = env.ANOMALY_GL ?? (hasRenderNode() ? "gpu" : "software");
  return mode === "gpu" ? ["--use-angle=gl-egl", "--enable-gpu", "--ignore-gpu-blocklist"] : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];
}

function hasRenderNode(): boolean {
  try {
    accessSync("/dev/dri/renderD128", constants.R_OK | constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
