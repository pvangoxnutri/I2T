/**
 * Asset imports.
 *
 * Vite turns `import logo from './x.png'` into a URL string, but the
 * project does not pull in `vite/client`, so TypeScript has no idea what
 * such an import is. Declared explicitly rather than by referencing the
 * whole of Vite's ambient types — this is the only kind of asset the
 * renderer imports, and a narrow declaration cannot quietly widen what
 * else the compiler accepts.
 */
declare module '*.png' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}
