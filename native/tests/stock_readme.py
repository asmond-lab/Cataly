# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
# Imported by: python3 native/tests/stock-run.py <cataly-bin> <omp-bin>
"""Observe workspace README decisions through a real Cataly + stock OMP turn."""

import json
import os
from pathlib import Path
from select import select
from signal import SIGKILL
from socket import AF_UNIX, SOCK_STREAM, socket
import subprocess
import sys
from typing import Protocol

WORKSPACE_TOOL = "cataly_read_readme"
PROMPT = "workspace tool fixture"


class HarnessRunner(Protocol):
    def __call__(
        self,
        command: list[str],
        env: dict[str, str],
        *requests: dict[str, str],
    ) -> list[dict]: ...


def exercise_tools(
    command: list[str],
    env: dict[str, str],
    root: Path,
    calls: list[str],
    results: list[str],
    run_harness: HarnessRunner,
) -> None:
    readme = root / "project" / "README.md"
    outside = root / "outside.md"
    inside_text = "# Native README test — 한글"
    secret = "OUTSIDE-CATALY-TEST-CANARY"
    outside.write_text(secret, encoding="utf-8")
    for case, decision, expected in (
        ("regular", "approve", inside_text),
        ("deny", "deny", "The user denied the README.md request"),
        ("disconnect", None, None),
        ("symlink", "approve", "Cannot read workspace README.md:"),
        ("hardlink", "approve", "not a single-link regular file"),
        ("fifo", "approve", "not a single-link regular file"),
        ("oversize", "approve", "README.md exceeds 16 KiB"),
    ):
        readme.unlink(missing_ok=True)
        readme.write_text(inside_text, encoding="utf-8")
        request_id = f"readme-{case}"
        request = {"op": "run_with_tools", "key": request_id, "id": request_id, "prompt": f"cataly-test: {PROMPT}"}
        before = len(results)
        with subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0) as owner:
            try:
                stdin, stdout = owner.stdin, owner.stdout
                assert stdin is not None and stdout is not None

                def send(item: dict[str, str]) -> None:
                    stdin.write((json.dumps(item) + "\n").encode())

                def receive() -> dict:
                    assert select([stdout], [], [], 12)[0], f"No Cataly reply for {case}"
                    return json.loads(stdout.readline())

                send(request)
                approval = receive()
                assert approval.get("tool") == WORKSPACE_TOOL and approval["id"] == request_id, approval
                if decision is None:
                    stdin.close()
                    receipt = receive()
                    assert receipt["status"] == "unconfirmed" and "not answered" in receipt["reason"], receipt
                    assert len(results) == before
                    assert owner.wait(timeout=12) == 0
                    saved, = run_harness(command, env, {"op": "receipt", "id": request_id})
                    assert saved["claim"] == receipt["claim"] and saved["status"] == "unconfirmed"
                    continue

                # Replace the file after the approval event to exercise the actual open boundary.
                if case in ("symlink", "hardlink", "fifo", "oversize"):
                    readme.unlink()
                    if case == "symlink":
                        readme.symlink_to(outside)
                    elif case == "hardlink":
                        os.link(outside, readme)
                    elif case == "fifo":
                        os.mkfifo(readme)
                    else:
                        readme.write_text("x" * (16 * 1024 + 1), encoding="utf-8")
                decide = {"op": "decide", "id": request_id, "approval_id": approval["approval_id"], "decision": decision}
                send({**decide, "approval_id": "stale"})
                assert "does not match" in receive()["error"]
                send({"op": "run_status", "id": request_id})
                assert receive() == {"id": request_id, "control": "awaiting_approval"}
                send(decide)
                assert receive() == {key: value for key, value in decide.items() if key != "op"}
                receipt = receive()
                assert expected is not None
                assert receipt.get("status") == "completed" and expected in receipt.get("text", ""), receipt
                observed = results[before:]
                assert len(observed) == 1 and expected in observed[0], observed
                assert secret not in observed[0]
                if case != "regular":
                    assert inside_text not in observed[0]
                send({"op": "quit"})
                assert owner.wait(timeout=12) == 0
            finally:
                if owner.poll() is None:
                    owner.kill()
                    owner.wait(timeout=12)

        count = calls.count(PROMPT)
        assert run_harness(command, env, request) == [receipt]
        assert calls.count(PROMPT) == count
        wrong_mode, = run_harness(command, env, {**request, "op": "run"})
        assert "different input" in wrong_mode["error"], wrong_mode
        assert calls.count(PROMPT) == count


def exercise_owner_edges(
    command: list[str],
    env: dict[str, str],
    root: Path,
    calls: list[str],
    results: list[str],
    run_harness: HarnessRunner,
) -> None:
    endpoint = str(root / "launch.sock")
    wrapper = root / "omp-gated"
    omp = command[2]
    wrapper.write_text(
        f"#!{sys.executable}\n"
        "import os, socket, sys\n"
        f"omp = {omp!r}\n"
        "if '--mode' not in sys.argv: os.execv(omp, [omp, *sys.argv[1:]])\n"
        "with socket.socket(socket.AF_UNIX) as gate:\n"
        f"    gate.connect({endpoint!r})\n"
        "    gate.sendall(f'{os.getpid()}\\n'.encode())\n"
        "    if gate.recv(1) != b'g': sys.exit(1)\n"
        "os.execv(omp, [omp, *sys.argv[1:]])\n",
        encoding="utf-8",
    )
    wrapper.chmod(0o700)
    gated = [*command[:2], str(wrapper), *command[3:]]
    with socket(AF_UNIX, SOCK_STREAM) as listener:
        listener.bind(endpoint)
        listener.listen()
        listener.settimeout(12)
        for cancel_before_launch in (True, False):
            key = "early-cancel" if cancel_before_launch else "omp-exit"
            request = {
                "op": "run_with_tools",
                "key": key,
                "id": key,
                "prompt": f"cataly-test: {PROMPT}",
            }
            before = (len(calls), len(results))
            with subprocess.Popen(gated, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0) as owner:
                try:
                    stdin, stdout = owner.stdin, owner.stdout
                    assert stdin is not None and stdout is not None

                    def send(item: dict[str, str]) -> None:
                        stdin.write((json.dumps(item) + "\n").encode())

                    def receive() -> dict:
                        assert select([stdout], [], [], 12)[0], f"No Cataly reply for {key}"
                        return json.loads(stdout.readline())

                    send(request)
                    peer, _ = listener.accept()
                    with peer, peer.makefile("rb") as launch:
                        peer.settimeout(12)
                        pid = int(launch.readline())
                        if cancel_before_launch:
                            send({"op": "cancel", "id": key})
                            assert receive()["control"] == "cancelling"
                        peer.sendall(b"g")
                    if cancel_before_launch:
                        assert "before sending the prompt" in receive()["error"]
                        send({"op": "receipt", "id": key})
                        assert "unknown Cataly request" in receive()["error"]
                        assert (len(calls), len(results)) == before
                    else:
                        approval = receive()
                        assert approval["tool"] == WORKSPACE_TOOL
                        os.kill(pid, SIGKILL)
                        assert receive()["status"] == "unconfirmed"
                        send({"op": "decide", "id": key, "approval_id": approval["approval_id"], "decision": "approve"})
                        assert "no active" in receive()["error"]
                        assert (len(calls), len(results)) == (before[0] + 1, before[1])
                    send({"op": "quit"})
                    assert owner.wait(timeout=12) == 0
                finally:
                    if owner.poll() is None:
                        owner.kill()
                        owner.wait(timeout=12)
    available, = run_harness(command, env, {
        "op": "run", "key": "early-cancel", "id": "after-cancel",
        "prompt": "cataly-test: after early cancellation",
    })
    assert available.get("status") == "completed", available
