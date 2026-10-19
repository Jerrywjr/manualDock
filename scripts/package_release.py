#!/usr/bin/env python3
"""Build ManualDock's offline release from an explicit, reviewed file list."""
from pathlib import Path
import hashlib
import ipaddress
import json
import os
import re
import shutil
import tempfile
import zipfile

RUNTIME = (
    'exports.js', 'library-view.js', 'background-runtime.js', 'runtime-client.js', 'archive.js', 'batch.js', 'session.js', 'source-connector.js', 'source-controls.js', 'background.js', 'bind-check.js', 'browser-io.js', 'capture.js', 'core.js', 'engine.js',
    'recovery.js', 'auto-retry.js', 'manifest.json', 'manual-adapters.js',
    'navigation-discovery.js', 'navigation-rotation.js', 'rotation-controller.js', 'openapi.js',
    'panel.css', 'panel.html', 'panel.js', 'profiles.js', 'sangfor-rules.js',
    'task-store.js', 'tree.js', 'vendor/yaml.js', 'vendor/yaml.LICENSE.txt',
)
PUBLIC_DOCS = (
    'README.md', 'AGENTS.md', 'LICENSE', '使用说明.md',
    'docs/handoff-2026-10-19.md', 'docs/project-status.md', 'docs/modules.json', 'docs/architecture.md', 'docs/function-status.md', 'docs/validation.md', 'docs/development.md',
)
SKILL_ROOT = 'skill/import-security-manuals'
SKILL_FILES = (
    f'{SKILL_ROOT}/SKILL.md', f'{SKILL_ROOT}/agents/openai.yaml',
    f'{SKILL_ROOT}/references/usage.md', f'{SKILL_ROOT}/scripts/inspect_archive.py',
)
PRIVATE_NETWORKS = tuple(ipaddress.ip_network(pair) for pair in
    ((0x0A000000, 8), (0xAC100000, 12), (0xC0A80000, 16)))


def checked_path(root, relative):
    """Refuse symlinks and paths escaping a specifically owned project root."""
    relative = Path(relative)
    if relative.is_absolute() or '..' in relative.parts:
        raise ValueError(f'Unsafe relative path: {relative}')
    candidate = root
    for part in relative.parts:
        candidate = candidate / part
        if candidate.is_symlink():
            raise ValueError(f'Refusing linked release path: {relative}')
    if not candidate.resolve().is_relative_to(root.resolve()):
        raise ValueError(f'Path escapes release root: {relative}')
    return candidate


def check_public_content(relative, data):
    """Fail on known kinds of private workspace evidence; never rewrite it away."""
    text = data.decode('utf-8')
    if re.search(r'/' + r'Users/[^/\s]+/|[A-Za-z]:\\Users\\|https?://\[(?:fc|fd)[0-9a-f:]+\]', text, re.I):
        raise ValueError(f'Personal path or private device address in {relative}')
    for raw in re.findall(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])', text):
        try:
            address = ipaddress.ip_address(raw)
        except ValueError:
            continue
        if any(address in network for network in PRIVATE_NETWORKS):
            raise ValueError(f'Private device address in {relative}')
    # Public adapter names are source documentation, not private device evidence.
    # Personal paths, private addresses and the explicit file allowlist remain enforced.


def runtime_hashes(root):
    return {name: hashlib.sha256(checked_path(root, 'extension/' + name).read_bytes()).hexdigest()
            for name in RUNTIME}


def build(root):
    manifest = json.loads(checked_path(root, 'extension/manifest.json').read_text())
    if manifest.get('name') != 'ManualDock':
        raise ValueError('Expected the ManualDock extension manifest')
    version = manifest.get('version', '')
    if not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Expected a three-part numeric extension version')
    payload = {}
    for relative in [*('extension/' + name for name in RUNTIME), *PUBLIC_DOCS, *SKILL_FILES]:
        data = checked_path(root, relative).read_bytes()
        check_public_content(relative, data)
        payload[relative] = data
    # Assets are a generated mirror, rebuilt only after all release inputs pass.
    assets = checked_path(root, f'{SKILL_ROOT}/assets/extension')
    if assets.exists():
        if not assets.is_dir():
            raise ValueError('Skill assets path must be a directory')
        shutil.rmtree(assets)
    for name in RUNTIME:
        data = payload['extension/' + name]
        target = checked_path(root, f'{SKILL_ROOT}/assets/extension/{name}')
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        assert target.read_bytes() == data
        payload[f'{SKILL_ROOT}/assets/extension/{name}'] = data
    hashes = runtime_hashes(root)
    hash_file = checked_path(root, 'docs/release-extension.sha256.json')
    hash_file.parent.mkdir(parents=True, exist_ok=True)
    hash_file.write_text(json.dumps(hashes, indent=2) + '\n')
    output = checked_path(root, f'manualdock-v{version}.zip')
    descriptor, temp_name = tempfile.mkstemp(prefix='.manualdock-release-', suffix='.zip', dir=root)
    os.close(descriptor)
    try:
        with zipfile.ZipFile(temp_name, 'w', zipfile.ZIP_DEFLATED) as archive:
            for relative, data in sorted(payload.items()):
                archive.writestr('manualdock/' + relative, data)
        os.replace(temp_name, output)
    finally:
        Path(temp_name).unlink(missing_ok=True)
    return {'zip': str(output), 'bytes': output.stat().st_size,
            'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
            'extensionFiles': len(RUNTIME), 'archiveFiles': len(payload)}


if __name__ == '__main__':
    print(json.dumps(build(Path(__file__).resolve().parent.parent), indent=2))
