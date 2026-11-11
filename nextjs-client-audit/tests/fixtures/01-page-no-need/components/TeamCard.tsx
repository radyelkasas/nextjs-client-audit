export type TeamMember = { name: string; role: string };

export function TeamCard({ member }: { member: TeamMember }) {
  return (
    <article>
      <h3>{member.name}</h3>
      <p>{member.role}</p>
    </article>
  );
}
