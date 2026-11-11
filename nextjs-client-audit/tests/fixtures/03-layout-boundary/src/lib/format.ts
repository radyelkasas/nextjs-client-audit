export const formatNumber = (n: number) => new Intl.NumberFormat("en-US").format(n);
export const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
export const initials = (name: string) => name.split(" ").map((p) => p[0]).join("");
