import { getProduct } from "@/lib/products";
import ProductModal from "@/components/ProductModal";
import { AddToCart } from "@/components/AddToCart";
import RelatedProducts from "@/components/RelatedProducts";

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = await getProduct(id);
  return (
    <main>
      <h1>{product.name}</h1>
      <ProductModal product={product} />
      <AddToCart productId={product.id} />
      <RelatedProducts category={product.category} />
    </main>
  );
}
