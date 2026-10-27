import type { Address } from "viem";
import { PROFILE_SCHEMA_VERSION, profileStoreSchema, type SafeProfile } from "@/lib/domain/profile";
import type { Environment, Migration } from "@/lib/domain/types";
import { legacyProfilesFromMigrations, parseProfile } from "@/lib/services/safe-profile";
import type { KeyValueStore } from "./persistence";

const PREFIX = "safe-migrator:v1";

export function profilesKey(source: Address): string {
  return `${PREFIX}:profiles:${source.toLowerCase()}`;
}

export interface LoadedProfiles {
  profiles: SafeProfile[];
  /** Stored entries that failed validation. They are kept in storage untouched, never repaired. */
  rejected: { id: string | null; reason: string }[];
}

/**
 * Loads saved profiles for a source. Each entry is validated independently; a corrupted entry is
 * reported and skipped rather than making every profile unreadable.
 */
export function loadProfiles(store: KeyValueStore, source: Address): LoadedProfiles {
  const raw = store.getItem(profilesKey(source));
  if (!raw) return { profiles: [], rejected: [] };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { profiles: [], rejected: [{ id: null, reason: "Saved profiles are not valid JSON." }] };
  }
  const envelope = profileStoreSchema.safeParse(json);
  if (!envelope.success) return { profiles: [], rejected: [{ id: null, reason: "Saved profile store has an unknown format." }] };
  const profiles: SafeProfile[] = [];
  const rejected: LoadedProfiles["rejected"] = [];
  for (const entry of envelope.data.profiles) {
    const parsed = parseProfile(entry, { source });
    if (parsed.ok) profiles.push(parsed.profile);
    else rejected.push({ id: typeof (entry as { id?: unknown })?.id === "string" ? (entry as { id: string }).id : null, reason: parsed.reason });
  }
  return { profiles, rejected };
}

/**
 * Persists profiles. Entries that failed validation on load are preserved verbatim so a newer
 * build (or the user) can still inspect them.
 */
export function saveProfiles(store: KeyValueStore, source: Address, profiles: readonly SafeProfile[]): void {
  const keep: unknown[] = [];
  const ids = new Set(profiles.map((p) => p.id));
  try {
    const prev = profileStoreSchema.safeParse(JSON.parse(store.getItem(profilesKey(source)) ?? "null"));
    if (prev.success) {
      for (const entry of prev.data.profiles) {
        const id = (entry as { id?: unknown })?.id;
        if (typeof id === "string" && ids.has(id)) continue;
        if (!parseProfile(entry, { source }).ok) keep.push(entry);
      }
    }
  } catch {
    // Unreadable previous value: nothing to preserve.
  }
  store.setItem(profilesKey(source), JSON.stringify({ kind: "safe-migrator/profile-store", schemaVersion: PROFILE_SCHEMA_VERSION, profiles: [...profiles, ...keep] }));
}

export function upsertProfile(list: readonly SafeProfile[], p: SafeProfile): SafeProfile[] {
  return list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [...list, p];
}

/**
 * Adds conservative legacy profiles for pre-v1.5 migration records that no profile covers yet.
 * Idempotent: legacy IDs derive from the configuration, so repeated calls add nothing new.
 */
export function withLegacyProfiles(profiles: readonly SafeProfile[], source: Address, environment: Environment, migrations: readonly Migration[]): SafeProfile[] {
  const linked = new Set(profiles.flatMap((p) => p.runIds));
  const unlinked = migrations.filter((m) => !m.profileId && !linked.has(m.id));
  const known = new Set(profiles.map((p) => p.id));
  const legacy = legacyProfilesFromMigrations(source, environment, unlinked).filter((p) => !known.has(p.id));
  return legacy.length ? [...profiles, ...legacy] : [...profiles];
}
