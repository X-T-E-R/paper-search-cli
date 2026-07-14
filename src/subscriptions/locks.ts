/** Compatibility surface for the shared runtime lock primitive. */
export {
  acquireLock,
  withLocks,
  type HeldLock,
  type LockOptions,
} from "../runtime/locks.js";
