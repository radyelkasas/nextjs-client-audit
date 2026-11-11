export type BrowserWindow = typeof window;
export type PriceSettings = { currency: string; window: string };

export function formatPrice(cents: number, settings: PriceSettings) {
  // settings.window is just a config field, not the browser window
  const mode = settings.window;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: settings.currency }).format(cents / 100) + (mode === "none" ? "" : "*");
}
