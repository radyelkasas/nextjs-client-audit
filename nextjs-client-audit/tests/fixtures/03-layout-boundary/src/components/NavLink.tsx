import Link from "next/link";
import { ChevronIcon } from "./icons";

export function NavLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href}>
      <ChevronIcon /> {label}
    </Link>
  );
}
