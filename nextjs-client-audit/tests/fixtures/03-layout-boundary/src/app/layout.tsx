"use client";

import { useState } from "react";
import { usePathname } from "next/navigation";
import type { Metadata } from "next";
import { Header } from "@/components/Header";
import { Sidebar } from "@/components/Sidebar";
import { Footer } from "@/components/Footer";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { ThemeBadge } from "@/components/ThemeBadge";
import "./globals.css";

export const metadata: Metadata = { title: "Acme Dashboard" };

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  return (
    <html lang="en">
      <body>
        <Header />
        <button className="menu-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          Menu
        </button>
        <div className="shell">
          <Sidebar open={menuOpen} />
          <main>
            <Breadcrumbs path={pathname} />
            {children}
          </main>
        </div>
        <ThemeBadge />
        <Footer />
      </body>
    </html>
  );
}
