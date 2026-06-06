![pi-codex-account terminal preview](assets/preview.png)

# pi-codex-account

Pi extension for saving, switching, and checking usage for multiple OpenAI Codex
OAuth accounts.

Pi stores one `openai-codex` login in `~/.pi/agent/auth.json`. This extension
stores named snapshots in `~/.pi/agent/codex-accounts.json` and swaps the active
login when you need it.

## Install

Install from npm:

```bash
pi install npm:pi-codex-account
```

Try it without installing:

```bash
pi -e npm:pi-codex-account
```

Use a local checkout:

```bash
pi -e /path/to/pi-codex-account
```

After installing or changing the package, reload Pi:

```text
/reload
```

## Commands

Use `/codex` without arguments to open the account picker.

| Command | What it does |
| --- | --- |
| `/codex save <label>` | Save the current Codex login. |
| `/codex switch <label>` | Switch to a saved login and reload Pi. |
| `/codex list` | List saved logins. |
| `/codex current` | Show the active login. |
| `/codex usage` | Show usage for the active login. |
| `/codex rename <old> <new>` | Rename a saved login. |
| `/codex remove <label>` | Delete a saved login. |

`/codex-account` also works as an alias for older installs.

## Example

Use this flow to save two accounts:

```text
/login openai-codex
/codex save work

/login openai-codex
/codex save personal

/codex switch work
```

If `/codex usage` says the token is expired, send one Codex model request first.
Pi refreshes the selected account, then `/codex usage` can read the latest usage.

## Security

The account store is written to:

```text
~/.pi/agent/codex-accounts.json
```

The file uses `0600` permissions, but it still contains OAuth tokens. Don't
commit it, share it, or copy it to untrusted machines.

## Development

Run the checks with Bun:

```bash
bun install
bun run typecheck
bun test
```

The Pi package manifest lives in `package.json`:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```
