import { z } from "zod";

/** A file in the project's content-addressed asset store (<project>/files/). */
export const FileRef = z
  .string()
  .regex(/^[0-9a-f]{16,64}\.(png|jpg|webp)$/, "file refs are <hash>.<png|jpg|webp>")
  .describe("A file in the project's asset store.");
export type FileRef = z.infer<typeof FileRef>;
