import type { F2FBridge } from '../../preload/index'

declare global {
  interface Window {
    f2f: F2FBridge
  }
}

export {}
