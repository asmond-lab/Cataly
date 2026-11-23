/** Only these exact historical field values are aliases. Contents and record identities remain opaque. */
export const parseCatalyRole = (value: unknown): "cataly" | "lane" | undefined => {
  if (value === "cataly" || value === "dori") return "cataly";
  if (value === "lane") return "lane";
  return undefined;
};

export const isCatalyEntry = (value: unknown, current: `omp-cataly:${string}`): boolean =>
  value === current || value === `omp-dori:${current.slice("omp-cataly:".length)}`;

// Persist the exact v0.1.3 ABI for state that its immutable rollback reader must still interpret.
// The unreleased Cataly spellings remain readable in chronological order; never dual-write.
export const SESSION_WIRE = {
  role: "omp-dori:role",
  monitor: "omp-dori:monitor",
  intake: "omp-dori:intake",
  monitorBootstrap: "omp-dori:monitor-bootstrap",
  lanePolicy: "omp-dori:lane-policy",
  laneReceiver: "omp-dori:discord-lane-receiver",
  askLane: "omp-dori:discord-ask-lane",
  remoteOwner: "omp-dori:native-remote-owner",
  admissionRejected: "omp-dori:admission-rejected",
  monitorMessage: "dori-monitor",
} as const;

export const MONITOR_MESSAGE = "cataly-monitor";
export const isMonitorMessage = (value: unknown): boolean =>
  value === MONITOR_MESSAGE || value === SESSION_WIRE.monitorMessage;
