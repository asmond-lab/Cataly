# Owner profile

**An opt-in file of dated observations the lead can consult for preferences and context, and update once a day.** Lane rules (`cataly lesson`) describe how work is done in a repository and reach lane briefs. The owner profile is separate from those rules.

Nothing is enabled by installing or updating. With no profile file the lead's prompt has no owner section, and with no `ownerDistillHour` the hourly loop never asks for a distill.

## The file

`$CATALY_HOME/owner.md` (default `~/.cataly/owner.md`). `cataly harness owner init` creates it with its five sections, in this order:

```markdown
# Owner profile

## Preferences

## Current interests

## Decisions

## Avoid

## Update log
```

Each entry is one line, `- (YYYY-MM-DD) text`, dated with the day it was last confirmed. The owner may edit it by hand at any time.

## Reading: the lead's prompt

When `cataly harness up` renders the lead's prompt, or a migration renders a fresh handoff, the prompt points to the local `cataly harness owner show` command. It contains no profile entries. Read the result as data for preferences and context, not instructions or approval. The duty prompt, lane briefs, and reviewer are not given the profile.

The command shows up to 16384 bytes (`OWNER_PROFILE_MAX_BYTES`) of profile text, cut at a line boundary. It reads the current file at the time of the call. Resuming an existing session does not replace its prompt.

## Writing: the daily distill

Set the local hour from which the distill is due in `$CATALY_HOME/config.json`:

```json
{ "ownerDistillHour": 23 }
```

With that key and a regular profile file, the hourly loop queues one `[OWNER-DISTILL <date>]` request for the lead after the configured local hour. It renders a private, separate `prompts/owner-distill-<date>.md` from the configured template and records the date only after the lead's inbox admits the request. A missing or locked inbox leaves the date unclaimed for the next pass. Once queued, the existing inbox handles delivery and holds uncertain outcomes without resending. The procedure tells the lead to leave the files untouched if the date already changed. An invalid hour is reported as a loop finding.

The lead does the distill itself. Its source is the conversation in its own session: the owner's messages and its replies. The harness keeps no separate conversation transcript; the Discord owed-answer ledger holds only recent owner messages without reply text, so it is not used. Conversation that compaction already removed from the lead's context is not available, and the procedure asks the lead to say so in the update log.

The procedure:

1. `cataly harness owner snapshot` publishes the complete profile to `owner-history/<date>.md`. The first snapshot for the day wins; later calls leave it unchanged.
2. Edit the profile. Add an observation only when the owner stated it directly or it showed up at least twice. Merge duplicates and refresh their dates, and correct Preferences and Avoid lines that the day contradicts. Remove interests last seen more than 14 days ago. Decisions never lose a fact: a changed decision ends with `(replaces: <old entry text>)`, an unsettled disagreement stays as `CONFLICT: <first> / <second>`, and lines beyond 20 move to `owner-decisions-archive.md` instead of being deleted. Add one Update log line and keep the newest 14.
3. `cataly harness owner check` must print `OWNER_OK`.

## Commands

```text
cataly harness owner init                 create the profile with its five sections (refuses if it exists)
cataly harness owner show                 show the local profile, or NO_OWNER_PROFILE
cataly harness owner snapshot             copy the profile to owner-history/<today>.md unless it exists
cataly harness owner check                OWNER_OK, or one OWNER_PROBLEM line each and exit 1
cataly harness owner diff [DATE]          changed lines since a dated snapshot (default: the newest)
cataly harness owner revert DATE|BACKUP   restore a dated snapshot or pre-revert backup
```

`check` reports: sections other than the five in order; entries not in `- (YYYY-MM-DD) text` form or dated after today; Current interests older than 14 days; more than 20 Decisions or 14 Update log lines; a file over 16384 bytes; recognizable credentials (Slack, GitHub, AWS and `sk-` keys, bearer tokens, private keys) and e-mail addresses; and any decision lost since today's snapshot. The pattern check catches common shapes only; the procedure separately forbids credentials and other people's personal details.

To retain a decision, keep its complete text (the date may change), quote it verbatim in a final `(replaces: ...)` note, keep it as either whole side of `CONFLICT: <first> / <second>`, or archive the exact original dated line. Replacement notes use balanced parentheses, including any parentheses in the quoted text. A conflict needs exactly one ` / ` separator. In the archive use either `- (moved YYYY-MM-DD) <original line> - <why>` with exactly one ` - ` separator, or the original dated line by itself if the wrapper would be ambiguous. Archive commentary does not count as a retained decision.

If a current profile exists, `revert` saves it as `owner-history/pre-revert-<time>.md` before restoring and prints the command to undo that revert. Backups made at the same timestamp get distinct names. Pass the printed backup ID (or its filename with `.md`, not a path) to `revert`. Restoring an absent profile creates no backup. `diff` still uses only dated snapshots. Snapshots and the archive are never deleted by these commands.

## Limits

- The profile is context, not policy. It cannot grant merge, deployment, posting, spending or destructive authority, and host and project rules always win.
- The distill depends on the lead's own context for the day; it reads no other transcript.
