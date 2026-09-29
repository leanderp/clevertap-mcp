# clevertap-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io) server for the [CleverTap](https://clevertap.com) REST API. Exposes CleverTap's user profiles, events, campaigns, and reports as tools that any MCP-compatible AI assistant (Claude, Cursor, etc.) can call directly.

---

## Features

- **Multi-project** — manage multiple CleverTap accounts from a single server instance
- **Guided setup** — if no project is configured, `clevertap_configure` walks you through the process
- **Full API coverage** — events, profiles, campaigns, and reports
- **Async polling** — long-running operations (event/profile counts) are polled automatically

---

## Tools

### Meta
| Tool | Description |
|------|-------------|
| `clevertap_configure` | Guided setup to add a project or generate the `CLEVERTAP_PROJECTS` config. Only registered when no project is configured, or when `CLEVERTAP_ENABLE_CONFIGURE=1` (it takes a passcode as an argument) |
| `clevertap_list_projects` | List all configured projects and their regions |

### Events
| Tool | Description |
|------|-------------|
| `clevertap_upload_events` | Upload one or more events for a user |
| `clevertap_get_events` | Query event data with filters |
| `clevertap_get_events_cursor` | Fetch the next page of event results via cursor |
| `clevertap_get_event_count` | Get the total count of an event (with async polling) |

### Profiles
| Tool | Description |
|------|-------------|
| `clevertap_upload_profile` | Create or update a user profile |
| `clevertap_get_profile` | Look up a single user by identity, email, or objectId |
| `clevertap_get_profiles_by_event` | Get profiles of users who performed an event |
| `clevertap_get_profiles_cursor` | Fetch the next page of profile results via cursor |
| `clevertap_delete_profile` | Delete a user profile |
| `clevertap_upload_device_token` | Register a push token for a user |
| `clevertap_get_profile_count` | Count profiles matching a segment |
| `clevertap_demerge_profile` | Split merged profiles apart |
| `clevertap_subscribe` | Subscribe/unsubscribe a user to channels |
| `clevertap_disassociate_phone` | Remove a phone number from a profile |

### Campaigns
| Tool | Description |
|------|-------------|
| `clevertap_get_campaigns` | List the campaigns **created through the API** within a date range (dashboard campaigns are not listed: use `clevertap_get_message_report`) |
| `clevertap_get_campaign_report` | Get delivery and engagement stats for a campaign |
| `clevertap_stop_campaign` | Stop a running campaign |
| `clevertap_create_campaign` | Create and launch a campaign |

### Reports
| Tool | Description |
|------|-------------|
| `clevertap_get_message_report` | Message-level delivery report (long ranges are fetched in 14-day slices; `limit`/`offset` page the output) |
| `clevertap_get_top_property_count` | Top property value counts for an event |
| `clevertap_get_event_trend` | Daily/weekly/monthly trend for an event |
| `clevertap_get_dau` | Daily active users trend |
| `clevertap_get_uninstall_report` | Uninstall trend report |
| `clevertap_get_real_time_counts` | Real-time active user counts |

### Generic
| Tool | Description |
|------|-------------|
| `clevertap_request` | Make any raw REST API request |
| `clevertap_poll` | Poll a pending async request by `req_id` |

---

## Pagination, timeouts and recovery

Read tools tell the caller what to do next instead of leaving it to guess.

- **Cursor exports** (`clevertap_get_events`, `clevertap_get_profiles_by_event`) return the first page of records plus `next_cursor` and a `next_actions` entry naming the tool to call for the next page. `done: true` marks the last page. `next_cursor` is a short **handle** (`cur_…`): pass it exactly as returned. CleverTap's own cursors are 1.5–2.4 KB and a model that re-types one corrupts it, so the handle is resolved inside the server (raw cursors are still accepted). Handles live in the memory of the MCP process for up to 4 hours and are lost if it restarts or another instance answers; the error then says to restart the export. Pages hold 23 records by default (CleverTap pages in multiples of 23 and treats a smaller `batch_size` as *unlimited*: 5 returned 989 records), without each profile's lifetime event summary (about 75% of a record) unless `include_event_summary: true`.
- **Asynchronous queries** (counts, trends, top properties) are polled automatically. If CleverTap is still computing when the time budget ends, the result is `status: "partial"` with a `next_actions` entry that continues with `clevertap_poll`.
- **`clevertap_get_message_report`** is synchronous and slow for long ranges (about 26 s for 30 days, 109 s for 90). Ranges are fetched in 14-day slices; if they do not all fit in one call the response has `complete: false`, a `remaining_range` and a `next_actions` entry to fetch the rest.
- **Errors** start with `Error:` and add `How to recover:` hints (wrong event name, wrong region, expired cursor, too many concurrent requests…) and, where it helps, `Suggested next calls:`. CleverTap answers many failures as HTTP 200 with `"status":"fail"`; those are reported as errors too.
- **Dates** are validated before calling the API in the tools that take a range (real `YYYYMMDD` dates, `from <= to`, not in the future for exports, at most one year for trends). `clevertap_get_campaigns` is not validated.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLEVERTAP_TIMEOUT_MS` | `40000` | Longest a single HTTP request may take |
| `CLEVERTAP_BUDGET_MS` | `50000` | Time budget for polling, cursor retries and message-report slicing within one tool call. Keep it below any timeout imposed by the host. Tools that make a single request (including `clevertap_request`) are bounded by `CLEVERTAP_TIMEOUT_MS` only |
| `CLEVERTAP_ENABLE_CONFIGURE` | unset | Set to `1` to expose `clevertap_configure` when projects are already configured |

`region` is required in practice: it defaults to `in1` with a warning on stderr, and credentials from another region are rejected as `Invalid Credentials`.

Read-only tools are announced with the MCP `readOnlyHint` annotation. Only GET requests and the read queries above are retried on HTTP 429; a POST that may write is never repeated automatically.

### Behaviour changes for existing clients

- `clevertap_get_events` and `clevertap_get_profiles_by_event` now return the **first page of records** (plus `next_cursor`, `done`, `next_actions`) instead of only a `cursor`. Pass `fetch_first_page: false` for the old shape. Pages are 23 records by default (minimum 23, maximum 50), records omit the profile's event summary unless `include_event_summary: true`, and `next_cursor` is a short handle.
- The `project` parameter of every tool is a free string, not an enum of names: a name that is not the account's is replaced by the only configured project (with a `project_note`), or is an error listing the valid names when there are several. Responses are compact JSON (no indentation).
- `clevertap_get_events` no longer accepts `groups`: CleverTap ignores it (verified against the API), so it never did anything.
- `clevertap_get_message_report` returns at most `limit` messages (default 100) and slices long ranges; use `limit`/`offset` or the `next_actions` entries for the rest.
- Range tools reject invalid dates, `from > to`, trends over one year or with more than 5 groups, and `top_n` outside 1–100 before calling the API.
- `clevertap_get_uninstall_report` queries `App Uninstalled` (the old `Uninstalled` was rejected by the API).
- Failures CleverTap reports as HTTP 200 with `"status":"fail"` are now tool errors (`isError`), for read and write tools alike.
- `clevertap_configure` is not registered when projects are already configured unless `CLEVERTAP_ENABLE_CONFIGURE=1`.

---

## Installation

```bash
git clone https://github.com/your-org/clevertap-mcp.git
cd clevertap-mcp
npm install
npm run build
```

---

## Configuration

The server reads project credentials from the `CLEVERTAP_PROJECTS` environment variable — a JSON array of project objects:

```json
[
  {
    "name": "My App - Production",
    "account_id": "XXX-XXX-XXXX",
    "passcode": "YYY-YYY-YYYY",
    "region": "us1"
  },
  {
    "name": "My App - Staging",
    "account_id": "AAA-AAA-AAAA",
    "passcode": "BBB-BBB-BBBB",
    "region": "us1"
  }
]
```

**Supported regions:** `in1`, `us1`, `eu1`, `sg1`, `aps3`, `mec1`

### Single-project fallback

You can also use individual environment variables for a single project:

```bash
CLEVERTAP_ACCOUNT_ID=XXX-XXX-XXXX
CLEVERTAP_PASSCODE=YYY-YYY-YYYY
CLEVERTAP_REGION=us1
```

---

## Adding to Claude Desktop

In your `claude_desktop_config.json` (or `~/.claude.json`):

```json
{
  "mcpServers": {
    "clevertap": {
      "command": "node",
      "args": ["/absolute/path/to/clevertap-mcp/dist/index.js"],
      "env": {
        "CLEVERTAP_PROJECTS": "[{\"name\":\"My App\",\"account_id\":\"XXX-XXX-XXXX\",\"passcode\":\"YYY-YYY-YYYY\",\"region\":\"us1\"}]"
      }
    }
  }
}
```

> **Important:** `CLEVERTAP_PROJECTS` must be a serialized JSON **string** (not a native JSON object) inside the `env` block.

---

## Development

```bash
npm run build      # compile TypeScript → dist/
npm run dev        # watch mode
npm start          # run compiled server
npm test           # build, then run the tests in test/ (node:test, no network)
```

### Project structure

```
src/
  index.ts          # MCP server entry point, project config, tool registration
  client.ts         # CleverTap REST API HTTP client (timeouts, polling, cursors)
  errors.ts         # CleverTapToolError, recovery hints, error formatting
  dates.ts          # YYYYMMDD validation and range slicing
  tools/
    paging.ts       # Cursor page helper (next_cursor / next_actions)
    events.ts       # Event upload and query tools
    profiles.ts     # Profile management tools
    campaigns.ts    # Campaign tools
    reports.ts      # Analytics and report tools
    generic.ts      # Raw request / poll tools
    web.ts          # (future) Browser session tools via Playwright
```

---

## License

MIT
