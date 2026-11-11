import { useState } from "react";

export function SearchBox() {
  const [q, setQ] = useState("");
  return <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" />;
}
