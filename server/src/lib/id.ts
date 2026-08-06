import { randomUUID } from "node:crypto";

/** Sortable-enough unique id: epoch millis prefix + uuid tail. */
export function newId(): string {
  return `${Date.now().toString(36)}-${randomUUID().slice(0, 12)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
