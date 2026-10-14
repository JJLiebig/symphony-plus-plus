.PHONY: help all setup deps build static fmt fmt-check lint assets-check test ci ci-prepare ci-fast ci-static ci-test ci-dialyzer ci-full dialyzer e2e

MIX ?= mix
QUIET ?= 1
MAKEFLAGS += --no-print-directory
GATE_LOG_ROOT ?= _build/make-logs
CI_DIALYZER_FLAGS ?= --format short --no-compile --no-check

ifeq ($(OS),Windows_NT)
GATE_RUN_ID := $(or $(GATE_RUN_ID),$(shell powershell.exe -NoProfile -Command "([guid]::NewGuid().ToString('N')).Substring(0, 12)"))
else
GATE_RUN_ID := $(or $(GATE_RUN_ID),$(shell date +%Y%m%d%H%M%S))
endif

GATE_LOG_DIR ?= $(GATE_LOG_ROOT)/$(GATE_RUN_ID)

ifeq ($(VERBOSE),1)
QUIET := 0
endif

ifeq ($(OS),Windows_NT)
define run_ci_step
	@powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal'; New-Item -ItemType Directory -Force -Path '$(GATE_LOG_DIR)' | Out-Null; $$label = '$(1)'; $$command = '$(2)'; if ('$(QUIET)' -eq '0') { Write-Output ('==> ' + $$label); cmd.exe /d /s /c $$command; exit $$LASTEXITCODE } else { $$log = '$(GATE_LOG_DIR)/$(1).log'; Write-Output ('==> ' + $$label); cmd.exe /d /s /c $$command > $$log 2>&1; $$status = $$LASTEXITCODE; if ($$null -eq $$status) { $$status = 1 }; if ($$status -eq 0) { Write-Output ('ok  ' + $$label + ' (log: ' + $$log + ')') } else { Write-Output ('fail ' + $$label + ' (exit ' + $$status + ', log: ' + $$log + ')'); Get-Content -LiteralPath $$log; exit $$status } }"
endef
else
define run_ci_step
	@mkdir -p "$(GATE_LOG_DIR)"
	@if [ "$(QUIET)" = "0" ]; then \
		printf '==> %s\n' "$(1)"; \
		$(2); \
	else \
		log="$(GATE_LOG_DIR)/$(1).log"; \
		printf '==> %s\n' "$(1)"; \
		{ $(2); } > "$$log" 2>&1; \
		status=$$?; \
		if [ $$status -eq 0 ]; then \
			printf 'ok  %s (log: %s)\n' "$(1)" "$$log"; \
		else \
			printf 'fail %s (exit %s, log: %s)\n' "$(1)" "$$status" "$$log"; \
			printf '%s\n' "--- $(1) log start ---"; \
			cat "$$log"; \
			printf '%s\n' "--- $(1) log end ---"; \
			exit $$status; \
		fi; \
	fi
endef
endif

help:
	@echo Targets: setup, deps, build, static, fmt, fmt-check, lint, assets-check, test, dialyzer, e2e
	@echo CI targets: ci-fast, ci-static, ci-test, ci-dialyzer, ci-full
	@echo make all is quiet by default. Logs are written under $(GATE_LOG_ROOT). Use VERBOSE=1 for streamed output.
	@echo make all runs static and retained qualification. Use make ci-full to include Dialyzer.

setup:
	@$(MIX) setup

deps:
	@$(MIX) deps.get

build:
	@$(MIX) build

static:
	@$(MIX) static

fmt:
	@$(MIX) format

fmt-check:
	@$(MIX) format --check-formatted

lint:
	@$(MIX) lint

assets-check:
	@cd assets && npm run quality

test:
	@$(MIX) test

dialyzer:
	@$(MIX) dialyzer --format short

e2e:
	@SYMPHONY_RUN_LIVE_E2E=1 $(MIX) test test/symphony_elixir/live_e2e_test.exs

ci-prepare:
	$(call run_ci_step,setup,$(MIX) setup)
	$(call run_ci_step,build,$(MIX) build)

ci-static: ci-prepare
	$(call run_ci_step,static,$(MIX) static)

ci-test: ci-prepare
	$(call run_ci_step,test,$(MIX) test --max-cases 4)

ci-dialyzer: ci-prepare
	$(call run_ci_step,dialyzer-plt,$(MIX) dialyzer --plt)
	$(call run_ci_step,dialyzer,$(MIX) dialyzer $(CI_DIALYZER_FLAGS))

ci-fast: ci-prepare
	$(call run_ci_step,static,$(MIX) static)
	$(call run_ci_step,test,$(MIX) test --max-cases 4)

ci-full: ci-prepare
	$(call run_ci_step,static,$(MIX) static)
	$(call run_ci_step,test,$(MIX) test --max-cases 4)
	$(call run_ci_step,dialyzer-plt,$(MIX) dialyzer --plt)
	$(call run_ci_step,dialyzer,$(MIX) dialyzer $(CI_DIALYZER_FLAGS))

ci: ci-fast

all: ci-fast
