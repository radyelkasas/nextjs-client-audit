import { Logo } from "./Logo";
import { UserMenu } from "./UserMenu";
import { SearchBox } from "./SearchBox";

export function Header() {
  return (
    <header>
      <Logo />
      <SearchBox />
      <UserMenu name="Rady" />
    </header>
  );
}
