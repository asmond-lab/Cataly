#!/usr/bin/env bash
# Smoke the released OMP binary without provider calls or operator credentials.
set -euo pipefail
cataly=$(realpath -- "${1:?usage: stock-omp.sh path/to/cataly path/to/omp}")
omp=$(realpath -- "${2:?specify a stock OMP binary}")
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -m 700 "$work/home" "$work/agent" "$work/project" "$work/sessions"
cat > "$work/agent/models.yml" <<'YAML'
providers:
  cataly-fixture:
    baseUrl: http://127.0.0.1:9/v1
    apiKey: cataly-fixture
    api: openai-completions
    models:
      - id: offline
        name: Cataly lifecycle fixture
        contextWindow: 8192
        maxTokens: 128
YAML
isolated=(env -i PATH="$PATH" HOME="$work/home" PI_CODING_AGENT_DIR="$work/agent" LANG=C.UTF-8)
model=cataly-fixture/offline
"${isolated[@]}" "$cataly" --omp "$omp" --cwd "$work/project" --model "$model" doctor \
  | jq -ec 'select(.rpc_protocol == 2 and .host_tools == true)'

# Fork is public OMP RPC and writes an empty native session without invoking inference.
state=$(
  cd -- "$work/project"
  printf '%s\n' '{"id":"fork","type":"fork"}' '{"id":"state","type":"get_state"}' |
    "${isolated[@]}" "$omp" --mode rpc-ui --offline --model "$model" \
      --no-extensions --no-skills --no-rules --no-context-files --no-tools --session-dir "$work/sessions" |
    jq -ecs 'if any(.[]; .id == "fork" and .success and .data.cancelled == false) then
      .[] | select(.id == "state" and .success) | .data else error("OMP did not fork the fixture") end'
)
file=$(jq -er '.sessionFile' <<< "$state")
id=$(jq -er '.sessionId' <<< "$state")
test -s "$file"
resume=("${isolated[@]}" "$cataly" --omp "$omp" --cwd "$work/project" --model "$model" resume "$file")
"${resume[@]}" --expect-id "$id" | jq -ec --arg id "$id" --arg file "$file" \
  'select(.sessionId == $id and .sessionFile == $file and .isStreaming == false)'
if "${resume[@]}" --expect-id unexpected > "$work/stdout" 2> "$work/stderr"; then
  echo 'Cataly accepted the wrong saved session identity' >&2
  exit 1
fi
test ! -s "$work/stdout"
grep -F 'OMP resumed a different session ID' "$work/stderr"

supervisor=("${isolated[@]}" "$cataly" --omp "$omp" --cwd "$work/project" --model "$model"
  harness --state-dir "$work/cataly")
first=$(
  "${supervisor[@]}" <<'JSON'
{"op":"open","key":"lane"}
{"op":"open","key":"head"}
{"op":"open","key":"head"}
{"op":"open","key":"lane"}
{"op":"open","key":"excess"}
{"op":"status","key":"lane"}
{"op":"close","key":"lane"}
{"op":"quit"}
JSON
)
jq -es '
  length == 7 and
  (.[0].error | contains("head before")) and
  .[1].state == "open" and .[1].key == "head" and
  (.[2].error | contains("already open")) and
  .[3].state == "open" and .[3].key == "lane" and
  .[3].binding.session.id != .[1].binding.session.id and
  (.[4].error | contains("capacity reached")) and
  .[5] == .[3] and
  .[6].state == "closed" and .[6].binding == .[3].binding
' <<< "$first"
second=$(
  "${supervisor[@]}" <<'JSON'
{"op":"status","key":"lane"}
{"op":"open","key":"head"}
{"op":"open","key":"lane"}
JSON
)
jq -es --argjson first "$(jq -s . <<< "$first")" '
  length == 3 and
  .[0].state == "parked" and
  .[1] == $first[1] and
  .[2] == $first[3]
' <<< "$second"

# A start receipt without a bound native identity must not launch another session.
touch "$work/cataly/interrupted.starting"
held=$(
  "${supervisor[@]}" <<'JSON'
{"op":"status","key":"interrupted"}
{"op":"open","key":"head"}
{"op":"open","key":"interrupted"}
JSON
)
jq -es '
  .[0] == {state:"unconfirmed", key:"interrupted"} and
  .[1].state == "open" and
  (.[2].error | contains("unconfirmed start"))
' <<< "$held"
test ! -e "$work/cataly/interrupted.sessions"

# A session directory left by the pre-marker reservation order is also held.
mkdir -m 700 "$work/cataly/orphaned.sessions"
orphaned=$(
  "${supervisor[@]}" <<'JSON'
{"op":"status","key":"orphaned"}
{"op":"open","key":"head"}
{"op":"open","key":"orphaned"}
JSON
)
jq -es '
  .[0] == {state:"unconfirmed", key:"orphaned"} and
  .[1].state == "open" and
  (.[2].error | contains("unconfirmed start"))
' <<< "$orphaned"
test -z "$(ls -A "$work/cataly/orphaned.sessions")"

# Keep the first controller alive while the second tries to take the same state.
coproc OWNER { "${supervisor[@]}"; }
owner_pid=$OWNER_PID
printf '%s\n' '{"op":"status","key":"head"}' >&"${OWNER[1]}"
IFS= read -r -t 20 reply <&"${OWNER[0]}"
jq -e '.state == "parked"' <<< "$reply"
if printf '%s\n' '{"op":"quit"}' | "${supervisor[@]}" > "$work/contender.out" 2> "$work/contender.err"; then
  echo 'Cataly accepted a second owner for the same state' >&2
  exit 1
fi
grep -F 'Cataly state is already controlled' "$work/contender.err"
printf '%s\n' '{"op":"quit"}' >&"${OWNER[1]}"
wait "$owner_pid"
