"""Use stock OMP behind a local wire fixture that declines one optional RPC."""

import json
import subprocess
import sys


def exercise_upgrade(command, env, root, calls, run_harness):
    path = root / "omp-rpc-without-host-tools"
    omp = command[2]
    path.write_text(f"""#!{sys.executable}
import json
import subprocess
import sys
from threading import Lock, Thread
if sys.argv[1:] == ['--version']:
    sys.exit(4)
with subprocess.Popen([{omp!r}, *sys.argv[1:]], stdin=subprocess.PIPE, stdout=subprocess.PIPE) as worker:
    output = Lock()
    def write(line):
        with output:
            sys.stdout.buffer.write(line)
            sys.stdout.buffer.flush()
    def forward():
        for line in worker.stdout:
            write(line)
    pump = Thread(target=forward)
    pump.start()
    for line in sys.stdin.buffer:
        request = json.loads(line)
        if request.get('type') == 'set_host_tools':
            decline = {{'type': 'response', 'id': request['id'], 'command': 'set_host_tools', 'success': False}}
            write(json.dumps(decline).encode() + b'\\n')
        else:
            worker.stdin.write(line)
            worker.stdin.flush()
    worker.stdin.close()
    pump.join()
    sys.exit(worker.wait())
""", encoding="utf-8")
    path.chmod(0o700)
    wrapped = [*command]
    wrapped[2] = str(path)
    check = subprocess.run([*wrapped[:7], "doctor"], env=env, capture_output=True, text=True, timeout=15, check=False)
    assert check.returncode == 0, check.stderr
    assert json.loads(check.stdout) == {"omp_version": None, "rpc_protocol": 2, "host_tools": False}
    prompt = "cataly-test: blocked optional README turn"
    request, = run_harness(wrapped, env, {"op": "run_with_tools", "id": "upgrade-1", "key": "upgrade-test", "prompt": prompt})
    assert request["status"] == "failed" and request["claim"]["tool"] == "read_readme", request
    assert "blocked optional README turn" not in calls
    followup, = run_harness(wrapped, env, {
        "op": "run", "id": "upgrade-2", "key": "upgrade-test", "prompt": "cataly-test: text after upgrade",
    })
    assert followup["text"] == "확인: text after upgrade"
    assert request["claim"]["session_id"] == followup["claim"]["session_id"]
