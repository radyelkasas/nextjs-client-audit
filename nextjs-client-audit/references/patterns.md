# Fix patterns: Before / After

Each pattern says when it applies, what changes, what it saves, and the risk. Use the user's real code when you write these; the examples below only show the shape.

## Contents
1. REMOVE
2. PUSH_DOWN: move the directive to the child that needs it
3. PUSH_DOWN: extract the interactive element
4. PUSH_DOWN: move a hook into the only child that uses it
5. PUSH_DOWN: client "shell" for shared state
6. PUSH_DOWN: client view (heavily interactive pages)
7. CHILDREN_PATTERN
8. MOVE_FETCH

---

## 1. REMOVE

**When:** no hooks, handlers, browser APIs or client-only libraries, and nothing below it relies on its boundary.

```tsx
// Before: app/about/page.tsx
"use client";
import { TeamCard } from "@/components/TeamCard";
export default function AboutPage() { return <TeamCard member={sara} />; }

// After
import { TeamCard } from "@/components/TeamCard";
export default function AboutPage() { return <TeamCard member={sara} />; }
```

**Saves:** the file and its whole import tree leave the client bundle. Also allows `export const metadata`.
**Risk:** none when the analysis is certain. Client Components it renders keep working, because they have their own directive.

## 2. PUSH_DOWN: move the directive to the child that needs it

**When:** the file itself needs nothing, but a child without its own directive uses hooks or handlers and only works because of the parent's boundary.

```tsx
// Before
// app/page.tsx
"use client";
import NewsletterForm from "@/components/NewsletterForm";
// components/NewsletterForm.tsx  (no directive, uses useState + onSubmit)

// After
// app/page.tsx: directive removed
import NewsletterForm from "@/components/NewsletterForm";
// components/NewsletterForm.tsx
"use client";
import { useState } from "react";
```

**Risk:** forgetting a child breaks the build ("useState only works in Client Components"). The audit lists every child that needs the directive (`fixTargets`).

## 3. PUSH_DOWN: extract the interactive element

**When:** a page or layout uses hooks, but they are all used inside **one** small element (a form, a button group) that contains no server components.

```tsx
// Before: app/settings/page.tsx
"use client";
import { useForm } from "react-hook-form";
export default function SettingsPage() {
  const { register, handleSubmit } = useForm<Values>();
  return (<section><SettingsIntro /><form onSubmit={handleSubmit(save)}>…</form></section>);
}

// After: app/settings/page.tsx (Server Component)
import { SettingsForm } from "@/components/SettingsForm";
export default function SettingsPage() {
  return (<section><SettingsIntro /><SettingsForm /></section>);
}
// components/SettingsForm.tsx
"use client";
import { useForm } from "react-hook-form";
export function SettingsForm() {
  const { register, handleSubmit } = useForm<Values>();
  return <form onSubmit={handleSubmit(save)}>…</form>;
}
```

**Rules for the extracted component:** copy the hook lines, the element, the imports it uses and the types it uses. Plain values from the parent (props, constants) become props. If the element uses a **function** or a value **derived from client state** that lives in the parent, it cannot be passed as a prop: move it into the new component too. The audit turns that case into a plan instead of guessing.

## 4. PUSH_DOWN: move a hook into the only child that uses it

**When:** a hook result only feeds one prop of one server-capable child: `<Breadcrumbs path={pathname} />`.

```tsx
// Before: layout.tsx
const pathname = usePathname();
<Breadcrumbs path={pathname} />

// After: layout.tsx (no hook, no directive)
<Breadcrumbs />
// components/Breadcrumbs.tsx
"use client";
import { usePathname } from "next/navigation";
export function Breadcrumbs() {
  const path = usePathname();
  …
}
```

**Why it is better:** a tiny leaf becomes client instead of the whole layout.

## 5. PUSH_DOWN: client "shell" for shared state

**When:** state is shared by a DOM control (a toggle button) and a server-capable component that only receives it as a plain prop (`<Sidebar open={menuOpen} />`).

**Prefer the DOM-preserving form.** Let the shell render the *same container elements* the layout had, and take every server part as a slot prop or `children`. Then nothing moves in the DOM, CSS keeps working, and only the state + control ship as JS.

```tsx
// Before: layout.tsx ("use client" for one toggle)
<button className="menu-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>Menu</button>
<div className="shell">
  <Sidebar open={menuOpen} />
  <main><Breadcrumbs />{children}</main>
</div>

// After: layout.tsx (Server Component)
<SidebarShell sidebar={<Sidebar />}>
  <main><Breadcrumbs />{children}</main>
</SidebarShell>

// components/SidebarShell.tsx
"use client";
import { useState } from "react";
export function SidebarShell({ sidebar, children }: { sidebar: React.ReactNode; children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <>
      <button className="menu-toggle" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>Menu</button>
      <div className="shell" data-open={menuOpen}>
        {sidebar}
        {children}
      </div>
    </>
  );
}

// components/Sidebar.tsx: the `open` prop is removed (type + uses); style it with `.shell[data-open="true"] nav { … }`
```

The script's automatic draft uses the simpler form (`<SidebarShell><Sidebar /></SidebarShell>` with the button inside the shell) and lists the DOM-order change and the prop removal as a plan. Turn it into the form above whenever the control and the component do not sit next to each other in the same container.

**Risk (always state it):** the child no longer receives the prop, so any styling that depended on it moves to the wrapper's data attribute.

## 6. PUSH_DOWN: client view (heavily interactive pages)

**When:** the page or layout is interactive almost everywhere (many hooks, most JSX touches them). Splitting would save little.

```tsx
// After: app/credits/page.tsx (Server Component)
import { CreditsView } from "./CreditsView";
export const metadata = { title: "Credits" };
export default function CreditsPage() { return <CreditsView />; }

// app/credits/CreditsView.tsx: the old page, unchanged, still "use client"
```

**Be honest about the gain:** JavaScript barely changes. The win is structural: metadata, `params`/`searchParams` and server data fetching become available, and new static sections default to Server Components. The audit marks these "low gain" and ranks them after real bundle wins.

## 7. CHILDREN_PATTERN

**When:** the component really needs the client (a Modal with open/close state), but it renders server-capable content that would otherwise be dragged into the bundle. The content must (a) not use the wrapper's state, handlers or loop variables, and (b) not already be in the client bundle via another Client Component. Otherwise moving it saves nothing.

```tsx
// Before: components/ProductModal.tsx
"use client";
import { ProductSpecs } from "./ProductSpecs";   // pulls in marked + lib/units
export default function ProductModal({ product }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>View details</button>
    {open && <div role="dialog"><ProductSpecs product={product} /></div>}
  </>);
}

// After: components/ProductModal.tsx
"use client";
export default function ProductModal({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (<>
    <button onClick={() => setOpen(true)}>View details</button>
    {open && <div role="dialog">{children}</div>}
  </>);
}
// app/products/[id]/page.tsx (Server Component)
<ProductModal>
  <ProductSpecs product={product} />
</ProductModal>
```

When the pieces are not next to each other, use named slot props (`specs={<ProductSpecs … />}`) instead of `children`. A layout whose only client need is a context Provider uses the same idea: a small `"use client"` `Providers` component that renders `{children}`.

**Note:** the children are rendered on the server even when the modal is closed. That is usually fine; for very expensive content, consider `<Suspense>` or loading it on open.

## 8. MOVE_FETCH

**When:** the only client work is fetching: `useState` + `fetch` in `useEffect`, or `useQuery`/`useSWR` with no other interactivity.

```tsx
// Before
"use client";
export default function RelatedProducts({ category }) {
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => { fetch(`/api/related?category=${category}`).then(r => r.json()).then(setItems); }, [category]);
  return <ul>{items.map(i => <li key={i.id}>{i.name}</li>)}</ul>;
}

// After
export default async function RelatedProducts({ category }) {
  const items: Item[] = await getRelatedProducts(category);   // the function behind /api/related
  return <ul>{items.map(i => <li key={i.id}>{i.name}</li>)}</ul>;
}
```

**Saves:** little JavaScript (React is in the bundle anyway). The real gains are UX and SEO: no loading flash, no client request waterfall, and the data is in the first HTML.
**Risks (always state them):**
- Data now loads per request or at build time. Keep it client-side if it depends on browser-only state, polls, or must refresh without navigation.
- `fetch("/api/...")` with a **relative URL does not work on the server**, and calling your own API route from a Server Component is an extra hop. Call the data function directly.
- Choose caching deliberately (`{ next: { revalidate: N } }` or `{ cache: "no-store" }`).
- Wrap the component in `<Suspense fallback={…}>` where it is rendered. Otherwise the page waits for this fetch (often after another one) before sending anything.
- With TanStack Query you can also prefetch on the server and hydrate (`HydrationBoundary`) instead of dropping the library.
