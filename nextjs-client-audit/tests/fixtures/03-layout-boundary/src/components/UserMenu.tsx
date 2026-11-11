import { Avatar } from "./icons";
import { initials } from "@/lib/format";

export function UserMenu({ name }: { name: string }) {
  return (
    <div className="user">
      <Avatar />
      <span>{initials(name)}</span>
    </div>
  );
}
