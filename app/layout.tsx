import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://hariuncle.netlify.app"),
  title: "A Harish Co — Document Intelligence",
  description: "Private, page-tracked PDF intelligence and Excel audit exports for A Harish Co.",
  openGraph: {
    title: "A Harish Co — Document Intelligence",
    description: "Every page treated with care.",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "A Harish Co document intelligence" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "A Harish Co — Document Intelligence",
    description: "Every page treated with care.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
