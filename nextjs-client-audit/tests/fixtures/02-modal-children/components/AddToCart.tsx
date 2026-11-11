"use client";

import { useTransition } from "react";
import { addToCart } from "@/lib/actions";

export function AddToCart({ productId }: { productId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <button disabled={pending} onClick={() => startTransition(() => addToCart(productId))}>
      {pending ? "Adding…" : "Add to cart"}
    </button>
  );
}
