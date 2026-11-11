# nextjs-client-audit

**A Claude Code Skill that finds every unnecessary `"use client"` in a Next.js App Router project, shows what each one costs, and gives you a safe, concrete fix built from your own code.**

[English](#english) · [العربي](#العربي)

---

## English

### Why

`"use client"` is not a switch that makes an error go away. It is a **boundary**: the file *and everything it imports* is shipped to the browser, downloaded, parsed and hydrated. One directive at the top of a page can quietly turn the whole page tree into client JavaScript.

Ask Claude *"why is my page heavy?"* or *"audit use client"* and this skill:

1. **Finds** every `"use client"` that is a real directive, and ignores the same text in comments, strings and code samples. It also flags directives written *after* the imports, which Next.js silently ignores.
2. **Checks if each one is needed**: React state/effect hooks, Next.js client hooks, event handlers, function props, browser APIs, client-only libraries, client-only custom hooks (it opens the hook's file), `next/dynamic` with `ssr:false`, `createContext`, class components.
3. **Measures the boundary**: it builds the import graph (tsconfig `paths` aliases included) and counts how many modules each boundary drags into the client bundle. This is an *estimate in modules*, clearly labelled, never presented as bytes.
4. **Classifies the fix**:

| Fix | When |
|---|---|
| `REMOVE` | The file uses nothing client-only. Delete the directive. |
| `PUSH_DOWN` | Move `"use client"` to the smallest child that needs it: a child file, an extracted form, a hook moved into the one leaf that uses it, or a small client "shell" for shared state. |
| `CHILDREN_PATTERN` | Keep a thin client wrapper (a Modal) and pass the heavy server content in as `children`. |
| `MOVE_FETCH` | The component is client only to fetch data in `useEffect` / `useQuery`. Make it an async Server Component. |

5. **Writes the report**: a summary, a priority table, Before/After code for the top 3 findings **using your real code**, and how to verify with `next build`.

### Trustworthy by design

- **Read-only.** The audit never edits files. Claude applies a fix only after you say yes, one fix at a time.
- **Honest about uncertainty.** If it cannot be sure, the finding says **Needs manual check** and what would settle it. Examples: an unknown `use*` hook from a package, a third-party component whose package does not declare `"use client"`, an import it could not resolve.
- **Checks third-party packages.** Before it says a shadcn/Radix wrapper can lose its directive, it opens the installed package and confirms the package ships its own `"use client"`.
- **Fixes that actually shrink the bundle.** A child is only suggested for `children` if it does not use the wrapper's state and is not already in the client bundle through another component.
- **Accurate about layouts.** A client layout ships its own imports on every page under it, but pages passed in as `{children}` stay Server Components. The report says exactly that.
- **Risk notes next to the fixes that can change behaviour.** For example: MOVE_FETCH changes when data loads, and a relative `fetch("/api/…")` won't work on the server.

### Install

**Claude Code (recommended)**

```bash
git clone https://github.com/radyelkasas/nextjs-client-audit.git
mkdir -p ~/.claude/skills
cp -R nextjs-client-audit/nextjs-client-audit ~/.claude/skills/
```

Or download `nextjs-client-audit.skill` from [Releases](https://github.com/radyelkasas/nextjs-client-audit/releases) and unzip it into `~/.claude/skills/` (a `.skill` file is a zip):

```bash
unzip nextjs-client-audit.skill -d ~/.claude/skills/
```

For one project only, put the folder in `<your-project>/.claude/skills/` instead.

**Claude.ai**: Settings → Capabilities → Skills → upload `nextjs-client-audit.skill`.

Requires Node.js 18+. No dependencies: it uses the `typescript` (or `@babel/parser`) already installed in your Next.js project, and falls back to a careful regex scan, with a warning, if neither is there.

### Try it

Open your Next.js project in Claude Code and ask:

```
audit use client in this project
```

Or *"why is my dashboard bundle so big?"*, *"check my client components"*, *"review Server vs Client components"*.

You can also run the script directly:

```bash
node ~/.claude/skills/nextjs-client-audit/scripts/audit.js . --format md      # Markdown report
node ~/.claude/skills/nextjs-client-audit/scripts/audit.js . --json audit.json # machine-readable JSON
```

Exit codes: `0` audit ran · `2` not an App Router project · `1` error.

### Config (optional)

Add `.client-audit.json` to your project root to teach it your own libraries:

```json
{
  "clientLibraries": { "@acme/motion": "any", "acme-flags": "hooks" },
  "serverSafeHooks": ["useFeatureFlag"],
  "extraScanDirs": ["src/features"],
  "ignore": ["src/legacy/**"]
}
```

See `references/rules.md` for every rule and the reasoning behind it, and `references/patterns.md` for Before/After examples of each fix.

### What's inside

```
nextjs-client-audit/
├── SKILL.md               instructions Claude follows (when to run, how to verify, how to present)
├── scripts/audit.js       the analyzer (Node.js, zero dependencies, JSON or Markdown output)
├── references/rules.md    Server vs Client rules, with reasoning
├── references/patterns.md Before/After for every fix type
├── tests/fixtures/        3 small Next.js projects + a Pages Router control
└── tests/run-tests.js     runs the audit on every fixture with every available parser
```

### Tests

```bash
node tests/run-tests.js
```

Three fixture projects cover the core cases:
1. A **page** marked `"use client"` for no reason. It is REMOVE, or PUSH_DOWN when a child silently relies on the boundary.
2. A **Modal** that really needs the client, with heavy server content inside. It is CHILDREN_PATTERN, plus a MOVE_FETCH widget.
3. A **layout** importing many components through one boundary. It is High priority PUSH_DOWN (a shell for shared menu state, and `usePathname` moved into `Breadcrumbs`).

They also include traps for false positives (`"use client"` in comments and strings, `settings.window`, `typeof window` in types, `useMemo`, type-only imports, test files) and false negatives (custom client hooks, `next/dynamic` with `ssr:false`, class components, misplaced directives, unknown hooks → manual check). Every check runs with TypeScript, Babel and the regex fallback.

### Limits

- Module counts are estimates. Use `next build` (First Load JS) for real numbers.
- Before/After drafts are built from your code, but complex refactors come back as a **plan** that Claude finishes by reading your files. Claude is told never to fill gaps with placeholders.
- Only static imports are followed. Dynamic `import(variable)` is invisible to any static analysis.

---

## العربي

### ليه الـ Skill دي؟

`"use client"` مش زرار بيخفّي الـ Error وخلاص. دي **Boundary**: الملف وكل حاجة بيعملها `import` بتنزل للمتصفح، وبيتعملها download وparse وhydration. ممكن سطر واحد في أول الصفحة يحوّل الصفحة كلها لـ JavaScript من غير ما تاخد بالك.

اسأل Claude *"ليه الصفحة تقيلة؟"* أو *"audit use client"*، والـ Skill هتعمل الآتي:

1. **تلاقي** كل `"use client"` حقيقية. بتتجاهل نفس الكلام لو جه في comment أو string أو code sample، وبتنبّهك لو الـ directive مكتوبة بعد الـ imports، لأن Next.js بيتجاهلها ساعتها.
2. **تشوف كل واحدة محتاجاها فعلًا ولا لأ**: Hooks زي `useState`/`useEffect`، وhooks الـ Next.js بتاعة الـ client، والـ Event handlers، والـ function props، والـ Browser APIs، والمكتبات اللي شغالة على الـ client بس، والـ custom hooks (بتفتح ملف الـ hook نفسه وتشوفه)، و`next/dynamic` مع `ssr:false`.
3. **تقيس الـ Boundary**: بتبني الـ import graph (بما فيها الـ aliases زي `@/`) وتعدّ كام module كل boundary بتسحبهم للـ client bundle. ده **تقدير بعدد الـ modules** ومكتوب إنه تقدير، مش حجم بالـ bytes.
4. **تحدد نوع الحل**:

| الحل | إمتى |
|---|---|
| `REMOVE` | الملف مش بيستخدم أي حاجة client. شيل الـ directive. |
| `PUSH_DOWN` | انزل بالـ `"use client"` لأصغر حتة محتاجاها: ملف child، أو form تطلّعه لوحده، أو hook تنقله للـ component الوحيد اللي بيستخدمه، أو "shell" صغير شايل الـ state المشتركة. |
| `CHILDREN_PATTERN` | خلي الـ wrapper (زي الـ Modal) Client، وابعتله المحتوى التقيل كـ `children` من الـ Server. |
| `MOVE_FETCH` | الـ component بقى Client عشان بيجيب Data في `useEffect`/`useQuery` بس. خليه async Server Component. |

5. **تكتب التقرير**: ملخص، وجدول أولويات، وBefore/After لأهم 3 مشاكل **من الكود بتاعك نفسه**، وإزاي تتأكد بـ `next build`.

### تقدر تثق فيها

- **Read-only**: مش بتعدّل أي ملف. Claude مش هيطبّق أي حل غير لما تقوله "اه"، وبيطبّق حل واحد في المرة.
- **صريحة لما مش متأكدة**: لو مش متأكدة بتكتب **Needs manual check** وتقولك تتأكد من إيه بالظبط.
- **بتفحص الـ packages**: قبل ما تقولك شيل الـ directive من wrapper بتاع shadcn/Radix، بتفتح الـ package المتسطّب عندك وتتأكد إنه فيه `"use client"` جواه.
- **حلول بتصغّر الـ bundle بجد**: مش بتقترح تبعت component كـ `children` لو بيستخدم الـ state بتاعة الـ wrapper، أو لو هو أصلًا موجود في الـ client bundle عن طريق component تاني.
- **دقيقة في موضوع الـ Layout**: الـ layout اللي عليها `"use client"` بتبعت الـ imports بتاعتها مع كل صفحة تحتها، لكن الصفحات اللي جاية كـ `{children}` بتفضل Server Components.

### التسطيب

**Claude Code**

```bash
git clone https://github.com/radyelkasas/nextjs-client-audit.git
mkdir -p ~/.claude/skills
cp -R nextjs-client-audit/nextjs-client-audit ~/.claude/skills/
```

أو نزّل ملف `nextjs-client-audit.skill` من [Releases](https://github.com/radyelkasas/nextjs-client-audit/releases) وفكّه في `~/.claude/skills/`:

```bash
unzip nextjs-client-audit.skill -d ~/.claude/skills/
```

**Claude.ai**: من Settings → Capabilities → Skills، اعمل upload لملف `nextjs-client-audit.skill`.

محتاج Node.js 18 أو أحدث، ومن غير أي dependencies. بتستخدم الـ `typescript` اللي متسطّب أصلًا في مشروع الـ Next.js بتاعك.

### جرّبها

افتح مشروع الـ Next.js في Claude Code واكتب:

```
audit use client in this project
```

أو *"ليه الـ bundle بتاع الـ dashboard كبير كده؟"*.

---

Made by **Rady Elkasas** · [radyelkasas.com](https://radyelkasas.com) · [@radyelkasas](https://github.com/radyelkasas) · MIT License
