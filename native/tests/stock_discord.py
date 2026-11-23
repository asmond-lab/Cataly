"""Drive the Rust Discord wire contract against stock OMP, without a live bot."""

from pathlib import Path


def exercise_discord(command, env, calls, run_harness):
    origin = {"bot": "99", "owner": "10", "channel": "20", "message": "102"}

    def run(target, prompt):
        return {"op": "discord_run", "origin": target, "prompt": f"cataly-test: {prompt}", "readme": False}

    def next_part(target):
        return {"op": "discord_delivery", "action": "next", "origin": target}

    def ack(target, part, remote):
        return {"op": "discord_delivery", "action": "ack", "origin": target, "part": part, "remote": remote}

    # Leave part 0 confirmed and restart the controller before asking for part 1.
    long_prompt = "🧪" * 1050 + " 끝"
    request = run(origin, long_prompt)
    result, = run_harness(command, env, request)
    state = Path(command[-1])
    (state / "discord-102-part-0.sending.tmp").write_text("incomplete intent", encoding="utf-8")
    first, = run_harness(command, env, next_part(origin))
    assert result.get("status") == "completed", result
    assert first["delivery"] == "part" and first["part"] == 0, first
    assert len(first["text"].encode("utf-16-le")) <= 4000 and len(first["nonce"]) == 24
    (state / "discord-102-part-0.posted.tmp").write_text("incomplete acknowledgement", encoding="utf-8")
    wrong, confirmed, second = run_harness(
        command, env, ack({**origin, "channel": "21"}, 0, "301"), ack(origin, 0, "301"), next_part(origin)
    )
    assert "origin does not match" in wrong["error"], wrong
    assert confirmed == {"delivery": "acknowledged", "part": 0}
    assert second["delivery"] == "part" and second["part"] == 1, second
    assert first["nonce"] != second["nonce"]
    assert first["text"] + second["text"] == result["text"].strip()

    # Stop after the Rust intent for part 1 as if Discord's POST outcome were unknown.
    saved, = run_harness(command, env, request)
    held, = run_harness(command, env, next_part(origin))
    assert saved == result and held == {"delivery": "held", "part": 1}, (saved, held)
    assert calls.count(long_prompt) == 1, calls
    settled, done = run_harness(command, env, ack(origin, 1, "302"), next_part(origin))
    assert settled == {"delivery": "acknowledged", "part": 1} and done == {"delivery": "done"}

    # Distinct Discord requests stay in the same channel lane across controllers, but not across channels.
    followup = run({**origin, "message": "103"}, "Discord follow-up")
    other = run({**origin, "message": "104", "channel": "21"}, "Discord other channel")
    continued, = run_harness(command, env, followup)
    isolated, = run_harness(command, env, other)
    assert continued.get("status") == isolated.get("status") == "completed", (continued, isolated)
    assert continued["claim"]["session_id"] == result["claim"]["session_id"]
    assert isolated["claim"]["session_id"] != result["claim"]["session_id"]

    conflicting, = run_harness(command, env, {**request, "prompt": "changed Discord message"})
    assert "different input" in conflicting["error"]
