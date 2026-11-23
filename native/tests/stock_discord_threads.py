"""Exercise the Rust inbox's active-thread allowlist without a live Discord account."""

from http.server import ThreadingHTTPServer
from select import select
import subprocess
from threading import Thread
from time import time_ns

from discord_wire import Discord, World, message


def thread(ident: str, parent: str = "20", guild: str = "40", *, archived: bool = False):
    return {"id": ident, "parent_id": parent, "guild_id": guild, "type": 11,
            "thread_metadata": {"archived": archived}}


def exercise_threads(command, env, root, calls) -> None:
    world = World()
    world.active_threads = [thread("22"), thread("23", "99"), thread("24", guild="41"), thread("25", archived=True)]
    world.history.append(message("100", "cataly-test: old thread history", channel="22"))
    with ThreadingHTTPServer(("127.0.0.1", 0), Discord) as server:
        server.world = world
        serving = Thread(target=server.serve_forever, daemon=True)
        serving.start()
        port = server.server_port
        wire_env = {**env, "CATALY_MEMORY_BIN": "", "CATALY_DISCORD_TOKEN": "synthetic-discord-token",
                    "CATALY_DISCORD_OWNER_ID": "10", "CATALY_DISCORD_API_BASE": f"http://127.0.0.1:{port}/api/v10/",
                    "CATALY_DISCORD_GATEWAY_URL": f"ws://127.0.0.1:{port}/gateway"}
        state = root / "discord-threads"
        argv = [*command[:7], "discord", "--channel", "20", "--channel", "21",
                "--follow-threads", "--state-dir", str(state)]
        try:
            try_gateway(argv, wire_env, world, calls)
            # Restart in one-shot REST mode: already-delivered requests keep their thread cursor.
            followup = subprocess.run([*argv, "--poll-seconds", "0"], env=wire_env,
                                      capture_output=True, text=True, check=False, timeout=15)
            assert followup.returncode == 0 and world.replies.empty(), followup
            assert world.history_channels == {"20", "22", "26"}, world.history_channels
        finally:
            server.shutdown()
            serving.join()


def try_gateway(argv, env, world, calls) -> None:
    with subprocess.Popen([*argv, "--gateway"], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as child:
        try:
            assert select([child.stdout], [], [], 12)[0]
            assert b"INBOUND_READY discord" in child.stdout.readline()
            identify = world.auth.get(timeout=5)
            assert identify["op"] == 2 and identify["d"]["intents"] & 1
            assert world.ready.wait(5)
            world.discovery.get(timeout=5)
            marker = (time_ns() // 1_000_000 - 1_420_070_400_000) << 22
            for index, channel in enumerate(["23", "24", "25"]):
                world.add(message(str(marker + index), "cataly-test: outside scoped threads", channel=channel))
            world.add(message(str(marker + 3), "cataly-test: existing allowed thread", channel="22"))
            first = world.replies.get(timeout=12)
            assert first["message_reference"] == {"channel_id": "22", "message_id": str(marker + 3), "fail_if_not_exists": True}
            assert first["content"] == "확인: existing allowed thread"

            world.active_threads.append(thread("26", parent="21"))
            world.dispatch("THREAD_CREATE", thread("26", parent="21"))
            world.add(message(str(marker + 4), "cataly-test: first message in new thread", channel="26"))
            second = world.replies.get(timeout=12)
            assert second["message_reference"]["channel_id"] == "26"
            assert second["content"] == "확인: first message in new thread"

            world.active_threads = [record for record in world.active_threads if record["id"] != "22"]
            world.dispatch("THREAD_UPDATE", thread("22", archived=True))
            world.add(message(str(marker + 5), "cataly-test: archived thread ignored", channel="22"))
            world.events.put({"op": 7})
            assert world.auth.get(timeout=12)["op"] == 6
            world.add(message(str(marker + 6), "cataly-test: resumed allowed thread", channel="26"))
            reply = world.replies.get(timeout=12)
            assert reply["message_reference"]["channel_id"] == "26" and reply["content"] == "확인: resumed allowed thread"
            assert not any(text in calls for text in ["old thread history", "outside scoped threads", "archived thread ignored"])
            child.terminate()
            out, err = child.communicate(timeout=10)
            assert child.returncode == 0 and world.replies.empty(), (out, err)
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate(timeout=5)
