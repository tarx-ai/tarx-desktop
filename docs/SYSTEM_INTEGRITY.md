# System Integrity (TARX Computer)

**Canonical name:** System Integrity  
**Do not call this:** “Mac Stability”

Full company standard:

- Identity, provenance, three-environment release policy, and moat language live in **tarx-web**:  
  `docs/TARXAN_IDENTITY_PROVENANCE_AND_SYSTEM_INTEGRITY.md`

## Non-negotiable

A TARX Computer release must **never** be certified on the founder’s primary **Development** environment.

| Environment | Role |
|---|---|
| Development | Dirty, multi-runtime, experimental — **never release authority** |
| Golden QA | Single install, clean profile — **only release authority** |
| Enterprise Validation | Deployment behavior across planes/Machines |

## Lifecycle Golden QA must pass

install → first launch → first answer → first tool → quit → reopen → update → uninstall

## Moat

TARX is the operating system that knows whether its own AI infrastructure is healthy, trustworthy, reproducible, and safe to execute.

## Culture

Do not optimize for passing today’s gate. Optimize for a permanent System Integrity framework reused by Computer, Supercomputer, and Enterprise unchanged.
