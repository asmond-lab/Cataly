import type { Subprocess } from "bun";

/** Bound only our foreground child. Detached descendants are not supervised. */
export function scheduleTimeout(proc: Subprocess, seconds: number | undefined) {
  let timedOut = false;
  let force: Timer | undefined;
  const timer =
    seconds === undefined
      ? undefined
      : setTimeout(() => {
          if (proc.exitCode !== null || proc.signalCode !== null) return;
          timedOut = true;
          proc.kill();
          force = setTimeout(() => proc.kill("SIGKILL"), 5000);
        }, seconds * 1000);
  return {
    expired: () => timedOut,
    clear: () => {
      clearTimeout(timer);
      clearTimeout(force);
    },
  };
}
