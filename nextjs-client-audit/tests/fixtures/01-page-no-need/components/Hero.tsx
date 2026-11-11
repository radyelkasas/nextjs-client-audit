// Note: "use client" is NOT needed here — this is a Server Component.
export function Hero({ title, subtitle }: { title: string; subtitle: string }) {
  const tip = "Add 'use client' only where you need state.";
  return (
    <header>
      <h1>{title}</h1>
      <p>{subtitle}</p>
      <code>{'"use client"'}</code>
      <small>{tip}</small>
    </header>
  );
}
