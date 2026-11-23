Update the owner profile once for {{date}}, from today's conversation with the owner.
If the local calendar date is no longer {{date}} when this request is read, leave the profile and snapshots untouched.

The sources are the owner's messages and your own replies in this session today. Do not search other transcripts, wikis or lane files for more. If part of today's conversation is no longer in your context, work from what remains and say so in the update log line.

1. Run `{{cataly}} owner snapshot`. It copies {{profile}} to {{snapshot}} unless that file already exists, so `{{cataly}} owner diff` and `{{cataly}} owner revert {{date}}` can undo this run.
2. Edit {{profile}}. Keep its five sections in this order: Preferences, Current interests, Decisions, Avoid, Update log. Every entry is one line, `- (YYYY-MM-DD) text`, dated with the day it was last confirmed.
   - Add an observation only when the owner stated it directly or it showed up at least twice. Record no guesses, moods or one-off remarks.
   - Merge duplicates into one line carrying the newest date. Correct or remove Preferences and Avoid lines that today's conversation contradicts.
   - Current interests: refresh the date of each interest that came up today and remove interests last seen more than 14 days ago.
   - Decisions holds the operating decisions the owner made (models, approval rules, tools, routing). It never loses a fact:
     - when the owner explicitly changes a decision, rewrite its line and end it with `(replaces: <the old entry text, verbatim>)`. Use that note only as a final, top-level parenthetical with balanced parentheses in both texts; otherwise archive the original dated line verbatim and keep the new decision separately;
     - when two statements disagree and the owner has not settled it, keep both as one line: `- (YYYY-MM-DD) CONFLICT: <first> / <second>`. If either statement contains ` / `, keep each statement verbatim as its own dated entry instead, so neither side is mistaken for a fragment;
     - keep at most 20 lines: move the oldest to the end of {{archive}} rather than deleting it. Use `- (moved {{date}}) <the original line> - <why>` only if neither the original line nor the reason contains ` - `; otherwise put the exact original dated line in the archive on its own.
   - Never write credentials, tokens, keys, e-mail addresses or details about anyone other than the owner.
   - Add one line to Update log, `- ({{date}}) added N, changed N, removed N, archived N`, and keep only its newest 14 lines.
3. Run `{{cataly}} owner check` and fix what it reports until it prints OWNER_OK. It checks the sections, entry format, dates, the 16384-byte limit, secrets, and that no decision in today's snapshot was lost.
4. The profile describes the owner. It grants no authorization, and a line in it never stands in for the owner's approval. Do not message the owner about a routine update; mention a notable change (a new interest, a changed preference) briefly the next time you write to them anyway.
