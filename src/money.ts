/** All money is whole US cents, so nothing is lost to floating-point rounding. */

export function assertCents(cents: number): void {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error(`invalid cents: ${cents}`);
}

export function centsToUsd(cents: number): string {
  assertCents(cents);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function usdToCents(value: string): number {
  const match = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) throw new Error(`invalid amount: ${value}`);
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}
