// Which business day does this moment belong to -- distinct from a plain
// calendar day: a shift opened at 5am and still running at 2:30am the
// NEXT calendar day keeps every order on the SAME business date (the day
// it opened), rather than an order placed after midnight silently
// rolling onto tomorrow's ledger. Reuses Location.autoCloseCutoffHour as
// the single "day boundary hour" (the same concept ShiftAutoCloseService
// already applies to a forgotten-open shift) instead of adding a second,
// easily-inconsistent cutoff setting.
//
// Works in UTC throughout -- the same simplification autoCloseCutoffHour's
// own cron comparison already makes. A real per-location timezone would
// need a new field and its own conversion layer; not implemented here.
//
// Fiscal year-end exception: when `now`'s hour is before the cutoff, the
// naive answer is "yesterday" -- UNLESS that rolled-back date is exactly
// this location's configured fiscal year-end (month + day), in which case
// the roll-back is suspended and the real calendar date of `now` is used
// instead. This stops the first few hours of a new fiscal year from being
// silently folded into the old year's last business day.
export function computeBusinessDate(
  now: Date,
  cutoffHour: number,
  fiscalYearEndMonth?: number | null,
  fiscalYearEndDay?: number | null,
): Date {
  const utcMidnight = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  if (now.getUTCHours() < cutoffHour) {
    const rolledBack = utcMidnight(new Date(now.getTime() - 24 * 60 * 60 * 1000));
    const isFiscalYearEnd =
      fiscalYearEndMonth != null &&
      fiscalYearEndDay != null &&
      rolledBack.getUTCMonth() + 1 === fiscalYearEndMonth &&
      rolledBack.getUTCDate() === fiscalYearEndDay;
    if (!isFiscalYearEnd) return rolledBack;
  }
  return utcMidnight(now);
}
