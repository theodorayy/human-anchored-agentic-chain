# Human-anchored Agentic Chain (HAC)

> **What**: A formal framework that anchors humans into the loop of agentic runtime and delegation chains.

## free identity

> **What**: An open-sourced OIDC authentication system that is intended to decentralise identity, attest users bound to legitimate government-issued identities (e.g., passports) whilst preserving privacy through nullifiers.

This project was inspired by the Nansen passport, eIDAS (the European Union's digital identity system), and Singpass (Singapore's National Digital Identity system).

https://github.com/theodorayy/free-identity

## agentic trust framework

> **What**: A formal framework for establishing who an agent is, whose authority it carries, what it's permitted to do, and how that permission chain can be verified at every node in a delegation graph.

We believe that behind every agentic action, a human "Principal" should be involved.

The human is anchored through an identity provider (IdP), such as Free Identity, or enterprise IdP systems like Microsoft Active Directory.

## key definitions

### established legal terms

| Term           | Definition                                                                                                                                |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Natural person | A natural person is a living human being.                                                                                                 |
| Legal person   | A legal person is a human or a non-human legal entity that is treated as a person for legal purposes and is capable of bearing liability. |

### agentic systems definitions

![Generic Agentic Systems Architecture](./etc/Generic%20Agentic%20Systems%20Archi.png)

| Define                  | What                                                                                                                                                                                                                                                                                                   | Remarks                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| **Root agent**          | An AI agent that:<br>• maintains durable context<br>• owns a goal<br>• directs the execution of subtasks towards that goal<br><br>**Capabilities:** plan, re-plan, escalate, delegate, decline<br><br>**Contains:** durable context, instructions, model, tools                                        |                                             |
| **Agent control plane** | A non-agentic control plane that:<br>• talks to the governance node<br>• consults policies<br>• retrieves credentials<br>• controls CUA runtime lifecycles<br>• enforces policies<br>• creates audit logs for decisions                                                                                |                                             |
| **Governance node**     | A node that does not produce effects, and does:<br><br>**Deterministic policy decision point (PDP):**<br>• policy store<br>• resolvers / filters<br><br>**LLM-based derivation:**<br>• preferences<br>• persona + memory<br><br>**Stores:**<br>• credentials<br>• jobs & artefacts                     |                                             |
| **Effector**            | An execution unit that may or may not be agentic, and:<br>• has no durable context across invocations<br>• bounded by the delegated goals of a subtask<br>• only does the execution of sub-tasks<br><br>**Contains:** ephemeral context, instruction, tools<br><br>**May contain:** model (if agentic) |                                             |
| **Authority-to-act**    | The binding establishing that a Principal (natural person) is acting within a scope of work delegated by an Accountable Party.                                                                                                                                                                         | Heavily referenced from vicarious liability |

### roles in agentic systems

| Role              | Definition                                                                                                                                                                                                                                                                                                                                   | Answers for                                                                                                                                                                                                               | Example                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Principal         | The natural person who authenticates and issues the instruction.                                                                                                                                                                                                                                                                             | The content and intent of the instruction itself                                                                                                                                                                          | An enterprise user instructing an AI agent                                   |
| Accountable Party | The legal person on whose behalf the Principal acts, bound by the Principal's instructions under a valid mandate.<br><br>Or, the Principal themselves, in personal-use contexts where no separate legal person is represented.                                                                                                               | The content of instructions the Principal issued under valid authority-to-act, distinct from the Operator's guardrail duty (see proportionate liability).                                                                 | The Principal's employer or organisation (or the Principal, in personal use) |
| Operator          | The legal person running the orchestrating scaffold (i.e., agent orchestrator): system prompt, context assembly, tool wiring, and model provisioning and configuration (which models are wired into the scaffold and how they are configured and made available, distinct from a Principal choosing among the options the Operator exposes). | The integration layer: everything wrapped around the model, (by default presumption) deviations within its hop, and the adequacy of its guardrails even on faithfully-executed instructions (see proportionate liability) | Anthropic (Claude app), Zomma                                                |
| Host              | The legal person serving the model weights at inference time, when distinct from the Creator.                                                                                                                                                                                                                                                | Serving the attested artefact: that the weights run are the weights claimed                                                                                                                                               | AWS Bedrock serving Haiku                                                    |
| Creator           | The legal person that trained the model.                                                                                                                                                                                                                                                                                                     | Model behaviour, only when the Operator's layer is provably clean and the artefact is attested                                                                                                                            | Anthropic (e.g., Sonnet, Haiku)                                              |
