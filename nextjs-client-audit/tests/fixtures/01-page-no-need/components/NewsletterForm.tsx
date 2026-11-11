import { useState } from "react";

export default function NewsletterForm() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);

  if (sent) return <p>Thanks! Check your inbox.</p>;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSent(true);
      }}
    >
      <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" />
      <button type="submit">Subscribe</button>
    </form>
  );
}
