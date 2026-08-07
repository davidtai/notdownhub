# Security policy

## Supported versions

notdownhub is at v0.x. Only the latest 0.x release gets security fixes. Older
0.x releases do not get backported fixes.

| Version | Supported |
|---|---|
| Latest 0.x | Yes |
| Older 0.x | No |

## Report a vulnerability

Report a vulnerability in private. Do not open a public issue for a security
problem.

Use one of these two private channels:

- Open a private GitHub security advisory on `davidtai/notdownhub`.
- Email david.tai@reg.finance.

We acknowledge a report within 7 days. We then send a fix timeline, or a request
for more detail.

## Scope

The hub API is a LAN or tailnet tool by design in v0.1. The hub API, runner
protocol, and mirror are unauthenticated on the public port. Only runner
registration is token-gated.

An open hub on the public internet is out of scope as a vulnerability. This is a
documented v0.1 limit, not a defect. See the
[security model](docs/architecture.md#security-model-v01) for the full trust
boundary.

Secrets stay on the machine that runs dispatch. The hub does not read secrets
from GitHub. A one-shot run shreds its ephemeral secret file at the end of the
run.
