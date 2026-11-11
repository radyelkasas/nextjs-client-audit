"use client";

import { useEffect, useState } from "react";

type Item = { id: string; name: string };

export default function RelatedProducts({ category }: { category: string }) {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    fetch(`/api/related?category=${category}`)
      .then((r) => r.json())
      .then(setItems);
  }, [category]);

  return (
    <aside>
      <h2>Related</h2>
      <ul>
        {items.map((i) => (
          <li key={i.id}>{i.name}</li>
        ))}
      </ul>
    </aside>
  );
}
