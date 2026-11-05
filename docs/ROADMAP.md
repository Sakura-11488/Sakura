# Sakura roadmap

The next phase is a trustworthy public engineering workflow and a useful community paper beta. These are completion criteria, not release dates. Research or a passing test does not establish readiness for real funds.

Track the work in the [next-phase GitHub milestone](https://github.com/Sakura-11488/Sakura/milestone/1): [public source reconciliation](https://github.com/Sakura-11488/Sakura/issues/12) and [owner security/settings setup](https://github.com/Sakura-11488/Sakura/issues/13). The [Rooms cohort milestone](https://github.com/Sakura-11488/sakura-perps/milestone/1) tracks beta operations and feedback.

## Current baseline

- The live Sakura website uses the Expo application and includes reading, watching, and community experiences.
- Sakura Rooms has an invite-only paper beta with separate identities, durable shared history, and Plan, My allocation, and Review screens.
- Rooms scenarios are fixed simulations. The beta accepts no deposits and performs no real-money trades.
- Public application default source remains a historical snapshot. A fresh checkout does not reproduce the live website.

## 1. Reconcile public source and release evidence

**Outcome:** contributors can identify and verify the public source they are reviewing.

Completion evidence:

- Review and publish the current application source intended for public access, preserving attribution and excluding private components and operational material.
- Establish one documented public development base and identify historical branches without deleting unreviewed work.
- Make installation, checks, and an export reproducible from a clean public checkout with documented configuration.
- Verify the exported application at `/app/` and document any features requiring separately deployed services.
- Record source revisions, build identifiers, validation results, and known limitations for each release in a shareable summary.

This work should not replace the live website or publish private release history merely to make a default branch look current.

## 2. Learn from complete Rooms sessions

**Outcome:** understand whether communities find the independent-allocation workflow useful and return to it.

Completion evidence:

- Invite a small cohort through the existing admission flow and observe complete Plan → My allocation → Review sessions.
- Record where hosts and members get stuck, whether they understand paper-only outcomes, and why they would return.
- Track completion, repeat participation, and recovery failures using consented, minimal information; keep invitations and identity material out of analytics.
- Turn the findings into prioritized issues with acceptance criteria, then validate improvements with the cohort.

Product learning can proceed alongside public source reconciliation. Participation counts and testimonials should come from actual sessions.

## 3. Strengthen beta operations and security reporting

**Outcome:** the service can be operated, recovered, and investigated with clear ownership.

Completion evidence:

- Confirm a private vulnerability intake and a human responder before announcing a security challenge or response-time commitment.
- Exercise backup restoration in an isolated environment and document how accepted history is checked after recovery.
- Configure and verify ongoing encrypted off-host backups. The existing off-host snapshot does not constitute continuous replication.
- Review invitation abuse, identity isolation, replay protection, interruption recovery, request limits, and dependency changes against documented threats.
- Define observable service-health failures, incident ownership, and a recovery procedure that never resets the live database to fix a deployment.

## 4. Introduce realistic paper scenarios

**Outcome:** users can practice decisions with explicit, reproducible market-data assumptions.

Completion evidence:

- Specify price-source provenance, stale-data behavior, fill assumptions, fees, funding, and risk limits before presenting simulated results.
- Clearly distinguish fixed scenarios, historical replays, and any live-data simulation in the interface and exports.
- Keep member decisions independent and preserve the exact assumptions needed to review an outcome later.
- Test outages, delayed or contradictory data, and interrupted actions without allowing uncertainty to look like a confirmed result.
- Validate the experience with the existing cohort before expanding access.

## 5. Evaluate a future real-money system

**Outcome:** an evidence-based decision about whether a bounded real-money system is justified.

This remains a separate research and security milestone. It requires an explicit custody and execution design, risk-engine invariants, adversarial testing, oracle and liquidation analysis, operational readiness, and independent security review. Financial and regulatory requirements also need appropriate review before a launch decision.

The paper beta is not approval for deposits or trading with real economic value. No audit, bounty, mainnet launch, token reward, or return is promised by this roadmap.
