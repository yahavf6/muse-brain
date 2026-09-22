# Security

Muse Brain v1 is a local-only tool. The server binds to `127.0.0.1` only; it is never meant to be reachable from another machine or the internet.

Every request is checked against the Host and Origin headers, which is the mitigation for DNS rebinding: a malicious page in a browser cannot use your browser as a proxy to reach the server, because the Host header it sends will not match.

There is no authentication in v1. This is a loopback trust model: any local process that can reach `127.0.0.1:4747` and send the right Host header can call `POST /api/call` with admin scope (the same power the graph page UI has, including edit and delete), and `POST /api/install`, which edits agent config files on disk (always with backups first). Treat anything running on your machine as able to reach the brain.

Bearer tokens and per-agent scopes are a v2 item, needed once cloud agents get access over a public hostname. They do not exist yet.

Please report vulnerabilities through GitHub's private vulnerability reporting on this repository, not as a public issue.
