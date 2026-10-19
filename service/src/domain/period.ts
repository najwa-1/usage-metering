// Billing periods are UTC calendar months, stored as the first day of the month.
export function periodStart(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}-01`;
}

export function periodLabel(period: string): string {
  return period.slice(0, 7);
}

export function parseMonth(input: string): string | null {
  const match = /^(\d{4})-(\d{2})$/.exec(input);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${match[2]}-01`;
}
