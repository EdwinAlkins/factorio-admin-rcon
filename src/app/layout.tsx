import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Factorio — Panneau d'admin",
  description: "Console RCON pour le serveur Factorio headless",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
