#!/usr/bin/env node
/*
 * nextjs-client-audit · audit.js
 *
 * Read-only audit of "use client" directives in a Next.js App Router project.
 * For every file that starts with "use client" it answers three questions:
 *   1. Does this file actually need to run in the browser?           (necessity signals)
 *   2. How much code does this boundary drag into the client bundle?  (import graph, an ESTIMATE in modules)
 *   3. What is the safest concrete fix?                               (REMOVE · PUSH_DOWN · CHILDREN_PATTERN · MOVE_FETCH)
 *
 * It never writes to the audited project. Output: JSON (default) or a Markdown report draft.
 *
 * Parsers, in order of preference (resolved from the audited project first, then from this script):
 *   typescript (compiler API)  →  @babel/parser  →  built-in regex heuristic (says so in the output)
 *
 * Usage:
 *   node audit.js [projectRoot] [--format json|md] [--json out.json] [--md out.md]
 *                 [--parser auto|typescript|babel|regex] [--config file] [--top 3] [--hook-depth 2]
 * Exit codes: 0 = audit ran · 2 = not an App Router project · 1 = error
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

const VERSION = '1.0.0';

// ------------------------------------------------------------------------------------------ constants
const CODE_EXT = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.cjs'];
const ASSET_EXT = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|ico|json|md|mdx|txt|woff2?|ttf|otf|mp4|webm|mp3|wav)$/i;
const IGNORE_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'out', 'coverage', '.git', '.turbo', '.vercel', '.cache', 'storybook-static']);
const TEST_DIRS = new Set(['__tests__', '__mocks__', '__fixtures__', 'e2e', 'cypress', 'playwright']);
const TEST_FILE = /(\.(test|spec|stories|cy|e2e)\.[cm]?[jt]sx?$)|(\.d\.ts$)/;
const SCAN_DIRS = ['app', 'src/app', 'components', 'src/components'];

// Next.js route segment files. error/global-error MUST be Client Components (Next.js requirement).
const ROUTE_FILES = new Set(['page', 'layout', 'template', 'default', 'not-found', 'loading', 'error', 'global-error', 'global-not-found', 'forbidden', 'unauthorized']);
const BROAD_ROUTE = new Set(['page', 'layout', 'template', 'default']);
const REQUIRED_CLIENT_ROUTE = new Set(['error', 'global-error']);
const NEXT_CLIENT_SOURCES = new Set(['next/navigation', 'next/router', 'next/web-vitals', 'next/link', 'next/form']);
// Bundled by Next.js anyway; never counted as "extra npm packages pulled into the client".
const FRAMEWORK_PKGS = new Set(['react', 'react-dom', 'next', 'server-only', 'client-only']);

const DEFAULT_CONFIG = {
  // React hooks that only work in Client Components. (useMemo, useCallback, useId, use are server-safe.)
  clientHooks: ['useState', 'useEffect', 'useReducer', 'useRef', 'useLayoutEffect', 'useContext', 'useTransition',
    'useOptimistic', 'useActionState', 'useSyncExternalStore', 'useInsertionEffect', 'useImperativeHandle',
    'useDeferredValue', 'useEffectEvent', 'useFormStatus', 'useFormState'],
  // Only counted when imported from next/navigation, next/router, next/web-vitals, next/link.
  nextClientHooks: ['useRouter', 'usePathname', 'useSearchParams', 'useParams', 'useSelectedLayoutSegment',
    'useSelectedLayoutSegments', 'useReportWebVitals', 'useServerInsertedHTML', 'useLinkStatus'],
  browserGlobals: ['window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'IntersectionObserver',
    'ResizeObserver', 'MutationObserver', 'matchMedia', 'requestAnimationFrame'],
  // "any"   = any value import from the package means the file must be a Client Component
  // "hooks" = only importing a use* hook from it does (other exports may be server-safe)
  clientLibraries: {
    'framer-motion': 'any', 'motion/react': 'any', 'react-spring': 'any', '@react-spring/web': 'any',
    'react-hook-form': 'hooks', 'zustand': 'hooks', 'jotai': 'hooks', 'valtio': 'hooks', 'recoil': 'hooks',
    'react-redux': 'hooks', '@tanstack/react-query': 'hooks', 'swr': 'any', 'next-themes': 'hooks',
    'react-use': 'any', 'usehooks-ts': 'any', '@uidotdev/usehooks': 'any', 'react-dropzone': 'any',
    '@dnd-kit/core': 'any', '@dnd-kit/sortable': 'any', 'react-intersection-observer': 'any',
    'react-hot-toast': 'hooks', 'sonner': 'hooks', '@react-three/fiber': 'any', '@react-three/drei': 'any',
    'next-auth/react': 'hooks', '@clerk/nextjs': 'hooks', 'react-i18next': 'hooks', '@apollo/client': 'hooks',
    'nuqs': 'hooks', '@tanstack/react-table': 'hooks', '@tanstack/react-form': 'hooks', 'embla-carousel-react': 'any',
    'recharts': 'any', 'react-chartjs-2': 'any', 'swiper/react': 'any', 'gsap': 'any', '@gsap/react': 'any', 'lottie-react': 'any',
  },
  // Component packages that are safe to render from a Server Component even though they do not declare "use client".
  serverSafePackages: ['lucide-react', '@heroicons/react', 'react-icons', '@tabler/icons-react', '@radix-ui/react-icons', 'react-markdown', 'next-mdx-remote'],
  // Data hooks: if these (or fetch inside useEffect) are the ONLY reason a file is client → MOVE_FETCH.
  dataHooks: ['useSWR', 'useSWRInfinite', 'useSWRImmutable', 'useQuery', 'useSuspenseQuery', 'useInfiniteQuery', 'useQueries'],
  // Hooks from packages that are known to work in Server Components too (never flagged as uncertain).
  serverSafeHooks: ['useTranslations', 'useFormatter', 'useLocale', 'useNow', 'useTimeZone', 'useMessages'],
  highImpactModules: 10,
  mediumImpactModules: 3,
  childrenPatternMinModules: 2,
  extraScanDirs: [],
  ignore: [],
};

// ------------------------------------------------------------------------------------------ CLI
function parseArgs(argv) {
  const o = { root: process.cwd(), format: 'json', json: null, md: null, parser: 'auto', config: null, top: 3, hookDepth: 2 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--format') o.format = val();
    else if (a === '--json') o.json = val();
    else if (a === '--md') o.md = val();
    else if (a === '--parser') o.parser = val();
    else if (a === '--config') o.config = val();
    else if (a === '--top') o.top = Number(val()) || 3;
    else if (a === '--hook-depth') o.hookDepth = Math.max(1, Number(val()) || 2);
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else rest.push(a);
  }
  if (rest[0]) o.root = path.resolve(rest[0]);
  return o;
}

const HELP = `nextjs-client-audit ${VERSION} — read-only "use client" audit for Next.js App Router

  node audit.js [projectRoot] [options]

  --format json|md        what to print to stdout (default json)
  --json <file>           also write the JSON result to a file
  --md <file>             also write the Markdown report draft to a file
  --parser <p>            auto (default) | typescript | babel | regex
  --config <file>         extra config (default: <root>/.client-audit.json if present)
  --top <n>               Before/After examples in the report (default 3)
  --hook-depth <n>        how deep to follow custom hooks (default 2, min 1)

Exit: 0 audit ran · 2 not an App Router project · 1 error. Never modifies files.`;

// ------------------------------------------------------------------------------------------ utils
const rel = (root, p) => path.relative(root, p).split(path.sep).join('/');
const exists = (p) => { try { fs.accessSync(p); return true; } catch { return false; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const isFile = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const uniq = (a) => [...new Set(a)];

function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (pos) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
}

function readJsonLoose(p) {
  try {
    let s = fs.readFileSync(p, 'utf8');
    // strip comments (outside strings) and trailing commas — tsconfig allows both
    s = stripJsonComments(s).replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(s);
  } catch { return null; }
}
function stripJsonComments(s) {
  let out = '', inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) { out += c; if (c === '\\') { out += s[++i] || ''; } else if (c === '"') inStr = false; continue; }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && s[i + 1] === '/') { while (i < s.length && s[i] !== '\n') i++; out += '\n'; continue; }
    if (c === '/' && s[i + 1] === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i++; continue; }
    out += c;
  }
  return out;
}

// ------------------------------------------------------------------------------------------ lexer (shared)
// Produces masked copies of the source with identical length/offsets:
//   noComments : comments → spaces, strings kept       (for import specifiers, URLs)
//   code       : comments AND string/template text → spaces, ${expr} kept   (for identifier searches)
// and the list of plain string tokens (for directive / misplaced-directive detection).
// JSX text is not understood here; a stray apostrophe ("Don't") can only mask until the end of its line.
function lex(text) {
  const n = text.length;
  const nc = text.split('');
  const code = text.split('');
  const strings = [];
  const blank = (arr, a, b) => { for (let k = a; k < b; k++) if (arr[k] !== '\n') arr[k] = ' '; };
  let i = 0;
  const tmplStack = []; // brace depth at which a template ${ began
  let braceDepth = 0;
  let prevSig = ''; // previous significant char, for regex-literal guessing
  const regexAllowedAfter = '(,=:[!&|?{};+-*%<>~^';
  while (i < n) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const e = text.indexOf('\n', i); const end = e < 0 ? n : e;
      blank(nc, i, end); blank(code, i, end); i = end; continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const e = text.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2;
      blank(nc, i, end); blank(code, i, end); i = end; continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
      const closed = text[j] === c;
      const end = closed ? j + 1 : j;
      if (closed) strings.push({ start: i, end, quote: c, value: text.slice(i + 1, j) });
      blank(code, i + 1, closed ? j : end);
      i = end; prevSig = 'a'; continue;
    }
    if (c === '`' || (c === '}' && tmplStack.length && tmplStack[tmplStack.length - 1] === braceDepth)) {
      if (c === '}') { tmplStack.pop(); braceDepth--; }
      let j = i + 1;
      while (j < n && text[j] !== '`' && !(text[j] === '$' && text[j + 1] === '{')) { if (text[j] === '\\') j++; j++; }
      blank(code, i + 1, Math.min(j, n));
      if (text[j] === '$') { tmplStack.push(braceDepth + 1); braceDepth++; i = j + 2; prevSig = '{'; continue; }
      i = j + 1; prevSig = 'a'; continue;
    }
    if (c === '/' && (prevSig === '' || regexAllowedAfter.includes(prevSig))) {
      // regex literal
      let j = i + 1, cls = false;
      while (j < n && text[j] !== '\n') {
        if (text[j] === '\\') { j += 2; continue; }
        if (text[j] === '[') cls = true; else if (text[j] === ']') cls = false; else if (text[j] === '/' && !cls) break;
        j++;
      }
      if (text[j] === '/') { blank(code, i + 1, j); i = j + 1; while (/[a-z]/i.test(text[i] || '')) i++; prevSig = 'a'; continue; }
    }
    if (c === '{') braceDepth++;
    else if (c === '}') braceDepth--;
    if (!/\s/.test(c)) prevSig = /[\w$)\]]/.test(c) ? 'a' : c;
    // keywords after which a regex may follow
    if (/[a-z]/.test(c) && !/[\w$]/.test(text[i - 1] || '')) {
      const m = /^(return|typeof|case|in|of|delete|void|throw|new)\b/.exec(text.slice(i, i + 8));
      if (m) { i += m[0].length; prevSig = '('; continue; }
    }
    i++;
  }
  return { noComments: nc.join(''), code: code.join(''), strings };
}

// Directive prologue: string-literal expression statements at the very top (comments, BOM, shebang allowed).
function scanPrologue(text) {
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (text.startsWith('#!', i)) { const e = text.indexOf('\n', i); i = e < 0 ? n : e; }
  const directives = [];
  const skip = (k) => {
    for (;;) {
      while (k < n && /\s/.test(text[k])) k++;
      if (text.startsWith('//', k)) { const e = text.indexOf('\n', k); k = e < 0 ? n : e; continue; }
      if (text.startsWith('/*', k)) { const e = text.indexOf('*/', k + 2); k = e < 0 ? n : e + 2; continue; }
      return k;
    }
  };
  for (;;) {
    i = skip(i);
    const q = text[i];
    if (q !== '"' && q !== "'") break;
    let j = i + 1;
    while (j < n && text[j] !== q && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
    if (text[j] !== q) break;
    const value = text.slice(i + 1, j);
    let k = j + 1;
    while (k < n && (text[k] === ' ' || text[k] === '\t')) k++;
    if (text[k] === ';') { directives.push({ value, start: i, end: k + 1 }); i = k + 1; continue; }
    const nk = skip(k);
    const nextChar = text[nk];
    const sameLine = !/\n/.test(text.slice(k, nk));
    // the statement continues ("use client".length, "a" + b …) → not a directive
    if (nextChar && '.[(`,+-*/%?=&|'.includes(nextChar)) break;
    if (sameLine && nk < n && nextChar !== '}') break;
    directives.push({ value, start: i, end: j + 1 });
    i = j + 1;
  }
  return { directives, end: i };
}

// ------------------------------------------------------------------------------------------ parsers
function tryRequire(name, root) {
  const bases = [path.join(root, 'package.json'), __filename];
  for (const b of bases) {
    try { const r = createRequire(b); const p = r.resolve(name); return { mod: r(p), from: p }; } catch { /* next */ }
  }
  try { return { mod: require(name), from: require.resolve(name) }; } catch { return null; }
}
function pkgVersionNear(file, name) {
  let d = path.dirname(file);
  for (let k = 0; k < 6; k++) {
    const pj = path.join(d, 'package.json');
    if (isFile(pj)) { const j = readJsonLoose(pj); if (j && j.name === name) return j.version; }
    d = path.dirname(d);
  }
  return '?';
}
function loadParser(mode, root) {
  const want = mode === 'auto' ? ['typescript', 'babel', 'regex'] : [mode];
  for (const w of want) {
    if (w === 'typescript') {
      const r = tryRequire('typescript', root);
      if (r && r.mod.createSourceFile) return { kind: 'typescript', name: `typescript@${r.mod.version}`, ts: r.mod, from: r.from };
    } else if (w === 'babel') {
      const r = tryRequire('@babel/parser', root);
      if (r && r.mod.parse) return { kind: 'babel', name: `@babel/parser@${pkgVersionNear(r.from, '@babel/parser')}`, babel: r.mod, from: r.from };
    } else if (w === 'regex') {
      return { kind: 'regex', name: 'regex-heuristic (no AST parser installed)' };
    }
  }
  if (mode !== 'auto') throw new Error(`parser "${mode}" requested but not installed (npm i -D ${mode === 'babel' ? '@babel/parser' : mode})`);
  return { kind: 'regex', name: 'regex-heuristic (no AST parser installed)' };
}

// ------------------------------------------------------------------------------------------ fact extraction
// Every extractor returns the same shape, so the analysis below does not care which parser ran.
function emptyFacts() {
  return {
    imports: [], calls: [], jsxAttrs: [], browser: [], classComponents: [], jsxComponents: [], stateVars: [],
    envVars: [], exports: [], metadataLine: null, dynamicSsrFalse: [], declared: new Set(), parseErrors: 0,
    hookDecls: [], jsxElements: [], jsxRefs: [], typeDecls: [], usageExact: false,
  };
}

function parseImportClause(clause) {
  const out = { defaultLocal: null, nsLocal: null, names: [] };
  let c = clause.trim();
  const brace = /\{([\s\S]*)\}/.exec(c);
  if (brace) {
    for (const part of brace[1].split(',')) {
      const p = part.trim(); if (!p) continue;
      const typeOnly = /^type\s+/.test(p);
      const m = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(p);
      if (m) out.names.push({ imported: m[1], local: m[2] || m[1], typeOnly });
    }
    c = c.replace(brace[0], '');
  }
  const ns = /\*\s*as\s+([\w$]+)/.exec(c);
  if (ns) { out.nsLocal = ns[1]; c = c.replace(ns[0], ''); }
  const def = /^\s*([\w$]+)/.exec(c.replace(/,/g, ' '));
  if (def && def[1] !== 'type') out.defaultLocal = def[1];
  return out;
}

// ---------- regex extractor
function extractRegex(text, L) {
  const f = emptyFacts();
  const { noComments: nc, code } = L.lex;
  const line = L.line;
  const add = (spec, pos, kind, typeOnly, clause) => {
    const parsed = clause ? parseImportClause(clause) : { defaultLocal: null, nsLocal: null, names: [] };
    f.imports.push({ spec, line: line(pos), kind, typeOnly: !!typeOnly, ...parsed });
  };
  let m;
  const IMPORT_RE = /(^|[;\n}])[ \t]*import\s+(type\s+)?([^;'"]*?)\s*from\s*(['"])([^'"\n]+)\4/g;
  while ((m = IMPORT_RE.exec(nc))) add(m[5], m.index + m[1].length, 'static', m[2], m[3]);
  const SIDE_RE = /(^|[;\n}])[ \t]*import\s*(['"])([^'"\n]+)\2/g;
  while ((m = SIDE_RE.exec(nc))) add(m[3], m.index + m[1].length, 'side-effect', false, '');
  const EXP_RE = /(^|[;\n}])[ \t]*export\s+(type\s+)?([^;'"]*?)\s*from\s*(['"])([^'"\n]+)\4/g;
  while ((m = EXP_RE.exec(nc))) add(m[5], m.index + m[1].length, 'reexport', m[2], '');
  const DYN_RE = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  while ((m = DYN_RE.exec(nc))) add(m[2], m.index, 'dynamic', false, '');
  const REQ_RE = /(?<![\w$.])require\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  while ((m = REQ_RE.exec(nc))) add(m[2], m.index, 'require', false, '');

  // local declarations (for shadowed browser globals)
  const DECL_RE = /\b(?:const|let|var|function|class)\s+([\w$]+)/g;
  while ((m = DECL_RE.exec(code))) f.declared.add(m[1]);
  const DESTR_RE = /\b(?:const|let|var)\s*[{[]([^}\]=]*)[}\]]\s*=/g;
  while ((m = DESTR_RE.exec(code))) for (const id of m[1].split(/[\s,:]+/)) if (/^[\w$]+$/.test(id)) f.declared.add(id);

  // useEffect / useLayoutEffect call ranges (to know if a fetch happens inside an effect)
  const effectRanges = [];
  const EFF_RE = /(?<![\w$])(?:React\.)?(useEffect|useLayoutEffect)\s*\(/g;
  while ((m = EFF_RE.exec(code))) {
    let d = 0, j = m.index + m[0].length - 1;
    for (; j < code.length; j++) { if (code[j] === '(') d++; else if (code[j] === ')') { d--; if (d === 0) break; } }
    effectRanges.push([m.index, j]);
  }
  const inEffect = (pos) => effectRanges.some(([a, b]) => pos > a && pos < b);

  // calls (identifier and member callee)
  const GEN = '(?:<(?:[^<>()]|<[^<>()]*>)*>)?';
  const CALL_RE = new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*${GEN}\\s*\\(`, 'g');
  while ((m = CALL_RE.exec(code))) {
    const name = m[1];
    if (/^(if|for|while|switch|catch|return|typeof|function|await|new|import|super|delete|void|in|of|do)$/.test(name)) continue;
    if (/function\s*\*?\s*$/.test(code.slice(Math.max(0, m.index - 14), m.index))) continue; // declaration, not a call
    const argStart = m.index + m[0].length;
    f.calls.push({ name, obj: null, line: line(m.index), pos: m.index, inEffect: inEffect(m.index), argText: argText(nc, argStart) });
  }
  const MEM_RE = new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)\\s*${GEN}\\s*\\(`, 'g');
  while ((m = MEM_RE.exec(code))) {
    f.calls.push({ name: m[2], obj: m[1], line: line(m.index), pos: m.index, inEffect: inEffect(m.index), argText: argText(nc, m.index + m[0].length) });
  }

  // JSX attributes: on[A-Z]* handlers and inline function props
  const elementBefore = (pos) => {
    const s = code.slice(Math.max(0, pos - 4000), pos);
    const all = [...s.matchAll(/<([A-Za-z][\w.:-]*)(?=[\s/>])/g)];
    const last = all[all.length - 1];
    return last ? { name: last[1], pos: pos - s.length + last.index } : { name: '?', pos };
  };
  const ATTR_RE = /\s([A-Za-z][\w-]*)\s*=\s*\{/g;
  while ((m = ATTR_RE.exec(code))) {
    const attr = m[1];
    const after = code.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const isFn = /^\s*(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(after) || /^\s*(?:async\s+)?function\b/.test(after);
    const isOn = /^on[A-Z]/.test(attr);
    if (!isOn && !isFn) continue;
    // ignore `const x = {` style code: an attribute must sit inside a JSX tag
    const before = code.slice(Math.max(0, m.index - 30), m.index + 1);
    if (/\b(const|let|var)\s+[\w$]*\s*$/.test(before)) continue;
    const el = elementBefore(m.index);
    const serverAction = isFn && /^\s*(?:async\s+)?(?:\([^()]*\)|[\w$]+)\s*=>\s*\{\s*['"]use server['"]/.test(nc.slice(m.index + m[0].length, m.index + m[0].length + 200));
    const span = jsxElementSpan(code, el.pos, el.name);
    f.jsxAttrs.push({ attr, element: el.name, isDom: /^[a-z]/.test(el.name), line: line(m.index), valueKind: isFn ? 'function' : 'identifier', serverAction, elStart: span[0], elEnd: span[1] });
  }

  // browser globals (must look like real usage: window.x, document.x, typeof window, new IntersectionObserver(...))
  const G = new Set(L.config.browserGlobals);
  const BROWSER_RES = [
    /(?<![\w$.])(window|document|navigator|localStorage|sessionStorage)(?:\?\.|\.)[A-Za-z_$]/g,
    /(?<![\w$.])(window|document|localStorage|sessionStorage)\s*\[/g,
    /\btypeof\s+(window|document|navigator|localStorage)\b/g,
    /(?<![\w$.])(?:new\s+)?(IntersectionObserver|ResizeObserver|MutationObserver)\s*\(/g,
    /(?<![\w$.])(matchMedia|requestAnimationFrame)\s*\(/g,
  ];
  for (const re of BROWSER_RES) {
    while ((m = re.exec(code))) {
      if (!G.has(m[1])) continue;
      // `type W = typeof window` / `x: typeof window` are type positions, not runtime usage
      if (/^typeof/.test(m[0])) { const ls = code.lastIndexOf('\n', m.index) + 1; if (/(\btype\s+[\w$]+\s*=|:)\s*$/.test(code.slice(ls, m.index))) continue; }
      if (f.declared.has(m[1])) continue;
      f.browser.push({ name: m[1], line: line(m.index), guarded: /^typeof/.test(m[0]) });
    }
  }
  const CLASS_RE = /\bclass\s+[\w$]+\s+extends\s+(?:React\.)?(?:Pure)?Component\b/g;
  while ((m = CLASS_RE.exec(code))) f.classComponents.push({ line: line(m.index) });
  if (/\bssr\s*:\s*false\b/.test(code) && f.imports.some((i) => i.spec === 'next/dynamic')) {
    const p = code.search(/\bssr\s*:\s*false\b/); f.dynamicSsrFalse.push({ line: line(p) });
  }
  // JSX components (Uppercase tags)
  const COMP_RE = /<([A-Z][\w$]*(?:\.[\w$]+)*)(?=[\s/>])/g;
  while ((m = COMP_RE.exec(code))) {
    const span = jsxElementSpan(code, m.index, m[1]);
    const openEnd = openTagEnd(code, m.index);
    const attrIdents = uniq([...code.slice(m.index, openEnd).matchAll(/\{([^{}]*)\}/g)].flatMap((x) => x[1].match(/(?<![\w$.])[A-Za-z_$][\w$]*/g) || []));
    f.jsxComponents.push({ name: m[1], line: line(m.index), start: span[0], end: span[1], attrIdents });
  }
  const STATE_RE = /\b(?:const|let)\s*\[\s*([\w$]+)\s*(?:,\s*([\w$]+))?\s*\]\s*=\s*(?:React\.)?(?:useState|useReducer|useOptimistic|useActionState)\b/g;
  while ((m = STATE_RE.exec(code))) f.stateVars.push(...[m[1], m[2]].filter(Boolean));
  const ENV_RE = /\bprocess\.env\.([A-Za-z_][\w]*)/g;
  while ((m = ENV_RE.exec(code))) f.envVars.push({ name: m[1], line: line(m.index) });
  // exports
  let em;
  const EXP_FN = /\bexport\s+(default\s+)?(async\s+)?function\s*\*?\s*([\w$]*)\s*\(([^)]*)\)/g;
  while ((em = EXP_FN.exec(nc))) f.exports.push({ name: em[3] || 'default', isDefault: !!em[1], async: !!em[2], line: line(em.index), params: em[4].trim() });
  const EXP_CONST = /\bexport\s+(?:const|let)\s+([\w$]+)\s*(?::[^=]+)?=\s*(async\s+)?(?:\(([^)]*)\)|[\w$]+)?/g;
  while ((em = EXP_CONST.exec(nc))) f.exports.push({ name: em[1], isDefault: false, async: !!em[2], line: line(em.index), params: (em[3] || '').trim() });
  const EXP_DEF = /\bexport\s+default\s+([A-Z][\w$]*)\s*;?\s*$/gm;
  while ((em = EXP_DEF.exec(nc))) f.exports.push({ name: em[1], isDefault: true, async: false, line: line(em.index), params: '', ref: true });
  const META = /\bexport\s+(?:const|let|var)\s+metadata\b|\bexport\s+(?:async\s+)?function\s+generateMetadata\b/.exec(nc);
  if (META) f.metadataLine = line(META.index);
  return f;
}

function argText(nc, start) {
  let d = 1, j = start;
  for (; j < nc.length && j < start + 400; j++) {
    const c = nc[j];
    if (c === '(' || c === '[' || c === '{') d++;
    else if (c === ')' || c === ']' || c === '}') { d--; if (d === 0) break; }
    else if (c === ',' && d === 1) break;
  }
  return nc.slice(start, j).trim();
}
function openTagEnd(code, start) {
  let d = 0;
  for (let j = start; j < code.length && j < start + 6000; j++) {
    const c = code[j];
    if (c === '{') d++; else if (c === '}') d--;
    else if (c === '>' && d === 0 && code[j - 1] !== '=') return j + 1;
  }
  return Math.min(code.length, start + 200);
}
function jsxElementSpan(code, start, name) {
  const oe = openTagEnd(code, start);
  if (code[oe - 2] === '/') return [start, oe];
  if (!name || name === '?') return [start, oe];
  // find matching close tag, honouring nesting of the same tag name
  const esc = name.replace(/[.$]/g, '\\$&');
  const re = new RegExp(`<${esc}(?=[\\s/>])|</${esc}\\s*>`, 'g');
  re.lastIndex = oe;
  let depth = 1, mm;
  while ((mm = re.exec(code))) {
    if (mm[0].startsWith('</')) { depth--; if (depth === 0) return [start, mm.index + mm[0].length]; }
    else { const e2 = openTagEnd(code, mm.index); if (code[e2 - 2] !== '/') depth++; }
    if (mm.index - start > 20000) break;
  }
  return [start, oe];
}

// ---------- TypeScript extractor
function extractTS(text, L, ts, file) {
  const f = emptyFacts();
  const ext = path.extname(file);
  const kind = ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.ts' ? ts.ScriptKind.TS : ext === '.jsx' ? ts.ScriptKind.JSX : ts.ScriptKind.JS;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  f.parseErrors = (sf.parseDiagnostics || []).length;
  const line = (pos) => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const G = new Set(L.config.browserGlobals);
  const browserHits = [];
  const isEffectCall = (n) => ts.isCallExpression(n) && (
    (ts.isIdentifier(n.expression) && /^(useEffect|useLayoutEffect)$/.test(n.expression.text)) ||
    (ts.isPropertyAccessExpression(n.expression) && /^(useEffect|useLayoutEffect)$/.test(n.expression.name.text)));
  const inEffect = (n) => { for (let p = n.parent; p; p = p.parent) if (isEffectCall(p)) return true; return false; };
  const declName = (nameNode) => {
    if (!nameNode) return;
    if (ts.isIdentifier(nameNode)) f.declared.add(nameNode.text);
    else if (ts.isObjectBindingPattern(nameNode) || ts.isArrayBindingPattern(nameNode)) nameNode.elements.forEach((e) => e.name && declName(e.name));
  };
  const fnIsServerAction = (fn) => {
    const b = fn.body;
    if (!b || !ts.isBlock(b) || !b.statements.length) return false;
    const s0 = b.statements[0];
    return ts.isExpressionStatement(s0) && ts.isStringLiteral(s0.expression) && s0.expression.text === 'use server';
  };
  const hasExport = (n) => (ts.getCombinedModifierFlags ? (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Export) !== 0 : false);
  const hasDefault = (n) => (ts.getCombinedModifierFlags ? (ts.getCombinedModifierFlags(n) & ts.ModifierFlags.Default) !== 0 : false);
  const isAsync = (n) => !!(n.modifiers && n.modifiers.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword));

  const visit = (n) => {
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      const ic = n.importClause;
      const rec = { spec: n.moduleSpecifier.text, line: line(n.getStart()), kind: ic ? 'static' : 'side-effect', typeOnly: !!(ic && ic.isTypeOnly), defaultLocal: null, nsLocal: null, names: [] };
      if (ic) {
        if (ic.name) rec.defaultLocal = ic.name.text;
        const nb = ic.namedBindings;
        if (nb && ts.isNamespaceImport(nb)) rec.nsLocal = nb.name.text;
        if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) rec.names.push({ imported: (el.propertyName || el.name).text, local: el.name.text, typeOnly: !!el.isTypeOnly });
      }
      f.imports.push(rec);
      [rec.defaultLocal, rec.nsLocal, ...rec.names.map((x) => x.local)].filter(Boolean).forEach((x) => f.declared.add(x));
    } else if (ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      f.imports.push({ spec: n.moduleSpecifier.text, line: line(n.getStart()), kind: 'reexport', typeOnly: !!n.isTypeOnly, defaultLocal: null, nsLocal: null, names: [] });
    } else if (ts.isCallExpression(n)) {
      const e = n.expression;
      if (e.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        f.imports.push({ spec: n.arguments[0].text, line: line(n.getStart()), kind: 'dynamic', typeOnly: false, defaultLocal: null, nsLocal: null, names: [] });
      } else if (ts.isIdentifier(e) && e.text === 'require' && n.arguments[0] && ts.isStringLiteralLike(n.arguments[0])) {
        f.imports.push({ spec: n.arguments[0].text, line: line(n.getStart()), kind: 'require', typeOnly: false, defaultLocal: null, nsLocal: null, names: [] });
      }
      const argT = n.arguments[0] ? n.arguments[0].getText() : '';
      if (ts.isIdentifier(e)) f.calls.push({ name: e.text, obj: null, line: line(n.getStart()), pos: n.getStart(), inEffect: inEffect(n), argText: argT });
      else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) f.calls.push({ name: e.name.text, obj: e.expression.text, line: line(n.getStart()), pos: n.getStart(), inEffect: inEffect(n), argText: argT });
      // next/dynamic(..., { ssr: false })
      if (ts.isIdentifier(e) && n.arguments[1] && ts.isObjectLiteralExpression(n.arguments[1])) {
        for (const p of n.arguments[1].properties) {
          if (ts.isPropertyAssignment(p) && p.name.getText() === 'ssr' && p.initializer.kind === ts.SyntaxKind.FalseKeyword) f.dynamicSsrFalse.push({ line: line(n.getStart()), callee: e.text });
        }
      }
    } else if (ts.isJsxAttribute(n)) {
      const attr = n.name.getText();
      const init = n.initializer && ts.isJsxExpression(n.initializer) ? n.initializer.expression : null;
      const isFn = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
      if (/^on[A-Z]/.test(attr) || isFn) {
        const opening = n.parent.parent; // JsxAttributes → JsxOpeningElement | JsxSelfClosingElement
        const tag = opening.tagName.getText();
        const elNode = ts.isJsxOpeningElement(opening) ? opening.parent : opening;
        f.jsxAttrs.push({ attr, element: tag, isDom: /^[a-z]/.test(tag), line: line(n.getStart()), valueKind: isFn ? 'function' : init && ts.isIdentifier(init) ? 'identifier' : 'other', serverAction: isFn && fnIsServerAction(init), elStart: elNode.getStart(), elEnd: elNode.getEnd() });
      }
    } else if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && /^[A-Z]/.test(n.tagName.getText())) {
      const elNode = ts.isJsxOpeningElement(n) ? n.parent : n;
      const attrIdents = [];
      const collect = (x) => { if (ts.isIdentifier(x)) attrIdents.push(x.text); ts.forEachChild(x, collect); };
      n.attributes.properties.forEach((p) => { if (ts.isJsxAttribute(p) && p.initializer) collect(p.initializer); else if (ts.isJsxSpreadAttribute(p)) collect(p.expression); });
      f.jsxComponents.push({ name: n.tagName.getText(), line: line(n.getStart()), start: elNode.getStart(), end: elNode.getEnd(), attrIdents: uniq(attrIdents) });
    } else if (ts.isIdentifier(n) && G.has(n.text)) {
      const p = n.parent;
      const isNamePos = p && p.name === n && !ts.isShorthandPropertyAssignment(p);
      const inType = p && (ts.isTypeQueryNode(p) || ts.isTypeReferenceNode(p) || ts.isQualifiedName(p));
      if (!isNamePos && !inType && !(p && ts.isJsxAttribute(p))) browserHits.push({ name: n.text, line: line(n.getStart()), guarded: !!(p && ts.isTypeOfExpression(p)) });
    } else if (ts.isClassLike(n) && n.heritageClauses) {
      for (const h of n.heritageClauses) for (const t of h.types) if (/^(React\.)?(Pure)?Component$/.test(t.expression.getText())) f.classComponents.push({ line: line(n.getStart()) });
    } else if (ts.isPropertyAccessExpression(n) && n.expression.getText() === 'process.env') {
      f.envVars.push({ name: n.name.text, line: line(n.getStart()) });
    }
    // JSX element tree + identifier references inside JSX expressions (for precise PUSH_DOWN drafts)
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) {
      const nm = ts.isJsxElement(n) ? n.openingElement.tagName.getText() : ts.isJsxSelfClosingElement(n) ? n.tagName.getText() : '<>';
      f.jsxElements.push({ name: nm, start: n.getStart(), end: n.getEnd(), line: line(n.getStart()), isDom: /^[a-z]/.test(nm) });
    }
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isProp = p && ((ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || ts.isJsxAttribute(p) || ts.isJsxOpeningElement(p) || ts.isJsxClosingElement(p) || ts.isJsxSelfClosingElement(p));
      if (!isProp) {
        let attr = null, pure = false, inExpr = false;
        for (let q = n.parent, prev = n; q; prev = q, q = q.parent) {
          if (ts.isJsxExpression(q)) { inExpr = true; if (q.expression === prev && ts.isJsxAttribute(q.parent)) pure = true; }
          if (ts.isJsxAttribute(q)) attr = q.name.getText();
          if (ts.isJsxElement(q) || ts.isJsxSelfClosingElement(q) || ts.isJsxFragment(q)) {
            if (inExpr) {
              const nm = ts.isJsxElement(q) ? q.openingElement.tagName.getText() : ts.isJsxSelfClosingElement(q) ? q.tagName.getText() : '<>';
              f.jsxRefs.push({ name: n.text, element: nm, isDom: /^[a-z]/.test(nm), start: q.getStart(), end: q.getEnd(), attr, pure: pure && !!attr, line: line(n.getStart()) });
            }
            break;
          }
          if (ts.isSourceFile(q)) break;
        }
      }
    }
    // declarations + state vars
    if (ts.isVariableDeclaration(n)) {
      declName(n.name);
      if (n.initializer && ts.isCallExpression(n.initializer)) {
        const ce = n.initializer.expression;
        const hk = ts.isIdentifier(ce) ? ce.text : ts.isPropertyAccessExpression(ce) ? ce.name.text : '';
        if (/^use[A-Z]/.test(hk)) {
          const names = [];
          const grab = (b) => { if (ts.isIdentifier(b)) names.push(b.text); else if (ts.isObjectBindingPattern(b) || ts.isArrayBindingPattern(b)) b.elements.forEach((e) => e.name && grab(e.name)); };
          grab(n.name);
          const stmt = n.parent && n.parent.parent && ts.isVariableStatement(n.parent.parent) ? n.parent.parent : n;
          f.hookDecls.push({ hook: hk, names, line: line(n.getStart()), start: stmt.getStart(), end: stmt.getEnd() });
        }
      }
      if (ts.isArrayBindingPattern(n.name) && n.initializer && ts.isCallExpression(n.initializer)) {
        const ce = n.initializer.expression;
        const nm = ts.isIdentifier(ce) ? ce.text : ts.isPropertyAccessExpression(ce) ? ce.name.text : '';
        if (/^(useState|useReducer|useOptimistic|useActionState)$/.test(nm)) n.name.elements.forEach((el) => { if (el.name && ts.isIdentifier(el.name)) f.stateVars.push(el.name.text); });
      }
      if (hasExport(n.parent.parent) && ts.isIdentifier(n.name)) {
        const init = n.initializer;
        const fn = init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? init : null;
        f.exports.push({ name: n.name.text, isDefault: false, async: fn ? isAsync(fn) : false, line: line(n.getStart()), params: fn ? fn.parameters.map((p) => p.getText()).join(', ') : '' });
        if (n.name.text === 'metadata') f.metadataLine = line(n.getStart());
      }
    }
    if (ts.isParameter(n)) declName(n.name);
    if ((ts.isTypeAliasDeclaration(n) || ts.isInterfaceDeclaration(n)) && n.name) f.typeDecls.push({ name: n.name.text, start: n.getStart(), end: n.getEnd() });
    if ((ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n)) && n.name) f.declared.add(n.name.text);
    if (ts.isFunctionDeclaration(n) && hasExport(n)) {
      const name = n.name ? n.name.text : 'default';
      f.exports.push({ name, isDefault: hasDefault(n), async: isAsync(n), line: line(n.getStart()), params: n.parameters.map((p) => p.getText()).join(', ') });
      if (name === 'generateMetadata') f.metadataLine = line(n.getStart());
    }
    if (ts.isExportAssignment(n) && !n.isExportEquals && ts.isIdentifier(n.expression)) f.exports.push({ name: n.expression.text, isDefault: true, async: false, line: line(n.getStart()), params: '', ref: true });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  f.browser = browserHits.filter((h) => !f.declared.has(h.name));
  f.usageExact = true;
  return f;
}

// ---------- Babel extractor
function extractBabel(text, L, babel, file) {
  const f = emptyFacts();
  const ext = path.extname(file);
  const plugins = ext === '.ts' ? ['typescript'] : ext === '.tsx' ? ['typescript', 'jsx'] : ['jsx'];
  let ast;
  try {
    ast = babel.parse(text, { sourceType: 'module', errorRecovery: true, plugins: [...plugins, 'decorators-legacy', 'importAttributes'] });
  } catch (e) {
    f.parseErrors = 1;
    return Object.assign(extractRegex(text, L), { parseErrors: 1 });
  }
  f.parseErrors = (ast.errors || []).length;
  const line = (node) => (node.loc ? node.loc.start.line : 1);
  const src = (node) => text.slice(node.start, node.end);
  const G = new Set(L.config.browserGlobals);
  const browserHits = [];
  const stack = [];
  const isEffectCall = (n) => n.type === 'CallExpression' && (
    (n.callee.type === 'Identifier' && /^(useEffect|useLayoutEffect)$/.test(n.callee.name)) ||
    (n.callee.type === 'MemberExpression' && n.callee.property && /^(useEffect|useLayoutEffect)$/.test(n.callee.property.name)));
  const inEffect = () => stack.some(isEffectCall);
  const declPattern = (p) => {
    if (!p) return;
    if (p.type === 'Identifier') f.declared.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((x) => declPattern(x.type === 'RestElement' ? x.argument : x.value));
    else if (p.type === 'ArrayPattern') p.elements.forEach((x) => x && declPattern(x));
    else if (p.type === 'AssignmentPattern') declPattern(p.left);
    else if (p.type === 'RestElement') declPattern(p.argument);
    else if (p.type === 'TSParameterProperty') declPattern(p.parameter);
  };
  const fnIsServerAction = (fn) => fn.body && fn.body.type === 'BlockStatement' && (fn.body.directives || []).some((d) => d.value.value === 'use server');
  const jsxName = (nm) => (nm.type === 'JSXIdentifier' ? nm.name : nm.type === 'JSXMemberExpression' ? `${jsxName(nm.object)}.${nm.property.name}` : nm.type === 'JSXNamespacedName' ? `${nm.namespace.name}:${nm.name.name}` : '?');
  const pushExportFn = (decl, isDefault) => {
    if (!decl) return;
    if (decl.type === 'FunctionDeclaration') {
      const name = decl.id ? decl.id.name : 'default';
      f.exports.push({ name, isDefault, async: !!decl.async, line: line(decl), params: decl.params.map(src).join(', ') });
      if (name === 'generateMetadata') f.metadataLine = line(decl);
    } else if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type !== 'Identifier') continue;
        const fn = d.init && /Function/.test(d.init.type) ? d.init : null;
        f.exports.push({ name: d.id.name, isDefault: false, async: fn ? !!fn.async : false, line: line(d), params: fn ? fn.params.map(src).join(', ') : '' });
        if (d.id.name === 'metadata') f.metadataLine = line(d);
      }
    } else if (decl.type === 'Identifier' && isDefault) {
      f.exports.push({ name: decl.name, isDefault: true, async: false, line: line(decl), params: '', ref: true });
    } else if (/Function/.test(decl.type) && isDefault) {
      f.exports.push({ name: 'default', isDefault: true, async: !!decl.async, line: line(decl), params: decl.params.map(src).join(', ') });
    }
  };
  const visit = (n, parent) => {
    if (!n || typeof n.type !== 'string') return;
    switch (n.type) {
      case 'ImportDeclaration': {
        const rec = { spec: n.source.value, line: line(n), kind: n.specifiers.length ? 'static' : 'side-effect', typeOnly: n.importKind === 'type', defaultLocal: null, nsLocal: null, names: [] };
        for (const s of n.specifiers) {
          if (s.type === 'ImportDefaultSpecifier') rec.defaultLocal = s.local.name;
          else if (s.type === 'ImportNamespaceSpecifier') rec.nsLocal = s.local.name;
          else rec.names.push({ imported: s.imported.name || s.imported.value, local: s.local.name, typeOnly: s.importKind === 'type' });
          f.declared.add(s.local.name);
        }
        f.imports.push(rec);
        break;
      }
      case 'ExportNamedDeclaration':
        if (n.source) f.imports.push({ spec: n.source.value, line: line(n), kind: 'reexport', typeOnly: n.exportKind === 'type', defaultLocal: null, nsLocal: null, names: [] });
        pushExportFn(n.declaration, false);
        break;
      case 'ExportAllDeclaration':
        f.imports.push({ spec: n.source.value, line: line(n), kind: 'reexport', typeOnly: n.exportKind === 'type', defaultLocal: null, nsLocal: null, names: [] });
        break;
      case 'ExportDefaultDeclaration':
        pushExportFn(n.declaration, true);
        break;
      case 'CallExpression': {
        const c = n.callee;
        const a0 = n.arguments[0];
        if (c.type === 'Import' && a0 && a0.type === 'StringLiteral') f.imports.push({ spec: a0.value, line: line(n), kind: 'dynamic', typeOnly: false, defaultLocal: null, nsLocal: null, names: [] });
        if (c.type === 'Identifier' && c.name === 'require' && a0 && a0.type === 'StringLiteral') f.imports.push({ spec: a0.value, line: line(n), kind: 'require', typeOnly: false, defaultLocal: null, nsLocal: null, names: [] });
        const argT = a0 ? src(a0) : '';
        if (c.type === 'Identifier') f.calls.push({ name: c.name, obj: null, line: line(n), pos: n.start, inEffect: inEffect(), argText: argT });
        else if (c.type === 'MemberExpression' && c.object.type === 'Identifier' && c.property.type === 'Identifier' && !c.computed) f.calls.push({ name: c.property.name, obj: c.object.name, line: line(n), pos: n.start, inEffect: inEffect(), argText: argT });
        const a1 = n.arguments[1];
        if (c.type === 'Identifier' && a1 && a1.type === 'ObjectExpression') {
          for (const p of a1.properties) if (p.type === 'ObjectProperty' && (p.key.name === 'ssr' || p.key.value === 'ssr') && p.value.type === 'BooleanLiteral' && p.value.value === false) f.dynamicSsrFalse.push({ line: line(n), callee: c.name });
        }
        break;
      }
      case 'ImportExpression':
        if (n.source && n.source.type === 'StringLiteral') f.imports.push({ spec: n.source.value, line: line(n), kind: 'dynamic', typeOnly: false, defaultLocal: null, nsLocal: null, names: [] });
        break;
      case 'JSXAttribute': {
        const attr = n.name.type === 'JSXNamespacedName' ? `${n.name.namespace.name}:${n.name.name.name}` : n.name.name;
        const ex = n.value && n.value.type === 'JSXExpressionContainer' ? n.value.expression : null;
        const isFn = !!ex && (ex.type === 'ArrowFunctionExpression' || ex.type === 'FunctionExpression');
        if (/^on[A-Z]/.test(attr) || isFn) {
          const opening = parent; // JSXOpeningElement
          const elNode = stack[stack.length - 2] && stack[stack.length - 2].type === 'JSXElement' ? stack[stack.length - 2] : opening;
          const tag = jsxName(opening.name);
          f.jsxAttrs.push({ attr, element: tag, isDom: /^[a-z]/.test(tag), line: line(n), valueKind: isFn ? 'function' : ex && ex.type === 'Identifier' ? 'identifier' : 'other', serverAction: isFn && fnIsServerAction(ex), elStart: elNode.start, elEnd: elNode.end });
        }
        break;
      }
      case 'JSXOpeningElement': {
        const tag = jsxName(n.name);
        if (/^[A-Z]/.test(tag)) {
          const elNode = parent && parent.type === 'JSXElement' ? parent : n;
          const ids = [];
          const collect = (x) => {
            if (!x || typeof x !== 'object') return;
            if (Array.isArray(x)) return x.forEach(collect);
            if (x.type === 'Identifier') ids.push(x.name);
            for (const k of Object.keys(x)) if (!['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments'].includes(k)) collect(x[k]);
          };
          n.attributes.forEach((a) => collect(a.type === 'JSXAttribute' ? a.value : a.argument));
          f.jsxComponents.push({ name: tag, line: line(n), start: elNode.start, end: elNode.end, attrIdents: uniq(ids) });
        }
        break;
      }
      case 'Identifier': {
        {
          const p = parent;
          const isProp = p && (((p.type === 'MemberExpression' || p.type === 'OptionalMemberExpression') && p.property === n && !p.computed) || (p.type === 'ObjectProperty' && p.key === n && !p.computed && !p.shorthand));
          if (!isProp) {
            let attr = null, pure = false, inExpr = false, prev = n;
            for (let k = stack.length - 1; k >= 0; k--) {
              const q = stack[k];
              if (q.type === 'JSXExpressionContainer') { inExpr = true; if (q.expression === prev && stack[k - 1] && stack[k - 1].type === 'JSXAttribute') pure = true; }
              if (q.type === 'JSXAttribute') attr = q.name.name;
              if (q.type === 'JSXElement' || q.type === 'JSXFragment') {
                if (inExpr) {
                  const nm = q.type === 'JSXElement' ? jsxName(q.openingElement.name) : '<>';
                  f.jsxRefs.push({ name: n.name, element: nm, isDom: /^[a-z]/.test(nm), start: q.start, end: q.end, attr, pure: pure && !!attr, line: line(n) });
                }
                break;
              }
              prev = q;
            }
          }
        }
        if (!G.has(n.name)) break;
        const p = parent;
        const skip = p && ((p.type === 'MemberExpression' || p.type === 'OptionalMemberExpression') && p.property === n && !p.computed
          || (p.type === 'ObjectProperty' && p.key === n && !p.computed && !p.shorthand)
          || (p.type === 'ClassMethod' || p.type === 'ClassProperty' || p.type === 'ObjectMethod' || p.type === 'TSPropertySignature') && p.key === n
          || /^TS(TypeQuery|TypeReference|QualifiedName)/.test(p.type));
        if (!skip) browserHits.push({ name: n.name, line: line(n), guarded: !!(p && p.type === 'UnaryExpression' && p.operator === 'typeof') });
        break;
      }
      case 'ClassDeclaration': case 'ClassExpression':
        if (n.superClass && /^(React\.)?(Pure)?Component$/.test(src(n.superClass))) f.classComponents.push({ line: line(n) });
        if (n.id) f.declared.add(n.id.name);
        break;
      case 'MemberExpression':
        if (n.object.type === 'MemberExpression' && src(n.object) === 'process.env' && !n.computed) f.envVars.push({ name: n.property.name, line: line(n) });
        break;
      case 'JSXElement': case 'JSXFragment': {
        const nm = n.type === 'JSXElement' ? jsxName(n.openingElement.name) : '<>';
        f.jsxElements.push({ name: nm, start: n.start, end: n.end, line: line(n), isDom: /^[a-z]/.test(nm) });
        break;
      }
      case 'VariableDeclarator':
        declPattern(n.id);
        if (n.init && n.init.type === 'CallExpression') {
          const ce = n.init.callee;
          const hk = ce.type === 'Identifier' ? ce.name : ce.type === 'MemberExpression' && ce.property ? ce.property.name : '';
          if (/^use[A-Z]/.test(hk)) {
            const names = [];
            const grab = (b) => { if (!b) return; if (b.type === 'Identifier') names.push(b.name); else if (b.type === 'ObjectPattern') b.properties.forEach((x) => grab(x.type === 'RestElement' ? x.argument : x.value)); else if (b.type === 'ArrayPattern') b.elements.forEach(grab); else if (b.type === 'AssignmentPattern') grab(b.left); };
            grab(n.id);
            const stmt = parent && parent.type === 'VariableDeclaration' ? parent : n;
            f.hookDecls.push({ hook: hk, names, line: line(n), start: stmt.start, end: stmt.end });
          }
        }
        if (n.id.type === 'ArrayPattern' && n.init && n.init.type === 'CallExpression') {
          const ce = n.init.callee;
          const nm = ce.type === 'Identifier' ? ce.name : ce.type === 'MemberExpression' ? ce.property.name : '';
          if (/^(useState|useReducer|useOptimistic|useActionState)$/.test(nm)) n.id.elements.forEach((el) => el && el.type === 'Identifier' && f.stateVars.push(el.name));
        }
        break;
      case 'TSTypeAliasDeclaration': case 'TSInterfaceDeclaration':
        if (n.id) f.typeDecls.push({ name: n.id.name, start: n.start, end: n.end });
        break;
      case 'FunctionDeclaration':
        if (n.id) f.declared.add(n.id.name);
        n.params.forEach(declPattern);
        break;
      case 'ArrowFunctionExpression': case 'FunctionExpression': case 'ObjectMethod': case 'ClassMethod':
        n.params.forEach(declPattern);
        break;
      default:
    }
    stack.push(n);
    for (const k of Object.keys(n)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || k === 'leadingComments' || k === 'trailingComments' || k === 'innerComments') continue;
      const v = n[k];
      if (Array.isArray(v)) { for (const x of v) if (x && typeof x.type === 'string') visit(x, n); }
      else if (v && typeof v.type === 'string') visit(v, n);
    }
    stack.pop();
  };
  visit(ast.program, null);
  f.browser = browserHits.filter((h) => !f.declared.has(h.name));
  f.usageExact = true;
  return f;
}

// ------------------------------------------------------------------------------------------ project model
function discover(root, config) {
  const appDirs = ['app', 'src/app'].map((d) => path.join(root, d)).filter(isDir);
  const scan = uniq([...SCAN_DIRS, ...(config.extraScanDirs || [])]).map((d) => path.join(root, d)).filter(isDir);
  const ignoreRes = (config.ignore || []).map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$'));
  const files = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!IGNORE_DIRS.has(e.name) && !TEST_DIRS.has(e.name) && !e.name.startsWith('.')) walk(p); continue; }
      if (!CODE_EXT.includes(path.extname(e.name)) || TEST_FILE.test(e.name)) continue;
      const r = rel(root, p);
      if (ignoreRes.some((re) => re.test(r))) continue;
      files.push(p);
    }
  };
  scan.forEach(walk);
  return { appDirs, scanDirs: scan.map((d) => rel(root, d)), files: uniq(files) };
}

function loadPathAliases(root) {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = path.join(root, name);
    if (!isFile(p)) continue;
    const j = readJsonLoose(p);
    const co = (j && j.compilerOptions) || {};
    const baseUrl = path.resolve(root, co.baseUrl || '.');
    const paths = co.paths || {};
    return { source: name, baseUrl, hasBaseUrl: !!co.baseUrl, rules: Object.entries(paths).map(([k, v]) => ({ key: k, targets: v })) };
  }
  return { source: null, baseUrl: root, hasBaseUrl: false, rules: [] };
}

function makeResolver(root, aliases) {
  const cache = new Map();
  const tryFile = (base) => {
    if (isFile(base) && CODE_EXT.includes(path.extname(base))) return base;
    for (const e of CODE_EXT) if (isFile(base + e)) return base + e;
    // TS ESM style: "./x.js" that is really ./x.ts(x)
    if (/\.[cm]?js$/.test(base)) { const b = base.replace(/\.[cm]?js$/, ''); for (const e of ['.ts', '.tsx']) if (isFile(b + e)) return b + e; }
    if (isDir(base)) for (const e of CODE_EXT) if (isFile(path.join(base, 'index' + e))) return path.join(base, 'index' + e);
    return null;
  };
  return (fromFile, spec) => {
    const key = path.dirname(fromFile) + '\0' + spec;
    if (cache.has(key)) return cache.get(key);
    let out;
    if (ASSET_EXT.test(spec)) out = { type: 'asset' };
    else if (spec.startsWith('.') || spec.startsWith('/')) {
      const r = tryFile(path.resolve(path.dirname(fromFile), spec));
      out = r ? { type: 'local', file: r } : { type: 'unresolved', reason: 'relative path not found' };
    } else {
      out = null;
      for (const rule of aliases.rules) {
        const star = rule.key.indexOf('*');
        const pre = star < 0 ? rule.key : rule.key.slice(0, star);
        const post = star < 0 ? '' : rule.key.slice(star + 1);
        if (star < 0 ? spec !== rule.key : !(spec.startsWith(pre) && spec.endsWith(post))) continue;
        const mid = star < 0 ? '' : spec.slice(pre.length, spec.length - post.length);
        for (const t of rule.targets) {
          const r = tryFile(path.resolve(aliases.baseUrl, t.replace('*', mid)));
          if (r) { out = { type: 'local', file: r, via: rule.key }; break; }
        }
        if (out) break;
        out = { type: 'unresolved', reason: `alias ${rule.key} matched but no file found` };
      }
      if (!out && aliases.hasBaseUrl) { const r = tryFile(path.resolve(aliases.baseUrl, spec)); if (r) out = { type: 'local', file: r, via: 'baseUrl' }; }
      if (!out && /^[@~#]\//.test(spec)) {
        // common alias convention without a tsconfig paths entry
        const r = tryFile(path.join(root, spec.slice(2))) || tryFile(path.join(root, 'src', spec.slice(2)));
        out = r ? { type: 'local', file: r, via: 'assumed @/ alias', assumed: true } : { type: 'unresolved', reason: 'alias not configured' };
      }
      if (!out) out = { type: 'package', name: spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0] };
    }
    cache.set(key, out);
    return out;
  };
}

function routeKind(root, appDirs, file) {
  const inApp = appDirs.some((d) => file.startsWith(d + path.sep));
  if (!inApp) return null;
  const base = path.basename(file).replace(/\.[^.]+$/, '');
  return ROUTE_FILES.has(base) ? base : null;
}

// ------------------------------------------------------------------------------------------ analysis
function analyze(opts) {
  const root = opts.root;
  if (!isDir(root)) throw new Error(`not a directory: ${root}`);
  let config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const cfgPath = opts.config ? path.resolve(opts.config) : path.join(root, '.client-audit.json');
  let configSource = null;
  if (isFile(cfgPath)) {
    const user = readJsonLoose(cfgPath);
    if (!user) throw new Error(`could not parse config ${cfgPath}`);
    configSource = rel(root, cfgPath) || cfgPath;
    for (const [k, v] of Object.entries(user)) {
      if (Array.isArray(v) && Array.isArray(config[k])) config[k] = uniq([...config[k], ...v]);
      else if (v && typeof v === 'object' && config[k] && typeof config[k] === 'object') config[k] = { ...config[k], ...v };
      else config[k] = v;
    }
  }

  const pkg = readJsonLoose(path.join(root, 'package.json')) || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const disc = discover(root, config);
  const base = { tool: 'nextjs-client-audit', version: VERSION, root, generatedAt: new Date().toISOString(), nextVersion: deps.next || null };

  if (!disc.appDirs.length) {
    const hasPages = isDir(path.join(root, 'pages')) || isDir(path.join(root, 'src/pages'));
    return {
      ...base, appRouter: false,
      message: hasPages
        ? 'Not an App Router project: found pages/ but no app/ or src/app/. "use client" and Server Components only exist in the App Router, so there is nothing to audit.'
        : 'Not an App Router project: no app/ or src/app/ directory found. Point the audit at the Next.js project root (the folder with package.json and app/).',
    };
  }

  const parser = loadParser(opts.parser, root);
  const aliases = loadPathAliases(root);
  const resolve = makeResolver(root, aliases);
  const warnings = [];
  if (parser.kind === 'regex') warnings.push({ type: 'parser-fallback', message: 'No AST parser (typescript or @babel/parser) is installed in the project, so the audit used a regex + heuristic scan. Results are still useful but less precise; "Needs manual check" is used more often. Run `npm i` in the project (Next.js + TypeScript projects already have typescript) for exact results.' });
  if (!deps.next) warnings.push({ type: 'no-next', message: 'package.json does not list "next". Is this the project root?' });

  // ---- load files on demand (scan set + anything they import locally)
  const files = new Map(); // abs → model
  const load = (abs) => {
    if (files.has(abs)) return files.get(abs);
    let text = '';
    try { text = fs.readFileSync(abs, 'utf8'); } catch { files.set(abs, null); return null; }
    const lexed = lex(text);
    const pro = scanPrologue(text);
    const L = { lex: lexed, line: lineIndex(text), config };
    let facts;
    try {
      facts = parser.kind === 'typescript' ? extractTS(text, L, parser.ts, abs) : parser.kind === 'babel' ? extractBabel(text, L, parser.babel, abs) : extractRegex(text, L);
    } catch (e) {
      facts = extractRegex(text, L); facts.parseErrors = (facts.parseErrors || 0) + 1;
    }
    // misplaced "use client": a statement-like 'use client' string after the prologue
    const misplaced = [];
    for (const s of lexed.strings) {
      if ((s.value !== 'use client' && s.value !== 'use server') || s.start < pro.end) continue;
      const ls = text.lastIndexOf('\n', s.start - 1) + 1;
      const le = text.indexOf('\n', s.end); const lineText = text.slice(ls, le < 0 ? text.length : le);
      if (/^\s*(['"])use (client|server)\1\s*;?\s*$/.test(lineText) && s.value === 'use client') misplaced.push(L.line(s.start));
    }
    const m = {
      abs, rel: rel(root, abs), text, line: L.line,
      directives: pro.directives.map((d) => d.value),
      directiveLine: pro.directives.find((d) => d.value === 'use client') ? L.line(pro.directives.find((d) => d.value === 'use client').start) : null,
      useClient: pro.directives.some((d) => d.value === 'use client'),
      useServer: pro.directives.some((d) => d.value === 'use server'),
      misplaced, facts, importMap: new Map(), deps: [], packages: [], unresolved: [], serverOnly: false,
      route: routeKind(root, disc.appDirs, abs),
    };
    for (const im of facts.imports) {
      if (im.typeOnly) continue;
      const r = resolve(abs, im.spec);
      const valueNames = im.names.filter((n) => !n.typeOnly);
      if (im.kind === 'static' && !im.defaultLocal && !im.nsLocal && im.names.length && !valueNames.length) continue; // import { type A, type B }
      if (im.spec === 'server-only') m.serverOnly = true;
      if (im.defaultLocal) m.importMap.set(im.defaultLocal, { spec: im.spec, imported: 'default', res: r, line: im.line });
      if (im.nsLocal) m.importMap.set(im.nsLocal, { spec: im.spec, imported: '*', res: r, line: im.line });
      for (const n of valueNames) m.importMap.set(n.local, { spec: im.spec, imported: n.imported, res: r, line: im.line });
      if (r.type === 'local') m.deps.push({ file: r.file, kind: im.kind, line: im.line, spec: im.spec, assumed: !!r.assumed });
      else if (r.type === 'package') m.packages.push({ name: r.name, spec: im.spec, kind: im.kind, line: im.line, valueNames: valueNames.map((n) => n.imported), hasDefault: !!im.defaultLocal, hasNs: !!im.nsLocal });
      else if (r.type === 'unresolved') m.unresolved.push({ spec: im.spec, reason: r.reason, line: im.line });
    }
    files.set(abs, m);
    return m;
  };
  const queue = [...disc.files];
  const seen = new Set();
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const m = load(f);
    if (!m) continue;
    for (const d of m.deps) if (!seen.has(d.file) && !d.file.split(path.sep).includes('node_modules')) queue.push(d.file);
  }
  const all = [...files.values()].filter(Boolean);
  const byAbs = new Map(all.map((m) => [m.abs, m]));
  // reverse edges
  for (const m of all) m.importers = [];
  for (const m of all) for (const d of m.deps) { const t = byAbs.get(d.file); if (t) t.importers.push({ file: m.abs, line: d.line }); }

  // ---- does an installed package ship its own "use client"? (then rendering it from a Server Component is fine)
  const pkgMemo = new Map();
  const projectRequire = (() => { try { return createRequire(path.join(root, 'package.json')); } catch { return null; } })();
  const fileHasUseClient = (f) => { try { const t = fs.readFileSync(f, 'utf8').slice(0, 4000); return scanPrologue(t).directives.some((d) => d.value === 'use client'); } catch { return false; } };
  function pkgClientMarked(name, spec) {
    const key = spec;
    if (pkgMemo.has(key)) return pkgMemo.get(key);
    let out = 'missing';
    try {
      const entries = [];
      try { entries.push(projectRequire.resolve(spec)); } catch { /* ESM-only */ }
      let pdir = null;
      try { pdir = path.dirname(projectRequire.resolve(`${name}/package.json`)); } catch {
        // package.json not exported: walk up from the entry
        if (entries[0]) { let d = path.dirname(entries[0]); for (let k = 0; k < 6 && d.length > 1; k++, d = path.dirname(d)) if (isFile(path.join(d, 'package.json')) && (readJsonLoose(path.join(d, 'package.json')) || {}).name === name) { pdir = d; break; } }
      }
      if (!pdir && isDir(path.join(root, 'node_modules', name))) pdir = path.join(root, 'node_modules', name);
      if (pdir) {
        const pj = readJsonLoose(path.join(pdir, 'package.json')) || {};
        for (const k of ['module', 'main']) if (typeof pj[k] === 'string') entries.push(path.join(pdir, pj[k]));
        if (entries.some((e) => isFile(e) && fileHasUseClient(e))) out = 'entry';
        else {
          // some libraries put the directive in each component file instead of the entry (e.g. MUI)
          const dirs = uniq(entries.filter(isFile).map((e) => path.dirname(e)));
          let found = false, n = 0;
          for (const d of dirs) {
            const stack = [[d, 0]];
            while (stack.length && !found && n < 400) {
              const [dd, depth] = stack.pop();
              let ents = []; try { ents = fs.readdirSync(dd, { withFileTypes: true }); } catch { continue; }
              for (const e of ents) {
                if (e.isDirectory() && depth < 2 && e.name !== 'node_modules') stack.push([path.join(dd, e.name), depth + 1]);
                else if (/\.(m?js|cjs)$/.test(e.name)) { n++; if (fileHasUseClient(path.join(dd, e.name))) { found = true; break; } }
              }
            }
          }
          out = found ? 'files' : 'none';
        }
      }
    } catch { out = 'missing'; }
    pkgMemo.set(key, out);
    return out;
  }

  // ---- signals
  const libMode = (spec) => {
    for (const [lib, mode] of Object.entries(config.clientLibraries)) if (spec === lib || spec.startsWith(lib + '/')) return { lib, mode };
    return null;
  };
  const isHookName = (n) => /^use[A-Z0-9]/.test(n);
  const hookMemo = new Map();
  function fileIsClientOnly(m, depth, trail) {
    // used for custom hooks: is this module itself client-only?
    if (m.useClient) return { client: true, why: `${m.rel} has "use client"` };
    const s = signalsOf(m, depth, trail);
    if (s.strong.length) return { client: true, why: `${m.rel}: ${s.strong[0].label}` };
    if (s.uncertain.length) return { client: null, why: `${m.rel}: ${s.uncertain[0].label}` };
    return { client: false, why: `${m.rel} uses no client-only API` };
  }
  const sigMemo = new Map();
  function signalsOf(m, depth = opts.hookDepth, trail = new Set()) {
    const key = m.abs + '@' + depth;
    if (sigMemo.has(key)) return sigMemo.get(key);
    const strong = [], uncertain = [], fetches = [];
    const add = (arr, cat, label, line, extra = {}) => arr.push({ cat, label, line, ...extra });
    const F = m.facts;
    const reactNs = new Set([...m.importMap].filter(([, v]) => v.spec === 'react' && (v.imported === '*' || v.imported === 'default')).map(([k]) => k));
    for (const c of F.calls) {
      if (c.obj) {
        if (reactNs.has(c.obj)) {
          if (config.clientHooks.includes(c.name)) add(strong, 'hook', `${c.obj}.${c.name}()`, c.line, { hook: c.name });
          else if (c.name === 'createContext') add(strong, 'context', `${c.obj}.createContext()`, c.line);
        } else if (c.obj === 'axios' || (m.importMap.get(c.obj) || {}).spec === 'axios') {
          fetches.push({ kind: 'axios', line: c.line, inEffect: c.inEffect, url: c.argText });
        }
        continue;
      }
      const imp = m.importMap.get(c.name);
      if (imp) {
        const imported = imp.imported === 'default' ? c.name : imp.imported;
        if (imp.spec === 'react') {
          if (config.clientHooks.includes(imported)) add(strong, 'hook', `${imported}()`, c.line, { hook: imported });
          else if (imported === 'createContext') add(strong, 'context', 'createContext()', c.line);
        } else if (imp.spec === 'react-dom' && /^(useFormStatus|useFormState)$/.test(imported)) {
          add(strong, 'hook', `${imported}()`, c.line, { hook: imported });
        } else if (NEXT_CLIENT_SOURCES.has(imp.spec)) {
          if (config.nextClientHooks.includes(imported)) add(strong, 'nextHook', `${imported}() from ${imp.spec}`, c.line, { hook: imported });
        } else if (imp.spec === 'axios') {
          fetches.push({ kind: 'axios', line: c.line, inEffect: c.inEffect, url: c.argText });
        } else if (imp.res.type === 'local' && isHookName(imported)) {
          const target = byAbs.get(imp.res.file) || load(imp.res.file);
          if (!target) add(uncertain, 'customHook', `${imported}() — could not read ${imp.spec}`, c.line);
          else if (trail.has(target.abs) || depth <= 0) add(uncertain, 'customHook', `${imported}() from ${target.rel} — not followed (depth limit)`, c.line);
          else {
            const r = fileIsClientOnly(target, depth - 1, new Set([...trail, m.abs]));
            if (r.client === true) add(strong, 'customHook', `${imported}() → client-only (${r.why})`, c.line, { hook: imported, from: target.rel });
            else if (r.client === null) add(uncertain, 'customHook', `${imported}() → unclear (${r.why})`, c.line, { from: target.rel });
          }
        } else if (imp.res.type === 'unresolved' && isHookName(imported)) {
          add(uncertain, 'customHook', `${imported}() from "${imp.spec}" — import could not be resolved`, c.line);
        } else if (imp.res.type === 'package' && isHookName(imported)) {
          const lm = libMode(imp.spec);
          if (config.dataHooks.includes(imported)) { fetches.push({ kind: 'dataHook', hook: imported, line: c.line, inEffect: true, url: c.argText }); add(strong, 'dataHook', `${imported}() from ${imp.spec}`, c.line, { hook: imported }); }
          else if (lm) add(strong, 'library', `${imported}() from ${imp.spec}`, c.line);
          else if (!config.serverSafeHooks.includes(imported)) add(uncertain, 'unknownHook', `${imported}() from "${imp.spec}" — unknown package hook (may or may not work on the Server)`, c.line);
        }
      } else if (!F.declared.has(c.name)) {
        if (config.clientHooks.includes(c.name)) add(strong, 'hook', `${c.name}() (not imported)`, c.line, { hook: c.name });
        else if (c.name === 'fetch') fetches.push({ kind: 'fetch', line: c.line, inEffect: c.inEffect, url: c.argText });
      }
    }
    // client-only libraries imported as values
    for (const p of m.packages) {
      const lm = libMode(p.spec);
      if (!lm || p.kind === 'reexport') continue;
      if (lm.mode === 'any' && (p.hasDefault || p.hasNs || p.valueNames.length || p.kind === 'dynamic')) add(strong, 'library', `imports ${p.spec} (client-only library)`, p.line, { lib: lm.lib });
    }
    // third-party components rendered here: fine from a Server Component only if the package marks itself "use client"
    const rendered = new Set(F.jsxComponents.map((c) => c.name.split('.')[0]));
    const pkgNotes = [];
    for (const p of m.packages) {
      if (FRAMEWORK_PKGS.has(p.name) || p.name === 'next' || libMode(p.spec) || config.serverSafePackages.some((x) => p.spec === x || p.spec.startsWith(x + '/'))) continue;
      const locals = [...m.importMap].filter(([, v]) => v.spec === p.spec).map(([k]) => k);
      const used = locals.filter((l) => rendered.has(l));
      if (!used.length) continue;
      const st = pkgClientMarked(p.name, p.spec);
      if (st === 'entry' || st === 'files') pkgNotes.push(`<${used[0]}> comes from ${p.name}, which ships its own "use client"`);
      else if (st === 'none') add(uncertain, 'packageComponent', `renders <${used.join('>, <')}> from ${p.name}, which does not declare "use client" — if it uses hooks inside, it only works in a Client Component`, p.line);
      else add(uncertain, 'packageComponent', `renders <${used.join('>, <')}> from ${p.name}, which is not installed (run npm install), so it could not be checked`, p.line);
    }
    for (const a of F.jsxAttrs) {
      if (/^on[A-Z]/.test(a.attr)) {
        if (a.isDom) add(strong, 'event', `${a.attr} on <${a.element}>`, a.line, { el: [a.elStart, a.elEnd] });
        else add(strong, 'functionProp', `passes ${a.attr} to <${a.element}> (functions cannot cross the Server→Client boundary)`, a.line, { el: [a.elStart, a.elEnd] });
      } else if (a.valueKind === 'function' && !a.serverAction) {
        add(strong, 'functionProp', `inline function in ${a.attr}={…} on <${a.element}>`, a.line, { el: [a.elStart, a.elEnd] });
      }
    }
    for (const b of F.browser) add(strong, 'browser', `${b.guarded ? 'typeof ' : ''}${b.name}${b.guarded ? ' (guarded)' : ''}`, b.line, { guarded: b.guarded });
    for (const c of F.classComponents) add(strong, 'class', 'class component (extends Component)', c.line);
    for (const d of F.dynamicSsrFalse) {
      const imp = m.importMap.get(d.callee || 'dynamic');
      if (!d.callee || (imp && imp.spec === 'next/dynamic')) add(strong, 'dynamicSsrFalse', 'next/dynamic with { ssr: false } (only allowed in Client Components)', d.line);
    }
    if (F.parseErrors && parser.kind !== 'regex') add(uncertain, 'parse', `${F.parseErrors} parse error(s) — file may use syntax the parser did not understand`, 1);
    const out = { strong, uncertain, fetches, pkgNotes };
    sigMemo.set(key, out);
    return out;
  }

  // ---- downstream (what a boundary drags into the client bundle)
  const downstream = (start) => {
    const mods = new Set(), pkgs = new Set(), orphans = [], frontier = [], uncertainNodes = [], serverOnly = [], env = [];
    const q = [{ m: start, via: null }];
    const visited = new Set([start.abs]);
    while (q.length) {
      const { m } = q.shift();
      for (const p of m.packages) if (!FRAMEWORK_PKGS.has(p.name)) pkgs.add(p.name);
      if (m.serverOnly) serverOnly.push(m.rel);
      for (const e of m.facts.envVars) if (!/^NEXT_PUBLIC_/.test(e.name) && e.name !== 'NODE_ENV') env.push({ file: m.rel, name: e.name, line: e.line });
      for (const d of m.deps) {
        if (visited.has(d.file)) continue;
        visited.add(d.file);
        const t = byAbs.get(d.file);
        if (!t) continue;
        if (t.useClient || t.useServer) continue; // already its own boundary / server action reference
        mods.add(t.abs);
        const s = signalsOf(t);
        const needs = s.strong.length > 0;
        if (needs) {
          orphans.push(t);
          // frontier = orphan reachable through a chain of server-capable modules only
          frontier.push(t);
          // do not descend: its subtree is client anyway once the orphan gets its own directive
          // (but still count it as pulled by THIS boundary today)
          collectAll(t, visited, mods, pkgs);
          continue;
        }
        if (s.uncertain.length) uncertainNodes.push({ m: t, why: s.uncertain[0].label });
        q.push({ m: t });
      }
    }
    return { mods, pkgs, orphans, frontier, uncertainNodes, serverOnly: uniq(serverOnly), env };
  };
  function collectAll(m, visited, mods, pkgs) {
    const st = [m];
    while (st.length) {
      const x = st.pop();
      for (const p of x.packages) if (!FRAMEWORK_PKGS.has(p.name)) pkgs.add(p.name);
      for (const d of x.deps) {
        if (visited.has(d.file)) continue;
        visited.add(d.file);
        const t = byAbs.get(d.file);
        if (!t || t.useClient || t.useServer) continue;
        mods.add(t.abs); st.push(t);
      }
    }
  }

  // ---- classify every "use client" file
  const scanSet = new Set(disc.files);
  const directiveFiles = all.filter((m) => m.useClient && scanSet.has(m.abs));
  const extraDirective = all.filter((m) => m.useClient && !scanSet.has(m.abs));
  const results = [];
  const dsMap = new Map();
  for (const m of all) if (m.useClient) dsMap.set(m.abs, downstream(m));
  // modules that are in the client bundle because of some boundary (other than `except`)
  const clientElsewhere = (abs, except) => {
    for (const [k, d] of dsMap) if (k !== except && (k === abs || d.mods.has(abs))) return true;
    return false;
  };
  // names a JSX child may reference and still be rendered by a Server Component instead:
  // the wrapper's own props (the importer can pass them), imports, and module-level constants
  const topLevelNames = (m) => new Set([...m.text.matchAll(/^(?:export\s+)?(?:const|let|var|function|class)\s+([\w$]+)/gm)].map((x) => x[1]));
  const propNames = (m, compName) => {
    const e = m.facts.exports.find((x) => x.name === compName) || m.facts.exports.find((x) => x.isDefault);
    const d = e && /^\{([^}]*)\}/.exec((e.params || '').trim());
    return new Set(d ? d[1].split(',').map((x) => x.trim().split(/[:=\s]/)[0].replace(/^\.\.\./, '')).filter(Boolean) : []);
  };
  for (const m of [...directiveFiles, ...extraDirective]) {
    const s = signalsOf(m);
    const ds = dsMap.get(m.abs) || downstream(m);
    const est = 1 + ds.mods.size;
    const why = [], risks = [];
    let status, fix = null, confidence = parser.kind === 'regex' ? 'medium' : 'high';
    let lowGainFlag = false;
    let skippedKidsOut = [];
    const kind = m.route || (/^use[A-Z]/.test(path.basename(m.abs)) ? 'hook' : 'component');
    const strongCats = new Set(s.strong.map((x) => x.cat));
    const assumedAlias = m.deps.some((d) => d.assumed);
    if (assumedAlias) risks.push('Some imports use an @/ alias that is not declared in tsconfig/jsconfig; it was assumed to point at the project root or src/.');

    if (m.route && REQUIRED_CLIENT_ROUTE.has(m.route)) {
      status = 'Required';
      why.push(`Next.js requires ${m.route}.tsx to be a Client Component (it is a React error boundary).`);
    } else if (!s.strong.length) {
      const uncertainAll = [...s.uncertain.map((u) => `${u.label} (line ${u.line})`), ...ds.uncertainNodes.map((u) => `${u.m.rel}: ${u.why}`)];
      const unresolvedLocal = m.unresolved;
      if (uncertainAll.length || unresolvedLocal.length) {
        status = 'Needs manual check';
        confidence = 'low';
        why.push('No certain client-only usage found, but the analysis is not conclusive:');
        uncertainAll.forEach((u) => why.push(`  · ${u}`));
        unresolvedLocal.forEach((u) => why.push(`  · import "${u.spec}" (line ${u.line}) could not be resolved — ${u.reason}`));
        fix = { type: ds.frontier.length ? 'PUSH_DOWN' : 'REMOVE', targets: ds.frontier.map((o) => o.rel) };
      } else {
        status = 'Unnecessary';
        why.push('Uses no state/effect hooks, no event handlers, no browser APIs and no client-only libraries.');
        if (s.pkgNotes.length) why.push(`Checked: ${uniq(s.pkgNotes).join('; ')} — so it can be rendered from a Server Component.`);
        if (!m.facts.jsxComponents.length && !m.facts.jsxAttrs.length && !/\.(t|j)sx$/.test(m.abs) && est <= 1) why.push('This is a non-UI module (no JSX): the directive only changes how other files may import it, so removing it is tidy-up with no bundle saving.');
        if (ds.frontier.length) {
          fix = { type: 'PUSH_DOWN', targets: ds.frontier.map((o) => o.rel) };
          why.push(`But ${ds.frontier.length} imported file(s) without their own "use client" rely on this boundary: ${ds.frontier.map((o) => `${o.rel} (${uniq(signalsOf(o).strong.map((x) => x.label)).slice(0, 3).join(', ')})`).join('; ')}. The directive moves there instead of just being deleted.`);
          risks.push('Removing the directive here without adding "use client" to those files would break them (hooks/handlers in a Server Component throw at build or render time).');
        } else {
          fix = { type: 'REMOVE', targets: [] };
        }
        if (parser.kind === 'regex') { risks.push('Regex mode: re-check the file by eye before removing the directive.'); }
      }
    } else {
      // necessary — but maybe too broad
      const fetchOnlyCats = ['hook', 'dataHook'];
      const onlyDataHooks = s.strong.every((x) => fetchOnlyCats.includes(x.cat) && (x.cat === 'dataHook' || /^(useState|useEffect|useReducer|useLayoutEffect)$/.test(x.hook)));
      const effectFetch = s.fetches.some((x) => x.inEffect);
      const isFetchOnly = onlyDataHooks && effectFetch;
      // Server-capable children rendered here (CHILDREN_PATTERN candidates)
      const heavyKids = [];
      const skippedKids = [];
      const tops = topLevelNames(m);
      const comp = componentName(m);
      const props = propNames(m, comp);
      for (const jc of m.facts.jsxComponents) {
        const imp = m.importMap.get(jc.name.split('.')[0]);
        if (!imp || imp.res.type !== 'local') continue;
        const t = byAbs.get(imp.res.file);
        if (!t || t.useClient) continue;
        const ts2 = signalsOf(t);
        if (ts2.strong.length || ts2.uncertain.length) continue;
        // nested inside another candidate? the outer one moves it anyway
        if (m.facts.jsxComponents.some((o) => o !== jc && o.start <= jc.start && o.end >= jc.end && heavyKids.some((h) => h.start === o.start))) continue;
        // it must not use anything that only exists inside the client component (state, handlers, loop variables)
        const inside = m.facts.usageExact
          ? uniq(m.facts.jsxRefs.filter((r) => r.start >= jc.start && r.end <= jc.end).map((r) => r.name))
          : uniq(jc.attrIdents);
        const blockers = inside.filter((x) => !props.has(x) && !m.importMap.has(x) && !tops.has(x) && !/^(undefined|null|true|false|Math|JSON|Number|String|Date|Object|Array)$/.test(x));
        const handlers = m.facts.jsxAttrs.some((a) => a.elStart >= jc.start && a.elEnd <= jc.end);
        if (blockers.length || handlers) { skippedKids.push({ name: jc.name, why: handlers ? 'has event handlers inside' : `uses ${blockers.slice(0, 3).join(', ')} from inside ${comp}` }); continue; }
        // only worth it if the code really leaves the bundle: not used by another Client Component anyway
        const sub = downstream(t);
        if (clientElsewhere(t.abs, m.abs)) { skippedKids.push({ name: jc.name, why: 'is in the client bundle anyway (used by other Client Components)' }); continue; }
        const weight = 1 + sub.mods.size;
        if (weight >= config.childrenPatternMinModules || sub.pkgs.size > 0) {
          if (!heavyKids.some((h) => h.file === t.rel)) heavyKids.push({ name: jc.name, file: t.rel, line: jc.line, weight, pkgs: [...sub.pkgs], dependsOnState: [], start: jc.start, end: jc.end });
        }
      }
      skippedKidsOut = skippedKids;
      if (isFetchOnly) {
        status = 'Too broad';
        fix = { type: 'MOVE_FETCH', targets: [] };
        if (est <= 2) { lowGainFlag = true; why.push('Bundle gain is small (≈' + est + ' module); the real win is UX: the data is in the first HTML, with no loading state and no extra browser request.'); }
        why.push(`The only client-side work is data fetching (${s.fetches.map((x) => x.kind === 'dataHook' ? x.hook : x.kind + ' in useEffect').join(', ')}). An async Server Component can fetch the same data before the HTML is sent — no loading spinner, no fetch code in the bundle.`);
        risks.push('Behaviour change: data is fetched per request/at build time instead of in the browser. Keep it client-side if it needs the user\'s browser state, polls, or must refresh without navigation.');
      } else if (m.route && BROAD_ROUTE.has(m.route)) {
        status = 'Too broad';
        if (strongCats.has('context') && !strongCats.has('event') && !strongCats.has('browser')) {
          fix = { type: 'CHILDREN_PATTERN', targets: [] };
          why.push(`The whole ${m.route} is client only to provide React context. Move the provider into a small "use client" Providers component and render {children} through it.`);
        } else {
          fix = { type: 'PUSH_DOWN', targets: [] };
          const what = uniq(s.strong.map((x) => x.label)).slice(0, 4).join(', ');
          const alsoWhy = [];
          if (ds.frontier.length && !isHeavyInteractive(m, s)) {
            fix.targets = ds.frontier.map((o) => o.rel);
            alsoWhy.push(`Also: ${ds.frontier.map((o) => `${o.rel} (${uniq(signalsOf(o).strong.map((x) => x.label)).slice(0, 2).join(', ')})`).join('; ')} ${ds.frontier.length > 1 ? 'have' : 'has'} no "use client" of ${ds.frontier.length > 1 ? 'their' : 'its'} own and only works because of this boundary, so ${ds.frontier.length > 1 ? 'they get' : 'it gets'} the directive when the boundary moves down.`);
          }
          const heavy = isHeavyInteractive(m, s);
          if (m.route === 'page') why.push(`A page marked "use client" makes the whole page and everything it imports (≈${est} modules) client code. Client features used: ${what}.`);
          else why.push(`Everything this ${m.route} imports (≈${est} modules) is sent to the browser on every page under it. (Pages rendered through {children} still stay Server Components — only the shared shell is affected.) Client features used: ${what}.`);
          why.push(...alsoWhy);
          if (heavy || est <= 2) lowGainFlag = true;
          if (!heavy && est <= 2) why.push('Small bundle gain (the client code it uses stays client); the win is mostly structural: the route file can export metadata and fetch on the server.');
          if (heavy) why.push(`Most of this ${m.route} is interactive (${heavy}), so splitting it saves little JavaScript; the recommended move is a thin Server ${m.route} that renders one client view component — that keeps metadata, params and server data fetching available.`);
        }
        risks.push('Extracting the interactive part changes the component tree; props from the page into the new client component must be serializable (no functions, no class instances).');
      } else if (heavyKids.length) {
        status = 'Too broad';
        fix = { type: 'CHILDREN_PATTERN', targets: heavyKids.map((h) => h.file) };
        why.push(`Needs to be a Client Component (${uniq(s.strong.map((x) => x.label)).slice(0, 3).join(', ')}), but it also renders server-capable content that gets dragged into the bundle: ${heavyKids.map((h) => `<${h.name}> (${h.file}, ≈${h.weight} module${h.weight > 1 ? 's' : ''}${h.pkgs.length ? ` + ${h.pkgs.join(', ')}` : ''})`).join('; ')}.`);
        for (const h of heavyKids) if (h.dependsOnState.length) { risks.push(`<${h.name}> receives client state (${h.dependsOnState.join(', ')}) as props, so it cannot simply be passed as children — only if that state can stay in the wrapper.`); confidence = 'medium'; }
      } else {
        status = 'Necessary';
        why.push(`Needs the browser: ${uniq(s.strong.map((x) => x.label)).slice(0, 4).join(', ')}.`);
      }
    }
    const buildErrors = [];
    if (m.facts.metadataLine && m.useClient) buildErrors.push(`it exports metadata/generateMetadata (line ${m.facts.metadataLine}), which Next.js does not allow in a Client Component`);
    if (ds.serverOnly.length) buildErrors.push(`its boundary imports modules marked "server-only" (${ds.serverOnly.join(', ')})`);
    if (buildErrors.length) risks.push(`Build error today: ${buildErrors.join('; and ')}. ${fix && fix.type !== 'CHILDREN_PATTERN' || m.route ? 'Moving the boundary down fixes this.' : 'Keep server-only code out of this client tree.'}`);
    if (ds.env.length) risks.push(`Modules inside this boundary read non-public env vars (${uniq(ds.env.map((e) => `${e.name} in ${e.file}`)).slice(0, 4).join(', ')}): undefined in the browser, and a leak risk if inlined.`);

    let priority = null;
    if (fix) {
      if (m.route && BROAD_ROUTE.has(m.route)) priority = 'High';
      else if (est >= config.highImpactModules) priority = 'High';
      else if (est >= config.mediumImpactModules || (fix.type === 'CHILDREN_PATTERN' && ds.pkgs.size > 0)) priority = 'Medium';
      else priority = 'Low';
    }
    results.push({
      file: m.rel, kind, status, priority, fix: fix ? fix.type : null, fixTargets: fix ? fix.targets : [], confidence, lowGain: lowGainFlag,
      why, risks: uniq(risks),
      signals: s.strong.map(({ cat, label, line }) => ({ cat, label, line })),
      uncertain: s.uncertain.map(({ cat, label, line }) => ({ cat, label, line })),
      fetches: s.fetches,
      childrenChecked: typeof skippedKidsOut !== 'undefined' ? skippedKidsOut : [],
      estimatedModules: est, estimatedPackages: [...ds.pkgs].sort(),
      downstream: [...ds.mods].map((a) => rel(root, a)).sort(),
      importers: (m.importers || []).map((i) => ({ file: rel(root, i.file), line: i.line })),
      directiveLine: m.directiveLine,
      _m: m, _s: s, _ds: ds,
    });
  }

  // project-level warnings
  for (const m of all) for (const l of m.misplaced) {
    const needs = signalsOf(m).strong.length > 0;
    warnings.push({ type: 'misplaced-directive', file: m.rel, line: l, message: `"use client" on line ${l} of ${m.rel} is not at the top of the file, so Next.js ignores it. ${needs ? 'This file does use client features, so move it above all imports.' : 'Nothing in this file needs the browser, so delete the line (moving it up would create a client boundary for no reason).'}` });
  }
  // client files nothing imports (dead code, or used only from outside the scanned folders)
  for (const r of results) if (!r._m.route && !r.importers.length && r.status !== 'Required') warnings.push({ type: 'unimported-client-file', file: r.file, message: `${r.file} has "use client" but no scanned file imports it — unused, or only used outside ${disc.scanDirs.join(', ')}. It ships nothing until something imports it.` });
  const unresolvedAll = all.flatMap((m) => m.unresolved.map((u) => `${m.rel}: "${u.spec}" (${u.reason})`));
  if (unresolvedAll.length) warnings.push({ type: 'unresolved-imports', message: `${unresolvedAll.length} local import(s) could not be resolved, so the import graph may be incomplete.`, items: unresolvedAll.slice(0, 20) });
  if (aliases.rules.length === 0 && all.some((m) => m.deps.some((d) => d.assumed))) warnings.push({ type: 'assumed-alias', message: 'Imports use "@/…" but tsconfig/jsconfig declares no "paths"; assumed "@/" = project root or src/.' });

  const prioRank = { High: 0, Medium: 1, Low: 2 };
  const certain = (r) => (r.status === 'Needs manual check' ? 1 : 0);
  const lowGain = (r) => (r.lowGain ? 1 : 0);
  const findings = results.filter((r) => r.fix).sort((a, b) => (prioRank[a.priority] - prioRank[b.priority]) || (certain(a) - certain(b)) || (lowGain(a) - lowGain(b)) || (b.estimatedModules - a.estimatedModules) || a.file.localeCompare(b.file));
  const summary = {
    filesScanned: disc.files.length,
    modulesInGraph: all.length,
    useClientFiles: results.length,
    unnecessary: results.filter((r) => r.status === 'Unnecessary').length,
    tooBroad: results.filter((r) => r.status === 'Too broad').length,
    needsManualCheck: results.filter((r) => r.status === 'Needs manual check').length,
    necessary: results.filter((r) => r.status === 'Necessary').length,
    required: results.filter((r) => r.status === 'Required').length,
    findings: findings.length,
    highPriority: findings.filter((r) => r.priority === 'High').length,
    byFix: findings.reduce((acc, r) => { acc[r.fix] = (acc[r.fix] || 0) + 1; return acc; }, {}),
  };
  return {
    ...base, appRouter: true,
    parser: { kind: parser.kind, name: parser.name, exact: parser.kind !== 'regex' },
    config: { source: configSource, aliases: aliases.source ? `${aliases.source} (${aliases.rules.map((r) => r.key).join(', ') || 'no paths'})` : 'none' },
    scanDirs: disc.scanDirs, appDirs: disc.appDirs.map((d) => rel(root, d)),
    summary, findings, files: results, warnings,
    estimateNote: 'estimatedModules counts this file plus the local modules it pulls into the client bundle that are not already client by themselves. It is an estimate from the import graph, not a measured byte size — run `next build` for real numbers.',
    _top: opts.top, _all: all,
  };
}

// How much of a component is interactive? Used to choose between "extract the small part" and "client view".
function isHeavyInteractive(m, s) {
  const F = m.facts;
  const lines = new Set(s.strong.map((x) => x.line));
  const decls = F.hookDecls.filter((d) => lines.has(d.line));
  const vars = new Set(decls.flatMap((d) => d.names));
  const touched = new Set(F.jsxRefs.filter((r) => vars.has(r.name)).map((r) => r.start + ':' + r.end));
  for (const a of F.jsxAttrs) touched.add(a.elStart + ':' + a.elEnd);
  // elements from client-only libraries (<motion.div>, <Swiper>, …) are interactive too
  const libSpecs = new Set(s.strong.filter((x) => x.cat === 'library' && x.lib).map((x) => x.lib));
  const libLocals = new Set([...m.importMap].filter(([, v]) => [...libSpecs].some((l) => v.spec === l || v.spec.startsWith(l + '/'))).map(([k]) => k));
  for (const c of F.jsxComponents) if (libLocals.has(c.name.split('.')[0])) touched.add(c.start + ':' + c.end);
  const total = F.jsxElements.length || 1;
  const share = touched.size / total;
  if (decls.length >= 6 || (F.usageExact && share >= 0.3 && touched.size >= 4) || (!F.usageExact && s.strong.length >= 8)) {
    return F.usageExact ? `${decls.length} client hook${decls.length === 1 ? '' : 's'}; ${touched.size} of ${total} JSX elements are interactive or use client values` : `${s.strong.length} client-only usages`;
  }
  return null;
}

// ------------------------------------------------------------------------------------------ Before / After drafts
// Built from the user's real code. They are drafts: the skill tells Claude to read the files and polish them.
function excerpt(m, from, to) {
  const lines = m.text.split('\n');
  const a = Math.max(1, from), b = Math.min(lines.length, to);
  return lines.slice(a - 1, b).join('\n');
}
function textAt(m, start, end) { return m.text.slice(start, end); }
function componentName(m) {
  const ex = m.facts.exports;
  const d = ex.find((e) => e.isDefault && e.name !== 'default') || ex.find((e) => /^[A-Z]/.test(e.name));
  if (d) return d.name;
  const b = path.basename(m.abs).replace(/\.[^.]+$/, '');
  return b.charAt(0).toUpperCase() + b.slice(1).replace(/[-_.](\w)/g, (_, c) => c.toUpperCase());
}
function langOf(file) { return /\.tsx?$/.test(file) ? 'tsx' : 'jsx'; }
function withoutDirective(m) {
  const pro = scanPrologue(m.text);
  const d = pro.directives.find((x) => x.value === 'use client');
  if (!d) return m.text;
  let rest = m.text.slice(0, d.start) + m.text.slice(d.end);
  rest = rest.replace(/^(\s*\n)+/, '').replace(/\n{3,}/g, '\n\n');
  return rest;
}
function head(text, n) { const l = text.split('\n'); return l.slice(0, n).join('\n') + (l.length > n ? '\n// …' : ''); }
function dedent(s) {
  const lines = s.split('\n');
  const ind = Math.min(...lines.slice(1).filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length), Infinity);
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Number.isFinite(ind) ? ind : 0))].join('\n');
}
function indent(s, pad) { return s.split('\n').map((l) => (l.trim() ? pad + l : l)).join('\n'); }


// ---------- PUSH_DOWN when the file itself uses client features: split it by what each hook result is used for
const IDENT_RE = /[A-Za-z_$][\w$]*/g;
const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function lineSpan(text, start, end) {
  // widen [start,end) to whole lines (incl. the newline) when the span is alone on its lines
  const ls = text.lastIndexOf('\n', start - 1) + 1;
  const le0 = text.indexOf('\n', end);
  const le = le0 < 0 ? text.length : le0 + 1;
  return (/^\s*$/.test(text.slice(ls, start)) && /^\s*$/.test(text.slice(end, le))) ? [ls, le] : [start, end];
}
function applyEdits(text, edits) {
  const sorted = [...edits].sort((x, y) => y[0] - x[0]);
  let out = text;
  for (const [a, b, rep] of sorted) out = out.slice(0, a) + rep + out.slice(b);
  return out;
}
function pruneImports(code) {
  // drop import specifiers that are no longer referenced; keep side-effect imports
  const IMP = /^import\s+(type\s+)?([^;'"]*?)\s+from\s+(['"])([^'"]+)\3;?[ \t]*\r?\n/gm;
  const body = code.replace(IMP, '');
  const used = (id) => new RegExp(`(?<![\\w$.])${escRe(id)}(?![\\w$])`).test(body);
  return code.replace(IMP, (full, typeKw, clause, q, spec) => {
    const c = parseImportClause(clause);
    const def = c.defaultLocal && used(c.defaultLocal) ? c.defaultLocal : null;
    const ns = c.nsLocal && used(c.nsLocal) ? c.nsLocal : null;
    const names = c.names.filter((n) => used(n.local));
    if (!def && !ns && !names.length) return '';
    if (def === c.defaultLocal && ns === c.nsLocal && names.length === c.names.length) return full;
    const parts = [];
    if (def) parts.push(def);
    if (ns) parts.push(`* as ${ns}`);
    if (names.length) parts.push(`{ ${names.map((n) => `${n.typeOnly ? 'type ' : ''}${n.imported}${n.imported !== n.local ? ' as ' + n.local : ''}`).join(', ')} }`);
    return `import ${typeKw || ''}${parts.join(', ')} from ${q}${spec}${q};\n`;
  });
}
function addImportLine(code, lineText) {
  // after the last `import … from` (side-effect imports such as CSS stay where they are)
  const IMP = /^import[^;'"]*?from\s+['"][^'"]+['"];?[ \t]*$/gm;
  let last = null, mm;
  while ((mm = IMP.exec(code))) last = mm;
  if (!last) return lineText + '\n' + code;
  const at = last.index + last[0].length;
  return code.slice(0, at) + '\n' + lineText + code.slice(at);
}
function importsFor(m, text) {
  // rebuild the import statements a moved snippet needs, from the parent's real imports
  const ids = new Set(text.match(IDENT_RE) || []);
  const bySpec = new Map();
  for (const im of m.facts.imports) {
    if (im.kind !== 'static') continue;
    const e = bySpec.get(im.spec) || { def: null, ns: null, names: [], typeOnly: im.typeOnly };
    if (im.defaultLocal && ids.has(im.defaultLocal)) e.def = im.defaultLocal;
    if (im.nsLocal && ids.has(im.nsLocal)) e.ns = im.nsLocal;
    for (const n of im.names) if (ids.has(n.local)) e.names.push(`${n.typeOnly && !im.typeOnly ? 'type ' : ''}${n.imported}${n.imported !== n.local ? ' as ' + n.local : ''}`);
    bySpec.set(im.spec, e);
  }
  const out = [];
  for (const [spec, e] of bySpec) {
    const parts = [];
    if (e.def) parts.push(e.def);
    if (e.ns) parts.push(`* as ${e.ns}`);
    if (e.names.length) parts.push(`{ ${uniq(e.names).join(', ')} }`);
    if (parts.length) out.push(`import ${e.typeOnly ? 'type ' : ''}${parts.join(', ')} from "${spec}";`);
  }
  return out;
}
function placementFor(m, all, newName) {
  // put new client components next to the project's other components, imported the same way
  const lang = langOf(m.rel);
  const rootAbs = m.abs.slice(0, m.abs.length - m.rel.length);
  for (const [, v] of m.importMap) {
    if (v.res.type !== 'local' || !/\/components\//.test('/' + v.spec)) continue;
    return { file: `${rel(rootAbs, path.dirname(v.res.file))}/${newName}.${lang}`, spec: v.spec.replace(/[^/]+$/, newName) };
  }
  return { file: `${path.posix.dirname(m.rel)}/${newName}.${lang}`, spec: `./${newName}` };
}
function pushDownOwnDraft(r, all) {
  const m = r._m;
  const F = m.facts;
  const lang = langOf(m.rel);
  const base = componentName(m).replace(/(Page|Layout|Template)$/, '') || 'Route';
  const strong = r._s.strong;
  const byAbs = new Map(all.map((x) => [x.abs, x]));
  const serverCapable = (tag) => {
    const imp = m.importMap.get(tag.split('.')[0]);
    if (!imp || imp.res.type !== 'local') return null;
    const t = byAbs.get(imp.res.file);
    return t && !t.useClient ? t : null;
  };
  const plans = [];
  if (!F.usageExact) {
    const lines = uniq(strong.map((x) => x.line)).sort((a, b) => a - b);
    return {
      partial: true,
      before: [{ file: m.rel, lang, code: m.text.trimEnd() }],
      after: [],
      plans: [`Move the code on line(s) ${lines.join(', ')} (${uniq(strong.map((x) => x.label)).slice(0, 4).join(', ')}) into a small "use client" component and render it from ${m.rel}; then delete the directive. (Regex mode cannot trace which JSX uses which hook result, so this draft is a plan — read the file and write the code.)`],
      note: `${m.rel} should become a Server Component; only the interactive part keeps "use client".`,
    };
  }
  if (m.route && isHeavyInteractive(m, r._s)) return clientViewDraft(r, base, lang);
  const clientLines = new Set(strong.map((x) => x.line));
  const decls = F.hookDecls.filter((d) => clientLines.has(d.line));
  const sameEl = (x, y) => x.start === y.start && x.end === y.end;
  let units = decls.map((d) => ({ decls: [d], refs: F.jsxRefs.filter((x) => d.names.includes(x.name)) }));
  for (const sg of strong.filter((x) => x.el)) {
    if (!units.some((u) => u.refs.some((rf) => rf.start <= sg.el[0] && rf.end >= sg.el[1]))) {
      const el = F.jsxElements.find((e) => e.start === sg.el[0] && e.end === sg.el[1]) || { name: '?', start: sg.el[0], end: sg.el[1], isDom: true };
      units.push({ decls: [], refs: [{ name: null, element: el.name, isDom: el.isDom, start: el.start, end: el.end, attr: null, pure: false, line: sg.line }] });
    }
  }
  // merge units that touch the same element (e.g. a form using both register and handleSubmit)
  for (let changed = true; changed;) {
    changed = false;
    outer: for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
      if (units[i].refs.some((x) => units[j].refs.some((y) => sameEl(x, y)))) {
        units[i] = { decls: [...units[i].decls, ...units[j].decls], refs: [...units[i].refs, ...units[j].refs] };
        units.splice(j, 1); changed = true; break outer;
      }
    }
  }
  const root = F.jsxElements.reduce((best, e) => (!best || e.end - e.start > best.end - best.start ? e : best), null);
  const edits = []; // edits to the parent file
  const pushEdit = (e) => { edits.push(e); if (e[0] >= 0) taken.push([e[0], e[1]]); };
  const newFiles = [];
  const childFiles = [];
  const notes = [];
  const used = new Set();
  const nameFor = (want) => { let n = want, k = 2; while (used.has(n)) n = want + k++; used.add(n); return n; };
  const declText = (u) => u.decls.map((d) => m.text.slice(d.start, d.end).trim());
  const typeDeclsFor = (txt) => F.typeDecls.filter((t) => new RegExp(`(?<![\\w$])${escRe(t.name)}(?![\\w$])`).test(txt)).map((t) => m.text.slice(t.start, t.end));
  const handled = new Set();
  const taken = [];
  const free = (spans) => spans.every(([a, b]) => taken.every(([x, y]) => b <= x || a >= y));
  const take = (spans) => spans.forEach((sp) => taken.push(sp));
  for (const u of units) {
    const unitSpans = [...u.refs.map((x) => [x.start, x.end]), ...u.decls.map((d) => [d.start, d.end])];
    if (!free(unitSpans)) { plans.push(`${u.decls.map((d) => d.hook + '()').join(', ') || 'An event handler'} (line ${u.decls[0] ? u.decls[0].line : u.refs[0].line}) overlaps another change; handle it by hand after applying the code above.`); continue; }
    const els = u.refs.filter((x, i, a) => a.findIndex((y) => sameEl(x, y)) === i);
    const varNames = uniq(u.decls.flatMap((d) => d.names));
    const where = (e) => `<${e.element}> (line ${m.line(e.start)})`;
    if (!els.length) {
      u.decls.forEach((d) => handled.add(d.line));
      plans.push(`${u.decls.map((d) => `${d.hook}() (line ${d.line})`).join(', ')} is not used in JSX; move it (and the logic that uses it) into the client component that needs it.`);
      continue;
    }
    // A) the hook result only feeds props of ONE server-capable child → move the hook into that child
    if (els.length === 1 && !els[0].isDom && u.refs.every((x) => x.attr && x.pure) && u.decls.length === 1 && serverCapable(els[0].element)) {
      const child = serverCapable(els[0].element);
      const d = u.decls[0];
      const stmt = m.text.slice(d.start, d.end).trim();
      const call = (/=\s*([\s\S]+?);?\s*$/.exec(stmt) || [])[1] || `${d.hook}()`;
      const props = uniq(u.refs.map((x) => x.attr));
      const elText = m.text.slice(els[0].start, els[0].end);
      let newEl = elText;
      for (const pr of props) newEl = newEl.replace(new RegExp(`\\s+${escRe(pr)}=\\{\\s*[\\w$.]+\\s*\\}`), '');
      pushEdit([els[0].start, els[0].end, newEl]);
      pushEdit([...lineSpan(m.text, d.start, d.end), '']);
      handled.add(d.line);
      const hookImports = importsFor(m, call);
      let ct = child.text;
      const exp = child.facts.exports.find((e) => /^[A-Z]/.test(e.name));
      if (exp) {
        const sigLine = ct.split('\n')[exp.line - 1];
        const bodyOpen = ct.indexOf('{', ct.indexOf(sigLine) + sigLine.indexOf(')'));
        const only = props.length === 1 && new RegExp(`^\\{\\s*${escRe(props[0])}\\s*\\}`).test(exp.params);
        const assign = props.map((pr) => `  const ${pr} = ${call};`).join('\n');
        if (bodyOpen > 0) ct = ct.slice(0, bodyOpen + 1) + '\n' + assign + ct.slice(bodyOpen + 1);
        if (only) ct = ct.replace(exp.params, '');
        else notes.push(`Remove the ${props.join(', ')} prop from ${child.rel}'s props type.`);
      }
      ct = `"use client";\n\n${hookImports.join('\n')}\n${ct}`;
      childFiles.push({ file: child.rel, lang: langOf(child.rel), before: child.text.trimEnd(), after: ct.trimEnd() });
      notes.push(`${d.hook}() moves into <${els[0].element}> (${child.rel}), the only place that uses it; that small leaf becomes the Client Component instead of the whole ${m.route || 'file'}.`);
      continue;
    }
    // smallest element that contains every use
    const ca = F.jsxElements.filter((e) => els.every((x) => e.start <= x.start && e.end >= x.end)).sort((x, y) => (x.end - x.start) - (y.end - y.start))[0];
    const serverInside = ca ? m.facts.jsxComponents.filter((c) => c.start >= ca.start && c.end <= ca.end && serverCapable(c.name)) : [];
    // B) everything lives inside one small element with no server components in it → extract that element
    if (ca && ca !== root && !serverInside.length && m.line(ca.end) - m.line(ca.start) <= 60) {
      const want = ca.name === 'form' ? `${base}Form` : ca.name === 'button' ? `${base}Button` : `${base}Interactive`;
      const nm = nameFor(want);
      const caText = m.text.slice(ca.start, ca.end);
      const moved = [...declText(u), caText].join('\n');
      const parentIds = new Set(F.declared);
      const imported = new Set([...m.importMap.keys()]);
      const movedIds = uniq(moved.match(IDENT_RE) || []);
      const localParams = new Set([...caText.matchAll(/\(\s*([\w$]+)\s*\)\s*=>|\(([^()]*)\)\s*=>|([\w$]+)\s*=>/g)].flatMap((x) => (x[1] || x[2] || x[3] || '').split(/[\s,{}:]+/)).filter(Boolean));
      const freeVals = movedIds.filter((x) => parentIds.has(x) && !imported.has(x) && !varNames.includes(x) && !localParams.has(x) && !F.typeDecls.some((t) => t.name === x));
      const allClientVars = new Set(F.hookDecls.flatMap((d) => d.names));
      const blockers = freeVals.filter((x) => {
        const fn = new RegExp(`function\\s+${escRe(x)}\\b|(?:const|let)\\s+${escRe(x)}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[\\w$]+)\\s*=>|(?:const|let)\\s+${escRe(x)}\\s*=\\s*use(?:Callback|Memo)\\b`).test(m.text);
        const dm = new RegExp(`(?:const|let|var)\\s+(?:\\{[^}]*\\b${escRe(x)}\\b[^}]*\\}|\\[[^\\]]*\\b${escRe(x)}\\b[^\\]]*\\]|${escRe(x)})\\s*=\\s*([^;\\n]+)`).exec(m.text);
        const derived = dm && (/\buse[A-Z]/.test(dm[1]) || (dm[1].match(IDENT_RE) || []).some((i) => allClientVars.has(i)));
        return fn || derived;
      });
      if (blockers.length) {
        const pl = blockers.length > 1;
        plans.push(`<${ca.name}> (line ${m.line(ca.start)}) holds the interactive code, but it also uses ${blockers.map((x) => '`' + x + '`').join(', ')} from ${m.rel}, which ${pl ? 'are functions or values' : 'is a function or a value'} derived from client state, so ${pl ? 'they' : 'it'} cannot be passed in as a prop. Move ${pl ? 'them' : 'it'} (and what ${pl ? 'they depend' : 'it depends'} on) into the new client component together with this element.`);
        continue;
      }
      const pl = placementFor(m, all, nm);
      const propsSig = freeVals.length ? `{ ${freeVals.join(', ')} }: { ${freeVals.map((x) => `${x}: unknown`).join('; ')} }` : '';
      const code = [
        '"use client";', '',
        ...importsFor(m, moved),
        ...typeDeclsFor(moved).map((t) => '\n' + t),
        '', `export function ${nm}(${propsSig}) {`,
        ...declText(u).map((x) => '  ' + x),
        '  return (', indent(dedent(caText), '    '), '  );', '}',
      ].join('\n').replace(/\n{3,}/g, '\n\n');
      newFiles.push({ file: pl.file, lang, code });
      pushEdit([ca.start, ca.end, `<${nm}${freeVals.map((x) => ` ${x}={${x}}`).join('')} />`]);
      for (const d of u.decls) { pushEdit([...lineSpan(m.text, d.start, d.end), '']); handled.add(d.line); }
      pushEdit([-1, -1, `import { ${nm} } from "${pl.spec}";`]);
      if (freeVals.length) notes.push(`${nm} uses ${freeVals.join(', ')} from ${m.rel}; they are passed as props (replace \`unknown\` with the real types).`);
      continue;
    }
    // C) state shared by DOM controls and passed as a plain prop to server-capable components → a client "shell"
    const domEls = els.filter((e) => e.isDom);
    const compEls = els.filter((e) => !e.isDom);
    const compOk = compEls.length && compEls.every((e) => serverCapable(e.element) && u.refs.filter((x) => sameEl(x, e)).every((x) => x.attr && x.pure));
    const domTop = domEls.filter((e) => !domEls.some((o) => o !== e && o.start <= e.start && o.end >= e.end));
    const domOk = domTop.length && domTop.every((e) => !m.facts.jsxComponents.some((c) => c.start >= e.start && c.end <= e.end && serverCapable(c.name)));
    if (u.decls.length && compOk && domOk && compEls.length === 1) {
      const comp = compEls[0];
      const nm = nameFor(`${comp.element.split('.').pop()}Shell`);
      const stateProps = uniq(u.refs.filter((x) => sameEl(x, comp)).map((x) => ({ attr: x.attr, v: x.name })).map((x) => JSON.stringify(x))).map((x) => JSON.parse(x));
      const compText = m.text.slice(comp.start, comp.end);
      let compClean = compText;
      for (const sp of stateProps) compClean = compClean.replace(new RegExp(`\\s+${escRe(sp.attr)}=\\{\\s*${escRe(sp.v)}\\s*\\}`), '');
      const domTexts = domTop.map((e) => m.text.slice(e.start, e.end));
      const moved = [...declText(u), ...domTexts].join('\n');
      const pl = placementFor(m, all, nm);
      const dataAttrs = stateProps.map((sp) => ` data-${sp.attr.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())}={${sp.v}}`).join('');
      const code = [
        '"use client";', '',
        ...importsFor(m, moved),
        '', `export function ${nm}({ children }: { children: React.ReactNode }) {`,
        ...declText(u).map((x) => '  ' + x),
        '  return (', '    <>', ...domTexts.map((t) => indent(dedent(t), '      ')),
        `      <div${dataAttrs}>{children}</div>`, '    </>', '  );', '}',
      ].join('\n');
      newFiles.push({ file: pl.file, lang, code });
      for (const e of domTop) pushEdit([...lineSpan(m.text, e.start, e.end), '']);
      const ind = /^[ \t]*/.exec(m.text.slice(m.text.lastIndexOf('\n', comp.start - 1) + 1))[0];
      pushEdit([comp.start, comp.end, `<${nm}>\n${ind}  ${dedent(compClean).trim()}\n${ind}</${nm}>`]);
      for (const d of u.decls) { pushEdit([...lineSpan(m.text, d.start, d.end), '']); handled.add(d.line); }
      pushEdit([-1, -1, `import { ${nm} } from "${pl.spec}";`]);
      notes.push(`${varNames.join(' / ')} ${varNames.length > 1 ? 'are' : 'is'} shared by ${domTop.map(where).join(', ')} and ${where(comp)}. ${nm} now owns that state and renders the control(s); <${comp.element}> stays a Server Component, passed in as children. It no longer gets ${stateProps.map((x) => '`' + x.attr + '`').join(', ')} as a prop (remove it from ${serverCapable(comp.element).rel}) — style it from the wrapper instead (e.g. \`[data-${stateProps[0].attr}="true"] nav { … }\`).`);
      plans.push(`DOM order: the control(s) now render right before <${comp.element}> inside ${nm}, which can change the layout (flex/grid parents). If it matters, let ${nm} render the shared container instead and take <${comp.element}> and the rest as slot props / children, so the DOM stays exactly the same (references/patterns.md §5).`);
      plans.push(`Remove the \`${stateProps.map((x) => x.attr).join('`, `')}\` prop from ${serverCapable(comp.element).rel} (its type and every use inside it); it no longer receives it.`);
      continue;
    }
    u.decls.forEach((d) => handled.add(d.line));
    plans.push(`${varNames.length ? varNames.join(', ') + ` (from ${u.decls.map((d) => d.hook + '()').join(', ')})` : 'The event handler(s)'} are used by ${els.map(where).join(', ')}. These are spread across the tree${serverInside.length ? ` around server-capable components (${uniq(serverInside.map((c) => '<' + c.name + '>')).join(', ')})` : ''}, so no single small element can be extracted automatically. Pick the smallest wrapper by hand: a "use client" component that owns this state and receives the server parts as children.`);
  }
  // leftovers: client signals in the parent that no unit moved (effects, browser APIs outside JSX, …)
  const leftover = strong.filter((x) => !x.el && !handled.has(x.line) && !u_inDecl(x.line, decls, handled));
  for (const x of leftover) {
    if (x.cat === 'library') plans.push(`${x.label} (line ${x.line}): its components can only render inside Client Components — keep them in the new client component(s).`);
    else if (x.cat === 'hook' && /^(useEffect|useLayoutEffect)$/.test(x.hook || '')) plans.push(`${x.label} (line ${x.line}) has no UI of its own: move it into a tiny "use client" component that returns null, and render that from ${m.rel}.`);
    else plans.push(`${x.label} (line ${x.line}) still lives in ${m.rel}; move it into the client component that needs it.`);
  }
  // modules below this boundary that use client features without their own directive must get one
  const byRelAll = new Map(all.map((x) => [x.rel, x]));
  for (const t of r.fixTargets || []) {
    const o = byRelAll.get(t);
    if (!o || childFiles.some((c) => c.file === o.rel)) continue;
    childFiles.push({ file: o.rel, lang: langOf(o.rel), before: o.text.trimEnd(), after: `"use client";\n\n${o.text}`.trimEnd() });
    notes.push(`${o.rel} gets its own "use client": it uses client features and only worked because of the old boundary.`);
  }
  // types copied into new client components and no longer used by the parent leave the parent
  for (const t of F.typeDecls) {
    const declTxt = m.text.slice(t.start, t.end);
    if (!newFiles.some((nf) => nf.code.includes(declTxt))) continue;
    const rest = applyEdits(m.text, [...edits.filter((e) => e[0] >= 0), [t.start, t.end, '']]);
    if (!new RegExp(`(?<![\\w$])${escRe(t.name)}(?![\\w$])`).test(rest)) pushEdit([...lineSpan(m.text, t.start, t.end), '']);
  }
  const realEdits = edits.filter((e) => e[0] >= 0);
  const importAdds = edits.filter((e) => e[0] < 0).map((e) => e[2]);
  let parentAfter = applyEdits(m.text, realEdits);
  // remove the directive and dead imports, add the new component imports
  const pro = scanPrologue(parentAfter);
  const d = pro.directives.find((x) => x.value === 'use client');
  const blocking = plans.filter((x) => !/^DOM order:|^Remove the `/.test(x));
  if (d && !blocking.length) parentAfter = (parentAfter.slice(0, d.start) + parentAfter.slice(d.end)).replace(/^(\s*\n)+/, '');
  for (const l of importAdds) parentAfter = addImportLine(parentAfter, l);
  parentAfter = pruneImports(parentAfter).replace(/\n{3,}/g, '\n\n').replace(/\{\n[ \t]*\n(\s*return\b)/g, '{\n$1');
  const before = [{ file: m.rel, lang, code: m.text.trimEnd() }, ...childFiles.map((c) => ({ file: c.file, lang: c.lang, code: c.before }))];
  const after = [{ file: m.rel, lang, code: parentAfter.trimEnd() }, ...newFiles, ...childFiles.map((c) => ({ file: c.file, lang: c.lang, code: c.after }))];
  // the directive can only be dropped from the parent when nothing client-only is left in it
  return {
    partial: plans.length > 0, plans, before, after,
    note: `${m.rel} becomes a Server Component again${blocking.length ? ' once the plan below is done' : ''}; only the small interactive pieces keep "use client".${notes.length ? ' ' + notes.join(' ') : ''}`,
  };
}
function clientViewDraft(r, base, lang) {
  const m = r._m;
  const F = m.facts;
  const name = componentName(m);
  const viewName = `${base}${m.route === 'layout' ? 'Shell' : 'View'}`;
  const dir = path.posix.dirname(m.rel);
  const exp = F.exports.find((e) => e.isDefault) || F.exports.find((e) => e.name === name);
  let view = m.text;
  // the view keeps "use client" and all the code; only its export changes
  view = view.replace(new RegExp(`export\\s+default\\s+(async\\s+)?function\\s+${escRe(name)}\\b`), `export function ${viewName}`)
    .replace(new RegExp(`^export\\s+default\\s+${escRe(name)}\\s*;?\\s*$`, 'm'), `export { ${name} as ${viewName} };`);
  let meta = '';
  const mm = /^export\s+(const|let)\s+metadata\b[\s\S]*?;\s*$/m.exec(view);
  if (mm) { meta = mm[0]; view = view.replace(mm[0] + '\n', ''); }
  const metaImport = meta && /\bMetadata\b/.test(meta) ? 'import type { Metadata } from "next";\n' : '';
  view = pruneImports(view).replace(/\n{3,}/g, '\n\n');
  const hasProps = exp && exp.params && exp.params.trim();
  const isLayout = m.route === 'layout' || m.route === 'template';
  const page = [
    `${metaImport}import { ${viewName} } from "./${viewName}";`, '',
    meta ? meta + '\n' : null,
    isLayout
      ? `export default function ${name}({ children }: { children: React.ReactNode }) {\n  return <${viewName}>{children}</${viewName}>;\n}`
      : hasProps
        ? `export default function ${name}(props: React.ComponentProps<typeof ${viewName}>) {\n  // params/searchParams can be passed through as they are (Promises are allowed as Client props)\n  return <${viewName} {...props} />;\n}`
        : `export default function ${name}() {\n  return <${viewName} />;\n}`,
  ].filter((x) => x !== null).join('\n');
  return {
    before: [{ file: m.rel, lang, code: m.text.trimEnd() }],
    after: [{ file: m.rel, lang, code: page }, { file: `${dir}/${viewName}.${lang}`, lang, code: view.trimEnd() }],
    note: `The ${m.route} file becomes a Server Component that renders ${viewName}; ${viewName} is the same code as before, still "use client". JavaScript sent to the browser barely changes (this ${m.route} is interactive almost everywhere) — the win is that ${m.rel} can now export metadata, await params/searchParams and fetch initial data on the server, and new static sections stay Server Components by default. For a real bundle cut, look for big static parts inside ${viewName} and pass them in as children.`,
  };
}
function u_inDecl(line, decls, handled) { return decls.some((d) => d.line === line && handled.has(line)); }


// ---------- CHILDREN_PATTERN: the client wrapper keeps its state; heavy server-capable children are passed in from a Server Component
function childrenDraft(r, all, name, lang) {
  const m = r._m;
  const byAbs = new Map(all.map((x) => [x.abs, x]));
  const kids = [];
  for (const kid of r.fixTargets) {
    const entry = [...m.importMap.entries()].find(([, v]) => v.res.type === 'local' && v.res.file.split(path.sep).join('/').endsWith('/' + kid));
    if (!entry) continue;
    for (const jc of m.facts.jsxComponents.filter((c) => c.name.split('.')[0] === entry[0])) kids.push({ local: entry[0], imp: entry[1], jc, file: byAbs.get(entry[1].res.file) });
  }
  kids.sort((x, y) => x.jc.start - y.jc.start);
  if (!kids.length) return null;
  // contiguous siblings → one {children}; otherwise one named slot prop per child
  const contiguous = kids.every((k, i) => i === 0 || /^\s*$/.test(m.text.slice(kids[i - 1].jc.end, k.jc.start)));
  const slotNames = new Map();
  kids.forEach((k) => { const b = k.local.charAt(0).toLowerCase() + k.local.slice(1); let n = b, i = 2; while ([...slotNames.values()].includes(n)) n = b + i++; slotNames.set(k, n); });
  const slotName = (k) => slotNames.get(k);
  const edits = [];
  if (contiguous) {
    edits.push([kids[0].jc.start, kids[kids.length - 1].jc.end, '{children}']);
  } else {
    for (const k of kids) edits.push([k.jc.start, k.jc.end, `{${slotName(k)}}`]);
  }
  let wrapper = applyEdits(m.text, edits);
  const slots = contiguous ? ['children'] : kids.map(slotName);
  const exp = m.facts.exports.find((e) => e.name === name);
  if (exp) {
    const sigLine = m.text.split('\n')[exp.line - 1];
    let newSig = sigLine;
    const slotT = slots.map((x) => `${x}: React.ReactNode`).join('; ');
    if (/\(\s*\)/.test(sigLine)) newSig = sigLine.replace(/\(\s*\)/, `({ ${slots.join(', ')} }: { ${slotT} })`);
    else if (/\(\s*\{/.test(sigLine)) newSig = sigLine.replace(/\(\s*\{\s*/, `({ ${slots.join(', ')}, `).replace(/\}\s*:\s*\{\s*/, `}: { ${slotT}; `);
    wrapper = wrapper.replace(sigLine, newSig);
  }
  wrapper = pruneImports(wrapper);
  const notes = [];
  const namedType = exp && /\}\s*:\s*([A-Z][\w$.<>]*)\s*$/.exec((exp.params || '').trim());
  if (namedType) notes.push(`Add ${slots.map((x) => '`' + x + ': React.ReactNode`').join(', ')} to the ${namedType[1]} type.`);
  // drop props that only the moved children used (inline destructure + inline type only)
  const droppedProps = [];
  if (exp) {
    const params = (/^\{([^}]*)\}/.exec((exp.params || '').trim()) || [])[1];
    if (params) {
      const body = wrapper.slice(wrapper.indexOf('{', wrapper.indexOf(name)) + 1);
      const afterSig = body.slice(body.indexOf(')') + 1);
      const unusedP = params.split(',').map((x) => x.trim().split(/[:=\s]/)[0]).filter((x) => x && !slots.includes(x) && !new RegExp(`(?<![\\w$.])${escRe(x)}(?![\\w$])`).test(afterSig));
      const sigNow = wrapper.split('\n').find((l) => new RegExp(`function\\s+${escRe(name)}\\b|const\\s+${escRe(name)}\\b`).test(l));
      if (sigNow && /\}\s*:\s*\{/.test(sigNow)) {
        let sig2 = sigNow;
        for (const x of unusedP) {
          sig2 = sig2.replace(new RegExp(`([({,]\\s*)${escRe(x)}\\s*,\\s*`), '$1').replace(new RegExp(`,\\s*${escRe(x)}\\s*(?=\\})`), '');
          sig2 = sig2.replace(new RegExp(`;?\\s*${escRe(x)}\\??\\s*:\\s*[^;}]+(?=[;}])`), '');
          droppedProps.push(x);
        }
        sig2 = sig2.replace(/\{\s*;\s*/g, '{ ').replace(/;\s*;/g, ';').replace(/\{\s*([^{}]*?)\s*\}/g, (x, inner) => `{ ${inner.trim()} }`);
        wrapper = pruneImports(wrapper.replace(sigNow, sig2));
      }
      else if (unusedP.length) notes.push(`${unusedP.map((x) => '`' + x + '`').join(', ')} ${unusedP.length > 1 ? 'are' : 'is'} no longer used inside ${name}; drop ${unusedP.length > 1 ? 'them' : 'it'} from its props type.`);
    }
  }
  const before = [{ file: m.rel, lang, code: m.text.trimEnd() }];
  const after = [{ file: m.rel, lang, code: wrapper.trimEnd() }];
  const importerRef = r.importers.map((i) => all.find((x) => x.rel === i.file)).filter(Boolean).find((imp) => imp.facts.jsxComponents.some((c) => c.name === name || c.name.split('.')[0] === name) && !imp.useClient)
    || r.importers.map((i) => all.find((x) => x.rel === i.file)).filter(Boolean)[0];
  if (importerRef) {
    const use = importerRef.facts.jsxComponents.find((c) => c.name === name || c.name.split('.')[0] === name);
    if (use) {
      const usageBefore = importerRef.text.slice(use.start, use.end);
      // the wrapper's props, as the importer passes them → substitute into the children's JSX
      const passed = {};
      for (const mm of usageBefore.matchAll(/\s([A-Za-z_$][\w$]*)=\{([^{}]+)\}/g)) passed[mm[1]] = mm[2].trim();
      const subst = (t) => t.replace(IDENT_RE, (id, off, str) => (passed[id] && passed[id] !== id && str[off - 1] !== '.' && str[off + id.length] !== '=' ? passed[id] : id));
      const kidJsx = kids.map((k) => subst(dedent(m.text.slice(k.jc.start, k.jc.end)).trim()));
      const ws = /^[ \t]*/.exec(importerRef.text.slice(importerRef.text.lastIndexOf('\n', use.start - 1) + 1))[0];
      let usageAfter;
      if (contiguous) {
        usageAfter = /\/>\s*$/.test(usageBefore)
          ? usageBefore.replace(/\s*\/>\s*$/, `>\n${kidJsx.map((k) => ws + '  ' + k).join('\n')}\n${ws}</${name}>`)
          : usageBefore.replace(new RegExp(`</${escRe(name)}>\\s*$`), `${kidJsx.map((k) => '  ' + k).join('\n')}\n</${name}>`);
      } else {
        usageAfter = usageBefore.replace(new RegExp(`^<${escRe(name)}`), `<${name}${kids.map((k, i) => ` ${slotName(k)}={${kidJsx[i]}}`).join('')}`);
      }
      // import lines for the children, written the way the importer already imports the wrapper
      const wrapperSpec = (importerRef.facts.imports.find((im) => [im.defaultLocal, ...im.names.map((n) => n.local)].includes(name)) || {}).spec;
      const importLines = uniq(kids.map((k) => {
        const kidBase = path.basename(k.file.abs).replace(/\.[^.]+$/, '');
        let spec;
        if (wrapperSpec && path.dirname(k.file.abs) === path.dirname(m.abs)) spec = wrapperSpec.replace(/[^/]+$/, kidBase);
        else { spec = path.relative(path.dirname(importerRef.abs), k.file.abs).split(path.sep).join('/').replace(/\.[^.]+$/, ''); if (!spec.startsWith('.')) spec = './' + spec; }
        return k.imp.imported === 'default' ? `import ${k.local} from "${spec}";` : `import { ${k.imp.imported}${k.imp.imported !== k.local ? ' as ' + k.local : ''} } from "${spec}";`;
      }));
      usageAfter = (ws + usageAfter).split('\n').map((l) => (l.startsWith(ws) ? l.slice(ws.length) : l)).join('\n');
      for (const x of droppedProps) usageAfter = usageAfter.replace(new RegExp(`\\s+${escRe(x)}=\\{[^{}]*\\}`), '');
      let importerAfter = importerRef.text.slice(0, use.start) + usageAfter.split('\n').map((l, i) => (i === 0 ? l : ws + l)).join('\n') + importerRef.text.slice(use.end);
      for (const l of importLines) if (!importerAfter.includes(l)) importerAfter = addImportLine(importerAfter, l);
      before.push({ file: importerRef.rel, lang: langOf(importerRef.rel), code: importerRef.text.trimEnd() });
      after.push({ file: importerRef.rel, lang: langOf(importerRef.rel), code: importerAfter.trimEnd() });
      if (importerRef.useClient) notes.push(`${importerRef.rel} is itself a Client Component, so the children only leave the bundle once they are rendered from a Server Component higher up.`);
    }
  } else notes.push(`No importer of ${m.rel} was found in the scanned folders; render the children wherever <${name}> is used.`);
  const stateDep = kids.filter((k) => k.jc.attrIdents.some((x) => m.facts.stateVars.includes(x)));
  if (stateDep.length) notes.push(`${stateDep.map((k) => '<' + k.local + '>').join(', ')} read client state, so they cannot move as-is — keep them inside ${name} or lift that state.`);
  return {
    before, after, partial: stateDep.length > 0,
    risks: ['The passed-in content is rendered on the server on every request, even while the component is closed/hidden (before, it rendered only when opened). Usually cheaper than shipping it as JS; for very expensive content wrap it in <Suspense> or load it on open.'],
    note: `${droppedProps.length ? `${droppedProps.map((x) => '`' + x + '`').join(', ')} ${droppedProps.length > 1 ? 'were' : 'was'} only used by the moved content, so ${droppedProps.length > 1 ? 'they are' : 'it is'} removed from ${name}'s props (no need to serialize ${droppedProps.length > 1 ? 'them' : 'it'} to the client). ` : ''}${name} stays a Client Component (it needs interactivity), but ${kids.map((k) => '<' + k.local + '>').join(' and ')} ${kids.length > 1 ? 'are' : 'is'} now rendered by a Server Component and passed in ${contiguous ? 'as children' : 'through slot props'}, so ${kids.length > 1 ? 'their' : 'its'} code and dependencies (${uniq(kids.map((k) => k.file.rel)).join(', ')}) leave the client bundle. Server Components passed as props are rendered on the server first, so this keeps working inside a Client Component.${notes.length ? ' ' + notes.join(' ') : ''}`,
  };
}

// ---------- MOVE_FETCH: the component becomes async and fetches on the server; the JSX it returned stays the same
function moveFetchDraft(r, name, lang) {
  const m = r._m;
  const F = m.facts;
  const f0 = r.fetches.find((x) => x.inEffect) || r.fetches[0];
  const url = f0 && f0.url ? f0.url : '';
  const exp = F.exports.find((e) => e.name === name) || { params: '' };
  // the state variable that receives the data and its useState<T> type
  const stateDecl = F.hookDecls.find((d) => /^(useState|useReducer)$/.test(d.hook)) || null;
  const stateVar = (stateDecl && stateDecl.names[0]) || F.stateVars[0] || 'data';
  const typeArg = stateDecl ? (/use(?:State|Reducer)\s*<([^>]+(?:<[^>]*>)?[^>]*)>/.exec(m.text.slice(stateDecl.start, stateDecl.end)) || [])[1] : null;
  const root = F.jsxElements.reduce((best, e) => (!best || e.end - e.start > best.end - best.start ? e : best), null);
  let jsx = root ? dedent(m.text.slice(root.start, root.end)) : null;
  if (!jsx) {
    // regex mode: take the JSX after the component's `return (`
    const code = lex(m.text).code;
    const rm = /\breturn\s*\(\s*<([A-Za-z][\w.]*|>)/g;
    let last = null, mm;
    while ((mm = rm.exec(code))) last = mm;
    if (last) { const st = last.index + last[0].length - last[1].length - 1; const sp = jsxElementSpan(code, st, last[1] === '>' ? null : last[1]); jsx = dedent(m.text.slice(sp[0], sp[1])); }
  }
  const keepImports = m.text.split('\n').filter((l) => /^import\b/.test(l.trim()) && !/from\s+['"](react|swr|@tanstack\/react-query|axios)['"]/.test(l));
  const types = F.typeDecls.map((t) => m.text.slice(t.start, t.end));
  const relative = /^[`'"]\//.test(url);
  const fetchExpr = f0 && f0.kind === 'dataHook'
    ? `await fetch(${url || '/* the URL your query function calls */'}).then((r) => r.json()) // was ${f0.hook}()`
    : `await fetch(${url}, { next: { revalidate: 60 } }).then((r) => r.json())`;
  const code = [
    ...keepImports, ...(keepImports.length ? [''] : []), ...types, ...(types.length ? [''] : []),
    `export default async function ${name}(${exp.params || ''}) {`,
    `  const ${stateVar}${typeArg ? ': ' + typeArg : ''} = ${fetchExpr};`,
    jsx ? `  return (\n${indent(jsx, '    ')}\n  );` : '  // render what the component rendered before',
    '}',
  ].join('\n');
  const notes = [];
  if (relative) {
    const rootAbs = m.abs.slice(0, m.abs.length - m.rel.length);
    const routePath = (/^[`'"](\/[^?`'"$]*)/.exec(url) || [])[1] || '';
    const segs = routePath.replace(/\/$/, '');
    const candidates = ['app', 'src/app'].flatMap((d) => ['ts', 'js'].map((e) => path.join(rootAbs, d, segs, `route.${e}`)));
    const found = candidates.find((c) => isFile(c));
    notes.push(`The URL is relative (${url.slice(0, 48)}). fetch() on the server needs an absolute URL, and calling your own API route from a Server Component is an extra network hop. Better: call the function behind that route directly.${found ? ` The route lives in ${rel(rootAbs, found)}; move its data logic into a function both can call.` : ` No route file for ${segs || 'this path'} was found in this project (it may be a rewrite/proxy or another service) — ask where the data comes from before writing the final code.`}`);
  }
  notes.push('Wrap it in <Suspense fallback={…}> where it is rendered, so the rest of the page streams without waiting for this fetch.');
  notes.push('`revalidate: 60` is a placeholder cache choice; pick what matches how fresh the data must be (`cache: "no-store"` for per-request data).');
  return {
    before: [{ file: m.rel, lang, code: m.text.trimEnd() }],
    after: [{ file: m.rel, lang, code }],
    partial: relative,
    plans: relative ? ['Replace the relative URL with a direct call to the data source (or an absolute URL) — see the note. Do not ship it with the relative URL: it fails on the server.'] : [],
    note: `"use client", useState and useEffect are gone: the data is fetched on the server before the HTML is sent, so there is no loading state and no fetch code in the browser. ${notes.join(' ')}`,
  };
}

function buildDraft(r, all) {
  const m = r._m;
  const lang = langOf(m.rel);
  const name = componentName(m);
  if (r.fix === 'REMOVE') {
    return {
      before: [{ file: m.rel, lang, code: m.text.trimEnd() }],
      after: [{ file: m.rel, lang, code: withoutDirective(m).trimEnd() }],
      note: 'Only the directive line is removed; nothing else changes. The file becomes a Server Component.',
    };
  }
  if (r.fix === 'PUSH_DOWN' && r.fixTargets.length && !r._s.strong.length) {
    const tgt = r.fixTargets.map((t) => all.find((x) => x.rel === t)).filter(Boolean);
    return {
      before: [{ file: m.rel, lang, code: m.text.trimEnd() }, ...tgt.map((t) => ({ file: t.rel, lang: langOf(t.rel), code: t.text.trimEnd() }))],
      after: [{ file: m.rel, lang, code: withoutDirective(m).trimEnd() }, ...tgt.map((t) => ({ file: t.rel, lang: langOf(t.rel), code: `"use client";\n\n${t.text}`.trimEnd() }))],
      note: `The directive moves from ${m.rel} down to ${tgt.map((t) => t.rel).join(', ')} — the only file(s) that actually use client features.`,
    };
  }
  if (r.fix === 'PUSH_DOWN') return pushDownOwnDraft(r, all);
  if (r.fix === 'CHILDREN_PATTERN' && r.fixTargets.length) return childrenDraft(r, all, name, lang);
  if (r.fix === 'CHILDREN_PATTERN') {
    return {
      before: [{ file: m.rel, lang, code: m.text.trimEnd() }],
      after: [
        { file: `${path.posix.dirname(m.rel)}/providers.${lang}`, lang, code: `"use client";\n\n// move the context/provider code from ${m.rel} here\nexport function Providers({ children }: { children: React.ReactNode }) {\n  // …state + <Context.Provider value={…}>{children}</Context.Provider>\n  return <>{children}</>;\n}` },
        { file: m.rel, lang, code: `import { Providers } from "./providers";\n\n${withoutDirective(m).trimEnd()}` },
      ],
      note: 'The route file becomes a Server Component that wraps its children in a thin client Providers component.',
    };
  }
  if (r.fix === 'MOVE_FETCH') return moveFetchDraft(r, name, lang);
  return null;
}

// ------------------------------------------------------------------------------------------ Markdown report
const clip = (code, n) => { const l = code.split('\n'); return l.length > n ? l.slice(0, n).join('\n') + `\n// … (${l.length - n} more lines)` : code; };
const mdCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
function toMarkdown(res) {
  if (!res.appRouter) return `# "use client" audit\n\n> ${res.message}\n`;
  const S = res.summary;
  const o = [];
  o.push(`# "use client" audit — ${path.basename(res.root)}`);
  o.push('');
  o.push(`_Next.js ${res.nextVersion || '?'} · parser: ${res.parser.name}${res.parser.exact ? '' : ' ⚠️'} · ${S.filesScanned} files scanned in ${res.scanDirs.join(', ')} · read-only_`);
  o.push('');
  o.push('## 1. Summary');
  o.push('');
  const pl = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  o.push(`- **${pl(S.useClientFiles, 'file starts', 'files start')}** with \`"use client"\`.`);
  o.push(`- **${S.unnecessary}** ${S.unnecessary === 1 ? 'is' : 'are'} unnecessary (the file itself uses no client-only code).`);
  if (S.tooBroad) o.push(`- **${S.tooBroad}** ${S.tooBroad === 1 ? 'is' : 'are'} needed but too broad (the boundary sits higher than it should).`);
  o.push(`- **${pl(S.highPriority, 'finding is', 'findings are')}** High priority.`);
  if (S.needsManualCheck) o.push(`- **${S.needsManualCheck}** ${S.needsManualCheck === 1 ? 'needs' : 'need'} a manual check (the analysis was not conclusive).`);
  o.push(`- ${S.necessary} ${S.necessary === 1 ? 'is' : 'are'} correctly placed${S.required ? `, ${S.required} ${S.required === 1 ? 'is' : 'are'} required by Next.js (error boundaries)` : ''}.`);
  if (!res.parser.exact) o.push(`\n> ⚠️ ${res.warnings.find((w) => w.type === 'parser-fallback').message}`);
  o.push('');
  o.push('## 2. Priority table');
  o.push('');
  if (!res.findings.length) o.push('No findings — every `"use client"` in this project is needed and placed as low as it can go. 🎉');
  else {
    o.push('| File | Why it is flagged | Priority | Fix type | Estimated modules affected |');
    o.push('|---|---|---|---|---|');
    for (const f of res.findings) {
      const why = (f.status === 'Needs manual check' ? '**Needs manual check** — ' : '') + f.why.map((w) => w.replace(/^  · /, '· ')).join(' ');
      const mods = `≈${f.estimatedModules}${f.estimatedPackages.length ? ` + ${f.estimatedPackages.length} npm (${f.estimatedPackages.slice(0, 3).join(', ')}${f.estimatedPackages.length > 3 ? '…' : ''})` : ''}`;
      o.push(`| \`${mdCell(f.file)}\` | ${mdCell(why)} | ${f.priority} | ${f.fix}${f.fixTargets.length ? ` → ${f.fixTargets.map((t) => '`' + t + '`').join(', ')}` : ''} | ${mods} |`);
    }
    o.push('');
    o.push(`_Estimated modules = the file + local modules its boundary pulls into the client bundle. ${res.estimateNote.split('. ').slice(1).join('. ')}_`);
  }
  const other = res.warnings.filter((w) => w.type !== 'parser-fallback');
  if (other.length) {
    o.push('');
    o.push('**Also noticed:**');
    other.forEach((w) => { o.push(`- ${w.message}`); (w.items || []).slice(0, 8).forEach((x) => o.push(`  - ${x}`)); });
  }
  o.push('');
  o.push(`## 3. Before / After — top ${Math.min(res._top || 3, res.findings.length)}`);
  o.push('');
  const top = [...res.findings.filter((f) => f.status !== 'Needs manual check'), ...res.findings.filter((f) => f.status === 'Needs manual check')].slice(0, res._top || 3);
  if (!top.length) o.push('_Nothing to change._');
  top.forEach((f, i) => {
    const d = f.draft;
    o.push(`### ${i + 1}. \`${f.file}\` — ${f.fix} (${f.priority})`);
    o.push('');
    if (!d) { o.push('_No automatic draft for this case; see the notes above._'); o.push(''); return; }
    if (f.status === 'Needs manual check') {
      o.push('> ⚠️ **Needs manual check — not a ready fix.** The analysis could not confirm this is safe.');
      o.push('');
      o.push('**How to decide:**');
      f.why.filter((w) => /^  · /.test(w)).forEach((w) => o.push(`- ${w.replace(/^  · /, '')} → check whether it uses React hooks or browser APIs inside (or ships its own "use client"). If it does, keep the directive; if not, ${f.fix === 'REMOVE' ? 'remove it' : 'apply the fix'}.`));
      o.push('- Until that is confirmed, **keep the directive** — it is the safe default (and it may become required once a boundary above it moves down).');
      o.push('');
      o.push('`' + f.file + '`');
      o.push('```' + (d.before[0] || {}).lang);
      o.push(clip((d.before[0] || {}).code || '', 30));
      o.push('```');
      o.push('');
      return;
    }
    o.push('**Before**');
    o.push('');
    d.before.forEach((b) => { o.push(`\`${b.file}\``); o.push('```' + b.lang); o.push(clip(b.code, 60)); o.push('```'); });
    if (d.after.length) {
      o.push(d.partial ? '**After (partial draft — finish the plan below)**' : '**After**');
      o.push('');
      d.after.forEach((b) => { o.push(`\`${b.file}\``); o.push('```' + b.lang); o.push(clip(b.code, 60)); o.push('```'); });
    }
    if (d.plans && d.plans.length) { o.push('**Plan (write this part from the real file):**'); d.plans.forEach((p) => o.push(`- ${p}`)); o.push(''); }
    o.push(`> ${d.note}`);
    if (f.risks.length) { o.push('>'); f.risks.forEach((r) => o.push(`> ⚠️ ${r}`)); }
    o.push('');
  });
  o.push('## 4. How to verify');
  o.push('');
  const brokenNow = res.findings.some((f) => f.risks.some((x) => x.startsWith('Build error today')));
  if (brokenNow) o.push('1. `next build` probably fails today (see "Build error today" above), so there are no "before" numbers. Fix that finding first, then use that build as the baseline.');
  else o.push('1. Before changing anything: `next build` and save the route table (the "First Load JS" column per route).');
  o.push('2. Apply one fix at a time, then run `next build` again. A correct fix keeps the build green and lowers First Load JS for the affected routes.');
  o.push('3. Click through the affected pages: every button, form and modal must still work (a missed hook or handler shows up as a build error or a dead button).');
  o.push('4. Optional: `ANALYZE=true next build` with `@next/bundle-analyzer` to see the client chunks shrink.');
  o.push('');
  return o.join('\n');
}

// ------------------------------------------------------------------------------------------ main
function publicJson(res) {
  if (!res.appRouter) return res;
  const strip = (r) => { const { _m, _s, _ds, ...rest } = r; return rest; };
  const { _top, _all, ...rest } = res;
  return { ...rest, findings: res.findings.map(strip), files: res.files.map((r) => { const { draft, ...x } = strip(r); return x; }) };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return 0; }
  if (opts.version) { console.log(VERSION); return 0; }
  const res = analyze(opts);
  if (res.appRouter) {
    const allM = res._all;
    for (const f of res.findings) { try { f.draft = buildDraft(f, allM); if (f.draft && f.draft.risks) f.risks.push(...f.draft.risks.filter((x) => !f.risks.includes(x))); } catch (e) { f.draft = null; f.risks.push(`(could not build a code draft: ${e.message})`); } }
  }
  const md = toMarkdown(res);
  const json = JSON.stringify(publicJson(res), null, 2);
  if (opts.json) fs.writeFileSync(opts.json, json);
  if (opts.md) fs.writeFileSync(opts.md, md);
  process.stdout.write((opts.format === 'md' ? md : json) + '\n');
  return res.appRouter ? 0 : 2;
}

if (require.main === module) {
  try { process.exitCode = main(); } catch (e) { console.error(`nextjs-client-audit: ${e.message}`); process.exitCode = 1; }
}
module.exports = { analyze, scanPrologue, lex, toMarkdown, buildDraft, DEFAULT_CONFIG, VERSION };
