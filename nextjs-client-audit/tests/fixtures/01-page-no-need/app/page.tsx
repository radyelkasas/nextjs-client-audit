// Home page. Someone added the directive below to silence an error once.
"use client";

import { Hero } from "@/components/Hero";
import { FeatureGrid } from "@/components/FeatureGrid";
import NewsletterForm from "@/components/NewsletterForm";
import { PriceTag } from "@/components/PriceTag";

const features = [
  { title: "Fast shipping", body: "Orders leave the warehouse in 24h." },
  { title: "Free returns", body: "Don't like it? Send it back within 30 days." },
];

export default function HomePage() {
  return (
    <main>
      <Hero title="Acme Store" subtitle="Read the document. Then shop." />
      <FeatureGrid items={features} />
      <PriceTag cents={4999} />
      <NewsletterForm />
    </main>
  );
}
