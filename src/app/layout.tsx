import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  icons: { icon: "/pretaste.svg", apple: "/pretaste.svg" },
  title: "Pretaste — Before you make it, get a taste.",
  description: "Challenge your product assumptions with Qloo’s cultural taste data. Compare ideas, explore audience signals, and leave with a clearer next step and traceable evidence.",
  other: { google: "notranslate" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Translation tools can rewrite the server DOM before React hydrates it.
    <html lang="en" translate="no" className="h-full antialiased notranslate">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
