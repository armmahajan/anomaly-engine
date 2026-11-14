import { z } from "zod";

/** Shared field schemas. */

export const Id = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "ids are lowercase snake_case")
  .max(64);

export const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "colors are #rrggbb");
