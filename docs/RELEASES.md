# Release process

Sakura releases combine application source, website hosting, and separately operated services. A merged source change is not evidence that the live application contains it.

## Source boundaries

The public default application branch is currently a historical Next.js/Capacitor snapshot. Its root build scripts do not reproduce the current Expo site. Public source reconciliation must establish accurate build instructions and checks before this default branch is treated as the live application baseline.

Public contribution branches must exclude private Studio source and private release integrations. Current web releases are assembled from the verified live baseline and reviewed authoring snapshots in a local release workspace. That integration history is not pushed to public remotes.

## Web release sequence

1. Identify the requested source changes, the current verified release, and any service or configuration dependencies. Preserve unrelated working copies and record the selected revisions.
2. Assemble the authorized Studio web release locally, retaining the private component and the required hosting integrations.
3. Build the current Expo application through the root or `web/` commands on that source line. The application export is `web/dist`.
4. Package the complete export in the hosting repository and run the normal build guards and relevant tests. Do not bypass a guard to hide a missing live feature.
5. Deploy a preview with appropriately separated service identity, credentials, and storage. Verify real application routes at `/app/`, including the affected user journey and preserved integrations.
6. Promote the verified release, run production smoke checks, and record the deployed build identifier and any remaining limitations.

The integration must preserve Studio, the ATSU relay and its catalog/cover/page/reader/share integrations, community API routes, and required packaging guards. Preserve previously shipped hashed assets needed by existing sessions and offline clients.

## Community service changes

The invite-only paper beta uses a persistent service behind hosting routes. An Expo export alone does not deploy that service.

Keep production and preview identities, credentials, and storage separate. Test invitation handling, authorization, exactly-once recovery after interruption, durable history, and revocation when changes affect those behaviors. Keep relay credentials and service identity secrets on the server.

Back up before a storage-affecting operation, validate the backup, and rehearse restoration separately. Never initialize over, reset, or roll back the live database merely to make a deployment work. Any application rollback must account for storage compatibility and accepted history.

The existing beta has verified on-host backups and an encrypted off-host snapshot. Ongoing off-host replication remains a [tracked milestone](ROADMAP.md#3-strengthen-beta-operations-and-security-reporting).

## Public release evidence

A public release summary should contain:

- User-visible changes and known limitations.
- Public source revisions or an explicit explanation of which components remain private.
- Application build and deployment identifiers sufficient to identify the verified release.
- Relevant checks and end-to-end verification results, with skipped or unverified areas stated.
- Compatibility or recovery considerations for stored data and existing clients.

Keep credentials, private source, service addresses, invitations, user records, raw logs, and private operational documents out of public release evidence. Source tests, preview validation, production smoke checks, and independent audits are different forms of evidence; label each accurately.

## Native releases

Native builds have separate source, signing, versioning, and device checks. Preserve existing application identifiers and the signing identity required for an in-place upgrade. An unsigned verification artifact is not an installable update. A successful website release does not establish that a native release is ready.
