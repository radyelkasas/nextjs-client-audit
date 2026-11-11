"use client";

import { useTheme } from "@/hooks/useTheme";

export function ThemeBadge() {
  const theme = useTheme();
  return <span className="badge">Theme: {theme}</span>;
}
