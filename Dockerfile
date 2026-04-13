FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 curl ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@latest --activate

# Install uv for Python 3.14 + generated stubs
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh

WORKDIR /app

# Install Python dependencies — UV_PYTHON_INSTALL_DIR keeps Python outside /root/
# so the non-root agent user can access it
COPY pyproject.toml ./
RUN UV_PYTHON_INSTALL_DIR=/opt/uv-python uv sync

# Install Node dependencies (layer cache)
COPY .npmrc pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY agents/package.json agents/
RUN pnpm install --frozen-lockfile

# Copy source
COPY agents/ agents/
COPY python/workspace.py python/
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONPATH="/app/python"

RUN useradd -m -s /bin/bash agent && chown -R agent:agent /app
USER agent

ENTRYPOINT ["pnpm", "--filter", "bitgn-agents", "start"]
