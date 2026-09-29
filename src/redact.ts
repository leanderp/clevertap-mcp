/**
 * PII redaction for the bulk export tools (events, profiles by event).
 *
 * Those endpoints return one full profile per record: name, email, phone, identities,
 * push token and an open-ended `profileData` map (buyer_email, user_phone, nombre, foto...).
 * A page of 23 records puts the contact details of 23 customers into the model's context,
 * and from there into transcripts. `profileData` has no fixed schema, so a field allow/deny
 * list alone is not enough: sensitive KEYS are masked at any depth, and every remaining
 * string is scanned for e-mail addresses and phone numbers.
 *
 * Identifiers that are not contact data stay (objectId, numeric identity, order counts, city,
 * dates) so the records remain useful for analysis and for looking a profile up afterwards.
 */

export interface RedactionStats {
  /** Values replaced because of their key (email, phone, name, token...). */
  keys: number;
  /** Fragments replaced inside other strings (an e-mail typed into a survey answer...). */
  values: number;
}

const MASK = "[redacted]";

// Matched against the key lowercased and stripped of accents ("númerotélefono" -> "numerotelefono").
const PII_KEYS: RegExp[] = [
  /e_?mail/,
  /phone/,
  /telefon/,
  /celular/,
  /whatsapp/,
  /movil/,
  /token/,
  /^(name|nombre|apellidos?|firstname|lastname|fullname)$/,
  /(^|_)(first|last|full|user|given|family)_?name$/,
  /foto|photo|avatar|picture/,
  /birth|dob|nacimiento|cumple/,
  /address|direccion|domicilio|lugardeenvio|street|calle/,
  /^badks$/,
  /cedula|passport|pasaporte|documento|^dni$|^rif$|^ssn$|^curp$/,
  /card|tarjeta|iban|cvv/,
  /latitude|longitude|^lat$|^lng$|^lon$|coordinate/,
];

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
// A '+' number with separators, or a bare run of 10-15 digits that is not part of a longer token
// ("$D_1790373205" is a date, not a phone).
const PHONE_PLUS = /\+\d[\d\s().-]{7,16}\d/g;
const PHONE_BARE = /(?<![\w$.])\d{10,15}(?!\w)/g;

function normalise(key: string): string {
  return key.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

export function isPiiKey(key: string): boolean {
  const k = normalise(key);
  return PII_KEYS.some((pattern) => pattern.test(k));
}

/** "is_email_rides_verified": "true" names an e-mail but carries no personal data. */
function isHarmlessFlag(value: unknown): boolean {
  return typeof value === "boolean" || (typeof value === "string" && /^(true|false|yes|no|y|n|si|sí)$/i.test(value));
}

function scrub(text: string, stats: RedactionStats): string {
  let hits = 0;
  const count = (replacement: string) => () => {
    hits += 1;
    return replacement;
  };
  const out = text
    .replace(EMAIL, count("[email]"))
    .replace(PHONE_PLUS, count("[phone]"))
    .replace(PHONE_BARE, count("[phone]"));
  stats.values += hits;
  return out;
}

function walk(value: unknown, stats: RedactionStats): unknown {
  if (typeof value === "string") return scrub(value, stats);
  if (Array.isArray(value)) return value.map((item) => walk(item, stats));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (isPiiKey(key) && !isHarmlessFlag(inner)) {
        out[key] = MASK;
        stats.keys += 1;
      } else {
        out[key] = walk(inner, stats);
      }
    }
    return out;
  }
  return value;
}

/** Returns a redacted copy; the input is not modified. */
export function redactPii<T>(input: T, stats: RedactionStats = { keys: 0, values: 0 }): T {
  return walk(input, stats) as T;
}

export const PII_NOTE =
  "Customer contact data (names, e-mails, phones, identities, push tokens, birth dates, addresses) is redacted. Pass include_pii: true to clevertap_get_events / clevertap_get_profiles_by_event only if you really need it.";

/** CLEVERTAP_REDACT_PII=always makes the server redact even when a caller asks for include_pii. */
export function piiForced(): boolean {
  return process.env.CLEVERTAP_REDACT_PII === "always";
}
