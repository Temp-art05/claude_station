import type { z } from "zod";

/**
 * PATCH semantics done right under zod v4: `.partial().parse()` still fills
 * `.default()` fields, so a body of `{viewUrl}` would silently reset every
 * other defaulted column. Validate with partial(), then keep only the keys the
 * caller actually sent.
 */
export function parsePatch<T extends z.ZodObject<z.ZodRawShape>>(
  schema: T,
  body: unknown,
): Partial<z.infer<T>> {
  const obj = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const parsed = schema.partial().parse(obj) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => key in obj),
  ) as Partial<z.infer<T>>;
}
