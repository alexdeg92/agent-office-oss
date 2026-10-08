# Security

Agent Office is a single-owner dashboard on a machine the owner controls. This page is the threat model for that deployment, how to report a problem, and which versions are supported.

## Threat model

**One owner.** There is one login: an email and a password. There is no account list and no shared session between people.

**Session cookie.** A successful login sets `taco_sess`. The value is HMAC-signed with `PORTAL_SECRET`. The cookie is `HttpOnly`, `SameSite=Lax`, `Path=/`, and has no `Domain`. It is `Secure` when the instance is production, or when `PORTAL_COOKIE_SECURE=1`. The lifetime is 12 hours. Logout revokes the session on the server.

**Password storage.** The password is an scrypt hash in `PORTAL_PASSWORD_HASH`. `agent-office hash-password` reads it from the terminal (no echo, asked twice) or from stdin, and prints only the hash. It does not take the password as an argument or from the environment. Verification compares the derived key in constant time. This release still boots with a plaintext `PORTAL_PASSWORD` and prints a warning. Remove that variable once the hash is set.

**Login throttling.** Failed logins are limited per client address and across all clients. After 5 failures from one address inside 15 minutes, further attempts from that address wait, doubling each time, up to 15 minutes. More than 20 failures in one minute, from any addresses, slows every login the same way. Two password checks may run at once for one address, and 16 overall; extra attempts wait 1 second. The response is HTTP 429 with `Retry-After`. A correct password during the wait is still refused. The client address is the socket address. `X-Forwarded-For` is used only when the connecting proxy is listed in `AO_TRUST_PROXY` (default: loopback only). A one-port install sets that header from the real socket and forces the API child to trust only the loopback hop.

**CSRF.** A non-GET request that carries the session cookie, and no bearer token, must be `application/json` when it has a body (anything else is 415). Its `Origin`, or the origin of `Referer` when `Origin` is absent, must be one of: the server's own origin, `AO_PUBLIC_URL`, or a loopback `X-Forwarded-Host` sent by the loopback hop (a one-port install opened as `localhost`, `127.0.0.1`, or `::1` on the listen port). A foreign `Origin` is refused with 403, including when `X-AO-Request: 1` is set. A request with no `Origin` and no `Referer` needs `X-AO-Request: 1`. A bearer token skips this origin rule and the cookie is dropped, so the two credentials are not combined.

**Read-only staging.** `PORTAL_READONLY=1` refuses runtime and OpenClaw writes (CLI writes, gateway restart, agent turns). It is a staging instance and cannot be `AO_ENV=production`. Login and logout still work. Store writes (projects, layout, preferences, mute) stay allowed until `PORTAL_READONLY_STORE=1`. Both switches are required to refuse every application write. The staging process must use its own data directory, not production's.

**Agent tokens.** The configured primary agent can hold a scoped bearer token. The token may call a short allowlist of project writes. It may not read the API, open the event stream, or send an `actor` field. Each token is limited to 30 requests a minute. An unknown or revoked token is 401 and the response does not say which. A request outside the allowlist is 403.

**Screenshot capture stays off.** `AO_CAPTURE` defaults to off. The capturer would run headless Chrome through an egress proxy that refuses special-purpose addresses. A check with a real browser showed that a page can still request a loopback URL directly, so a captured public page could reach a service on the same machine. Leave `AO_CAPTURE` unset. Project images then use the code host's OpenGraph card, or a monogram.

## Reporting a vulnerability

The maintainer has not published a contact yet. Replace the line below before treating this file as the public reporting policy.

**Contact:** `TODO: vulnerability contact`

## Supported versions

| Version | Supported |
| --- | --- |
| 1.0.0 | Yes. First packaged release. |
| Anything older | No supported release line. |
