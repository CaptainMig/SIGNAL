// The calendar day of a timestamp in the ledger's display time zone (ET).
// One definition, used by the daily tone summary and by scorecard ranking,
// so "a day" means the same thing everywhere.
export const DAY_TIME_ZONE = 'America/New_York';

export function dayOf(iso, timeZone = DAY_TIME_ZONE) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(t));
  const get = (k) => parts.find((p) => p.type === k)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
