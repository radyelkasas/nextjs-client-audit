# Server vs Client Components: the rules this audit applies

Each rule says **what** the audit does and **why**, so you can defend or overrule a finding.

## Contents
1. What "use client" actually does
2. When a file truly needs "use client"
3. Things that look client-only but are not
4. Files that must be client (never flag)
5. Directive placement
6. The import graph and "estimated modules"
7. Priority
8. Uncertainty → "Needs manual check"
9. Third-party packages
10. Config (`.client-audit.json`)

---

## 1. What "use client" actually does

In the App Router every component is a Server Component by default. `"use client"` marks a **module boundary**: that file, *and every module it imports that is not already its own boundary*, is bundled for the browser, downloaded, parsed and hydrated.

- **Why it matters:** one directive at the top of a page pulls the page's whole import tree into the client bundle. The cost shows up as First Load JS, slower hydration and more work on low-end phones.
- **What does NOT cross the boundary:** components passed in as **props or `children`** from a Server Component. They are rendered on the server first and arrive as finished output. That is the whole idea behind CHILDREN_PATTERN, and it is also why a `"use client"` **layout** does not turn its pages into client code (Next.js passes pages to layouts as `children`).

## 2. When a file truly needs "use client"

A file needs the directive if it uses **any** of the following. Each is a "strong signal" with a line number.

| Signal | Examples | Why it needs the browser |
|---|---|---|
| React state/effect hooks | `useState`, `useEffect`, `useReducer`, `useRef`, `useLayoutEffect`, `useContext`, `useTransition`, `useOptimistic`, `useActionState`, `useSyncExternalStore`, `useInsertionEffect`, `useImperativeHandle`, `useDeferredValue`, `useFormStatus` | They hold or react to state that lives in the browser; Server Components render once and have no state. |
| Next.js client hooks | `useRouter`, `usePathname`, `useSearchParams`, `useParams`, `useSelectedLayoutSegment(s)`, only when imported from `next/navigation` / `next/router` | They read the live browser URL. (A Server Component gets `params`/`searchParams` as props instead.) |
| Event handlers | `onClick`, `onChange`, `onSubmit`, any `on[A-Z]*` prop | Handlers are functions, and functions cannot be serialized from server to browser. |
| Inline function props | `render={() => …}`, `formatter={fn}` on any element | Same reason: a Server Component cannot pass a function to a Client Component. **Exception:** an inline Server Action (`async () => { "use server"; … }`) is allowed. |
| Browser APIs | `window`, `document`, `localStorage`, `sessionStorage`, `navigator`, `IntersectionObserver`, `ResizeObserver`, `MutationObserver`, `matchMedia`, `requestAnimationFrame` | They do not exist on the server. Property names (`settings.window`) and type positions (`typeof window` in a type) are ignored. |
| `createContext`, class components | `createContext()`, `class X extends React.Component` | Context and class lifecycles are client-only features. |
| `next/dynamic` with `{ ssr: false }` | `dynamic(() => import("./Map"), { ssr: false })` | Next.js only allows `ssr: false` inside Client Components. |
| Client-only libraries | `framer-motion`, `react-hook-form`, `zustand`, `@tanstack/react-query` hooks, `swr`, `next-auth/react`, `recharts`… | They use hooks or browser APIs internally. Mode `any` = any import counts; mode `hooks` = only `use*` imports count (e.g. `QueryClient` itself is fine on the server). |
| Custom hooks that are client-only | `useTheme()` from `@/hooks/useTheme` | The audit opens the hook's file (depth 2 by default) and checks it with the same rules. A custom hook is only client-only if its file is. |

If none apply, the file is **Unnecessary**.

## 3. Things that look client-only but are not

- `useMemo`, `useCallback`, `useId`, `use`, `useDebugValue`, `cache`, `forwardRef`, `memo`: React exports these to Server Components too.
- Rendering a Client Component: a Server Component may render `<ShareButton />` even though ShareButton is `"use client"`. **Rendering a client component is not a reason to be client.**
- Importing **types**: `import type { X }` and `import { type X }` are erased at build time and pull nothing into the bundle.
- `"use client"` written in a string, a comment or a code sample: only a real directive in the prologue counts (see §5).
- `<Link>`, `<Image>`, `<Script>` from `next/*`: these are fine in Server Components.

## 4. Files that must be client (never flagged)

- `error.tsx` and `global-error.tsx` must be Client Components (they are React error boundaries). The audit marks them **Required**.
- Files that genuinely need the browser and sit as low as they can go are marked **Necessary** and not reported.

## 5. Directive placement

A directive only counts if it is in the file's **prologue**: before any import or code. Comments, a BOM, a shebang and `"use strict"` may come first. `'use client'` and `"use client"`, with or without a semicolon, both count.

- **Why:** this is how the bundler reads it. A `"use client"` written after the imports is silently ignored. The audit reports it as **misplaced**, because that is almost always a bug: someone thinks the file is client and it is not.

## 6. The import graph and "estimated modules"

The audit resolves `import`, `export … from`, `import()` and `require()`, including `tsconfig`/`jsconfig` `paths` aliases (`@/…`), `baseUrl`, `index` files and `.js → .ts` ESM-style specifiers. Type-only imports and asset imports (CSS, images, JSON) are skipped.

For every `"use client"` file it walks the graph and counts **local modules that become client code only because of this boundary**. It stops at modules that already have their own `"use client"` (they are client anyway) and at `"use server"` files (Server Actions are references, not code). It also lists npm packages reached, ignoring `react`, `react-dom` and `next`.

- **It is an estimate.** It counts modules, not bytes. A 3-line util and a 900-line chart both count as 1. Always say "≈N modules" and point to `next build` for real numbers.
- **"Relies on this boundary":** a module *without* its own directive that uses hooks or handlers only works today because a parent's `"use client"` covers it. Removing the parent's directive would break it, so the audit turns REMOVE into PUSH_DOWN and names those files.

## 7. Priority

| Priority | When | Why |
|---|---|---|
| **High** | the file is a `page`, `layout`, `template` or `default`; or ≥ 10 estimated modules (configurable) | A client page ships the whole page tree. A client layout ships its shell on every page under it. These are the biggest wins. |
| **Medium** | ≥ 3 modules, or a CHILDREN_PATTERN that moves npm packages out of the bundle | Real, local savings. |
| **Low** | the rest | Tidy-up, or a UX win more than a bundle win (a small MOVE_FETCH); e.g. a `"use client"` on a hooks-only module has no bundle effect. |

Within a priority, certain findings come before "Needs manual check", real bundle wins come before "low gain" structural refactors (the client-view pattern), and bigger estimates come first.

## 8. Uncertainty → "Needs manual check"

The audit never calls a change safe when it is not sure. A file with no certain client signal becomes **Needs manual check** (confidence `low`) when any of these is true:
- a `use*` hook from a package the audit does not know (it may or may not work on the server);
- a third-party component whose package does not ship `"use client"` (see §9);
- a local import it could not resolve (missing file, unknown alias);
- a file it could not parse completely;
- something it imports is itself uncertain.

In the report, say what is uncertain and the one check that settles it.

## 9. Third-party packages

Rendering a third-party component from a Server Component is fine **if that package marks itself `"use client"`** (Radix and most modern UI kits do). For every package component a candidate file renders, the audit opens the installed package (entry file, then its component files) and looks for the directive:
- found → noted in `why` ("ships its own "use client""), so removing the wrapper's directive is safe;
- not found → **Needs manual check**: if it uses hooks inside, it only works in a Client Component;
- not installed → **Needs manual check** (run `npm install` and re-audit).

Icon sets and similar pure packages (`lucide-react`, `react-icons`, `@heroicons/react`…) are on a server-safe list.

## 10. Config (`.client-audit.json` in the project root, or `--config`)

Arrays are **added** to the defaults; objects are merged.

```json
{
  "clientLibraries": { "@acme/ui-motion": "any", "acme-flags": "hooks" },
  "serverSafeHooks": ["useFeatureFlag"],
  "serverSafePackages": ["@acme/icons"],
  "extraScanDirs": ["src/features"],
  "ignore": ["src/legacy/**"],
  "highImpactModules": 10,
  "mediumImpactModules": 3,
  "childrenPatternMinModules": 2
}
```

Scanned by default: `app/`, `src/app/`, `components/`, `src/components/`, plus anything they import. Ignored: `node_modules`, `.next`, `dist`, `build`, `out`, `coverage`, test/spec/stories files, and `__tests__`, `__mocks__`, `e2e`, `cypress`, `playwright` folders.
