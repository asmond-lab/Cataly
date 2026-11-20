# Lanes & Verifiable `Done =` Signals

A **lane** is one scoped job owned by a dedicated `cataly-lane` Antigravity subagent and tracked in `~/.cataly/state/lanes/<key>.json`.

## Supported `Done =` Signals

Join multiple signals with `;`. Every signal must pass live verification for a lane to close.

| Signal | Live Verification |
| :--- | :--- |
| `merged <owner/repo>#N` | `gh pr view` confirms `state == MERGED` with a non-empty `mergeCommit.oid` |
| `closed <owner/repo>#N` | `gh issue view` confirms `state == CLOSED` |
| `published <pkg>@<version>` | `npm view <pkg>@<version> version --json` confirms the exact version exists |
| `command ["argv","..."] [stdout~"regex"]` | Executes argv directly (no shell, 120s timeout), exit code 0, optional stdout regex match |
| `file <path> [sha256=<hex>] [json:.a.b=<json>]` | File exists, optional exact SHA-256 match, optional exact JSON field comparison |
| `url <http(s) url> [status=200] [body~"regex"]` | HTTP GET returns expected status code and optional body regex match |

## Launching a Lane (Lead Workflow)

1. Write a clear brief describing: goal, code location, evidence so far, ideal end state, and what not to touch.
2. Call `cataly_lane_create` with `key`, `title`, `cwd`, `done`, `briefBody`, `priority` (1–9), and optional `worklogId`/`thread`.
3. Call `invoke_subagent` with:
   - `TypeName`: `"cataly-lane"`
   - `Role`: `"Cataly Lane: <key>"`
   - `Prompt`: the `renderedBrief` returned by `cataly_lane_create`
4. Call `cataly_lane_attach` with `key` and the returned `conversationId`.
5. When the subagent completes or messages back, inspect its claim and run `cataly_lane_verify_close`.
