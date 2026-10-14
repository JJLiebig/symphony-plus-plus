Code.require_file("../../../support/symphony_plus_plus/mcp_case.exs", __DIR__)

defmodule SymphonyElixir.SymphonyPlusPlus.MCP.LocalTrustedCommentToolsTest do
  use SymphonyElixir.SymphonyPlusPlus.MCPCase

  test "trusted local comments remain unavailable outside local MCP", %{repo: repo} do
    work_request = create_work_request!(repo, id: "WR-MCP-LOCAL-OPERATOR-COMMENT-LIST-DENIED")

    stdio_list_response =
      Server.handle(
        %{
          "jsonrpc" => "2.0",
          "id" => "stdio-local-operator-list-comments",
          "method" => "tools/call",
          "params" => %{
            "name" => "list_comments",
            "arguments" => %{"target_kind" => "work_request", "target_id" => work_request.id}
          }
        },
        Server.new(Config.default(repo: repo), initialized: true)
      )

    assert get_in(stdio_list_response, ["error", "code"]) == -32_001
    assert get_in(stdio_list_response, ["error", "data", "reason"]) == "claim_required"
    assert get_in(stdio_list_response, ["error", "data", "action"]) == "claim_local_architect_assignment"
  end

  defp list_package_comments(server, work_package_id, target_id, request_id) do
    Server.handle(
      %{
        "jsonrpc" => "2.0",
        "id" => request_id,
        "method" => "tools/call",
        "params" => %{
          "name" => "list_comments",
          "arguments" => %{"work_package_id" => work_package_id, "target_kind" => "work_package", "target_id" => target_id}
        }
      },
      server
    )
  end
end
