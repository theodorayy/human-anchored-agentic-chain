# Agent Trust Framework (ATF)

ATF is a formal framework for identity and access in agentic AI systems, informed by NIST SP 800-63 (identity, authentication, federation) and NIST SP 800-207 (zero trust authorisation), re-derived for contexts where AI agents act as principals alongside, and delegated from, human users.

The framework answers: who a principal (human or agent) is, how it proves that identity, what it is permitted to do, how authority flows down a delegation chain without ever exceeding the permissions of the granting principal, and how trust is recognised across organisational and jurisdictional boundaries.

## The Five Layers

| Acronym | Name                        | Type    | Source  | Agentic Question                                                                                                        |
| ------- | --------------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| AIL     | Agent Identity Level        | Tier    | 800-63A | How was this agent's identity established and by whom?                                                                  |
| ANL     | Agent Authentication Level  | Tier    | 800-63B | What is the agent's session key bound to, and how was that binding established?                                         |
| AZP     | Agent Authorization Profile | Profile | 800-207 | What is this agent permitted to do, over what scope, under what authorisation mode?                                     |
| ADS     | Agent Delegation Scheme     | Model   | Novel   | How is authority transferred down a principal→agent→agent chain without exceeding the granting principal's permissions? |
| AFP     | Agent Federation Profile    | Profile | 800-63C | How is agent trust recognised across organisational and jurisdictional boundaries?                                      |

### AIL — Agent Identity Level

> How verifiably can this agent trace its authority back to a recognised principal?

Agents are ephemeral. They spin up, execute, and terminate. Traditional identity assumes persistent entities; AIL reframes identity as lineage. The question is not "who are you?" but "who spawned you, and how strong is the proof?"

AIL grades confidence across three axes: hop verifiability (is each link in the delegation chain cryptographically signed or merely claimed), chain completeness (is the full chain traceable back to the originating human), and originating principal strength (the human's own identity assurance under NIST 800-63). AIL also encompasses provenance metadata (which model, which build artefact) and operator accountability (which legal person is responsible).

### ANL — Agent Authentication Level (AuthN)

> How does an agent prove it is the same agent across sessions?

The meaningful axis is not authenticator type (agents have no passwords or biometrics) but what the session key is bound to: a config file, a TPM, a hardware security module, or a remote attestation quote from a trusted execution environment. ANL tiers reflect increasing strength of that binding, informed by workload identity standards such as SPIFFE and attested key release mechanisms.

### AZP — Agent Authorization Profile (AuthZ)

What is this agent permitted to do, and under what conditions? Derived from 800-207's dynamic policy model. AZP captures two orthogonal axes:

- **Scope** — which resources, operations, and data classes the agent may act on
- **Authorisation mode** — what authorisation is required before the agent may act:
  1. **Autonomous** — acts freely within scope
  2. **Supervised** — acts but logs for human review
  3. **Gated** — requires explicit approval before acting
  4. **Forbidden** — cannot act regardless of instruction

### ADS — Agent Delegation Scheme

How does authority flow from a human principal to an agent, and from that agent to sub-agents? The critical property is attenuation: a delegatee can never hold more authority than its delegator. ADS specifies the properties attenuation must preserve in an agentic context: how delegation interacts with the authorisation mode (e.g. a Supervised principal cannot delegate to an Autonomous sub-agent), how revocation propagates down the chain, and how delegation depth is bounded. Neither 800-63 nor 800-207 models this.

### AFP — Agent Federation Profile

How is an agent credential issued in one system accepted by another, across organisations, platforms, or jurisdictions? Analogous to FAL in 800-63C and mutual recognition in eIDAS 2.0. AFP addresses trust list governance, assurance level mapping across jurisdictions, and revocation propagation across federation boundaries. Relevant to cross-border agentic deployments, ASEAN DPI interoperability, and government-to-private-sector agent trust.

## Repo Structure

- `docs/` — research and framework documentation (primary artefact)
- `src/` — reference implementation packages (pnpm workspaces, added when needed)
- `README.md` — project overview
