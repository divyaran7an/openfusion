import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "OpenFusion",
  description: "Single-page local studio for OpenFusion. Compose your own compound model API."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
