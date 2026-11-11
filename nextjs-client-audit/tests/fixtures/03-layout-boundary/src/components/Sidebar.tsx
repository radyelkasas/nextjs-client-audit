import { NavLink } from "./NavLink";
import { navItems } from "@/lib/nav";

export function Sidebar({ open }: { open: boolean }) {
  return (
    <nav data-open={open}>
      {navItems.map((item) => (
        <NavLink key={item.href} href={item.href} label={item.label} />
      ))}
    </nav>
  );
}
