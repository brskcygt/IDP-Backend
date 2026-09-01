# React (JSX & TSX) Modern Frontend Engineering Directives

## 1. Environment & Dialect Detection (Strict)
- **Respect Project Dialect:**
  - If the project or file is in **JavaScript/JSX (`.jsx`, `.js`)**, write pure modern JSX/JS. **Do NOT convert files to TSX/TS** or introduce TypeScript syntax unless explicitly requested.
  - If the project uses **TypeScript (`.tsx`, `.ts`)**, apply strict TypeScript typing rules.
- **Always preserve existing file extensions** without arbitrarily migrating between JS and TS.

## 2. File Size Limits & Single-Component Rule (Strict)
- **Line Thresholds:**
  - **Page & View Containers:** Maximum **850 lines** per `.jsx` / `.tsx` file.
  - **Modular / Reusable Components:** Maximum **200 lines** per `.jsx` / `.tsx` file.
  - **Custom Hooks & Services:** Maximum **150 lines** per `.js` / `.ts` file.
  - **Pure Utilities & Helper Functions:** Maximum **100 lines** per `.js` / `.ts` file.
- **Decomposition Mandate:**
  - If a **Page** approaches 850 lines, decompose it into semantic section components (e.g., `HeaderSection.jsx`, `DataTableSection.jsx`, `ActionModal.jsx`) located in a local `components/` subfolder.
  - If a **Component** exceeds 200 lines, extract internal business logic into a dedicated hook (e.g., `useComponentLogic.js`) or split child UI atoms into standalone files.
- **Single Component Per File:**
  - Every component file must declare and export **exactly one component or page**.
  - **Zero Local UI Declarations:** Never write inline secondary sub-components (e.g., `const ListItem = () => ...`, `function CardHeader() { ... }`) inside the same file.
  - Every UI element that has its own JSX structure must live in its own separate file and be imported explicitly.

## 3. JavaScript (JSX) & TypeScript (TSX) Standards
- **When working in JavaScript / JSX (`.jsx`, `.js`):**
  - Use modern ES6+ syntax (destructuring, optional chaining `?.`, nullish coalescing `??`, arrow functions).
  - Use `PropTypes` or comprehensive JSDoc comments (`/** @param {...} */`) for component props and complex functions where applicable in the codebase.
  - Write defensive runtime checks for nested objects, API responses, and function callbacks.
- **When working in TypeScript / TSX (`.tsx`, `.ts`):**
  - **Zero `any` Policy:** Use strict generic types, discriminated unions for state variants, and exact types.
  - Explicitly type all component props, event handlers (`React.MouseEvent`, `React.ChangeEvent`), and API responses.

## 4. Testing & Verification Rules (Strict)
- **Conditional Testing Policy:**
  - **Existing Test Setup:** Check `package.json` and project files for an existing test framework (`jest`, `vitest`, `@testing-library/react`, `cypress`, `playwright`). If a test infrastructure exists, write unit/component tests for new features and run tests to verify.
  - **No Test Setup:** If the project does **NOT** have an existing test setup, **DO NOT write test files**, do not install test frameworks, and do not attempt to run test commands. Focus directly on code implementation and linting/type verification.
- **Validation Gate:** Always run existing linters (`eslint`) and type checks (`tsc --noEmit` if TS) before marking tasks complete.

## 5. Sub-Agent Orchestration & Frontend Workflow
- **Architect/Worker Separation:**
  - **Planning (Architect):** For component redesigns, complex state refactoring, or new views, outline the component breakdown, folder structure, state flow, and props contracts before modifying code.
  - **Worker Tasks:** Delegate asset searches, icon imports, CSS/Tailwind class lookups, package checks (`package.json`), and build validations to background sub-agents.
- **Context Isolation:** Do not output raw build traces, bundle analyzer dumps, or entire SVG files into the conversation. Keep responses focused on actionable code.

## 6. React Architecture & Component Design
- **Functional Components Only:** Use modern functional components with hooks. Avoid class components entirely.
- **Custom Hooks for Logic:** Extract business logic, complex effects, event listeners, and API calls into dedicated custom hooks (`useAuth`, `useDebounce`, `useTableFilter`).
- **Composition over Prop Drilling:** Use component composition (`children` prop) or Context API/Zustand where appropriate to prevent prop drilling deeper than 2 levels.

## 7. State Management & Lifecycle Hygiene
- **Minimal State:** Derive values during render where possible instead of synchronizing duplicate state via `useEffect`.
- **`useEffect` Guardrails:**
  - Never use `useEffect` for data transformation that can be computed synchronously or memoized.
  - Always provide accurate dependency arrays; never suppress hook linter rules.
  - Always clean up side effects (event listeners, timers, abort controllers for fetch requests).
- **Form State:** Prefer uncontrolled components or performant libraries (e.g., React Hook Form) over heavy re-rendering controlled forms.

## 8. Performance, Rendering & Bundle Optimization
- **Re-render Prevention:**
  - Use `React.memo`, `useMemo`, and `useCallback` deliberately for computationally expensive operations or referential equality in dependency arrays.
  - Ensure stable object/array references passed as props to memoized children.
- **Code Splitting & Lazy Loading:**
  - Use `React.lazy` and `Suspense` for heavy routes, modals, and third-party charts/editors.
  - Prefer tree-shakeable named imports over default whole-library imports (e.g., icons, lodash-es).
- **DOM & Asset Optimization:**
  - Set explicit `key` props on mapped elements using unique entity IDs (never use array index for dynamic/reorderable lists).
  - Ensure images, svgs, and fonts use modern formats with lazy-loading and explicit layout dimensions.

## 9. Styling, UI/UX & Accessibility (a11y)
- **Styling Conventions:** Follow existing project styling systems (Tailwind CSS, CSS Modules, Styled Components, or UI component libraries) consistently.
- **Semantic HTML & a11y:**
  - Use semantic tags (`<nav>`, `<main>`, `<article>`, `<button>`, `<aside>`) instead of nested `<div>` soup.
  - Ensure interactive elements are keyboard-accessible with proper ARIA attributes (`aria-expanded`, `aria-label`, `role`).
- **Responsive & Defensive UI:**
  - Implement mobile-first responsive design.
  - Always handle UI states gracefully: **Loading (skeletons/spinners)**, **Empty**, **Error**, and **Success**.
- **Token Optimization:** Apply surgical diffs to JSX/TSX files.