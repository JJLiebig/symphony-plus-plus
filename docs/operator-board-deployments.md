# Deployment observations on the operator board

The hydrated local dashboard can report whether a completed goal is currently
deployed to dev or prod. These observations never change completion, readiness,
merge eligibility, blockers, or the ledger. Finished still means delivered.

## Setup

Edit the external operator configuration at `$SYMPP_HOME/operator-board.json`
(default `~/.agents/splusplus/operator-board.json`), or point
`SYMPP_OPERATOR_CONFIG` at a different file:

```json
{
  "repos": {
    "acme-labs/compass": {
      "area": ["Acme Labs", "Compass"],
      "deploy_workflows": {
        "dev": "deploy-dev.yml",
        "prod": "deploy-prod.yml"
      }
    }
  }
}
```

Use a workflow file name or its numeric GitHub workflow ID as a string. Either
environment can be omitted. A repository with neither tag has no deployments
field, and produces no deployment API traffic.

**Tagging a workflow certifies that every successful run deploys its `head_sha`
to that environment.** The workflow must have one consistent target environment
across branches and invocations. Do not tag a workflow that accepts a different
revision input, skips deployment on a successful path, only builds artifacts,
or deploys different environments by branch. No GitHub Deployment records or
additional workflow instrumentation are required. Pull-request-triggered runs
and runs from another head repository cannot prove deployment.

Reads use the existing GitHub token when supplied, otherwise the existing `gh`
authentication. Private repositories require read access to Actions and Contents;
repository metadata supplies the default branch. Setup changes take effect on
the next hydrated read; provider observations may remain cached for 60 seconds.

## Response

Both `work_requests.work_requests[]` cards and
`work_request_details[].work_request` receive the same additive observations:

```json
{
  "base_branch": "beta",
  "default_branch": "trunk",
  "deployments": {
    "acme-labs/compass": {
      "dev": {
        "status": "ok",
        "at": "2026-10-10T11:00:00Z",
        "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "workflow": "deploy-dev.yml",
        "run_id": 12345,
        "url": "https://github.com/acme-labs/compass/actions/runs/12345",
        "observed_at": "2026-10-10T11:00:30Z"
      }
    }
  }
}
```

Repositories stay separate for goals spanning several repositories. An absent
environment tag is omitted. `default_branch` is best effort, only for the goal's
tagged primary repository, from GitHub repository metadata; it is omitted when
unavailable or unconfigured and never inferred from `base_branch`.

The existing hydrated goal completion marker must be present before a goal can
be deployed. All merge commits of its current visible delivered packages in
each repository must be ancestors of the deployed revision (or equal to it).
Superseded, abandoned and skipped packages do not contribute. Completed work
without a PR contributes no merge SHA; a repository containing only such work
has no deployment observation.

The most recently updated successful run owns the environment. Its revision
must include all relevant merge commits for `ok`. A subsequent failed attempt
does not undo a successful deployment. A successful rollback to an earlier or
divergent revision does undo it: an older success cannot restore `ok`. After
such a rollback, or when there has been no success, the latest later attempt
containing all required commits reports `failed` for failure, timeout or action
required; an unfinished, cancelled, skipped or other attempt reports `pending`.
Retries are ordered by update time, then attempt and run ID, rather than creation
order. This is a current observation, not a deployment history service.

`at` is the selected completed run's GitHub `updated_at`, or a live attempt's
`run_started_at`/`created_at`. It is an observed workflow time, not a measured
application cutover time. `observed_at` is the oldest cached workflow page's
fetch time. With no selected run, `at`, `revision`, `run_id` and `url` are null.
Pending observations may include `reason`: `unfinished`, `missing_merge_evidence`,
`not_deployed` or `unavailable`. Provider errors never become failed deployments.

## Read limits

Provider reads happen after the SQLite snapshot transaction. Identical repository,
workflow-page and commit-comparison requests are shared within a read and cached
for 60 seconds. Stale entries are removed on subsequent reads. A hydrated read
allows at most 30 provider requests and five seconds of external observation
work to protect dashboard response time and GitHub API usage. Each workflow is
paged at 100 runs per page until complete or the read budget is exhausted. Exhausted budgets, missing
permissions, unavailable comparisons or incomplete pages yield pending rather
than a deployment claim. A later read can complete from cached earlier pages.

GitHub lists current run attempts rather than an atomic deployment history. A
retry can change a run's reported conclusion; concurrent provider changes or
deleted runs may change what can be observed. This integration only asserts
current state from the complete bounded run listing it can read. Large histories
can need several reads to populate the cache; no historical result is silently assumed.

The implementation uses GitHub's [workflow run listing](https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow),
[commit comparison](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
and [repository metadata](https://docs.github.com/en/rest/repos/repos#get-a-repository)
endpoints. Listing pages support at most 100 entries. The listing is unfiltered,
so GitHub's 1,000-result filtered-search limit does not apply. Commit ancestry uses comparison status,
so truncated commit-detail arrays do not affect the result.
