import "server-only";

export type Product = { id: string; name: string; category: string; specsMarkdown: string; weightGrams: number };

export async function getProduct(id: string): Promise<Product> {
  const res = await fetch(`https://api.example.com/products/${id}`, {
    headers: { Authorization: `Bearer ${process.env.SHOP_API_KEY}` },
  });
  return res.json();
}
