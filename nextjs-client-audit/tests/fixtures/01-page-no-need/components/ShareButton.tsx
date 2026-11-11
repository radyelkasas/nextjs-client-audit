"use client";

export function ShareButton({ url }: { url: string }) {
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(url);
      }}
    >
      Copy link
    </button>
  );
}
