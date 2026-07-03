# Threat Surface to ATF Mapping

> Maps the five agentic-AI attack vectors (Lush Binary, 2026) to ATF layers, grounded in the live Zomma threat model (`docs/zomma-threat-model.md`) as a sample system's current state.

Each vector lists the ATF layer that governs it, the live Zomma threat that demonstrates it, and the honest residual gap.

## 1. Credential Exposure

Agents meet secrets (API keys, tokens, passwords) during work and may log them, embed them in code, or pass them insecurely. They do not recognise a string as a secret.

- **ATF layer:** AZP (scope bounds which data classes the agent may touch) + ANL (task-bound credential dies with the task, capping blast radius).
- **Also a guardrail-adequacy question** under Proportionate liability: an Operator that lets an agent log secrets failed its duty.
- **Zomma evidence:** T7 (plaintext passwords transcribed into logs, no redaction, "almost certain"); T2 (single Fernet key for the whole vault).
- **Residual gap:** ATF bounds and attributes credential access; it does not redact secrets from model output. Redaction is an Operator control, not an ATF layer.

## 2. Supply Chain Contamination

Agents install dependencies from training data that may be typosquatted, outdated, or over-permissioned. AI-generated code optimises for function, not security.

- **ATF layer:** AIL (the composite artefact: scaffold build provenance + pinned model + config digest). A changed dependency changes the artefact, so a verified AIL flags it.
- **Zomma evidence:** T14 (unpinned base images, vendored OSWorld, unpinned Tauri git dep, no SAST or dependency audit in CI).
- **Residual gap:** AIL attests *the agent's own artefact*, not arbitrary packages it installs at runtime. Runtime dependency hygiene sits beyond the composite digest.

## 3. Prompt Injection

Malicious instructions hidden in code comments, READMEs, issue templates, or dependency metadata hijack agent behaviour.

- **ATF layer:** ADS protects the *delegation payload* (the hop-0 instruction). Injection through scaffold-assembled context (files, tool outputs, retrieved docs) is the **declared AIL/ADS gap**: AIL "does not claim" integrity of the model's full context window.
- **Zomma evidence:** zomma-agent chat + file upload (`/agent/upload`, `/agent/chat`) take user-controlled content into the LLM context; T9 (`exec()` of LLM-generated code) is the execution sink an injection would target.
- **Residual gap:** This is the vector ATF *bounds* rather than *prevents*. Attenuation limits what an injected instruction can reach; oversight modes gate sensitive actions. The injection itself is an Operator-layer matter.

## 4. Unauthorized Access Escalation

Agents accumulate permissions over time: a session starting with read access ends with write access to production. The April 2026 OS-compromise demo chained low-severity access into full compromise.

- **ATF layer:** ATF's strongest answer. AZP's chains-only-narrow rule forbids authority widening within a chain; escalation requires a fresh root assertion at a higher AAL. ADS attenuation enforces it per hop.
- **Zomma evidence:** T1 (policy spine fails open to `allow`, agent acts unsupervised); T6 (one shared ECS role can `RunInstances` on `*`); T17 (caller self-asserts its own `org_id` on the service-token path).
- **Residual gap:** ATF defines the invariant; it does not enforce it at the infra IAM layer. A fail-open policy engine (T1) or over-broad cloud role (T6) breaks the chain below ATF's reach.

## 5. Multi-Agent Amplification

When agents coordinate, a compromise in one can propagate across the network through legitimate channels.

- **ATF layer:** ADS attenuation caps what a compromised hop passes downstream; per-hop role triples (Operator, Creator, Host) localise which agent deviated for liability.
- **Zomma evidence:** T8 (one shared `ZOMMA_WORKER_TOKEN` authenticates all worker callbacks with no instance-identity check, so one token compromises the worker plane); T17 (shared service token enables cross-service impersonation).
- **Residual gap:** ADS attenuates *downward* authority but does not stop lateral delegations within existing scope, nor aggregate abuse (N sub-agents each within scope exceeding the parent's intent). This is the Sybil/aggregate gap.

## Summary

| Vector | ATF layer | Owned or bounded? |
| ------ | --------- | ----------------- |
| Credential Exposure | AZP + ANL | Bounded (redaction is Operator's) |
| Supply Chain | AIL | Owned for own artefact; bounded at runtime |
| Prompt Injection | ADS + declared gap | Bounded, not prevented |
| Access Escalation | AZP (chains-only-narrow) + ADS | Owned |
| Multi-Agent Amplification | ADS + AIL per-hop roles | Bounded (lateral/aggregate gap) |

Two vectors are owned by ATF's core ideas (Access Escalation, Supply Chain). Three are bounded, not eliminated: ATF limits blast radius via attenuation and localises blame via liability, but the injection, redaction, and aggregate-abuse controls remain Operator responsibilities.

## ATF as runtime governance

Lush Binary's core point: static security controls aren't enough for autonomous agents; you need runtime governance — real-time enforcement of what an agent can do while it's doing it. ATF answers this, but only partly static, mostly runtime:

- **AIL is static** (enrolment-time). Certified once per deploy. Tells you *what the agent is*.
- **ANL, AZP, ADS are the runtime governance layer.** ANL re-attests the instance on a cadence; AZP's PDP evaluates every request; ADS attenuates every hop. This is enforcement *during* execution, not a one-time gate.

The honest scope: ATF provides runtime governance of **authority** (what an agent is permitted to do, enforced per request and per hop). It does **not** provide behavioural anomaly detection ("this agent is acting weird"). A prompt-injected agent acting within its scope passes every ATF check — the declared gap. Behavioural monitoring is a complementary Operator control, not an ATF layer.

## References

Lush Binary. (2026). _AI agent security: An autonomous coding production guide_. https://lushbinary.com/blog/ai-agent-security-autonomous-coding-production-guide/
