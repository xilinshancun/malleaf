# Malleaf RFCs

Use an RFC for changes that introduce product behavior, cross module boundaries, alter persistence or update handling, or require architectural tradeoffs. Small corrections with an established solution can link to the RFC they implement.

An RFC is the durable agreement between the person requesting a change, its implementer, and its reviewers. Keep it aligned with the implementation so another agent can resume from the repository.

## Required content

Each numbered document records:

- The problem, observable goals, scope, and constraints.
- The proposed design, component boundaries, and externally visible contracts.
- Alternatives considered and the reason for the selected approach.
- Failure, recovery, and compatibility behavior where relevant.
- Focused tasks with an owner, dependencies, acceptance criteria, and current status.
- Verification results and links to the reviewed commits or pull requests.
- Decisions that changed during implementation, including who made them and why.

Keep a proposal to at most six independently verifiable tasks. Split larger work into related RFCs and record their dependencies. Diagrams describe dependencies; they do not replace acceptance criteria.

## Lifecycle

Use `draft`, `accepted`, `implementing`, `verified`, `superseded`, or `rejected` for a proposal. Use `pending`, `in-progress`, `implemented`, or `blocked` for a task. An implemented task has its required evidence; a verified proposal has also completed independent review.

Before implementation, an architecture reviewer checks the design against the requirements and the source. The implementer records the decision to proceed. Before delivery, a separate code reviewer checks the resulting behavior, failure paths, and verification evidence. Address findings before marking the proposal verified.

The user may delegate decisions within an explicit scope. Record that delegation and any resulting choices. Never label an agent's decision as human approval. Questions outside the delegation stay visible as unresolved items; continue independent work that remains authorized.

## Working with agents

Every participating agent reads the relevant RFC and repository development rules. Claim a task before changing its files. A task starts when its dependencies are satisfied; independent reviewers may inspect concurrently. Keep design review separate from code review, and preserve the reasoning from both.

Tests must demonstrate the promised behavior, including recovery when the feature changes running software. Follow the repository's targeted local test policy and use CI for broad suites. A passing build alone does not prove a working product or a successful upgrade.

If implementation changes a contract or invalidates an assumption, amend the RFC and obtain the appropriate review before continuing the dependent work. Preserve completed evidence and explain what the new design requires rechecking.

## Index

| RFC                               | Subject                                       | Status                                              |
| --------------------------------- | --------------------------------------------- | --------------------------------------------------- |
| [0001](0001-product-isolation.md) | Product identity and local isolation          | Verified against `3b7455eda`; all 21 CI jobs passed |
| [0002](0002-personal-runtime.md)  | Personal runtime slots and paired data epochs | Accepted; depends on RFC-0001                       |

The [product brief](../malleaf.md) records the requested behavior; [upstream provenance](../../UPSTREAM.md) records the imported baseline.

## Public precedents

RFC design records are used in [Rust](https://github.com/rust-lang/rfcs), [Work2Skill](https://github.com/china-qijizhifeng/Work2Skill/blob/main/WorkRecorder/WorkRecorder_RFC.md), and [Harbor-nexau](https://github.com/china-qijizhifeng/Harbor-nexau/blob/main/docs/rfcs/0001-basestream-gpu-environment.md). [OpenSpec](https://github.com/Fission-AI/OpenSpec/blob/main/docs/concepts.md) and [GitHub Spec Kit](https://github.github.com/spec-kit/reference/agentic-sdd.html) provide related workflows for specification-driven agent development. This document defines Malleaf's own workflow.
