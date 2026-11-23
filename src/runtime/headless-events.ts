import { dialogOf, entryOf, type HeadlessDialog, type HeadlessEntry, string } from "./headless-protocol.ts";

const RING_SIZE = 40;

/** Holds actionable native UI requests separately from the bounded read-only output ring. */
export class HeadlessEvents {
  readonly dialogs = new Map<string, HeadlessDialog>();
  readonly recent: HeadlessEntry[] = [];
  activeSince: number | undefined;

  record(frame: Record<string, unknown>): void {
    switch (frame["type"]) {
      case "extension_ui_request": {
        if (frame["method"] === "cancel") {
          const target = string(frame["targetId"]);
          if (target) this.dialogs.delete(target);
          break;
        }
        const dialog = dialogOf(frame);
        if (dialog) this.dialogs.set(dialog.id, dialog);
        break;
      }
      case "agent_start":
        this.activeSince ??= Date.now();
        break;
      case "session_settled":
        this.activeSince = undefined;
        break;
    }
    const entry = entryOf(frame);
    if (entry) {
      this.recent.push(entry);
      if (this.recent.length > RING_SIZE) this.recent.shift();
    }
  }
}
