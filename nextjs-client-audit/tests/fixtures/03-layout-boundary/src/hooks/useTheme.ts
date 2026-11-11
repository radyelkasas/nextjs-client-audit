import { useSyncExternalStore } from "react";

const read = () => localStorage.getItem("theme") ?? "light";

export function useTheme() {
  return useSyncExternalStore((cb) => {
    window.addEventListener("storage", cb);
    return () => window.removeEventListener("storage", cb);
  }, read, () => "light");
}
