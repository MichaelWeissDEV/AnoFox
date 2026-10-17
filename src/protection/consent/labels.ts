/**
 * Classification of consent-dialog button labels (pure).
 *
 * The auto-reject must NEVER click something that grants consent. Therefore:
 *  - a label is "reject" only if it matches an explicit refusal / "only necessary" pattern,
 *  - "accept" wins nothing: labels that are neither clearly reject nor accept are "other" and are never clicked,
 *  - reject patterns are tested first so "Accept only necessary cookies" (a refusal of optional cookies) is a reject.
 */
export type ButtonKind = 'reject' | 'accept' | 'other';

export function normalizeLabel(raw: string): string {
  return raw
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip diacritics
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

const NECESSARY = '(necessary|necessarily|essential|required|functional|noodzakelijk\\w*|essentieel\\w*|notwendig\\w*|erforderlich\\w*|essenziell\\w*|essentiell\\w*|necessaire\\w*|essentiel\\w*|necesari\\w*|esencial\\w*|necessari\\w*|essenzial\\w*|necess\\w*)';

const REJECT: RegExp[] = [
  // explicit refusal
  /\b(reject|decline|deny|refuse|disagree|opt out)\b/,
  /\b(ablehnen|verweigern|widersprechen|nicht zustimmen)\b/,
  /\b(refuser|rejeter|decliner)\b/,
  /\b(rechazar|denegar|no acepto)\b/,
  /\b(rifiuta|rifiutare|rifiuto|nega)\b/,
  /\b(weigeren|afwijzen|alles weigeren)\b/,
  /\b(rejeitar|recusar)\b/,
  /\bodrzuc\w*/,
  /\b(avvisa|avslå|afvis)\b/,
  // "only necessary"
  new RegExp(`\\b(only|just|solely)\\b.*\\b${NECESSARY}\\b`),
  new RegExp(`\\b${NECESSARY}\\b.*\\b(only)\\b`),
  new RegExp(`\\b(nur|ausschliesslich|lediglich)\\b.*\\b${NECESSARY}\\b`),
  new RegExp(`\\b(uniquement|seulement)\\b.*\\b${NECESSARY}\\b`),
  new RegExp(`\\b(solo|solamente|soltanto)\\b.*\\b${NECESSARY}\\b`),
  new RegExp(`\\b(alleen|enkel)\\b.*\\b${NECESSARY}\\b`),
  new RegExp(`\\b(apenas|somente)\\b.*\\b${NECESSARY}\\b`),
  // continue without consenting
  /continue without (accepting|agreeing|consenting)/,
  /without (accepting|agreeing|consenting)/,
  /\b(ohne|sans|sin|senza|zonder)\b.*\b(zustimmung|einwilligung|accepter|aceptar|accettare|accepteren)\b/
];

const ACCEPT: RegExp[] = [
  /\b(accept|agree|allow|consent|got it|i understand|okay|ok|yes|i agree)\b/,
  /\b(akzeptieren|zustimmen|einverstanden|erlauben|annehmen|verstanden|stimme zu)\b/,
  /\b(accepter|j ?'?accepte|autoriser|tout accepter|d accord)\b/,
  /\b(aceptar|permitir|acepto|de acuerdo)\b/,
  /\b(accetta|accetto|consenti|accettare)\b/,
  /\b(accepteren|akkoord|toestaan)\b/,
  /\b(aceitar|permitir|concordo)\b/
];

export function classifyButton(raw: string): ButtonKind {
  const t = normalizeLabel(raw);
  if (!t) return 'other';
  if (REJECT.some((r) => r.test(t))) return 'reject';
  if (ACCEPT.some((r) => r.test(t))) return 'accept';
  return 'other';
}
