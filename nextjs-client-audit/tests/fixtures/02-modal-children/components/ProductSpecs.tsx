import { marked } from "marked";
import { formatWeight } from "@/lib/units";
import type { Product } from "@/lib/products";

export function ProductSpecs({ product }: { product: Product }) {
  const html = marked.parse(product.specsMarkdown) as string;
  return (
    <section>
      <h2>Specifications</h2>
      <p>Weight: {formatWeight(product.weightGrams)}</p>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </section>
  );
}
