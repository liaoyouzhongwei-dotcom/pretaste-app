import type { ReactNode } from "react";

export function TasteMark() {
  return <svg viewBox="0 0 36 36" fill="none" aria-hidden="true"><path d="m18 2 3.5 9.5 9.1-4.4-4.4 9.1 9.5 3.5-9.9 2 3 9.7-8.4-5.7-5 8.8-1-10-10.1 1.6 6.5-7.8-8-6.2 10.1.5L18 2Z" fill="currentColor"/><circle cx="18" cy="18" r="5" fill="var(--background, #f7f5ee)"/></svg>;
}
export function Icon({ name }: { name: "arrow" | "check" | "spark" | "chart" | "book" | "layers" | "close" | "download" | "chevron" | "clock" }) {
  const paths: Record<typeof name, ReactNode> = {
    arrow: <path d="M4 12h15M13 5l7 7-7 7" />, check: <path d="m5 12 4 4L19 6" />,
    spark: <path d="m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7L12 3Z" />,
    chart: <path d="M4 4v16h17M8 15l4-5 4 2 4-7" />,
    book: <><path d="M12 5v15M12 5C8 2 4 3 2 4v15c4-2 7-1 10 1 3-2 6-3 10-1V4c-2-1-6-2-10 1Z" /><path d="M6 8h2m8 0h2M6 12h2m8 0h2" /></>,
    layers: <><rect x="6" y="3" width="14" height="17" rx="2" /><path d="M6 7H3v14h13v-1M10 8h6m-6 4h6m-6 4h3" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    download: <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />,
    chevron: <path d="m6 9 6 6 6-6" />,
    clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
