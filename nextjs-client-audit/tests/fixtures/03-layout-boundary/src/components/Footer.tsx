import { getBuildInfo } from "@/lib/stats";
import { LocaleSwitch } from "./LocaleSwitch";

export function Footer() {
  const info = getBuildInfo();
  return (
    <footer>
      <small>Build {info.sha}</small>
      <LocaleSwitch />
    </footer>
  );
}
