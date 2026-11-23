/** cataly recall: search one space or logically delete one identity's rows from the opt-in ledger. */
import { parseArgs } from "node:util";
import type { Command } from "./cli-context.ts";
import { MessengerError } from "./messenger/http.ts";
import {
  createRecallScope,
  openRecallLedger,
  purgeRecallLedger,
  validateRecallConversation,
} from "./messenger/recall-ledger.ts";
import { rankRecall, recalledItem, type RecallSettings } from "./messenger/recall-text.ts";

type RecallCommandInput = {
  readonly rest: readonly string[];
  readonly config: { readonly stateDir: string; readonly recall?: RecallSettings };
};

const invalid = (message: string): never => {
  throw new MessengerError(message, 0);
};

export const recallCommand = (async ({ rest, config }: RecallCommandInput): Promise<void> => {
  // The shared CLI parser is permissive for other commands. Recall accepts only its own options.
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: {
        scope: { type: "string" },
        space: { type: "string" },
        limit: { type: "string" },
        purge: { type: "boolean" },
      },
    });
  } catch (error) {
    if (error instanceof TypeError) return invalid("invalid recall options; use --scope, --space, --limit or --purge");
    throw error;
  }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) invalid(`--${token.name} may only be passed once`);
    seen.add(token.name);
  }
  const { values, positionals } = parsed;
  const parts = values.scope?.split(":");
  if (parts?.length !== 3) return invalid("--scope must be <platform>:<bot-id>:<owner-id>");
  const scope = createRecallScope(parts[0], parts[1], parts[2]);
  if (values.purge) {
    if (positionals.length || values.space !== undefined || values.limit !== undefined)
      return invalid("recall --purge takes only --scope <platform>:<bot-id>:<owner-id>");
    console.log(`RECALL_PURGED ${purgeRecallLedger(config.stateDir, scope)}`);
    return;
  }
  // A positional "purge" or a literal "--purge" after "--" is just search text.
  const query = positionals.join(" ").trim() || invalid("recall needs a query, or use recall --purge with --scope");
  const limitText = values.limit?.trim();
  const limit = limitText === undefined ? 4 : Number(limitText);
  if ((limitText !== undefined && !/^\d+$/.test(limitText)) || !Number.isSafeInteger(limit) || limit <= 0)
    invalid("--limit must be a positive whole number of rows");
  const space = values.space ?? invalid("--space is required: supply the Discord parent/channel or Telegram chat ID");
  const conversation = validateRecallConversation(scope.platform, { channel: space, thread: space });
  if (config.recall?.enabled !== true) invalid('recall is off; set "recall": {"enabled": true} in config.json');
  const ledger = openRecallLedger(config.stateDir, scope, { settings: config.recall, now: Date.now() });
  try {
    const found = rankRecall(query, ledger.rows(conversation)).slice(0, limit);
    if (found.length === 0) console.log("RECALL_NONE");
    for (const row of found) console.log(`RECALL ${row.platform} ${row.channel} ${JSON.stringify(recalledItem(row))}`);
  } finally {
    ledger.close();
  }
}) satisfies Command;
