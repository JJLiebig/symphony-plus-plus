Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.WorkerTools01Test do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  alias SymphonyElixir.SymphonyPlusPlus.MCP.WorktreeScope
  alias SymphonyElixir.SymphonyPlusPlus.ProductTree

  test "worker tools update only the scoped planning state and deny sibling mutations", %{repo: repo} do
    assert {:ok, own_package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WORKER-OWN", kind: "adapter"))
    assert {:ok, sibling_package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-WORKER-SIBLING", kind: "adapter"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, own_package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    read_plan_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "read-plan", "method" => "tools/call", "params" => %{"name" => "read_task_plan"}},
        repo: repo,
        session: session
      )

    plan_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "plan",
          "method" => "tools/call",
          "params" => %{
            "name" => "update_task_plan",
            "arguments" => %{
              "expected_version" => get_in(read_plan_response, ["result", "structuredContent", "version"]),
              "nodes" => [%{"title" => "Implement MCP worker tools", "status" => "done"}]
            }
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(plan_response, ["result", "structuredContent", "plan_nodes", Access.at(0), "status"]) == "done"
    assert get_in(plan_response, ["result", "structuredContent", "plan_nodes", Access.at(0), "id"]) =~ ~r/^plan_/

    finding_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"title" => "Scoped", "body" => "Own package only", "idempotency_key" => "finding-scoped"}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(finding_response, ["result", "structuredContent", "finding", "title"]) == "Scoped"

    explicit_finding_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding-explicit-id",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"id" => " custom-finding-id ", "title" => "Explicit", "body" => "Caller supplied id", "idempotency_key" => "finding-explicit"}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(explicit_finding_response, ["result", "structuredContent", "finding", "id"]) == "custom-finding-id"

    explicit_finding_replay_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding-explicit-id-replay",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"id" => "custom-finding-id-retry", "title" => "Explicit", "body" => "Caller supplied id", "idempotency_key" => "finding-explicit"}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(explicit_finding_replay_response, ["error", "data", "reason"]) == "idempotency_conflict"

    matching_explicit_finding_replay_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding-explicit-id-matching-replay",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"id" => "custom-finding-id", "title" => "Explicit", "body" => "Caller supplied id", "idempotency_key" => "finding-explicit"}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(matching_explicit_finding_replay_response, ["result", "structuredContent", "finding", "id"]) == "custom-finding-id"

    explicit_finding_id_conflict_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding-explicit-id-conflict",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"id" => "custom-finding-id", "title" => "Explicit", "body" => "Caller supplied id", "idempotency_key" => "finding-other"}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(explicit_finding_id_conflict_response, ["error", "data", "reason"]) == "idempotency_conflict"

    finding_replay_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding-replay",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"title" => "Scoped", "body" => "Own package only", "idempotency_key" => "finding-scoped"}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(finding_replay_response, ["result", "structuredContent", "finding", "id"]) ==
             get_in(finding_response, ["result", "structuredContent", "finding", "id"])

    whitespace_finding_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding-whitespace",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"title" => "Whitespace", "body" => "Trim idempotency", "idempotency_key" => " finding-space "}
          }
        },
        repo: repo,
        session: session
      )

    whitespace_replay_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding-whitespace-replay",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"title" => "Whitespace", "body" => "Trim idempotency", "idempotency_key" => "finding-space"}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(whitespace_replay_response, ["result", "structuredContent", "finding", "id"]) ==
             get_in(whitespace_finding_response, ["result", "structuredContent", "finding", "id"])

    assert {:ok, second_minted} = AccessGrantService.mint_worker_grant(repo, own_package.id)
    assert {:ok, second_assignment} = AccessGrantService.claim(repo, second_minted.work_key.secret, claimed_by: "worker-2")
    second_session = MCPHarness.session(second_assignment, proof_hash: second_minted.grant.secret_hash)

    attach_tool(repo, session, "attach_branch", %{"branch" => "agent/SYMPP-WORKER-OWN/worker", "head_sha" => "own-head"})
    attach_tool(repo, second_session, "attach_branch", %{"branch" => "agent/SYMPP-WORKER-OWN/worker", "head_sha" => "own-head"})

    finding_regrant_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding-regrant",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"title" => "Scoped", "body" => "Own package only", "idempotency_key" => "finding-scoped"}
          }
        },
        repo: repo,
        session: second_session
      )

    assert get_in(finding_regrant_response, ["result", "structuredContent", "finding", "id"]) ==
             get_in(finding_response, ["result", "structuredContent", "finding", "id"])

    conflicting_finding_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding-conflict",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"title" => "Scoped", "body" => "Different body", "idempotency_key" => "finding-scoped"}
          }
        },
        repo: repo,
        session: second_session
      )

    assert get_in(conflicting_finding_response, ["error", "data", "reason"]) == "idempotency_conflict"

    progress_args = %{"summary" => "Progress", "idempotency_key" => "worker-progress-1", "body" => "Done"}

    progress_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "progress", "method" => "tools/call", "params" => %{"name" => "append_progress", "arguments" => progress_args}},
        repo: repo,
        session: session
      )

    replay_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "progress-replay", "method" => "tools/call", "params" => %{"name" => "append_progress", "arguments" => progress_args}},
        repo: repo,
        session: session
      )

    assert get_in(progress_response, ["result", "structuredContent", "progress_event", "id"]) ==
             get_in(replay_response, ["result", "structuredContent", "progress_event", "id"])

    whitespace_progress_replay_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "progress-whitespace-replay",
          "method" => "tools/call",
          "params" => %{"name" => "append_progress", "arguments" => %{progress_args | "idempotency_key" => " worker-progress-1 "}}
        },
        repo: repo,
        session: session
      )

    assert get_in(whitespace_progress_replay_response, ["result", "structuredContent", "progress_event", "id"]) ==
             get_in(progress_response, ["result", "structuredContent", "progress_event", "id"])

    redacted_progress_args = %{
      "summary" => "Redacted progress",
      "idempotency_key" => "worker-progress-redacted",
      "payload" => %{"token" => "sk-secret"}
    }

    redacted_progress_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "progress-redacted",
          "method" => "tools/call",
          "params" => %{"name" => "append_progress", "arguments" => redacted_progress_args}
        },
        repo: repo,
        session: session
      )

    assert response_progress_payload(repo, redacted_progress_response)["token"] == "[REDACTED]"

    leaked_secret = WorkKey.generate().secret
    second_leaked_secret = WorkKey.generate().secret
    fine_grained_pat = "github_pat_" <> Base.encode16(:crypto.strong_rand_bytes(18), case: :lower)
    query_password = "pw-" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
    legacy_aws_access_key_id = "AKIA" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :upper)
    legacy_aws_signature = Base.url_encode64(:crypto.strong_rand_bytes(18), padding: false)

    text_redacted_progress_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "progress-text-redacted",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_progress",
            "arguments" => %{
              "summary" => "Worker pasted #{leaked_secret} then kept going",
              "idempotency_key" => "worker-progress-text-redacted",
              "payload" => %{
                "Authorization: Bearer #{leaked_secret}" => "present",
                "Authorization: Bearer #{second_leaked_secret}" => "also present",
                "fine_grained_pat" => "Saw #{fine_grained_pat}",
                "note" => "Before Bearer #{leaked_secret} after",
                "password_url" => "Login https://example.test/login?password=#{query_password}&page=1",
                "s3_url" => "Fetch https://bucket.s3.amazonaws.test/object?AWSAccessKeyId=#{legacy_aws_access_key_id}&Signature=#{legacy_aws_signature}&Expires=1",
                "safe_url" => "Review https://example.test/issues/1?w=1",
                "signed_url" => "Fetch https://example.test/download?sig=#{leaked_secret}&page=1"
              }
            }
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(text_redacted_progress_response, ["result", "structuredContent", "progress_event", "summary"]) ==
             "Worker pasted [REDACTED] then kept going"

    refute Map.has_key?(get_in(text_redacted_progress_response, ["result", "structuredContent", "progress_event"]), "payload")
    encoded_text_redacted_response = Jason.encode!(get_in(text_redacted_progress_response, ["result", "structuredContent"]))
    refute encoded_text_redacted_response =~ leaked_secret
    refute encoded_text_redacted_response =~ second_leaked_secret
    refute encoded_text_redacted_response =~ fine_grained_pat
    refute encoded_text_redacted_response =~ query_password
    refute encoded_text_redacted_response =~ legacy_aws_access_key_id
    refute encoded_text_redacted_response =~ legacy_aws_signature

    redacted_replay_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "progress-redacted-replay",
          "method" => "tools/call",
          "params" => %{"name" => "append_progress", "arguments" => redacted_progress_args}
        },
        repo: repo,
        session: session
      )

    assert get_in(redacted_replay_response, ["result", "structuredContent", "progress_event", "id"]) ==
             get_in(redacted_progress_response, ["result", "structuredContent", "progress_event", "id"])

    conflicting_progress_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "progress-conflict",
          "method" => "tools/call",
          "params" => %{"name" => "append_progress", "arguments" => Map.put(progress_args, "summary", "Different progress")}
        },
        repo: repo,
        session: session
      )

    assert get_in(conflicting_progress_response, ["error", "data", "reason"]) == "idempotency_conflict"

    denied_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "denied",
          "method" => "tools/call",
          "params" => %{
            "name" => "update_task_plan",
            "arguments" => %{
              "expected_version" => get_in(plan_response, ["result", "structuredContent", "version"]),
              "work_package_id" => sibling_package.id,
              "nodes" => [%{"title" => "Mutate sibling"}]
            }
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(denied_response, ["error", "code"]) == -32_003
    assert get_in(denied_response, ["error", "data", "reason"]) == "outside_session_scope"

    assert {:ok, own_nodes} = PlanningRepository.list_plan_nodes(repo, own_package.id)
    assert {:ok, sibling_nodes} = PlanningRepository.list_plan_nodes(repo, sibling_package.id)
    assert length(own_nodes) == 1
    assert sibling_nodes == []
  end

  test "worker context projects only its package, parent summary, selected decisions, and direct dependencies", %{repo: repo} do
    parent_work_request =
      create_work_request!(repo,
        id: "WR-WORKER-CONTEXT",
        title: "Ship scoped worker context",
        human_description: "Let workers explain their assigned outcome."
      )

    assert {:ok, dependency} =
             WorkPackageRepository.create(
               repo,
               WorkPackageFactory.attrs(
                 id: "SYMPP-WORKER-CONTEXT-DEPENDENCY",
                 work_request_id: parent_work_request.id,
                 title: "Finish dependency",
                 repo: parent_work_request.repo,
                 base_branch: parent_work_request.base_branch,
                 status: "ready_for_merge"
               )
             )

    assert {:ok, sibling} =
             WorkPackageRepository.create(
               repo,
               WorkPackageFactory.attrs(
                 id: "SYMPP-WORKER-CONTEXT-SIBLING",
                 work_request_id: parent_work_request.id,
                 title: "Sibling contract title",
                 engineering_scope: "sibling-contract-secret",
                 repo: parent_work_request.repo,
                 base_branch: parent_work_request.base_branch,
                 status: "active"
               )
             )

    assert {:ok, package} =
             WorkPackageRepository.create(
               repo,
               WorkPackageFactory.attrs(
                 id: "SYMPP-WORKER-CONTEXT-PACKAGE",
                 work_request_id: parent_work_request.id,
                 title: "Scoped work package",
                 repo: parent_work_request.repo,
                 base_branch: parent_work_request.base_branch,
                 allowed_file_globs: ["elixir/lib/**"],
                 acceptance_criteria: ["Honor decision WRD-WORKER-CONTEXT-CONTRACT."],
                 status: "active"
               )
             )

    assert {:ok, selected_decision} =
             WorkRequestRepository.record_decision(
               repo,
               parent_work_request.id,
               work_request_decision_attrs(
                 id: "WRD-WORKER-CONTEXT-SELECTED",
                 decision: "Use the direct dependency contract.",
                 rationale: "It controls this worker's sequencing.",
                 scope_impact: "Read only the selected decision."
               )
             )

    assert {:ok, contract_decision} =
             WorkRequestRepository.record_decision(
               repo,
               parent_work_request.id,
               work_request_decision_attrs(
                 id: "WRD-WORKER-CONTEXT-CONTRACT",
                 decision: "Keep referenced decisions in worker context.",
                 rationale: "The worker cannot read the parent decision log.",
                 scope_impact: "Expose only explicitly referenced decisions."
               )
             )

    assert {:ok, _unrelated_decision} =
             WorkRequestRepository.record_decision(
               repo,
               parent_work_request.id,
               work_request_decision_attrs(
                 id: "WRD-WORKER-CONTEXT-UNRELATED",
                 decision: "Sibling-only decision must stay hidden."
               )
             )

    assert {:ok, _edge} =
             ProductTree.create_dependency_edge(repo, %{
               work_request_id: parent_work_request.id,
               source_kind: "work_package",
               source_id: package.id,
               target_kind: "work_package",
               target_id: dependency.id,
               kind: "depends_on",
               reason: "Worker needs direct dependency status.",
               decision_ref: %{"id" => selected_decision.id}
             })

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-context")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)
    response = mcp_tool(repo, session, "read_context", %{})
    context = get_in(response, ["result", "structuredContent"])

    assert context["parent_work_request"] == %{
             "id" => parent_work_request.id,
             "title" => parent_work_request.title,
             "goal" => parent_work_request.human_description,
             "status" => parent_work_request.status
           }

    assert context["direct_dependencies"] == [
             %{"id" => dependency.id, "title" => dependency.title, "status" => dependency.status}
           ]

    assert context["selected_decisions"] == [
             %{
               "id" => selected_decision.id,
               "decision" => selected_decision.decision,
               "rationale" => selected_decision.rationale,
               "scope_impact" => selected_decision.scope_impact
             },
             %{
               "id" => contract_decision.id,
               "decision" => contract_decision.decision,
               "rationale" => contract_decision.rationale,
               "scope_impact" => contract_decision.scope_impact
             }
           ]

    assert context["work_package"] == %{
             "id" => package.id,
             "status" => package.status,
             "contract_revision" => package.contract_revision,
             "repo" => package.repo,
             "base_branch" => package.base_branch,
             "branch" => package.branch_pattern,
             "goal" => package.goal,
             "product_description" => package.product_description,
             "engineering_scope" => package.engineering_scope,
             "allowed_file_globs" => package.allowed_file_globs,
             "forbidden_file_globs" => package.forbidden_file_globs,
             "acceptance_criteria" => package.acceptance_criteria,
             "validation_steps" => package.validation_steps,
             "stop_conditions" => package.stop_conditions,
             "review" => package.review_requirement
           }

    assert context["current_binding"] == %{
             "state" => "bound",
             "role" => "worker",
             "surface_profile" => "full",
             "next_action" => "continue_current_assignment"
           }

    context_text = get_in(response, ["result", "content", Access.at(0), "text"])
    assert context_text =~ dependency.id
    refute context_text =~ sibling.title
    refute context_text =~ "sibling-contract-secret"
    refute context_text =~ "Sibling-only decision must stay hidden."
  end

  test "progress metadata tools reject non-string required fields", %{repo: repo} do
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-METADATA-ARGS", kind: "mcp"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    numeric_key_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "numeric-progress-key",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_progress",
            "arguments" => %{"summary" => "Progress", "idempotency_key" => 123}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(numeric_key_response, ["error", "code"]) == -32_602
    assert get_in(numeric_key_response, ["error", "data", "reason"]) == "missing_idempotency_key"

    numeric_summary_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "numeric-progress-summary",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_progress",
            "arguments" => %{"summary" => 123, "idempotency_key" => "numeric-progress-summary"}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(numeric_summary_response, ["error", "code"]) == -32_602
    assert get_in(numeric_summary_response, ["error", "data", "reason"]) == "missing_summary"
  end

  test "compact worker metadata calls infer current package targets and keep verbose compatibility", %{repo: repo} do
    fixture = TestSupport.git_repo_fixture!("main", prefix: "sympp-compact-metadata")

    assert {:ok, package} =
             WorkPackageRepository.create(
               repo,
               WorkPackageFactory.attrs(
                 id: "SYMPP-COMPACT-METADATA",
                 kind: "mcp",
                 branch_pattern: "agent/{{work_package_id}}/{{slug}}",
                 worktree_path: fixture.repo_root
               )
             )

    assert {:ok, branch} = WorktreeScope.prepare_branch(package, nil)
    TestSupport.git_output!(fixture.repo_root, ["checkout", "-b", branch])
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    tools_response = MCPHarness.request(%{"jsonrpc" => "2.0", "id" => "literal-branch-tools", "method" => "tools/list", "params" => %{}}, repo: repo, session: session)
    tools_by_name = tools_response |> get_in(["result", "tools"]) |> Map.new(&{&1["name"], &1})
    assert get_in(tools_by_name, ["attach_branch", "inputSchema", "required"]) == ["head_sha"]

    for tool <- ["update_task_plan", "append_progress", "attach_branch"] do
      refute "work_package_id" in get_in(tools_by_name, [tool, "inputSchema", "required"])
    end

    compact_branch_response = attach_tool(repo, session, "attach_branch", %{"head_sha" => "compact-head"})
    compact_branch_payload = response_progress_payload(repo, compact_branch_response)
    assert compact_branch_payload["branch"] == branch
    assert compact_branch_payload["head_sha"] == "compact-head"

    verbose_branch_response = attach_tool(repo, session, "attach_branch", %{"branch" => branch, "head_sha" => "verbose-head"})
    verbose_branch_payload = response_progress_payload(repo, verbose_branch_response)
    assert verbose_branch_payload["branch"] == branch
    assert verbose_branch_payload["head_sha"] == "verbose-head"

    compact_comment_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "compact-comment", "method" => "tools/call", "params" => %{"name" => "add_comment", "arguments" => %{"body" => "Compact package note"}}},
        repo: repo,
        session: session
      )

    assert get_in(compact_comment_response, ["result", "structuredContent", "comment", "target_kind"]) == "work_package"
    assert get_in(compact_comment_response, ["result", "structuredContent", "comment", "target_id"]) == package.id

    verbose_comment_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "verbose-comment",
          "method" => "tools/call",
          "params" => %{
            "name" => "add_comment",
            "arguments" => %{"target_kind" => "work_package", "target_id" => package.id, "body" => "Verbose package note"}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(verbose_comment_response, ["result", "structuredContent", "comment", "target_id"]) == package.id

    compact_list_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "compact-list-comments", "method" => "tools/call", "params" => %{"name" => "list_comments"}},
        repo: repo,
        session: session
      )

    assert get_in(compact_list_response, ["result", "structuredContent", "target"]) == %{"kind" => "work_package", "id" => package.id}
    compact_bodies = compact_list_response |> get_in(["result", "structuredContent", "comments"]) |> Enum.map(& &1["body"])
    assert Enum.sort(compact_bodies) == ["Compact package note", "Verbose package note"]

    verbose_list_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "verbose-list-comments",
          "method" => "tools/call",
          "params" => %{"name" => "list_comments", "arguments" => %{"target_kind" => "work_package", "target_id" => package.id}}
        },
        repo: repo,
        session: session
      )

    assert verbose_list_response |> get_in(["result", "structuredContent", "comments"]) |> length() == 2

    repo.update_all(
      from(work_package in WorkPackage, where: work_package.id == ^package.id),
      set: [branch_pattern: "legacy/*"]
    )

    invalid_inferred_branch_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "invalid-inferred-branch",
          "method" => "tools/call",
          "params" => %{"name" => "attach_branch", "arguments" => %{"head_sha" => "invalid-head"}}
        },
        repo: repo,
        session: session
      )

    assert get_in(invalid_inferred_branch_response, ["error", "code"]) == -32_602
    assert get_in(invalid_inferred_branch_response, ["error", "data", "reason"]) == "unsupported_branch_pattern_wildcard"
    assert get_in(invalid_inferred_branch_response, ["error", "data", "validation_errors", Access.at(0), "field"]) == "branch_pattern"
  end

  test "worker-facing WorkPackage tools and resources emit TOON agent text without changing JSON structured content", %{repo: repo} do
    leaked_secret = WorkKey.generate().secret
    api_token = "sk-" <> Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
    api_key = "plain-api-key-value"
    access_key = "plain-access-key-value"

    assert {:ok, package} =
             WorkPackageRepository.create(
               repo,
               WorkPackageFactory.attrs(
                 id: "SYMPP-TOON-WORKER",
                 kind: "mcp",
                 title: "Emit TOON worker context",
                 product_description: "Context includes Bearer #{leaked_secret}",
                 engineering_scope: "Keep structuredContent JSON stable",
                 acceptance_criteria: ["Do not invent completion state"]
               )
             )

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    assignment_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "assignment", "method" => "tools/call", "params" => %{"name" => "get_current_assignment"}},
        repo: repo,
        session: session
      )

    assignment_text = get_in(assignment_response, ["result", "content", Access.at(0), "text"])
    assert assignment_text =~ "assignment:"
    assert get_in(assignment_response, ["result", "structuredContent", "assignment", "work_package_id"]) == package.id
    refute assignment_text =~ minted.work_key.secret

    context_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "context", "method" => "tools/call", "params" => %{"name" => "read_context"}},
        repo: repo,
        session: session
      )

    context_text = get_in(context_response, ["result", "content", Access.at(0), "text"])
    assert context_text =~ "work_package:"
    assert context_text =~ "product_description:"
    assert context_text =~ "[REDACTED]"
    assert get_in(context_response, ["result", "structuredContent", "text"]) =~ "# source: `Emit TOON worker context`"
    refute context_text =~ leaked_secret

    acceptance_resource =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "acceptance-resource",
          "method" => "resources/read",
          "params" => %{"uri" => "sympp://work-packages/#{package.id}/acceptance.md"}
        },
        repo: repo,
        session: session
      )

    acceptance_contents = get_in(acceptance_resource, ["result", "contents"])
    assert [%{"mimeType" => "text/vnd.toon"} = acceptance_toon_resource] = acceptance_contents

    resource_list =
      MCPHarness.request(%{"jsonrpc" => "2.0", "id" => "resources", "method" => "resources/list"}, repo: repo, session: session)

    listed_acceptance = Enum.find(get_in(resource_list, ["result", "resources"]), &(&1["uri"] == acceptance_toon_resource["uri"]))
    assert listed_acceptance["mimeType"] == acceptance_toon_resource["mimeType"]
    assert acceptance_toon_resource["text"] =~ "acceptance[1]{source}:"
    assert acceptance_toon_resource["text"] =~ "Do not invent completion state"
    refute acceptance_toon_resource["text"] =~ "done"

    http_acceptance_resource =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "http-acceptance-resource",
          "method" => "resources/read",
          "params" => %{"uri" => "sympp://work-packages/#{package.id}/acceptance.md"}
        },
        config: Config.default(repo: repo, mode: :http, surface_profile: :full),
        session: session
      )

    assert [%{"mimeType" => "text/vnd.toon", "text" => http_acceptance_text}] =
             get_in(http_acceptance_resource, ["result", "contents"])

    assert http_acceptance_text == acceptance_toon_resource["text"]

    read_plan_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "read-plan", "method" => "tools/call", "params" => %{"name" => "read_task_plan"}},
        repo: repo,
        session: session
      )

    read_plan_text = get_in(read_plan_response, ["result", "content", Access.at(0), "text"])
    assert read_plan_text =~ "plan_nodes[0]:"
    assert get_in(read_plan_response, ["result", "structuredContent", "text"]) =~ "# Task Plan"

    update_plan_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "update-plan",
          "method" => "tools/call",
          "params" => %{
            "name" => "update_task_plan",
            "arguments" => %{
              "expected_version" => get_in(read_plan_response, ["result", "structuredContent", "version"]),
              "nodes" => [%{"title" => "Verify TOON worker context", "status" => "done"}]
            }
          }
        },
        repo: repo,
        session: session
      )

    update_plan_text = get_in(update_plan_response, ["result", "content", Access.at(0), "text"])
    assert update_plan_text =~ "plan_nodes[1]"
    assert update_plan_text =~ "Verify TOON worker context"
    assert get_in(update_plan_response, ["result", "structuredContent", "plan_nodes", Access.at(0), "id"]) =~ ~r/^plan_/

    finding_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "finding",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_finding",
            "arguments" => %{"title" => "TOON visible", "body" => "Finding body", "idempotency_key" => "toon-finding"}
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(finding_response, ["result", "content", Access.at(0), "text"]) =~ "finding:"
    assert get_in(finding_response, ["result", "structuredContent", "finding", "title"]) == "TOON visible"

    findings_resource =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "findings-resource",
          "method" => "resources/read",
          "params" => %{"uri" => "sympp://work-packages/#{package.id}/findings.md"}
        },
        repo: repo,
        session: session
      )

    findings_contents = get_in(findings_resource, ["result", "contents"])
    assert [%{"mimeType" => "text/vnd.toon"} = findings_toon_resource] = findings_contents
    assert findings_toon_resource["text"] =~ "findings[1]"
    assert findings_toon_resource["text"] =~ "TOON visible"

    progress_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "progress",
          "method" => "tools/call",
          "params" => %{
            "name" => "append_progress",
            "arguments" => %{
              "summary" => "Recorded TOON progress with #{api_token}",
              "idempotency_key" => "toon-progress",
              "payload" => %{
                "accessKey" => access_key,
                "apiKey" => api_key,
                "grant_verifier" => "verifier-value",
                "private_payload" => %{"path" => "C:/private/payload", "payload" => "private-value"},
                "safe" => "visible"
              }
            }
          }
        },
        repo: repo,
        session: session
      )

    progress_text = get_in(progress_response, ["result", "content", Access.at(0), "text"])
    assert progress_text =~ "progress_event:"
    assert progress_text =~ "[REDACTED]"
    assert progress_text =~ "key_count: 0"
    assert progress_text =~ "sensitive_key_count: 0"
    assert response_progress_payload(repo, progress_response)["safe"] == "visible"
    refute progress_text =~ access_key
    refute progress_text =~ api_key
    refute progress_text =~ api_token
    refute progress_text =~ "visible"
    refute progress_text =~ "verifier-value"
    refute progress_text =~ "handoff-value"

    progress_resource =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "progress-resource",
          "method" => "resources/read",
          "params" => %{"uri" => "sympp://work-packages/#{package.id}/progress.md"}
        },
        repo: repo,
        session: session
      )

    contents = get_in(progress_resource, ["result", "contents"])
    assert [%{"mimeType" => "text/vnd.toon"} = toon_resource] = contents
    assert toon_resource["text"] =~ "Recorded TOON progress"
    assert toon_resource["text"] =~ "progress_events"
    assert toon_resource["text"] =~ "[REDACTED]"
    assert toon_resource["text"] =~ "key_count: 5"
    assert toon_resource["text"] =~ "sensitive_key_count: 4"
    refute toon_resource["text"] =~ access_key
    refute toon_resource["text"] =~ api_key
    refute toon_resource["text"] =~ api_token
    refute toon_resource["text"] =~ "visible"
    refute toon_resource["text"] =~ "verifier-value"
    refute toon_resource["text"] =~ "handoff-value"
  end

  test "read_task_plan TOON uses the same bounded state as the rendered virtual file", %{repo: repo} do
    assert {:ok, package} =
             WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-TOON-PLAN-BOUNDS", kind: "mcp"))

    plan_nodes =
      for index <- 1..101 do
        assert {:ok, plan_node} =
                 PlanningRepository.append_plan_node(repo, %{
                   "work_package_id" => package.id,
                   "title" => "Plan node #{index}",
                   "status" => "pending"
                 })

        plan_node
      end

    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "worker-1")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    read_plan_response =
      MCPHarness.request(
        %{"jsonrpc" => "2.0", "id" => "read-plan", "method" => "tools/call", "params" => %{"name" => "read_task_plan"}},
        repo: repo,
        session: session
      )

    read_plan_text = get_in(read_plan_response, ["result", "content", Access.at(0), "text"])
    assert read_plan_text =~ "omitted:"
    assert read_plan_text =~ "plan_nodes: 1"
    refute read_plan_text =~ "Plan node 101"
    assert get_in(read_plan_response, ["result", "structuredContent", "text"]) =~ "1 later plan nodes omitted"
    assert get_in(read_plan_response, ["result", "structuredContent", "omitted", "plan_nodes"]) == 1

    structured_plan_nodes = get_in(read_plan_response, ["result", "structuredContent", "plan_nodes"])
    assert length(structured_plan_nodes) == 100
    assert get_in(structured_plan_nodes, [Access.at(0), "id"]) == hd(plan_nodes).id
    assert get_in(structured_plan_nodes, [Access.at(0), "status"]) == "pending"
    assert get_in(structured_plan_nodes, [Access.at(0), "title"]) == "Plan node 1"

    version = get_in(read_plan_response, ["result", "structuredContent", "version"])
    assert version

    update_response =
      MCPHarness.request(
        %{
          "jsonrpc" => "2.0",
          "id" => "update-plan",
          "method" => "tools/call",
          "params" => %{
            "name" => "update_task_plan",
            "arguments" => %{
              "expected_version" => version,
              "nodes" => [%{"id" => get_in(structured_plan_nodes, [Access.at(0), "id"]), "status" => "done"}]
            }
          }
        },
        repo: repo,
        session: session
      )

    assert get_in(update_response, ["result", "structuredContent", "plan_nodes", Access.at(0), "status"]) == "done"
  end

  test "native document defaults match resources and recover safe observation identity", %{repo: repo} do
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-DOCUMENTS", kind: "mcp"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "reader")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)
    input = %{"dependency_id" => "dep-1", "prerequisite_work_package_id" => "wp-input", "candidate_head_sha" => "input-head"}

    assert {:ok, observation} =
             PlanningRepository.append_audit_progress_event(repo, assignment, %{
               "summary" => "Consumed candidate",
               "body" => "Evidence is in the existing PR. Bearer synthetic-secret-token",
               "idempotency_key" => "consumed-once",
               "payload" => %{"head_sha" => "consumer-head", "dependency_inputs" => [Map.put(input, "private_payload", "must-not-leak")], "arbitrary" => "must-not-leak"}
             })

    id = observation.id
    mcp_tool(repo, session, "append_finding", %{"title" => "Prior evidence", "body" => "Recover the finding body", "idempotency_key" => "finding-once"})

    for document <- ~w(context.md task_plan.md findings.md progress.md acceptance.md review.md handoff.md) do
      response = mcp_tool(repo, session, "read_work_package_document", %{"document" => document, "future_field" => true})

      resource =
        MCPHarness.request(%{"jsonrpc" => "2.0", "id" => document, "method" => "resources/read", "params" => %{"uri" => "sympp://work-packages/#{package.id}/#{document}"}},
          repo: repo,
          session: session
        )

      assert get_in(response, ["result", "content", Access.at(0), "text"]) == get_in(resource, ["result", "contents", Access.at(0), "text"])
      assert get_in(response, ["result", "structuredContent", "file"]) == document
    end

    # A fresh session recovers the original observation without replaying its mutation.
    reconnected = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)
    response = mcp_tool(repo, reconnected, "read_work_package_document", %{"document" => "progress.md"})
    assert [%{"id" => ^id, "sequence" => 1, "idempotency_key" => "consumed-once"} = event] = get_in(response, ["result", "structuredContent", "progress_events"])
    assert event["payload"]["observation"] == %{"head_sha" => "consumer-head", "dependency_inputs" => [input]}
    assert event["body"] =~ "Evidence is in the existing PR."
    refute Jason.encode!(response) =~ "synthetic-secret-token"
    refute Jason.encode!(response) =~ "must-not-leak"

    for payload <- [
          %{"type" => "branch", "source_tool" => "attach_branch", "branch" => "agent/example", "head_sha" => "branch-head"},
          %{
            "type" => "pr",
            "source_tool" => "sync_pr",
            "url" => "https://example.test/evidence?token=synthetic-private-value",
            "head_sha" => "pr-head",
            "check_summary" => %{"status" => "success", "private_payload" => "must-not-leak"}
          }
        ] do
      attrs = %{summary: "Prior typed evidence", payload: payload}
      assert {:ok, _} = PlanningRepository.append_audit_progress_event(repo, assignment, attrs)
    end

    typed = mcp_tool(repo, session, "read_work_package_document", %{"document" => "progress.md"})
    [_, branch, pr] = get_in(typed, ["result", "structuredContent", "progress_events"])
    assert branch["payload"]["observation"] == %{"type" => "branch", "source_tool" => "attach_branch", "branch" => "agent/example", "head_sha" => "branch-head"}
    assert pr["payload"]["observation"]["head_sha"] == "pr-head"
    assert pr["payload"]["observation"]["check_summary"] == %{"status" => "success"}
    refute Jason.encode!(typed) =~ "synthetic-private-value"
    refute Jason.encode!(typed) =~ "must-not-leak"

    finding = mcp_tool(repo, session, "read_work_package_document", %{"document" => "findings.md"}) |> get_in(["result", "structuredContent", "findings", Access.at(0)])
    assert finding["sequence"] == 1
    assert finding["idempotency_key"] == "finding-once"
    assert finding["body"] == "Recover the finding body"
  end

  test "native history cursors recover every older row while appends leave the boundary unchanged", %{repo: repo} do
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-PAGED-DOCS", kind: "mcp"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "reader")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    for n <- 1..205 do
      assert {:ok, _} = PlanningRepository.append_progress_event(repo, %{work_package_id: package.id, summary: "Progress #{n}", idempotency_key: "event-#{n}"})
      assert {:ok, _} = PlanningRepository.append_finding(repo, %{work_package_id: package.id, title: "Finding #{n}", body: "Evidence #{n}", idempotency_key: "finding-#{n}"})
      assert {:ok, _} = PlanningRepository.append_artifact(repo, %{work_package_id: package.id, title: "Artifact #{n}", path: "evidence/#{n}"})
    end

    for {document, collection} <- [{"progress.md", "progress_events"}, {"findings.md", "findings"}, {"handoff.md", "artifacts"}] do
      first = mcp_tool(repo, session, "read_work_package_document", %{"document" => document}) |> get_in(["result", "structuredContent"])
      assert Enum.map(first[collection], & &1["sequence"]) == Enum.to_list(106..205)
      assert first["omitted"][collection] == 105
      assert first["next_before_sequence"] == 106

      assert {:ok, _} = PlanningRepository.append_progress_event(repo, %{work_package_id: package.id, summary: "Concurrent append #{document}"})
      if document == "findings.md", do: PlanningRepository.append_finding(repo, %{work_package_id: package.id, title: "Concurrent append", body: document})
      if document == "handoff.md", do: PlanningRepository.append_artifact(repo, %{work_package_id: package.id, title: "Concurrent append", path: document})

      second = mcp_tool(repo, session, "read_work_package_document", %{"document" => document, "before_sequence" => first["next_before_sequence"]}) |> get_in(["result", "structuredContent"])
      assert Enum.map(second[collection], & &1["sequence"]) == Enum.to_list(6..105)
      assert second["omitted"][collection] == 5
      last = mcp_tool(repo, session, "read_work_package_document", %{"document" => document, "before_sequence" => second["next_before_sequence"]}) |> get_in(["result", "structuredContent"])
      assert Enum.map(last[collection], & &1["sequence"]) == Enum.to_list(1..5)
      assert last["omitted"][collection] == 0
      assert last["next_before_sequence"] == nil
      assert length(Enum.uniq_by(last[collection] ++ second[collection] ++ first[collection], & &1["id"])) == 205

      if document == "handoff.md" do
        assert List.last(last["latest_progress"])["summary"] == "Concurrent append handoff.md"
        assert last["acceptance"] == package.acceptance_criteria
      end
    end
  end

  test "native document reads reject unsupported cursors and unauthorized scopes", %{repo: repo} do
    assert {:ok, package} = WorkPackageRepository.create(repo, WorkPackageFactory.attrs(id: "SYMPP-DOC-AUTH", kind: "mcp"))
    assert {:ok, minted} = AccessGrantService.mint_worker_grant(repo, package.id)
    assert {:ok, assignment} = AccessGrantService.claim(repo, minted.work_key.secret, claimed_by: "reader")
    session = MCPHarness.session(assignment, proof_hash: minted.grant.secret_hash)

    for {arguments, reason} <- [
          {%{"document" => "../progress.md"}, "unknown_virtual_file"},
          {%{"document" => "review.md", "before_sequence" => 1}, "unsupported_document_cursor"},
          {%{"document" => "progress.md", "before_sequence" => 0}, "invalid_before_sequence"},
          {%{"document" => "progress.md", "before_sequence" => "1"}, "invalid_before_sequence"}
        ] do
      assert get_in(mcp_tool(repo, session, "read_work_package_document", arguments), ["error", "data", "reason"]) == reason
    end

    sibling = mcp_tool(repo, session, "read_work_package_document", %{"document" => "progress.md", "work_package_id" => "sibling"})
    assert get_in(sibling, ["error", "code"]) == -32_003
    assert get_in(mcp_tool(repo, nil, "read_work_package_document", %{"document" => "progress.md"}), ["error", "code"]) == -32_001
    repo.update_all(AccessGrant, set: [expires_at: DateTime.add(DateTime.utc_now(:microsecond), -1, :second)])
    assert get_in(mcp_tool(repo, session, "read_work_package_document", %{"document" => "progress.md"}), ["error", "data", "reason"]) == "expired"
    assert {:ok, _} = AccessGrantService.revoke(repo, minted.grant.id)
    assert get_in(mcp_tool(repo, session, "read_work_package_document", %{"document" => "progress.md"}), ["error", "data", "reason"]) == "revoked"
  end
end
