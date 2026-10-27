import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Farmstead · Farm management",
  description:
    "Feed formulation and farm operations, grounded in your records.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en-NG">
      <body>{children}</body>
    </html>
  );
}
