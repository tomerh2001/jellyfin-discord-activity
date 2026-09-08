#!/usr/bin/env python3
"""Read the service's 1Password item and configure the existing TrueNAS stack.

Populate discord_client_id, discord_client_secret, discord_bot_token,
discord_public_key, and discord_guild_id in Home Server / Jellyfin Discord
Activity. Existing Jellyfin/password/encryption fields are also required.
Cloudflare Worker attestation mode also requires discord_proxy_edge_secret.

    python3 deploy/configure-home-server.py --check
    python3 deploy/configure-home-server.py --apply
    python3 deploy/configure-home-server.py --apply --proxy-auth-mode cloudflare-worker

No secrets are printed or written into this repository. --apply validates all
fields and Compose before changing runtime files, then uses filesystem.setacl
for the private NFSv4 secret directory. It does not deploy or restart anything.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


DEFAULT_ROOT = Path("/mnt/Pool/System/Home/tomerh2001/projects/tomerh2001")
SECRET_FIELDS = (
    "discord_client_secret", "discord_bot_token", "app_session_secret",
    "token_encryption_key", "jellyfin_shared_password",
)
EDGE_SECRET_FIELD = "discord_proxy_edge_secret"
PUBLIC_FIELDS = {
    "discord_client_id": "DISCORD_CLIENT_ID",
    "discord_public_key": "DISCORD_PUBLIC_KEY",
    "discord_guild_id": "DISCORD_ALLOWED_GUILD_IDS",
}


def secret_fields(proxy_auth_mode: str) -> tuple[str, ...]:
    return (*SECRET_FIELDS, EDGE_SECRET_FIELD) if proxy_auth_mode == "cloudflare-worker" else SECRET_FIELDS


def required_fields(proxy_auth_mode: str) -> tuple[str, ...]:
    return (*secret_fields(proxy_auth_mode), *PUBLIC_FIELDS)


def resolve_proxy_auth_mode(requested: str | None, stack: Path) -> str:
    if requested:
        return requested
    match = re.search(r"^DISCORD_PROXY_AUTH_MODE=(.*)$", (stack / ".env").read_text(), re.M)
    mode = match.group(1).strip() if match else "signature"
    if mode not in ("signature", "cloudflare-worker"):
        raise SetupError("Stack DISCORD_PROXY_AUTH_MODE must be signature or cloudflare-worker.")
    return mode


class SetupError(Exception):
    """A safe, credential-free setup error."""


def run(args: list[str], *, timeout: int = 90) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise SetupError("A required command was unavailable or timed out.") from None


def read_fields(args: argparse.Namespace) -> tuple[dict[str, str], list[str]]:
    values: dict[str, str] = {}
    unavailable: list[str] = []
    for field in required_fields(args.proxy_auth_mode):
        result = run([sys.executable, str(args.resolver), "get", f"op://{args.vault}/{args.item_id}/{field}"])
        if result.returncode:
            # Resolver diagnostics may contain upstream payloads; never relay them.
            # Connect-mode op read reports empty fields as not found.
            if "could not find field or file" in result.stderr.lower():
                values[field] = ""
            else:
                unavailable.append(field)
            continue
        values[field] = result.stdout.rstrip("\r\n")
    return values, unavailable


def invalid_fields(values: dict[str, str]) -> list[str]:
    invalid: set[str] = set()
    for field, value in values.items():
        if value and (len(value) > 4096 or "\n" in value or "\r" in value or "\x00" in value):
            invalid.add(field)
    for field in ("discord_client_secret", "discord_bot_token", "app_session_secret"):
        value = values.get(field, "")
        if value and (len(value) < 32 or len(set(value)) < 12 or re.search(r"development|change[-_ ]?me|replace[-_ ]?me|your[-_ ]|example|placeholder", value, re.I)):
            invalid.add(field)
    value = values.get(EDGE_SECRET_FIELD, "")
    if value:
        valid = bool(re.fullmatch(r"[A-Za-z0-9_-]{43,512}", value)) and len(set(value)) >= 12
        valid = valid and not re.search(r"development|change[-_]?me|replace[-_]?me|example|placeholder", value, re.I)
        if re.fullmatch(r"[a-fA-F0-9]+", value):
            valid = valid and len(value) >= 64 and len(value) % 2 == 0
        else:
            try:
                decoded = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
                valid = valid and len(decoded) >= 32 and base64.urlsafe_b64encode(decoded).decode().rstrip("=") == value
            except ValueError:
                valid = False
        if not valid:
            invalid.add(EDGE_SECRET_FIELD)
    value = values.get("token_encryption_key", "")
    if value:
        try:
            if len(base64.b64decode(value, validate=True)) != 32 or len(set(value)) < 12:
                invalid.add("token_encryption_key")
        except ValueError:
            invalid.add("token_encryption_key")
    value = values.get("jellyfin_shared_password", "")
    if value and len(value) < 12:
        invalid.add("jellyfin_shared_password")
    value = values.get("discord_client_id", "")
    if value and not re.fullmatch(r"[0-9]{17,20}", value):
        invalid.add("discord_client_id")
    value = values.get("discord_public_key", "")
    if value and not re.fullmatch(r"[0-9a-fA-F]{64}", value):
        invalid.add("discord_public_key")
    value = values.get("discord_guild_id", "")
    if value and not all(re.fullmatch(r"[0-9]{17,20}", part.strip()) for part in value.split(",")):
        invalid.add("discord_guild_id")
    return sorted(invalid)


def replace_env(text: str, updates: dict[str, str]) -> str:
    pending = dict(updates)
    lines = []
    for line in text.splitlines():
        name = line.split("=", 1)[0]
        if name in updates:
            if name in pending:
                lines.append(name + "=" + pending.pop(name))
        else:
            lines.append(line)
    lines.extend(name + "=" + value for name, value in pending.items())
    return "\n".join(lines) + "\n"


def compose_check(stack: Path, env_file: Path) -> None:
    result = run(["docker", "compose", "--project-directory", str(stack), "--env-file", str(env_file), "-f", str(stack / "compose.yml"), "config", "-q"])
    if result.returncode:
        raise SetupError("Compose validation failed; inspect the stack configuration locally.")


def set_secret_acl(directory: Path, uid: int, gid: int, operator: int, admins: int) -> None:
    prefix = [] if os.geteuid() == 0 else ["sudo", "-n"]
    entries = []
    for tag, ident in (("owner@", None), ("USER", operator), ("GROUP", admins)):
        entry = {"tag": tag, "type": "ALLOW", "perms": {"BASIC": "FULL_CONTROL"}, "flags": {"BASIC": "INHERIT"}}
        if ident is not None:
            entry["id"] = ident
        entries.append(entry)
    payload = {"path": str(directory), "uid": uid, "gid": gid, "dacl": entries,
               "options": {"recursive": True, "traverse": False, "canonicalize": True, "validate_effective_acl": False}}
    result = run([*prefix, "midclt", "call", "filesystem.setacl", json.dumps(payload)])
    if result.returncode:
        raise SetupError("TrueNAS could not set the runtime secret ACL.")
    try:
        job_id = int(result.stdout.strip())
    except ValueError:
        raise SetupError("TrueNAS returned an unexpected ACL job result.") from None
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        result = run([*prefix, "midclt", "call", "core.get_jobs", json.dumps([["id", "=", job_id]]), '{"get":true}'])
        try:
            job = json.loads(result.stdout) if result.returncode == 0 else {}
        except ValueError:
            job = {}
        if job.get("state") == "SUCCESS":
            return
        if job.get("state") in ("FAILED", "ABORTED"):
            raise SetupError("TrueNAS rejected the runtime secret ACL.")
        time.sleep(1)
    raise SetupError("TrueNAS ACL job did not finish within two minutes.")


def apply_config(args: argparse.Namespace, values: dict[str, str]) -> None:
    stack = args.stack_dir.resolve()
    directory = args.data_dir / ".secrets"
    env_path = stack / ".env"
    if not directory.is_dir() or directory.is_symlink() or env_path.is_symlink():
        raise SetupError("The existing provisioned secret directory and regular stack .env are required.")
    active_secret_fields = secret_fields(args.proxy_auth_mode)
    if any((directory / field).is_symlink() for field in active_secret_fields):
        raise SetupError("Runtime secret paths must not be symlinks.")
    original = env_path.read_text()
    old = dict(re.findall(r"^([A-Z_]+)=(.*)$", original, re.M))
    try:
        uid, gid = int(old["PUID"]), int(old["PGID"])
        if min(uid, gid) < 1:
            raise ValueError()
    except (KeyError, ValueError):
        raise SetupError("Stack PUID/PGID must identify the provisioned non-root service account.") from None
    updates = {env_name: values[field].strip() for field, env_name in PUBLIC_FIELDS.items()}
    updates["DISCORD_PROXY_AUTH_MODE"] = args.proxy_auth_mode
    candidate = replace_env(original, updates)
    # This temporary file contains only the existing nonsecret stack config and IDs.
    with tempfile.NamedTemporaryFile(mode="w", prefix="jellyfin-watch-env-", suffix=".env") as temp:
        temp.write(candidate)
        temp.flush()
        compose_check(stack, Path(temp.name))
    staged: dict[str, Path] = {}
    try:
        for field in active_secret_fields:
            target = directory / field
            if target.exists() and target.read_text().rstrip("\r\n") == values[field]:
                continue
            fd, name = tempfile.mkstemp(prefix=".pending-", dir=directory)
            staged[field] = Path(name)
            with os.fdopen(fd, "w") as output:
                output.write(values[field] + "\n")
                output.flush()
                os.fsync(output.fileno())
        # Apply owner/operator/admin ACLs before any new secret becomes active.
        set_secret_acl(directory, uid, gid, args.operator_uid, args.admin_gid)
        for field, staged_path in staged.items():
            os.replace(staged_path, directory / field)
        # Updating in place retains the operator-authored stack file's ACL/owner.
        with env_path.open("w") as output:
            output.write(candidate)
            output.flush()
            os.fsync(output.fileno())
        compose_check(stack, env_path)
    finally:
        for staged_path in staged.values():
            staged_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--vault", default="Home Server")
    parser.add_argument("--item-id", default="ivaz6seq2o4y7kuow5xjwqrqse")
    parser.add_argument("--resolver", type=Path, default=DEFAULT_ROOT / "agent-skills/skills/onepassword/scripts/secret_resolver.py")
    parser.add_argument("--stack-dir", type=Path, default=Path("/mnt/Pool/Services/Stacks/jellyfin-discord-activity"))
    parser.add_argument("--data-dir", type=Path, default=Path("/mnt/Pool/Services/Data/jellyfin-discord-activity"))
    parser.add_argument("--operator-uid", type=int, default=3000)
    parser.add_argument("--admin-gid", type=int, default=544)
    parser.add_argument("--proxy-auth-mode", choices=("signature", "cloudflare-worker"),
                        help="Explicit ingress mode; otherwise preserve the mode already in the stack .env.")
    args = parser.parse_args()
    if "/" in args.vault or not re.fullmatch(r"[a-z0-9]{26}", args.item_id) or min(args.operator_uid, args.admin_gid) < 1:
        raise SetupError("Invalid vault/item or operator/admin identifiers.")
    args.proxy_auth_mode = resolve_proxy_auth_mode(args.proxy_auth_mode, args.stack_dir)
    values, unavailable = read_fields(args)
    missing = [field for field in required_fields(args.proxy_auth_mode) if field not in unavailable and not values.get(field)]
    invalid = invalid_fields(values)
    ready = not (missing or unavailable or invalid)
    if ready and args.apply:
        apply_config(args, values)
    print(json.dumps({"ready": ready, "applied": bool(ready and args.apply), "proxy_auth_mode": args.proxy_auth_mode,
                      "missing_fields": missing, "unavailable_fields": unavailable, "invalid_fields": invalid}))
    return 0 if ready else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except SetupError as error:
        print(json.dumps({"ready": False, "applied": False, "error": str(error)}))
        raise SystemExit(2) from None
    except Exception:
        # Tracebacks, subprocess output and upstream errors can contain secrets.
        print(json.dumps({"ready": False, "applied": False, "error": "Configuration failed; no deployment was started. Resolve the host failure and rerun the helper."}))
        raise SystemExit(2) from None
