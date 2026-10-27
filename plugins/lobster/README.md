# magpie-lobster-auth

Signs in to a [LobsterAI](https://lobsterai.youdao.com) (有道龙虾, NetEase
Youdao's desktop agent) account and serves its models as the provider
`lobster` in [magpie](https://usemagpie.ai). About 30 models: DeepSeek, GLM,
Kimi, Qwen, MiniMax and Doubao.

**English** · [中文](README.zh-CN.md)

## Where this comes from

This is a **merged build** of two sources, and it keeps the credit for both:

- **[Jasery/opencode-lobster-auth](https://github.com/Jasery/opencode-lobster-auth)**
  — the original magpie provider plugin (MIT, © 2026 Jasery). The hook
  structure, the SSE handling, the thinking-level translation, the Kimi K3
  contract, the sign-in methods and the README you are reading started here.
  `LICENSE` is theirs, unchanged.
- **The reverse-engineering implementation** in
  `D:/projects/model-reverse/handlers/lobsterai.mjs` — six capabilities
  recovered from the desktop client's own source and confirmed against the
  service: the dynamic client version, the `installation_uuid` attribution
  fields, the double-JSON credential format, the server-side sign-in, the
  `openclaw` model catalogue and the daily check-in.

What the merge added on top of the original plugin:

| Capability | What it does |
| --- | --- |
| Dynamic client version | The version header follows the installed desktop client (read from its `app.asar`), instead of a hard-coded string that goes stale. |
| Refresh attribution | `/api/auth/refresh` now carries `uuid`, `userId` and `version`, as the client itself does. |
| Server-side sign-in | A third method signs in from a credential copy on a server, with no browser and no typing. |
| Automatic renewal | A refreshed token is written back to the server copy, so a long-running deployment keeps working. |
| Model fallback chain | Cloud catalogue → the client's `openclaw` catalogue → a static list. |
| Daily check-in | magpie's `auth.checkin` hook claims the daily credits. |
| Runtime portability | `node:sqlite` instead of `bun:sqlite`, so the plugin loads under Node as well as Bun. |

## Install

A folder plugin — it is not published to npm:

```sh
magpie plugin add /path/to/magpie-lobster
magpie plugin login lobster
```

## Signing in

Three ways, in this order. All name the account by the Youdao account id
(`yid`), so signing in with another way to an account already signed in
replaces it in place.

0. **Browser (a Youdao account).** The plugin serves a callback on
   `127.0.0.1` and magpie opens Youdao's sign-in page. The browser comes back
   with a code, which is traded for tokens at `/api/auth/exchange`. Kept as
   an `oauth` sign-in holding the access and refresh tokens and their expiry,
   so magpie renews it.
1. **The desktop's sign-in.** Uses the account LobsterAI's own desktop app is
   signed in to. **No page is opened and nothing is typed.** The app's SQLite
   database is read, never written:
   - Windows: `%APPDATA%\LobsterAI\lobsterai.sqlite`
   - macOS: `~/Library/Application Support/LobsterAI/lobsterai.sqlite`
   - Linux: `~/.config/LobsterAI/lobsterai.sqlite`

   A database that isn't there, or one the app keeps encrypted, fails this
   way with a message saying so; use the browser way instead.
2. **A server-side copy of the credentials.** For a deployment that has no
   desktop client: point `LOBSTER_SERVER_COPY_DB` at a copy of that
   database. The plugin reads its `refreshToken` and trades it for a fresh
   token pair at `/api/auth/refresh` — still no browser, still no typing.
   The result is a normal `oauth` sign-in, so magpie renews it from then on
   and writes the renewed token back to the copy.

All three are kept in magpie's `plugin-auth.json`.

### Why the desktop import keeps no token

The desktop way stores **no credential at all** — `access` and `refresh` are
empty and `expires` is 0 — and reads the token from the app's database on
every request:

- A copied `refreshToken` would be shared with the app: whichever side
  refreshes first signs the other out. Empty means neither disturbs the
  other.
- `expires` of 0 means magpie never renews it — magpie renews only an
  `oauth` sign-in whose expiry is set — so the app's session is never
  touched.
- Reading it fresh means the plugin follows a token the app renewed, with no
  need to sign in again.

The cost: if the app is signed out, uninstalled, or its database becomes
unreadable, the account stops working at once and magpie is told to ask for
a new sign-in. That is more honest than a token that quietly went stale.

### Writing, and where it is allowed to write

The plugin's write path and its read path are physically separate:

- The **desktop database is never written**. It may be running; a write could
  corrupt the app's session. The read connection is opened `readOnly`.
- A **server copy** is written only when it is a server copy — the desktop
  data directory is refused by path, not merely by convention — and only for
  the `auth_tokens` row. The write uses the client's own double-JSON
  format and adapts to the table shape (the `updated_at` column is filled
  when the table has it, omitted when it doesn't).

### Renewal

A browser sign-in and a server-copy sign-in are renewed by magpie through the
plugin's `auth.refresh`, six hours before they end. The refresh request
carries the attribution fields the client sends — `firstKeyfrom`,
`latestKeyfrom`, `uuid` (the installation id), `userId` and `version`.
The desktop's sign-in is structurally never renewed, as above.

## Requests

Chats are chat completions at
`https://lobsterai-server.youdao.com/api/proxy/v1`. Three of LobsterAI's
habits are handled:

- **Every reply is SSE**, even one asked for with `stream: false`. A
  non-streaming caller gets one `chat.completion` reassembled from it; a
  streaming caller gets the events as they are.
- **Failures ride inside a 200.** LobsterAI puts an error in the stream
  (`event: error`) and still answers 200, which would leave a caller with
  nothing to fail over on. The plugin reads the first record and answers the
  status it means: `40100` → 401, `40300` → 403, `42900` or rate-limit
  wording → 429, anything else → 400. A sign-in LobsterAI turns down is a
  genuine 401, passed through with magpie's lapse mark so the account is
  flagged.
- **Requests carry the desktop client's headers**
  (`X-LobsterAI-Client-Version`, `X-LobsterAI-Client-Capabilities`).
  LobsterAI doesn't insist on them, but they name the feature set the plugin
  speaks. The version is read from the installed client, so it stays right.

### Thinking levels

A model's `thinkingConfig` gives it levels — `off`, `high`, `max` in the
current catalogue — and they reach the wire in LobsterAI's own field:
`{"lobsterai_options":{"version":1,"thinking":{"level":"off"}}}`.

Two things are worth knowing:

- **`lobsterai_options` is only for models that have a thinking profile.**
  21 of the 29 models have none, and sending the field to one of those is a
  hard error (`code 4000`, *model does not have a valid thinkingConfig*), so
  the whole chat fails. A level is passed on only where there is a profile
  to map it through.
- **The lowest level is offered as `none`, not `off`.** magpie doesn't use
  what a variant holds; it maps `reasoning_effort` onto a level name the
  model declared, from a ladder of its own
  (`none/minimal/low/medium/high/xhigh/max`). `off` is not on that ladder,
  so a level declared as `off` can never be chosen. The plugin declares
  `none` and turns it back into `off` for LobsterAI.

Measured on `deepseek-flash`: `none` leaves `reasoning_content` at exactly
0 bytes, while `high`, `max` and no level at all don't.

### Kimi K3

LobsterAI's `kimi-k3` takes its sampling parameters from the server, so
`temperature`, `top_p`, `n` and the penalties are dropped, `reasoning_effort`
is fixed to `max`, and an assistant tool call missing `reasoning_content` is
given an empty one.

`kimi-k3` is one of the models LobsterAI serves but does not list:
`/api/models/available` returns 29 models and none of them is K3, yet a chat
against `kimi-k3` answers normally. It is kept in the list this package
declares for a signed-out account, so `lobster/kimi-k3` is offered — and the
handling above is live, not a precaution.

## Models

Signed in, the list is the account's own (`/api/models/available`): 29
models, each with its context window, whether it takes images, and its
thinking levels. When the cloud list is unavailable, the plugin falls back
to the catalogue the desktop client keeps locally
(`%APPDATA%/LobsterAI/openclaw/state/openclaw.json`), and then to a static
list of eight, so the provider is always visible and never empty.

`costMultiplier` becomes magpie's `rate`. It is **time-of-day pricing**:
`deepseek-flash` is 0.05 in LobsterAI's off-peak hours and 0.1 in the peak
ones (09:00–12:00 and 14:00–18:00, Beijing time). The rate is read when the
list is, so it can be a while out of date.

## Usage

`magpie quota` shows the free allowance, when it ends and the credits left,
from `/api/user/quota` and `/api/user/profile-summary`. The plugin reports
`kept`: it renews nothing itself, so it must not claim a renewal it didn't
do.

## Daily check-in

The plugin implements magpie's `auth.checkin` hook and claims LobsterAI's
daily credits through the `client-activities` flow the desktop client uses.
It reports `claimed` only when the service actually granted credits — a 200
with nothing granted means it was already claimed today, not a success.

## Configuration

Everything that reaches the network can be pointed elsewhere, which is what
makes the plugin testable offline:

| Variable | Meaning | Default |
| --- | --- | --- |
| `LOBSTER_API_BASE` | The API root every request goes to | `https://lobsterai-server.youdao.com/api` |
| `LOBSTER_SERVER_COPY_DB` | The server-side credential copy | unset — no server sign-in without it |
| `LOBSTER_OPENCLAW_PATH` | The client's local model catalogue | `%APPDATA%/LobsterAI/openclaw/state/openclaw.json` |
| `LOBSTER_ASAR_PATH` | The client's `app.asar`, for the version | auto-detected |
| `LOBSTER_CLIENT_VERSION` | Pins the client version | read from the client |
| `LOBSTER_LOGIN_URL` | The sign-in page | the portal's |

The same values can be given in magpie's `plugins.json` under `options`.

## Not here

- **Company accounts.** LobsterAI sends them through a different page
  (`EnterpriseIdentitySelect`). Only personal accounts are handled.
- **An exact output limit.** The catalogue has no such field. The plugin
  declares a conservative 32,000; measured, LobsterAI takes 262,144 and
  answers 500 at 524,288, so the real ceiling is somewhere between.
- **OpenCode.** The plugin is written in OpenCode's provider-plugin format —
  that is the format magpie loads — but it has only been exercised in magpie.
  `auth.refresh`, `auth.refreshLead`, `auth.checkin` and the `magpie`
  field in `package.json` are magpie's own, which OpenCode ignores.
- **Several accounts at once.** magpie keeps one sign-in per provider.

## Development

```sh
bun test                # the reference runtime
node --test --test-force-exit "test/**/*.test.mjs"
```

The entry point only assembles the hooks. The logic lives in `lib/` as plain
functions and is reached through `_internal`, because magpie and OpenCode
both treat every exported function as a plugin of its own.

## License

MIT — see [LICENSE](LICENSE). © 2026 Jasery and the contributors of this
merged build.
