'use client'

import type { TeamMember } from "@/components/TeamCard";
import { TeamCard } from "@/components/TeamCard";

const team: TeamMember[] = [
  { name: "Sara", role: "Design" },
  { name: "Omar", role: "Engineering" },
];

export default function AboutPage() {
  return (
    <section>
      <h1>About us</h1>
      <p>We open the window to great products.</p>
      {team.map((m) => (
        <TeamCard key={m.name} member={m} />
      ))}
    </section>
  );
}
