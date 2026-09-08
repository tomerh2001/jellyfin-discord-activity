import base64
import importlib.util
from pathlib import Path
import secrets
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("configure_home_server", Path(__file__).with_name("configure-home-server.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class IngressConfigurationTests(unittest.TestCase):
    def test_cloudflare_mode_requires_its_own_secret_without_changing_signature_requirements(self):
        self.assertNotIn(module.EDGE_SECRET_FIELD, module.required_fields("signature"))
        self.assertIn(module.EDGE_SECRET_FIELD, module.required_fields("cloudflare-worker"))

    def test_rerunning_helper_preserves_explicit_existing_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            stack = Path(directory)
            env = stack / ".env"
            env.write_text("DISCORD_PROXY_AUTH_MODE=cloudflare-worker\n")
            self.assertEqual(module.resolve_proxy_auth_mode(None, stack), "cloudflare-worker")
            self.assertEqual(module.resolve_proxy_auth_mode("signature", stack), "signature")
            env.write_text("DISCORD_PROXY_AUTH_MODE=off\n")
            with self.assertRaises(module.SetupError):
                module.resolve_proxy_auth_mode(None, stack)
            env.write_text("DISCORD_CLIENT_ID=123\n")
            self.assertEqual(module.resolve_proxy_auth_mode(None, stack), "signature")

    def test_rejects_weak_and_noncanonical_edge_encodings(self):
        for value in ("short", "a" * 64, "0123456789abcdef" * 3, "x" * 513, secrets.token_hex(32) + "\n"):
            with self.subTest(length=len(value)):
                self.assertIn(module.EDGE_SECRET_FIELD, module.invalid_fields({module.EDGE_SECRET_FIELD: value}))
        for value in (secrets.token_hex(32), base64.urlsafe_b64encode(secrets.token_bytes(32)).decode().rstrip("=")):
            self.assertNotIn(module.EDGE_SECRET_FIELD, module.invalid_fields({module.EDGE_SECRET_FIELD: value}))


if __name__ == "__main__":
    unittest.main()
