"""Exercise the Rust harness with a stock OMP and a loopback-only model fixture."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
from select import select
import sys
import tempfile
from threading import Event, Thread

from stock_discord import exercise_discord
from stock_discord_head import exercise_head
from stock_discord_monitor import exercise_monitor
from stock_discord_threads import exercise_threads
from stock_omp_upgrade import exercise_upgrade
from stock_readme import PROMPT as README_PROMPT
from stock_readme import WORKSPACE_TOOL, exercise_owner_edges, exercise_tools


REQUEST_PREFIX = "cataly-test: "


class Model(BaseHTTPRequestHandler):
    calls: list[str] = []
    tool_results: list[str] = []
    interrupted = Event()
    release = Event()
    controlled_started = Event()
    controlled_release = Event()

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        last = body["messages"][-1]
        if last["role"] == "tool":
            result = last["content"]
            if not isinstance(result, str):
                result = "".join(part["text"] for part in result if part["type"] == "text")
            self.tool_results.append(result)
            self.stream(body["model"], [({"role": "assistant", "content": result}, None), ({}, "stop")])
            return
        prompt = body["messages"][-1]["content"]
        if not isinstance(prompt, str):
            prompt = "".join(part["text"] for part in prompt if part["type"] == "text")
        # OMP may prepend its context reminder to the final user message.
        for opener, closer in (("<system-reminder>", "</system-reminder>"),
                               ("&lt;system-reminder>", "&lt;/system-reminder>")):
            if prompt.startswith(opener):
                _, found, prompt = prompt.partition(closer)
                assert found, "expected the stock OMP context reminder to end"
                break
        # Stock OMP can also send independent provider capability probes.
        lane_request = prompt.startswith(REQUEST_PREFIX)
        if lane_request:
            prompt = prompt.removeprefix(REQUEST_PREFIX)
            self.calls.append(prompt)
        if lane_request and prompt == README_PROMPT:
            offered = [tool["function"]["name"] for tool in body.get("tools", [])]
            if offered != [WORKSPACE_TOOL]:
                self.send_error(400, f"Unexpected model tool list: {offered}")
                print(f"Unexpected model tool list: {offered}", file=sys.stderr)
                return
            self.stream(body["model"], [
                ({"role": "assistant", "tool_calls": [{
                    "index": 0, "id": "workspace_call", "type": "function",
                    "function": {"name": WORKSPACE_TOOL, "arguments": "{}"},
                }]}, None),
                ({}, "tool_calls"),
            ])
            return
        if lane_request and body.get("tools"):
            self.send_error(400, "Text-only run exposed model tools")
            return
        if lane_request and prompt == "interrupt fixture":
            self.interrupted.set()
            self.release.wait(20)
        if lane_request and prompt == "controlled interruption":
            self.controlled_started.set()
            self.controlled_release.wait(20)
            return  # The controller closes OMP before the test releases the blocked handler.
        if lane_request and prompt == "provider error fixture":
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"error":{"message":"fixture failure"}}')
            return
        text = f"확인: {prompt}" if lane_request else "391"
        self.stream(body["model"], [({"role": "assistant", "content": text}, None), ({}, "stop")])

    def stream(self, model: str, chunks: list[tuple[dict, str | None]]) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        for delta, finish in chunks:
            data = {"id": "cataly-fixture", "object": "chat.completion.chunk", "created": 0,
                    "model": model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(data)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")

    def log_message(self, *_args: object) -> None:
        pass


def run(key: str, request_id: str, prompt: str) -> dict[str, str]:
    return {"op": "run", "key": key, "id": request_id, "prompt": REQUEST_PREFIX + prompt}


def run_harness(command: list[str], env: dict[str, str], *requests: dict[str, str]) -> list[dict]:
    data = "".join(json.dumps(request) + "\n" for request in requests)
    result = subprocess.run(command, env=env, input=data, capture_output=True, text=True, timeout=45, check=False)
    if result.returncode != 0:
        raise AssertionError(f"Cataly exited {result.returncode}: {result.stderr}")
    return [json.loads(line) for line in result.stdout.splitlines()]


def exercise(command: list[str], env: dict[str, str]) -> None:
    request = run("lane", "answer-1", "first request")
    receipt = {"op": "receipt", "id": "answer-1"}
    first, repeated, looked_up, conflict, second, failed, parked = run_harness(
        command, env, request, request, receipt, run("lane", "answer-1", "different"),
        run("lane", "answer-2", "second request"), run("lane", "fail-1", "provider error fixture"),
        {"op": "status", "key": "lane"},
    )
    assert first["status"] == "completed" and first["text"] == "확인: first request", first
    assert first == repeated == looked_up and first["claim"]["id"] == "answer-1"
    assert "already used" in conflict["error"], conflict
    assert second["text"] == "확인: second request" and second["claim"]["session_id"] == first["claim"]["session_id"], second
    assert failed["status"] == "failed" and "text" not in failed, failed
    assert parked["state"] == "parked", parked
    saved, replay = run_harness(command, env, receipt, request)
    assert saved == replay == first
    assert Model.calls == ["first request", "second request", "provider error fixture"], Model.calls

    lost = run("other", "lost-1", "interrupt fixture")
    with subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, text=True) as owner:
        try:
            if owner.stdin is None:
                raise AssertionError("expected controller stdin")
            owner.stdin.write(json.dumps(lost) + "\n")
            owner.stdin.flush()
            assert Model.interrupted.wait(20), "model did not receive request"
        finally:
            owner.kill()
            owner.wait(timeout=15)
            Model.release.set()
    pending, replay, hold = run_harness(command, env, {"op": "receipt", "id": "lost-1"}, lost, run("other", "new-id", "must not run"))
    assert pending == replay and pending["status"] == "unconfirmed", (pending, replay)
    assert "unconfirmed request" in hold["error"], hold
    assert Model.calls[-1] == "interrupt fixture" and Model.calls.count("interrupt fixture") == 1, Model.calls

def exercise_control(command: list[str], env: dict[str, str]) -> None:
    request = {**run("controlled", "control-1", "controlled interruption"), "op": "run_controlled"}
    request_id = request["id"]
    with subprocess.Popen(command, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, bufsize=0) as owner:
        try:
            stdin, stdout = owner.stdin, owner.stdout
            if stdin is None or stdout is None:
                raise AssertionError("expected controller pipes")

            def send(item: dict[str, str]) -> None:
                stdin.write((json.dumps(item) + "\n").encode())

            def receive() -> dict:
                assert select([stdout], [], [], 12)[0], "Cataly did not answer while the OMP turn was blocked"
                return json.loads(stdout.readline())

            send(request)
            assert Model.controlled_started.wait(12), "OMP did not receive the controlled request"
            send({"op": "cancel", "id": "foreign-id"})
            assert "does not match" in receive()["error"]
            send({"op": "run_status", "id": request_id})
            assert receive() == {"id": request_id, "control": "running"}
            send({"op": "cancel", "id": request_id})
            assert receive() == {"id": request_id, "control": "cancelling"}
            cancelled = receive()
            assert cancelled["status"] == "unconfirmed" and "cancellation requested" in cancelled["reason"], cancelled
            assert not Model.controlled_release.is_set()
            send({"op": "status", "key": "controlled"})
            assert receive()["state"] == "parked"
            send({"op": "quit"})
            assert owner.wait(timeout=12) == 0
        finally:
            if owner.poll() is None:
                owner.kill()
                owner.wait(timeout=12)
            Model.controlled_release.set()

    saved, replay, hold = run_harness(command, env, {"op": "receipt", "id": request_id}, request,
                                     run("controlled", "control-2", "must not run"))
    assert saved == replay and saved["status"] == "unconfirmed", (saved, replay)
    assert "unconfirmed request" in hold["error"], hold
    assert Model.calls.count("controlled interruption") == 1 and "must not run" not in Model.calls, Model.calls

def main() -> None:
    cataly, omp = (str(Path(arg).resolve(strict=True)) for arg in sys.argv[1:])
    with tempfile.TemporaryDirectory(prefix="cataly-turn-") as tmp, ThreadingHTTPServer(("127.0.0.1", 0), Model) as server:
        root = Path(tmp)
        for name in ("home", "agent", "project"):
            (root / name).mkdir(mode=0o700)
        (root / "agent" / "models.yml").write_text(f"""providers:
  cataly-fixture:
    baseUrl: http://127.0.0.1:{server.server_port}/v1
    apiKey: cataly-fixture
    api: openai-completions
    models:
      - id: local
        name: Cataly fixture
        contextWindow: 8192
        maxTokens: 512
""", encoding="utf-8")
        env = {"PATH": os.environ["PATH"], "HOME": str(root / "home"), "PI_CODING_AGENT_DIR": str(root / "agent")}
        command = [cataly, "--omp", omp, "--cwd", str(root / "project"), "--model", "cataly-fixture/local",
                   "harness", "--state-dir", str(root / "state")]
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            exercise(command, env)
            exercise_control(command, env)
            exercise_tools(command, env, root, Model.calls, Model.tool_results, run_harness)
            exercise_owner_edges(command, env, root, Model.calls, Model.tool_results, run_harness)
            exercise_discord(command, env, Model.calls, run_harness)
            exercise_monitor(command, env, root, Model.calls, Model.tool_results)
            exercise_threads(command, env, root, Model.calls)
            exercise_head(command, env, root, Model, run_harness)
            exercise_upgrade(command, env, root, Model.calls, run_harness)
        finally:
            server.shutdown()
            thread.join()
    print("Cataly stock OMP turns, durable receipts, controlled cancellation and host tool decisions: OK")


if __name__ == "__main__":
    main()
