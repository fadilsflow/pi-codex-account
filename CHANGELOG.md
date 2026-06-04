# Changelog

All notable changes to `pi-codex-account` are documented in this file.

## 0.1.0 - 2026-06-05

Initial public release.

### Added

- Added `/codex` for saving, switching, listing, renaming, and removing Codex
  OAuth account snapshots.
- Added `/codex usage` to query active-account usage directly from ChatGPT's
  usage endpoint.
- Added `codex-accounts.json` account snapshot storage with `0600` file
  permissions.
- Added a backward-compatible `/codex-account` alias.
- Added tests for account storage, active-account detection, auth switching,
  usage normalization, report formatting, and argument parsing.
