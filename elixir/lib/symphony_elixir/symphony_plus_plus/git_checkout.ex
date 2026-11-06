defmodule SymphonyElixir.SymphonyPlusPlus.GitCheckout do
  @moduledoc false

  # The factory keeps private state under umask 0077. Only Git processes that
  # materialize source use ordinary checkout permissions; the VM is unchanged.
  @spec run(String.t(), [String.t()]) :: {String.t(), non_neg_integer()}
  def run(git, args) do
    case :os.type() do
      {:unix, _} ->
        System.cmd("sh", ["-c", "umask 022; exec \"$@\"", "sympp-git", git | args], stderr_to_stdout: true)

      _ ->
        System.cmd(git, args, stderr_to_stdout: true)
    end
  end
end
