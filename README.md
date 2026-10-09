# ManualDock

Bring online device manuals and API documentation into local, searchable files.

ManualDock is a local Chrome extension with a companion AI-agent Skill. Open a manual in a browser where you are already signed in, identify its table of contents and article area, then collect chapters into Markdown, offline HTML, JSON, and a collection report. No server, cloud account, or AI API is required.

[中文说明](README.zh-CN.md) · [Feature status](docs/function-status.md) · [Validation](docs/validation.md)

## Install

1. Download and extract the release ZIP, or clone this repository. The current version is **0.2.2**.
2. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select the `extension` directory. The extension is named **ManualDock**.
3. Keep that directory in a stable location. To update an existing installation, replace its files and use Chrome's **Reload** button. Loading a different directory creates a separate extension identity and separate local progress.

The extension interface is currently in Chinese. The companion [Skill](skill/import-security-manuals/SKILL.md) is optional; installing it does not install or connect the Chrome extension.

## Collect a manual

1. Sign in on the device yourself, open its manual, and click the extension's toolbar icon.
2. Check the detected chapters and article preview. If needed, point-select the contents area, article area, and two different example chapters; validate and save the rule.
3. Enter the product and version, then click **开始 / 继续采集** (Start / Continue). Keep both the manual and control tabs open.
4. Inspect failed and review items before exporting. A finished queue means all discovered chapters were processed; it does **not** prove the whole manual was discovered.

Each completed chapter is saved locally. Retryable connection, login, and loading interruptions schedule another attempt **three minutes later**. Recovery retains saved chapters and revalidates two sample chapters before continuing. The **暂停** (Pause) button cancels automatic continuation. If a session expires, sign in in the original source tab and return to its manual; ManualDock does not sign in for you. Reopening a control page can restore the saved retry schedule, but a closed control page does not execute retries. A closed source tab or revoked page access requires opening the manual and clicking the extension again.

## Optional navigation rotation

Open the device's management interface in a **separate tab**, click the extension, and use navigation detection. ManualDock derives candidate menus from the current page's navigation structure and visible labels; it does not assume particular menu names. Inspect the proposed sequence, remove unsuitable entries, and run the trial before starting. If the page has no reliably identifiable navigation, point-select the menus yourself.

Rotation is off by default and normally clicks one menu every 60 seconds. It stops when the document reloads, a target disappears, or matching becomes ambiguous. Clicking a menu does not prove the device renewed its session. ManualDock does not create or delete device objects, submit configuration, or execute API examples. Some products end sessions regardless of navigation activity.

## Import API specifications

Import local Swagger 2.0 or OpenAPI 3.0/3.1 JSON/YAML, or specify a same-origin specification URL. Interfaces are organized by method and path. Internal references are resolved, circular references remain links, and missing external references are reported without fetching them. YAML parsing is bundled locally and limits alias expansion. Importing documentation never invokes its described endpoints.

## Scope and limitations

- Ordinary links, query parameters, hash routes, same-URL chapter navigation, and recognizable lazy trees can use automatic detection or reusable calibration.
- Stable chapter identifiers avoid duplicate queue entries. Repeated article bodies, unloaded branches, ambiguous nodes, and scan limits are reported for review. There is no independent authoritative directory against which to guarantee completeness.
- The extension uses user-granted tab access. It does not read passwords, cookies, or tokens. Cross-origin frames, closed components, virtualized directories, and changed page structures may require adaptation.
- Progress stays in the extension's local database. Export backups before clearing browser data or uninstalling. A task is limited to 5,000 chapters.
- Automated tests use synthetic pages and isolated browser profiles. Compatibility and session renewal have not been established across other real devices.

## Development

Clone the GitHub source to develop or run tests; the install ZIP contains runtime files and usage instructions. Node.js 22 and Python 3 are used for tests and packaging; neither is needed to run the extension.

```sh
npm ci
npx playwright install chromium
npm test
npm run test:browser
npm run test:openapi:browser
python3 scripts/package_release.py
```

See [development notes](docs/development.md) for architecture and test boundaries. Code is licensed under [MIT](LICENSE); the bundled YAML parser retains its [ISC license](extension/vendor/yaml.LICENSE.txt).

An optional [GitHub Actions template](https://github.com/Jerrywjr/manualdock/blob/main/ci/check.yml) is included. Copy it to `.github/workflows/check.yml` to enable automated runs; this requires workflow-write permission. The template is not active by default.
