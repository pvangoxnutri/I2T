/** The domain model lives in src/shared so the Electron main process and
 * the renderer share one set of types. This shim keeps renderer imports
 * (`../types`) unchanged. */
export * from '../../shared/types'
