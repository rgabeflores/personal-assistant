export type KeySyncAction = "create" | "update" | "unchanged" | "keep" | "missing";

/** What to do with one provider's secret, given the local key and the secret's current state. */
export function planKeySync(local: string | undefined, current: { exists: boolean; value: string | undefined }): KeySyncAction {
  if (!local) return current.value ? "keep" : "missing";
  if (current.value === local) return "unchanged";
  return current.exists ? "update" : "create";
}
