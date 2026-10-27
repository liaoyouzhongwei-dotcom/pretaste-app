/** Server UTC calendar date. An explicit clock makes prompt dates testable. */
export function currentDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}
