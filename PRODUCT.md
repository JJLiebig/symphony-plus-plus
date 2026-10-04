# Product

## Platform

web

## Users

The primary user is the human overseer coordinating local agent work. They need to understand execution state, dependencies, active workers, reviews, pull requests, blockers, and delivery progress without reading agent transcripts.

## Product Purpose

Symphony++ is a local planning and orchestration cockpit for real software delivery. It gives agents structured tools and gives the human operator a shared visual source of truth. Success means the operator can quickly answer what is happening, what can proceed, what is waiting, and what needs attention.

For delivery-tracked work, Symphony++ typically begins after the human and an agent have explored the problem and refined it into a sufficiently concrete goal, spec, or direction. That handoff becomes a WorkRequest, after which an architect can slice the work, dispatch bounded execution, and oversee delivery end to end. Solo Sessions remain available for lightweight planning before or outside that lifecycle.

Symphony++ coordinates delivery work through its ledger; it does not own terminal sessions, model accounts, or the human's interactive coding environment.

## Positioning

The lean local cockpit where human oversight and agent execution stay synchronized through the same ledger.

## Beta Direction

The approved [factory workflow](docs/design/factory-workflow.md) extends this
cockpit toward agent-agnostic delivery: direct workers for small clear work,
feature architects for substantial requests, and human/UI collaboration with
explicit backend dependencies and technical review. Domain chiefs remain an
optional human entrypoint; model and host choices are separate from roles.

The operator must see the owner, current activity, waiting reason, and next
action. Keep worker handoffs compact and reuse valid check/review evidence.
This is a target contract, not a claim that the current board or runtime already
implements the entire workflow.

## Brand Personality

Calm, dense, trustworthy. The voice is direct and operational: precise without ceremony, energetic only when the underlying system is active, and quiet when no action is needed.

## Anti-references

- Nested-card labyrinths that make hierarchy harder to read.
- Oversized execution cards filled with bookkeeping details.
- Beige, cream, or parchment-like neutral states.
- Decorative workflow lines that cross cards, overlap unpredictably, or imply false sequencing.
- Dashboard clutter that elevates internal execution records above product work.
- Guardrails and lifecycle copy that make ordinary recovery harder than the work itself.

## Design Principles

1. **State at a glance.** Titles, lifecycle state, progress, and PR presence carry the board; everything else is progressive detail.
2. **One shared truth.** Human-facing projections must agree with the ledger and agent-facing tools.
3. **Stable geometry.** Status updates and group expansion must not destroy the operator's mental map.
4. **Complexity earns space.** Small work stays compact; large work may reveal structure without turning the whole dashboard into nested containers.
5. **Motion explains change.** Animation communicates activity, transitions, and topology changes; it never decorates inactive state.

## Accessibility & Inclusion

Target WCAG AA contrast, full keyboard operability, non-color state cues, readable status labels, and reduced-motion behavior that preserves meaning without choreography.
