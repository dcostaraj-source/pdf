import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://hariuncle.netlify.app"),
  title: "Harish Acharya & Co — Document Intelligence",
  description: "Private, page-tracked PDF intelligence for Harish Acharya & Co.",
  openGraph: {
    title: "Harish Acharya & Co — Document Intelligence",
    description: "Every page treated with care.",
    images: [{ url: "/og.png", width: 1536, height: 1024, alt: "Harish Acharya & Co document intelligence" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Harish Acharya & Co — Document Intelligence",
    description: "Every page treated with care.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body suppressHydrationWarning>{children}</body></html>;
}
