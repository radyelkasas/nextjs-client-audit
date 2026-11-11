---
name: nextjs-client-audit
description: Audit a Next.js App Router project for unnecessary or misplaced "use client" directives, measure how much code each one drags into the browser bundle, and give a concrete, safe fix (REMOVE, PUSH_DOWN, CHILDREN_PATTERN, MOVE_FETCH) with Before/After code from the user's own files. Use this whenever the user says "audit use client", "check my client components", "review Server vs Client components", "why is my page heavy / slow", "my Next.js bundle is big", "First Load JS is too high", "too much JavaScript", "do I need use client here", or opens a Next.js app/ project and asks about performance, bundle size, hydration cost or React Server Components, even if they never say "use client".
---

# nextjs-client-audit

Find every `"use client"` that should not be there (or sits too high in the tree), show what it costs, and hand the developer a fix they can trust. The developer wants a fast, accurate report built from their real code, not a lecture on Server Components.

Why this matters: `"use client"` is not a label for one file. It is a **boundary**. The file and everything it imports gets bundled, shipped and hydrated in the browser. One directive at the top of a page or layout can quietly turn dozens of server-capable modules into client JavaScript. The fix is almost always small, but it has to be placed correctly or the app breaks. That is why this skill leans on a script for the facts and on you for judgment.

## 1. Run the audit (always first)

Find the project root: the folder with `package.json` (listing `next`) and `app/` or `src/app/`. In a monorepo, run once per Next.js app.

```bash
OUT="$(mktemp -d)"   # or your scratchpad folder, if the environment gives you one
node <this-skill>/scripts/audit.js <project-root> --json "$OUT/client-audit.json" --md "$OUT/client-audit.md" > /dev/null
```

- The script is **read-only**. It never edits the project, so you can run it without asking.
- It prefers the TypeScript compiler API (resolved from the project's own `node_modules`, which almost every Next.js + TS project has), then `@babel/parser`, then a regex fallback. Check `parser` in the JSON. If it says `regex-heuristic`, tell the user the results are less precise and that `npm install` in the project gives exact results.
- **Exit code 2** means it is not an App Router project. Show the `message` and stop. There is nothing to audit in a Pages Router app, because Server Components do not exist there.
- Options: `--top N` sets how many Before/After examples to include, and `--config file` points at a custom config. Without `--config`, the script picks up `.client-audit.json` in the project root if it exists. Read `references/rules.md` → "Config" when the user has their own client-only libraries.

## 2. Understand what came back

Read `client-audit.json`. The fields that matter:

| Field | Meaning |
|---|---|
| `summary` | counts: `useClientFiles`, `unnecessary`, `tooBroad`, `needsManualCheck`, `highPriority` |
| `findings[]` | every file that needs a change, already sorted by priority, certainty and impact |
| `findings[].status` | `Unnecessary` (the file itself uses no client code), `Too broad` (needed, but the boundary is too high), `Needs manual check` (inconclusive) |
| `findings[].fix` | `REMOVE`, `PUSH_DOWN`, `CHILDREN_PATTERN`, `MOVE_FETCH` (see `references/patterns.md`) |
| `findings[].why / risks / signals` | the evidence (each signal has a line number) |
| `findings[].estimatedModules` | the file plus the local modules its boundary pulls into the client. **An estimate from the import graph, not bytes** |
| `findings[].draft` | Before/After code built from the real files; `partial: true` + `plans[]` when part of it must be written by hand |
| `files[]` | every `"use client"` file, including `Necessary` and `Required` ones (no change needed) |
| `warnings[]` | misplaced directives, client files nothing imports, unresolved imports, parser fallback |

`Unnecessary` + `PUSH_DOWN` means: this file needs nothing, but a file below it (listed in `fixTargets`) uses hooks/handlers **without its own directive** and only works because of this boundary. Never present that as "just delete the line" — the directive moves down, in the same change. The same rule applies to every PUSH_DOWN: each file in `fixTargets` gets `"use client"`, or the build breaks.

The four fix types, in one line each (details and reasoning in `references/patterns.md`):
- **REMOVE**: the file uses nothing client-only. Delete the directive.
- **PUSH_DOWN**: move `"use client"` to the smallest child that really needs it (or split the interactive part out).
- **CHILDREN_PATTERN**: keep a thin client wrapper and pass the heavy server-rendered content in as `children` (or slot props).
- **MOVE_FETCH**: the component is client only so it can fetch in `useEffect`/`useQuery`. Make it an async Server Component instead.

## 3. Verify before you present

The script is careful, but you are the reviewer. For each finding you will put in the top 3 (and any finding whose `confidence` is not `high`):

1. **Open the file and the files named in `fixTargets` / `draft`.** Confirm the signals are real, and that nothing was missed, such as a hook from a package the script does not know (a `use*` import counts), a `ref` callback, or a context Provider rendered here.
2. **Check the draft against the real code.** The drafts are made from the user's files, but:
   - If `draft.partial` is true, write the missing part yourself from the real file. Use the user's names and JSX, and never use placeholders like `// …your code here`.
   - Make sure every variable used inside moved JSX is defined or passed in. Props crossing from a Server to a Client Component must be serializable: no functions (except Server Actions), no class instances.
   - Keep everything else byte-for-byte the same. A Before/After that also "cleans up" unrelated code destroys trust.
   - Show complete files (or complete components) in After, not fragments: the user should be able to paste them.
   - Watch the DOM: if a wrapper moves an element into a flex/grid container (the SHELL draft says so in its plan), restructure it so the DOM order stays identical. `references/patterns.md` §5 shows how.
   - MOVE_FETCH with a relative URL (`fetch("/api/…")`) is never final: it fails on the server. Find the route handler (the note says whether it exists) and call its data function directly, or ask the user where the data comes from.
3. **Partial drafts:** when `draft.partial` is true and the missing piece is in the code, write it. When it is not in the code at all (e.g. the data behind a relative `/api/...` URL lives in another service), show the Before, a sketch clearly labelled as an assumption, and ask the one question that unblocks it. Never present that as a ready fix.
4. **Respect `Needs manual check`.** Never present it as safe and never show it as a ready Before/After. Say what is uncertain (the `why` lines list it) and the one check that settles it, for example "look inside `node_modules/acme-flags`: does it use React hooks or ship `"use client"`?".
5. If something in the JSON is wrong, say so and correct it in the report. Your reading of the code wins over the heuristic, but explain why.

## 4. Present the report

Use exactly this structure and order. `client-audit.md` is a ready draft in this format. Start from it, apply your corrections from step 3, and answer in the user's language (keep code, file names and tech terms in English).

```
## 1. Summary
- N files start with "use client" · N unnecessary · N High priority  (+ too broad / needs manual check counts)
- One sentence on the biggest win.

## 2. Priority table
| File | Why it is flagged | Priority | Fix type | Estimated modules affected |
(all High and Medium rows; if there are more than ~15 Low rows, summarise them in one line)
Also noticed: misplaced directives, server-only/env leaks, parser fallback (only if any)

## 3. Before / After: top 3 by impact (all of them if there are fewer)
For each: file · fix type · Before (real code) · After (real code) · one line on what it saves · ⚠️ risk if behaviour can change

## 4. How to verify
`next build` before/after and compare First Load JS for the affected routes; click through the changed UI.
```

Presentation rules, and why:
- **Lead with impact, not with counts.** "Your layout ships 13 modules to every page" is what makes someone act.
- **Call module counts estimates** ("≈13 modules"). The real byte numbers come from `next build`, and the user should never catch you overstating.
- **Explain each risk next to its fix.** For example: MOVE_FETCH changes when data loads (and should be wrapped in `<Suspense>` so the page streams), PUSH_DOWN/SHELL can change DOM order, and CHILDREN_PATTERN content renders on the server even while a modal is closed.
- **Say "build error today" when it is one.** A `"use client"` file that exports `metadata`, or a boundary that imports `server-only` code, is broken now. The fix repairs it, so it is a reason to act, not a risk of acting.
- **Admit small gains.** A page fix that only moves a few small modules is still worth doing for structure (metadata, server fetching), but say the bundle gain is small; the audit flags these as `lowGain`.
- **Say a layout's cost accurately.** A `"use client"` layout ships its own imports on every page under it, but pages passed in through `{children}` stay Server Components. Don't claim a layout makes the pages themselves client.
- **Report a clean project as a win.** If there are no findings, say so in two lines.

## 5. Applying fixes (only with explicit confirmation)

Never edit files as part of the audit. After the report, offer: "Want me to apply fix 1?" When the user says yes:
1. Apply **one** finding at a time, exactly as shown in its After.
2. Run the type check or build if available (`npx tsc --noEmit`, `next build`) and report the result honestly.
3. Re-run the audit to confirm the finding is gone, then offer the next one.

If a fix could change behaviour (MOVE_FETCH, SHELL wrappers, removing a prop), say so before editing, not after.

## Reference files
- `references/rules.md`: the Server vs Client rules the audit applies, with the reasoning, edge cases (error.tsx, Server Actions, `next/dynamic` with `ssr:false`, third-party packages) and config. Read it when a finding surprises you or the user asks "why?".
- `references/patterns.md`: Before/After for each fix type, including the SHELL and client-view variants. Read it when you write or polish a draft by hand.
