"""XMTP dev-network test using the real Hermes processing lifecycle.

Run with Hermes on PYTHONPATH and CONE_TEST_BINARY pointing to the built CLI.
Uses disposable identities; never loads the operator's Cone configuration.
"""
import asyncio
import json
import os
import tempfile
import time
from pathlib import Path

from test_adapter import module, PlatformConfig
from gateway.platforms.base import ProcessingOutcome


async def main():
    binary = os.environ["CONE_TEST_BINARY"]
    root = Path(tempfile.mkdtemp(prefix="cone-hermes-live-"))
    os.environ["HERMES_HOME"] = str(root / "hermes")
    alice_home, bob_home = root / "alice", root / "bob"

    async def cli(home, *args):
        env = dict(os.environ, CONE_HOME=str(home), CONE_SECRET_KEY="", XMTP_ENV="dev")
        child = await asyncio.create_subprocess_exec(binary, *args, env=env, cwd=root,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        out, err = await asyncio.wait_for(child.communicate(), 90)
        if child.returncode not in (0, 3):
            raise RuntimeError(f"cone {args[0]} failed: {err.decode()}")
        return json.loads(out)

    alice = await cli(alice_home, "init", "--env", "dev")
    bob = await cli(bob_home, "init", "--env", "dev")
    print("Fresh identities initialized", flush=True)
    calls = []
    handled_at = []
    latencies = []
    published_before_ack = asyncio.Event()
    adapter = None

    async def start(interrupt_ack=False):
        adapter = module.ConeAdapter(PlatformConfig(enabled=True, extra={"binary": binary, "home": str(bob_home)}))

        async def handler(event):
            calls.append(event.message_id)
            handled_at.append(time.monotonic())
            return f"Hermes reply {len(calls)}"

        adapter.set_message_handler(handler)
        if interrupt_ack:
            async def interrupted(event, outcome):
                if outcome == ProcessingOutcome.SUCCESS:
                    published_before_ack.set()
                else:
                    raise RuntimeError("Hermes response processing failed")
            adapter.on_processing_complete = interrupted
        await adapter.connect()
        return adapter

    async def wait_handled(adapter, expected_calls):
        for _ in range(300):
            pending = await adapter._rpc("receive", consumer="hermes", limit=10, waitMs=0)
            if len(calls) >= expected_calls and not pending["messages"]:
                return
            await asyncio.sleep(0.1)
        raise RuntimeError("Hermes did not acknowledge completed processing")

    try:
        adapter = await start()
        await adapter._rpc("connect", to=alice["inboxId"], name="Alice")
        await cli(alice_home, "connect", bob["inboxId"], "--name", "Bob")
        started = time.monotonic()
        await cli(alice_home, "send", "--to", "Bob", "--text", "first request", "--idempotency-key", "first")
        first = await cli(alice_home, "receive", "--timeout-ms", "30000")
        assert [m["text"] for m in first["messages"]] == ["Hermes reply 1"], first
        await cli(alice_home, "ack", "--message", first["messages"][0]["messageId"])
        await wait_handled(adapter, 1)
        latencies.append(round(handled_at[0] - started, 3))
        print("Automatic reply published and processing acknowledged", flush=True)

        started = time.monotonic()
        await cli(alice_home, "send", "--to", "Bob", "--text", "next request", "--idempotency-key", "next")
        next_reply = await cli(alice_home, "receive", "--timeout-ms", "30000")
        assert [m["text"] for m in next_reply["messages"]] == ["Hermes reply 2"], next_reply
        await cli(alice_home, "ack", "--message", next_reply["messages"][0]["messageId"])
        await wait_handled(adapter, 2)
        latencies.append(round(handled_at[1] - started, 3))
        print(json.dumps({"sendCommandToHandlerSeconds": latencies}), flush=True)
        assert max(latencies) < 10, "A healthy stream must deliver without waiting for the 30-second catch-up"

        await adapter.disconnect()
        await cli(alice_home, "send", "--to", "Bob", "--text", "request while offline", "--idempotency-key", "offline")
        adapter = await start(interrupt_ack=True)
        assert (await adapter._rpc("identity"))["inboxId"] == bob["inboxId"]
        await asyncio.wait_for(published_before_ack.wait(), 40)
        second = await cli(alice_home, "receive", "--timeout-ms", "30000")
        assert [m["text"] for m in second["messages"]] == ["Hermes reply 3"], second
        await cli(alice_home, "ack", "--message", second["messages"][0]["messageId"])
        print("Offline message recovered; stopping after publication but before acknowledgement", flush=True)

        await adapter.disconnect()
        adapter = await start()
        await wait_handled(adapter, 4)
        replay = await cli(alice_home, "receive", "--timeout-ms", "1500")
        assert replay["messages"] == [], replay
        assert calls[2] == calls[3], calls
        print(json.dumps({"ok": True, "identityPreserved": True, "offlineRecovery": True,
                          "replayedUnacknowledgedProcessing": True, "duplicateReplies": 0,
                          "sendCommandToHandlerSeconds": latencies}))
    finally:
        if adapter:
            await adapter.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
