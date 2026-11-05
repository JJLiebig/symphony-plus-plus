# Idea: repo memory and a per-repo owner

Status: idea only, parked as an open PR so it is not forgotten. Nothing here is built.

## The idea

Today the architect plans a WorkRequest into WorkPackages and workers execute them. Every worker starts cold on its repo.

Two possible additions, in order of cost:

1. **Repo memory.** One curated notes document per repo: conventions, flaky tests, CI quirks, past decisions. Updated after each delivered package; read by every worker on that repo.
2. **Repo owner.** A per-repo agent between the architect and the workers. The architect splits a WorkRequest by repo; each owner plans and reviews its repo's packages. Owners report to the architect; only the architect escalates to the human, so the board keeps one place to ask.

## Why not yet

- Another layer adds latency, tokens and a new place to get stuck.
- Long-lived agent sessions drift; memory written to the ledger or a file stays reliable.

## How to decide

Run the current factory on a real multi-repo WorkRequest and watch for:

- Workers repeating the same repo mistakes: build repo memory.
- The architect becoming slow, losing track or running out of context: build the repo owner.

Memory first; the owner only if the evidence asks for it.
