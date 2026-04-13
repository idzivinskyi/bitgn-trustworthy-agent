-include .env
export

BENCHMARK_HOST   ?= https://api.bitgn.com
BENCHMARK_ID     ?= bitgn/pac1-dev
IMAGE            := bitgn-agent

NODE_MODULES     := node_modules/.pnpm/lock.yaml

.PHONY: install install-python typecheck-agents lint build run

$(NODE_MODULES): pnpm-workspace.yaml $(wildcard */package.json)
	pnpm install
	@touch $@

install-python:
	uv sync

install: $(NODE_MODULES) install-python

typecheck-agents: $(NODE_MODULES)
	pnpm --filter bitgn-agents typecheck

lint: typecheck-agents

build:
	docker build -t $(IMAGE) .

run: build
	@mkdir -p runs
	@logfile="runs/$$(date +%Y%m%d-%H%M%S).log"; \
	args=""; \
	[ -n "$(MODEL)" ] && args="$$args --model $(MODEL)"; \
	[ -n "$(MAX_ITERATIONS)" ] && args="$$args --max-iterations $(MAX_ITERATIONS)"; \
	[ -n "$(MAX_TOKENS)" ] && args="$$args --max-tokens $(MAX_TOKENS)"; \
	[ -n "$(CONCURRENCY)" ] && args="$$args --concurrency $(CONCURRENCY)"; \
	[ -n "$(SUBMIT)" ] && args="$$args --submit"; \
	[ -n "$(TASKS)" ] && args="$$args $(TASKS)"; \
	docker_opts="--rm"; \
	[ -f .env ] && docker_opts="$$docker_opts --env-file .env"; \
	docker_opts="$$docker_opts -e BENCHMARK_HOST=$(BENCHMARK_HOST) -e BENCHMARK_ID=$(BENCHMARK_ID) -e RUN_LOGFILE=$$logfile"; \
	[ -n "$(LOG_LEVEL)" ] && docker_opts="$$docker_opts -e LOG_LEVEL=$(LOG_LEVEL)"; \
	docker_opts="$$docker_opts -v $(PWD)/runs:/app/runs"; \
	echo "Logging to $$logfile"; \
	docker run $$docker_opts $(IMAGE) $$args 2>&1 | tee "$$logfile"
