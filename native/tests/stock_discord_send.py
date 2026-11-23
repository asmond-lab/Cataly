"""Drive Discord send through the native binary against the stock loopback fixture."""

import json
import subprocess
from collections.abc import Sequence
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from discord_wire import World


def exercise_send(binary: str, env: dict[str, str], world: "World") -> None:
    def run(text: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [binary, "discord-send", *args], env={**env, "CATALY_DISCORD_GUILD_ID": "40"},
            input=text, capture_output=True, text=True, check=False, timeout=10,
        )

    def sent(text: str, args: Sequence[str], confirmed: bool, count: int) -> list[dict]:
        result = run(text, *args)
        assert result.returncode == 0, result.stderr
        receipt = json.loads(result.stdout)
        assert receipt["channel"] == "20" and receipt["replyConfirmed"] is confirmed, receipt
        assert len(receipt["ids"]) == count, receipt
        return [world.replies.get(timeout=2) for _ in receipt["ids"]]

    text = "한" * 1999 + "😀" + " tail"
    first, second = sent(text, ("--to", "#work", "--reply", "100"), True, 2)
    assert first["message_reference"] == {"message_id": "100", "channel_id": "20", "fail_if_not_exists": True}
    assert "message_reference" not in second and first["content"] + second["content"] == text
    assert first["allowed_mentions"] == {"parse": [], "replied_user": False}

    body = "가😀code\n" * 530
    fenced = "```rust\n" + body + "```"
    pieces = sent(fenced, ("--thread", "20"), False, 3)
    contents = [part["content"] for part in pieces]
    assert all(part.startswith("```rust\n") and part.endswith("\n```") for part in contents), contents
    assert all(len(part.encode("utf-16-le")) // 2 <= 2000 for part in contents)
    assert "".join(part.removeprefix("```rust\n").removesuffix("```") for part in contents) == body

    world.force_plain_reply = True
    sent("server did not confirm reply", ("--thread", "20", "--reply", "100"), False, 1)
    world.force_plain_reply = False

    world.reject_text = "blocked continuation"
    result = run("x" * 2000 + world.reject_text, "--thread", "20")
    assert result.returncode != 0 and "stopped at part 2" in result.stderr and "confirmed IDs: [" in result.stderr, result
    assert world.replies.get(timeout=2)["content"] == "x" * 2000
    assert world.replies.empty()

    result = run("changed", "--to", "20", "--edit", "300")
    assert result.returncode == 0 and json.loads(result.stdout)["ids"] == [], result
    assert world.cleared.get(timeout=2)["content"] == "changed"
    for args in [("--to", "21"), ("--thread", "20", "--edit", "300", "--reply", "100")]:
        denied = run("no effect", *args)
        assert denied.returncode != 0, denied
    assert world.replies.empty() and world.cleared.empty()
