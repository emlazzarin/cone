"""Run with Hermes on PYTHONPATH; uses its actual adapter base and registry."""
import asyncio
import importlib.util
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

from gateway.config import PlatformConfig
from gateway.platform_registry import PlatformEntry, platform_registry
from gateway.platforms.base import ProcessingOutcome

spec = importlib.util.spec_from_file_location("cone_adapter_tested", Path(__file__).with_name("adapter.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
module.register(SimpleNamespace(register_platform=lambda **kwargs: platform_registry.register(PlatformEntry(**kwargs))))


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    def make_adapter(self):
        return module.ConeAdapter(PlatformConfig(enabled=True, extra={"binary": "/unused/cone"}))

    async def test_send_failure_reuses_key_and_success_uses_real_message_id(self):
        adapter = self.make_adapter()
        adapter._active["chat"] = {"message": {"messageId": "incoming"}, "part": 0}
        adapter._rpc = AsyncMock(side_effect=[module.ConeRpcError("offline"), {"messageId": "published"}])
        self.assertFalse((await adapter.send("chat", "reply")).success)
        result = await adapter.send("chat", "reply")
        self.assertTrue(result.success)
        self.assertEqual(result.message_id, "published")
        self.assertEqual([call.kwargs["key"] for call in adapter._rpc.call_args_list], ["hermes:incoming:0"] * 2)

    async def test_only_successful_processing_acknowledges_the_exact_message(self):
        for outcome in ProcessingOutcome:
            adapter = self.make_adapter()
            adapter._rpc = AsyncMock(return_value={})
            adapter._active["chat"] = {"message": {"messageId": "incoming"}, "part": 0}
            event = SimpleNamespace(source=SimpleNamespace(chat_id="chat"), message_id="incoming")
            await adapter.on_processing_complete(event, outcome)
            if outcome == ProcessingOutcome.SUCCESS:
                adapter._rpc.assert_awaited_once_with("ack", consumer="hermes", messageIds=["incoming"])
            else:
                adapter._rpc.assert_not_awaited()
            self.assertNotIn("chat", adapter._active)

    async def test_scheduling_a_background_turn_does_not_acknowledge_or_dispatch_twice(self):
        adapter = self.make_adapter()
        adapter._running = True
        adapter.handle_message = AsyncMock()
        message = {"conversationId": "chat", "conversationKind": "dm", "messageId": "incoming",
                   "senderInboxId": "peer", "text": "/restart"}
        adapter._rpc = AsyncMock(side_effect=[{"messages": [message, dict(message, messageId="second")]}, asyncio.CancelledError()])
        with self.assertRaises(asyncio.CancelledError):
            await adapter._receive()
        adapter.handle_message.assert_awaited_once()
        event = adapter.handle_message.call_args.args[0]
        self.assertFalse(event.is_command())
        self.assertEqual(adapter._active["chat"]["message"]["messageId"], "incoming")
        self.assertEqual(adapter._rpc.call_args_list[1].kwargs["excludeConversationIds"], ["chat"])
        self.assertEqual([call.args[0] for call in adapter._rpc.call_args_list], ["receive", "receive"])

    async def test_group_messages_only_dispatch_when_addressed(self):
        adapter = self.make_adapter()
        adapter._running = True
        adapter.handle_message = AsyncMock()
        adapter._rpc = AsyncMock(side_effect=[{"messages": [{"conversationId": "group", "conversationKind": "group",
            "messageId": "ignored", "senderInboxId": "peer", "text": "hello everybody"}]}, {}, asyncio.CancelledError()])
        with self.assertRaises(asyncio.CancelledError):
            await adapter._receive()
        adapter.handle_message.assert_not_awaited()
        self.assertEqual(adapter._rpc.call_args_list[1].args[0], "ack")


if __name__ == "__main__":
    unittest.main()
