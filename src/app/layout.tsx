import type { Metadata } from "next";
import { Figtree, Fira_Code } from "next/font/google";
import "./globals.css";

const sans = Figtree({ subsets: ["latin"], variable: "--font-figtree", display: "swap" });
const mono = Fira_Code({ subsets: ["latin"], variable: "--font-fira", display: "swap" });

export const metadata: Metadata = {
  icons: { icon: "/pretaste.svg", apple: "/pretaste.svg" },
  title: "Pretaste — Test your AI's audience guess against Qloo taste data",
  description: "Pretaste asks an LLM who your product idea is for, then checks each guess against Qloo's cultural taste data. See which guesses hold, rank your ideas, and keep the recorded evidence.",
  other: { google: "notranslate" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // Translation tools can rewrite the server DOM before React hydrates it.
    <html lang="en" translate="no" className={`h-full antialiased notranslate ${sans.variable} ${mono.variable}`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
