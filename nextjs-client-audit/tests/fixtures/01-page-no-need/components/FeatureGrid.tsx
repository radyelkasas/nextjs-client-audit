import { Badge } from "./Badge";

type Feature = { title: string; body: string };

export function FeatureGrid({ items }: { items: Feature[] }) {
  return (
    <ul>
      {items.map((f) => (
        <li key={f.title}>
          <Badge label="new" />
          <h3>{f.title}</h3>
          <p>{f.body}</p>
        </li>
      ))}
    </ul>
  );
}
