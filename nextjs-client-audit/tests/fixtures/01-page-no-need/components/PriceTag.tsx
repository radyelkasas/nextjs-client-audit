"use client";

import { useMemo } from "react";
import { formatPrice, type PriceSettings } from "@/lib/format";

const settings: PriceSettings = { currency: "USD", window: "none" };

export function PriceTag({ cents }: { cents: number }) {
  const label = useMemo(() => formatPrice(cents, settings), [cents]);
  return <strong className="price">{label}</strong>;
}
