# Malleaf product brief

Malleaf lets people shape the local software they use through conversation. The shared product provides a maintained base; personal versions retain their own behavior and can adopt later releases when their owner chooses.

## Scope

A customization may change any Malleaf layer: interface, backend, persistence, agent orchestration, provider adapters, or desktop application. Claude Code, Codex, and other external harnesses remain dependencies rather than source forks.

The intended flow is request, isolated source change, build and automated acceptance, personal preview, then keep or return to the previous working version. Backend and native changes may require a managed restart. The product must not promise that arbitrary source changes can replace running code without restarting.

Each customization needs its intent, base version, source changes, acceptance criteria, and resulting build recorded. A displayed personal version such as `1.2.1.alice-1` identifies the base and revision; the source commit and build identity provide exact provenance.

## Updating and sharing

People may keep customizing an old base or adopt a newer Malleaf release. The agent should resolve implementation conflicts itself and present genuine behavioral choices in ordinary language. A failed upgrade must leave a working version available. Source rollback alone is insufficient when a change modifies stored data.

Sharing should distinguish a single customization from a complete version. Contributing to the common product and sharing a personal variant are separate operations. The community hosting model remains an architecture decision; it is not required for local customization.

## First acceptance target

Demonstrate a real backend or orchestration change as well as a visible interface change, build and test the candidate, verify that the running version changed, and recover the previous version after a failed candidate. A frontend-only reload does not satisfy this target.

The repository currently contains the upstream source import and this brief. Architecture, implementation stages, and validation evidence will be recorded as they are completed. Read [upstream integration notes](../UPSTREAM.md) for the source baseline and existing CI limitation.
