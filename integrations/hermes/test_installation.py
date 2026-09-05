"""Exercise the compiled installer through Hermes's CLI, loader and config parser.

Run with Hermes on PYTHONPATH and CONE_TEST_BINARY pointing to a compiled Cone.
"""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


@unittest.skipUnless(os.environ.get("CONE_TEST_BINARY"), "requires a compiled Cone")
class InstallationTests(unittest.TestCase):
    def test_install_and_repeat_load_effective_settings_without_changing_other_platforms(self):
        binary = str(Path(os.environ["CONE_TEST_BINARY"]).resolve())
        hermes = str(Path(sys.executable).with_name("hermes"))
        with tempfile.TemporaryDirectory(prefix="cone-hermes-install-") as temporary:
            home = Path(temporary)
            config = home / "config.yaml"
            config.write_text(yaml.safe_dump({
                "gateway": {"platforms": {"cone": {"enabled": False, "extra": {
                    "binary": "/old/cone", "home": "/old/identity", "name": "old",
                }}}},
                "display": {"streaming": True, "tool_progress": "all",
                    "platforms": {"telegram": {"streaming": True}}},
            }))
            env = {**os.environ, "HERMES_HOME": temporary, "CONE_HOME": str(home / "identity")}
            for custom_home in (True, False):
                if not custom_home:
                    env.pop("CONE_HOME")
                subprocess.run([binary, "integrate", "hermes", "--binary", binary,
                    "--hermes", hermes, "--no-restart"], env=env, check=True, capture_output=True, text=True)
                # Load in a fresh process: Hermes caches discovery and config.
                result = subprocess.run([sys.executable, "-c", '''
import json
from hermes_cli.plugins import discover_plugins
from hermes_cli.config import load_config
from gateway.config import load_gateway_config, Platform
from gateway.platform_registry import platform_registry
from gateway.display_config import resolve_display_setting
discover_plugins()
entry = platform_registry.get("cone")
config = load_gateway_config().platforms[Platform("cone")]
adapter = entry.adapter_factory(config)
user_config = load_config()
print(json.dumps({"enabled": config.enabled, "binary": adapter.binary,
    "home": adapter.cone_home, "name": adapter.alias,
    "editing": adapter.SUPPORTS_MESSAGE_EDITING,
    "display": {key: resolve_display_setting(user_config, "cone", key)
        for key in ["tool_progress", "streaming", "thinking_progress", "interim_assistant_messages", "long_running_notifications"]}}))
'''], env=env, check=True, capture_output=True, text=True)
                actual = json.loads(result.stdout.strip().splitlines()[-1])
                self.assertEqual(actual, {"enabled": True, "binary": binary,
                    "home": str(home / "identity") if custom_home else "", "name": "hermes", "editing": False,
                    "display": {"tool_progress": "off", "streaming": False, "thinking_progress": False,
                        "interim_assistant_messages": False, "long_running_notifications": False}})
                saved = yaml.safe_load(config.read_text())
                self.assertEqual(saved["display"]["platforms"]["telegram"], {"streaming": True})
                self.assertEqual(saved["display"]["tool_progress"], "all")


if __name__ == "__main__":
    unittest.main()
