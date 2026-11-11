import { titleCase } from "@/lib/format";

export function Breadcrumbs({ path }: { path: string }) {
  const parts = path.split("/").filter(Boolean);
  return <p className="crumbs">{parts.map(titleCase).join(" / ")}</p>;
}
