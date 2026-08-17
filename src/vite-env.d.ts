/**
 * Ambient declarations for Vite's `?raw` imports.
 *
 * src/index.tsx inlines ~25 migration files as strings so production can
 * self-heal its schema (`ensureFullSchema`). Vite resolves `?raw` at build time
 * and returns the file contents; TypeScript has no idea what that suffix means
 * and reported every one as a missing module, which is a quarter of the errors
 * that kept this file out of the typecheck gate.
 *
 * Declared here rather than loosening the compiler, because the import IS
 * meaningful — it is a string, and saying so is more useful than silencing it.
 */
declare module '*.sql?raw' {
  const content: string;
  export default content;
}

declare module '*?raw' {
  const content: string;
  export default content;
}
