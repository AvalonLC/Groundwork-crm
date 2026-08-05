import dictionary from "../../docs/dictionary.json" with { type: "json" };

export type VocabularyMode = "simple" | "advanced";

const TERMS: Record<string, string> = dictionary.terms;

/**
 * See docs/spec/DICTIONARY.md / CLAUDE.md UI invariants: two vocabularies,
 * one dataset, per-user toggle. Simple mode is DEFAULT and contains zero
 * accounting words. This function only changes labels — never which numbers
 * are shown, and never called anywhere that would branch on mode to hide or
 * compute a different value.
 */
export function translateTerm(term: string, mode: VocabularyMode): string {
  if (mode === "advanced") return term;
  return TERMS[term] ?? term;
}

export const DEFAULT_VOCABULARY_MODE: VocabularyMode = "simple";
