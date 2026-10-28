import type { Address } from "viem";
import type { AssessmentDraft } from "@/lib/domain/destination";
import type { KeyValueStore } from "./persistence";

const PREFIX = "safe-migrator:v1:assessment";

export function assessmentDraftKey(source: Address): string {
  return `${PREFIX}:${source.toLowerCase()}`;
}

export function loadAssessmentDraft(store: KeyValueStore, source: Address): AssessmentDraft | null {
  try {
    const raw = store.getItem(assessmentDraftKey(source));
    return raw ? (JSON.parse(raw) as AssessmentDraft) : null;
  } catch {
    return null;
  }
}

export function saveAssessmentDraft(store: KeyValueStore, draft: AssessmentDraft): void {
  store.setItem(assessmentDraftKey(draft.source), JSON.stringify(draft));
}

export function clearAssessmentDraft(store: KeyValueStore, source: Address): void {
  store.removeItem(assessmentDraftKey(source));
}
