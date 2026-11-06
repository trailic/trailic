import type { Metadata, Viewport } from "next";
import { Overpass, Overpass_Mono } from "next/font/google";
import { BRAND } from "@/domain/brand";
import "./globals.css";

/** Overpass descends from Highway Gothic, the lettering of road signs: wayfinding is what this product does. */
const sans = Overpass({ variable: "--font-brand-sans", subsets: ["latin"], display: "swap" });
const mono = Overpass_Mono({ variable: "--font-brand-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: { default: BRAND, template: `%s · ${BRAND}` },
  description: "What people do on your sites, with no cookies and no cloud you don’t control.",
  robots: { index: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fcfcfb" },
    { media: "(prefers-color-scheme: dark)", color: "#14110f" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
