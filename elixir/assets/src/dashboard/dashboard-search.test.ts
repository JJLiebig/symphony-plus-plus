import { describe, expect, it } from "vitest";

import type { WorkPackageCard, WorkRequestDetail } from "@/types/dashboard";

import type { RepoSummary } from "./dashboard-data";
import { filterWorkstreamsBySearch, matchesDashboardSearch } from "./dashboard-search";

describe("dashboard search", () => {
  it("matches compact fuzzy dashboard text", () => {
    expect(matchesDashboardSearch("nsvkrk", ["nextide-saas-vod-kraken"])).toBe(true);
    expect(matchesDashboardSearch("wr 123", ["wr_123", "Creator roster read model"])).toBe(true);
    expect(matchesDashboardSearch("missing", ["Creator roster read model"])).toBe(false);
    expect(matchesDashboardSearch("zzzz", ["wr_zabzcydzef"])).toBe(false);
    expect(matchesDashboardSearch("replay", ["ready plan analysis yearly"])).toBe(false);
  });

  it("shows a matching repository's work and trims to matching request/package content otherwise", () => {
    const pkg: WorkPackageCard = { id: "wp_backend", title: "Backend API", repo: "vod-api" };
    const detail: WorkRequestDetail = {
      work_request: { id: "wr_creator_roster", title: "Creator roster read model", repo: "vod-api" },
      work_packages: [{ id: "wrs_backend", work_request_id: "wr_creator_roster", title: "Fast creator read", work_package_id: pkg.id }],
    };
    const repo: RepoSummary = {
      repoKey: "vod-api",
      repo: "nextide-saas-vod-api",
      baseBranches: ["main"],
      requested: 1,
      active: 1,
      implementing: 0,
      finished: 0,
      guidanceCount: 0,
      blockerCount: 0,
      packages: [pkg],
      requests: [detail.work_request],
    };

    const repoMatch = filterWorkstreamsBySearch([repo], new Map([[repo.repoKey, [detail]]]), "vod api");
    const requestMatch = filterWorkstreamsBySearch([repo], new Map([[repo.repoKey, [detail]]]), "creator roster");
    const miss = filterWorkstreamsBySearch([repo], new Map([[repo.repoKey, [detail]]]), "billing");

    expect(repoMatch.repos[0]).toMatchObject({ repo: repo.repo, packages: [pkg], requests: [detail.work_request] });
    expect(repoMatch.requestDetailsByRepo.get(repo.repoKey)).toEqual([detail]);
    expect(requestMatch.repos[0].packages).toEqual([pkg]);
    expect(requestMatch.requestDetailsByRepo.get(repo.repoKey)).toEqual([detail]);
    expect(miss.repos).toEqual([]);
  });

  it("finds requests by the owner, actor, wait, next step and eligibility shown on the Work board", () => {
    const detail: WorkRequestDetail = {
      work_request: { id: "wr_board", title: "Board request", repo: "vod-api" },
      work_packages: [{
        id: "wp_ui", work_request_id: "wr_board", title: "UI wiring", status: "ready_for_merge",
        activity_signal: { accountable_owner: { id: "chief-ui" }, current_actor: { name: "Opus", role: "worker" }, stage: "ready_for_merge", waiting_reason: "dependency_not_delivered", next_actor: "architect", next_action: "deliver_prerequisites" },
        merge_eligibility: { eligible: false, reason_codes: ["dependency_not_delivered"], next_action: "deliver_prerequisites" },
      }],
    };
    const repo: RepoSummary = { repoKey: "vod-api", repo: "vod-api", baseBranches: ["main"], requested: 0, active: 1, implementing: 0, finished: 0, guidanceCount: 0, blockerCount: 0, packages: [], requests: [detail.work_request] };
    const details = new Map([[repo.repoKey, [detail]]]);

    for (const query of ["chief-ui", "opus", "prerequisite delivery", "architect", "qualified"]) {
      expect(filterWorkstreamsBySearch([repo], details, query).requestDetailsByRepo.get(repo.repoKey)).toEqual([detail]);
    }
    expect(filterWorkstreamsBySearch([repo], details, "ready to merge").repos).toEqual([]);
  });
});
