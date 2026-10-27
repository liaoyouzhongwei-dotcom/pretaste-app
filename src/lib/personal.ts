/** Very rough personal-data guard for custom input (emails, phone numbers). */
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.]+/;
const NUMBER_RUN_RE = /\+?\d[\d\s().-]{8,}\d/g;
const DATE_RE = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/;
const ISBN_RE = /^97[89][\d\s-]{10,14}$/;

/** True for an email, or a run of 10+ digits that is not a date or an ISBN. */
export function looksPersonal(text: string): boolean {
  if (EMAIL_RE.test(text)) return true;
  for (const run of text.match(NUMBER_RUN_RE) ?? []) {
    const t = run.trim();
    if (DATE_RE.test(t) || ISBN_RE.test(t)) continue;
    if ((t.match(/\d/g) ?? []).length >= 10) return true;
  }
  return false;
}
