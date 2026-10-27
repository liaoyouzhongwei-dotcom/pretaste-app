/** Display-only: internal ids ("24_and_younger") read as words and long decimals are rounded. Stored claims keep the raw text the checker uses. */
export function readable(text: string): string {
  return text
    .replace(/([A-Za-z0-9])_(?=[A-Za-z0-9])/g, "$1 ")
    .replace(/-?\d+\.\d{3,}/g, (n) => String(Math.round(Number(n) * 100) / 100));
}
