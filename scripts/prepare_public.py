#!/usr/bin/env python3
"""Prepare a public ManualDock source tree; never copy a whole development folder."""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile

from package_release import RUNTIME, PUBLIC_DOCS, SKILL_FILES, SKILL_ROOT, checked_path, check_public_content

PUBLIC_TESTS = (
    'library-view.test.mjs', 'library-layout.browser.mjs', 'background-runtime.test.mjs', 'runtime-client.test.mjs', 'runtime.browser.mjs', 'recognition.browser.mjs',
    'source-connector.test.mjs', 'source-controls.test.mjs', 'archive-restore.test.mjs', 'batch.test.mjs', 'session.test.mjs', 'task-store.test.mjs', 'panel-bind.test.mjs', 'archive.test.mjs', 'auto-retry.test.mjs', 'background.test.mjs',
    'browser-io.test.mjs', 'capture.test.mjs', 'capture-disclosures.test.mjs', 'content-preparation.test.mjs', 'core.test.mjs',
    'engine-recovery.chromium.mjs', 'engine-recovery.integration.mjs', 'engine.test.mjs', 'generic-capture.test.mjs', 'integration-panel.test.mjs',
    'integration-profiles.test.mjs', 'manual-adapters.test.mjs',
    'directory-scan.test.mjs', 'navigation-discovery.test.mjs', 'navigation-rotation.test.mjs', 'rotation-controller.test.mjs',
    'openapi.test.mjs', 'profiles.test.mjs', 'recovery.test.mjs',
    'universal-archive.test.mjs', 'universal-export.test.mjs',
    'universal.browser.integration.mjs', 'layout.browser.mjs', 'workspace.browser.mjs', 'scan-workspace.browser.mjs',
)
SOURCE_FILES = (
    '.gitignore', '.prettierignore', '.prettierrc.json', '.editorconfig', 'CONTRIBUTING.md', 'ci/check.yml', 'package.json', 'package-lock.json',
    'scripts/build-openapi-vendor.mjs', 'scripts/package_release.py', 'scripts/sync-assets.mjs', 'scripts/check-source.mjs',
    'scripts/prepare_public.py', 'scripts/check-handoff.mjs',
)
MARKER = '.manualdock-export.json'


def collect(source):
    manifest = json.loads(checked_path(source, 'extension/manifest.json').read_text())
    if manifest.get('name') != 'ManualDock':
        raise ValueError('Only the independent ManualDock product can be exported')
    payload = {}
    for relative in [*PUBLIC_DOCS, *SKILL_FILES, *SOURCE_FILES,
                     *('extension/' + name for name in RUNTIME),
                     *('tests/' + name for name in PUBLIC_TESTS)]:
        data = checked_path(source, relative).read_bytes()
        check_public_content(relative, data)
        payload[relative] = data
    for name in RUNTIME:
        payload[f'{SKILL_ROOT}/assets/extension/{name}'] = payload['extension/' + name]
    # This public tree has no historical controller or private-fixture test jobs.
    package = json.loads(payload['package.json'])
    if package.get('name') != 'manualdock' or package.get('version') != manifest['version']:
        raise ValueError('Package name/version must match the ManualDock manifest')
    removed_scripts = []
    payload['package.json'] = (json.dumps(package, indent=2, ensure_ascii=False) + '\n').encode()
    lock = json.loads(payload['package-lock.json'])
    if lock.get('name') != package['name'] or lock.get('version') != package['version']:
        raise ValueError('Refresh package-lock.json before preparing public source')
    # A private snapshot must never become a dependency of a published test.
    for relative, data in payload.items():
        if relative.startswith('tests/') and b'fixtures/' in data:
            raise ValueError(f'Test depends on a non-public fixture: {relative}')
    return payload, removed_scripts


def export(source, destination, refresh=False):
    source = source.resolve()
    if destination.is_symlink():
        raise ValueError('Refusing a linked destination')
    destination = destination.absolute()
    if destination.resolve() == source or source.is_relative_to(destination.resolve()) or destination.resolve().is_relative_to(source):
        raise ValueError('Public output must be a separate project directory')
    # Require a real parent, refusing symlinks anywhere in the output path.
    for item in (destination, *destination.parents):
        if item.is_symlink():
            raise ValueError('Refusing a destination with linked parents')
    payload, removed_scripts = collect(source)
    old_files = []
    if destination.exists():
        if not refresh or not destination.is_dir():
            raise ValueError('Destination exists; use --refresh only for an earlier generated export')
        marker = checked_path(destination, MARKER)
        if not marker.is_file():
            raise ValueError('Refusing to refresh a directory without an export marker')
        previous = json.loads(marker.read_text())
        if previous.get('generator') != 'manualdock-public-export-v1':
            raise ValueError('Unrecognized export marker')
        old_files = previous.get('files', [])
        if not isinstance(old_files, list) or not all(isinstance(x, str) for x in old_files):
            raise ValueError('Invalid export file list')
        for relative in [*old_files, *payload]:
            checked_path(destination, relative)
        expected = set(old_files) | set(payload) | {MARKER}
        generated_docs = {'browser-test-universal.json', 'test-universal-panel.png',
                          'test-universal-failure.png', 'release-extension.sha256.json'}
        for directory, dirs, files in os.walk(destination, followlinks=False):
            dirs[:] = [name for name in dirs if name not in {'.git', 'node_modules', '__pycache__'}]
            for name in files:
                relative = (Path(directory) / name).relative_to(destination).as_posix()
                generated = (relative.startswith('docs/') and name in generated_docs) or bool(re.fullmatch(r'manualdock-v\d+\.\d+\.\d+\.zip', relative))
                if relative not in expected and not generated and name != '.DS_Store':
                    raise ValueError(f'Unreviewed file in existing public directory: {relative}')
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
    # Fully materialize and validate content before touching an existing export.
    temp = Path(tempfile.mkdtemp(prefix='.manualdock-public-', dir=destination.parent))
    try:
        for relative, data in payload.items():
            target = checked_path(temp, relative)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        marker = {'generator': 'manualdock-public-export-v1', 'files': sorted(payload),
                  'sha256': {key: hashlib.sha256(value).hexdigest() for key, value in sorted(payload.items())}}
        (temp / MARKER).write_text(json.dumps(marker, indent=2) + '\n')
        if not destination.exists():
            temp.rename(destination)
        else:
            # Preserve Git metadata and local dependencies; unknown files were rejected.
            # Only files named by our prior marker can be removed.
            for relative in old_files:
                if relative not in payload:
                    checked_path(destination, relative).unlink(missing_ok=True)
            for relative in [*payload, MARKER]:
                target = checked_path(destination, relative)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(temp / relative, target)
    finally:
        if temp.exists():
            shutil.rmtree(temp)
    return {'directory': str(destination), 'files': len(payload),
            'testFiles': list(PUBLIC_TESTS), 'removedHistoricalPackageScripts': removed_scripts,
            'published': False}


if __name__ == '__main__':
    root = Path(__file__).resolve().parent.parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='Validate public inputs without writing an export')
    parser.add_argument('--destination', type=Path, default=root.parent / 'manualdock')
    parser.add_argument('--refresh', action='store_true', help='Update an earlier generated source export')
    args = parser.parse_args()
    try:
        if args.check:
            payload, _ = collect(root)
            print(json.dumps({'checkedFiles': len(payload), 'written': False}))
        else:
            print(json.dumps(export(root, args.destination, args.refresh), indent=2))
    except (ValueError, OSError, UnicodeError) as error:
        sys.exit(str(error))
