"use client";

import { useState } from "react";
import type { Product } from "@/lib/products";
import { ProductSpecs } from "./ProductSpecs";
import { ReviewsList } from "./ReviewsList";

export default function ProductModal({ product }: { product: Product }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button onClick={() => setOpen(true)}>View details</button>
      {open && (
        <div role="dialog" className="modal">
          <button onClick={() => setOpen(false)} aria-label="Close">×</button>
          <ProductSpecs product={product} />
          <ReviewsList productId={product.id} />
        </div>
      )}
    </>
  );
}
