export function Stars({ value }: { value: number }) {
  return <span aria-label={`${value} of 5`}>{"★".repeat(value)}{"☆".repeat(5 - value)}</span>;
}
