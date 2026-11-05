# Security policy

## Current reporting status

GitHub private vulnerability reporting is currently disabled for this repository, and a verified private intake and designated responder have not been established in this policy. Do not send sensitive reports to an assumed project email address or publish exploit details in an issue or pull request.

Until a verified private route is published here, retain vulnerability details privately. You may open an issue asking only for a security contact, without impact details, credentials, code, or reproduction steps. There is no response-time commitment or bug bounty announced by this policy.

For Perps and Rooms implementation research, also read the [sakura-perps security policy](https://github.com/Sakura-11488/sakura-perps/blob/main/SECURITY.md). Follow its current intake status and scope; a link to that policy does not establish that its private reporting channel is available.

## Identify the affected component

This repository's public default branch contains historical application source and does not reproduce the live Expo application. A useful report identifies the exact public source revision, local build, or observed live screen. Distinguish application, hosting, and Perps service behavior using the [repository map](docs/REPOSITORIES.md).

When a verified private intake is available, a report should include the affected version, a minimal local reproduction using synthetic data, expected and observed behavior, and the security impact. Redact personal records and all credentials.

## Testing boundaries

Prefer isolated local tests with synthetic identities and simulated assets. Do not access another person's data, reuse their invitations, transact with real funds, or disrupt shared services. This policy does not authorize attacks on production or third-party infrastructure.

The Rooms beta is paper-only and uses fixed simulated scenarios. Its availability does not establish readiness of a real-money system or an independent audit. Any future security challenge must publish a specific target, permitted scope, and verified private reporting route before participants are invited.

## Repository hygiene

Do not commit wallet secrets, service credentials, signing keys, browser identity material, invitation codes, database copies, or private source. Public client configuration must contain only values intended for the client. Keep production and preview service credentials separate.

Security-related changes should include focused validation and a clear account of residual limitations. A green build, a source review, and an independent audit must never be presented as interchangeable.
