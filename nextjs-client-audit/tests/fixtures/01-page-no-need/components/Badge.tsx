import { cx } from "@/lib/cx";

"use client";

export function Badge({ label }: { label: string }) {
  return <span className={cx("badge", label)}>{label}</span>;
}
