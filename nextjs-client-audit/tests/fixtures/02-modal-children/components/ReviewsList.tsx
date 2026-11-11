import { Stars } from "./Stars";
import { timeAgo } from "@/lib/dates";

const reviews = [
  { id: 1, author: "Mona", rating: 5, at: "2026-10-01", text: "Great quality." },
  { id: 2, author: "Karim", rating: 4, at: "2026-10-20", text: "Good value." },
];

export function ReviewsList({ productId }: { productId: string }) {
  return (
    <ul data-product={productId}>
      {reviews.map((r) => (
        <li key={r.id}>
          <Stars value={r.rating} /> <b>{r.author}</b> · {timeAgo(r.at)}
          <p>{r.text}</p>
        </li>
      ))}
    </ul>
  );
}
