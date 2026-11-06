"""Exercise the published extension entry in a real Pi TUI, with a local fake model."""

import fcntl
import http.server
import json
import os
from pathlib import Path
import pty
import re
import select
import shutil
import struct
import subprocess
import tempfile
import termios
import threading
import time

ROOT = Path(__file__).resolve().parent.parent
TITLE = "Fix login validation"
requests = []


class ModelServer(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        naming = body["model"] == "title-model"
        answer = "Done."
        if naming:
            state = json.loads(body["messages"][-1]["content"])
            answer = "KEEP"
            if not state["current_title"]:
                answer = "TITLE: " + TITLE
            if "billing" in state["new_request"].lower():
                answer = "TITLE: Implement billing"
        record = {"naming": naming, "body": body, "started": time.monotonic()}
        requests.append(record)
        time.sleep(0.4 if naming else 1.2)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        chunks = [
            {"delta": {"role": "assistant", "content": answer}, "finish_reason": None},
            {"delta": {}, "finish_reason": "stop"},
        ]
        for choice in chunks:
            chunk = {"id": "smoke", "object": "chat.completion.chunk", "created": 0,
                     "model": body["model"], "choices": [{"index": 0, **choice}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()
        record["finished"] = time.monotonic()


server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), ModelServer)
threading.Thread(target=server.serve_forever, daemon=True).start()
process = None
master = None
try:
    with tempfile.TemporaryDirectory(prefix="pi-ghostty-smoke-") as temporary:
        agent = Path(temporary) / "agent"
        agent.mkdir()
        project = Path(temporary) / "demo-app"
        project.mkdir()
        (agent / "settings.json").write_text(json.dumps({"quietStartup": True, "defaultProjectTrust": "no"}))
        (agent / "pi-ghostty.json").write_text(json.dumps({"provider": "smoke", "id": "title-model"}))
        (agent / "models.json").write_text(json.dumps({"providers": {"smoke": {
            "baseUrl": f"http://127.0.0.1:{server.server_port}/v1",
            "api": "openai-completions", "apiKey": "dummy",
            "models": [{"id": name, "reasoning": False, "input": ["text"],
                        "contextWindow": 8192, "maxTokens": 2048} for name in ["test-model", "title-model"]],
        }}}))
        master, slave = pty.openpty()
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        environment = {key: value for key, value in os.environ.items() if not key.startswith("PI_")}
        environment.update(PI_CODING_AGENT_DIR=str(agent), PI_OFFLINE="1", TERM="xterm-256color")
        command = [shutil.which("node"), str(ROOT / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
                   "--offline", "--no-extensions", "-e", str(ROOT / "extensions/ghostty.ts"),
                   "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
                   "--no-tools", "--no-session", "--no-approve", "--tui-mode", "regular",
                   "--provider", "smoke", "--model", "test-model", "--thinking", "off",
                   "--system-prompt", "Respond briefly. No tools.", "Fix login validation"]
        process = subprocess.Popen(command, cwd=project, env=environment, stdin=slave, stdout=slave, stderr=slave)
        os.close(slave)
        output = bytearray()
        expected = [f"{TITLE} | demo-app", f"{TITLE} | demo-app", "Implement billing | demo-app"]
        prompts = [b"Add tests and commit\r", b"Now implement billing\r"]
        stage = 0
        stage_start = 0
        deadline = time.monotonic() + 40
        titles = []
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                output.extend(data)
                if b"\x1b[6n" in data:
                    os.write(master, b"\x1b[1;1R")
                if b"\x1b[?u" in data:
                    os.write(master, b"\x1b[?0u")
                for code in (10, 11):
                    if f"\x1b]{code};?".encode() in data:
                        os.write(master, f"\x1b]{code};rgb:0000/0000/0000\x1b\\".encode())
                titles = [value.decode() for value in re.findall(rb"\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)", output)]
                stage_titles = titles[stage_start:]
                idle = expected[stage]
                if idle in stage_titles and any(title.endswith(idle) and title != idle for title in stage_titles):
                    working = [title for title in stage_titles if title.endswith(idle) and title != idle]
                    assert len(set(working)) >= 2, f"Spinner did not animate: {working}"
                    stage += 1
                    if stage == len(expected):
                        break
                    stage_start = len(titles)
                    os.write(master, prompts[stage - 1])
            if process.poll() is not None:
                break

        assert stage == len(expected), f"Missing title transition at stage {stage}. Titles: {titles}. Output: {output[-2500:]!r}"
        assert titles[-1] == expected[-1], f"Spinner did not settle: {titles[-5:]}"
        naming = [request for request in requests if request["naming"]]
        main = [request for request in requests if not request["naming"]]
        assert len(naming) == 3 and len(main) == 3, f"Unexpected requests: {len(naming)} naming, {len(main)} main"
        for title_request, main_request in zip(naming, main):
            assert main_request["started"] < title_request["finished"], "Naming delayed the main request"
            assert len(title_request["body"]["messages"]) == 2, "Naming received conversation history"
            assert not title_request["body"].get("tools"), "Naming received tools"
        os.write(master, b"\x04")
        deadline = time.monotonic() + 10
        while process.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break
        assert process.poll() == 0, f"Pi did not exit cleanly: {process.poll()}. Output: {output[-1500:]!r}"
        print("PASS: real Pi TUI generated, kept, and replaced titles using the dedicated model; animated and settled cleanly")
finally:
    if process is not None and process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
    if master is not None:
        os.close(master)
    server.shutdown()
    server.server_close()
