# Cataly source-candidate recipe; build from the candidate root. See docs/container.md.
# Ubuntu, not Alpine: the pinned Bun assets need glibc.
FROM ubuntu:24.04

# Binary assets are sha256-verified. Top-level npm packages have exact versions.
# Cataly comes from this build context; native OMP and omp-ulw consume its bound upstream source/overlay locks.
# This recipe has not been built as part of the source port.
# Builds for linux/amd64 and linux/arm64; TARGETARCH is set by the builder.
ARG TARGETARCH
ARG NODE_VERSION=24.21.0
ARG NODE_SHA256_AMD64=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff
ARG NODE_SHA256_ARM64=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5
ARG BUN_VERSION=1.4.4
# GitHub release asset digests for bun-v1.4.4 (see docs/container.md).
ARG BUN_SHA256_AMD64=bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c
ARG BUN_SHA256_ARM64=baa6bb36f51d6e58561e02bbea825038a9df454f673d6d776e8bbf86f8c7850e
ARG HERDR_VERSION=0.9.5
ARG HERDR_SHA256_AMD64=14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d
ARG HERDR_SHA256_ARM64=17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c
ARG AGENT_MESSENGER_VERSION=2.40.0
ARG GH_VERSION=2.100.0
ARG GH_SHA256_AMD64=698c8d88cc19cc92bfe96bad58d10b2a5b274c52433d6dc57799c81f6139d5fc
ARG GH_SHA256_ARM64=33ccd2ad7ce639c927e1cb209e36555b0e1fbb89f7a38239c0568040ec758612
# Optional terminal tooling for adapter QA: none, hc (herdr-core), or herdr.
ARG TERMINAL_BACKEND=none
ARG HC_VERSION=0.1.18
ARG HC_SHA256_AMD64=5b2f97cb4b2a9d7a6b2cc5942628203ed9fbb7cc0c2b4b09ad8a6f5648e246b7
ARG HC_SHA256_ARM64=cf33393cf950bb763734dc3e16610ab9daf8492391a4ef0de56026cd7f752853

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl git unzip jq ripgrep procps openssh-client \
    && rm -rf /var/lib/apt/lists/*

# gh, node, bun and optional terminal tooling: pinned per-arch assets, each sha256-verified.
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) NODE_ASSET=x64;    HERDR_ASSET=x86_64;  BUN_ASSET=x64;    GH_ASSET=amd64; \
             NODE_SHA256="${NODE_SHA256_AMD64}"; HERDR_SHA256="${HERDR_SHA256_AMD64}"; \
             BUN_SHA256="${BUN_SHA256_AMD64}";   GH_SHA256="${GH_SHA256_AMD64}"; \
             HC_SHA256="${HC_SHA256_AMD64}" ;; \
      arm64) NODE_ASSET=arm64;   HERDR_ASSET=aarch64; BUN_ASSET=aarch64; GH_ASSET=arm64; \
             NODE_SHA256="${NODE_SHA256_ARM64}"; HERDR_SHA256="${HERDR_SHA256_ARM64}"; \
             BUN_SHA256="${BUN_SHA256_ARM64}";   GH_SHA256="${GH_SHA256_ARM64}"; \
             HC_SHA256="${HC_SHA256_ARM64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o /tmp/gh.deb \
      "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${GH_ASSET}.deb" \
    && echo "${GH_SHA256}  /tmp/gh.deb" | sha256sum -c - \
    && dpkg -i /tmp/gh.deb && rm /tmp/gh.deb && \
    curl -fsSL -o /tmp/node.tar.gz \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NODE_ASSET}.tar.gz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
    && tar -xz -C /usr/local --strip-components=1 -f /tmp/node.tar.gz && rm /tmp/node.tar.gz && \
    curl -fsSL -o /tmp/bun.zip \
      "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${BUN_ASSET}.zip" \
    && echo "${BUN_SHA256}  /tmp/bun.zip" | sha256sum -c - \
    && unzip -j -o /tmp/bun.zip "*/bun" -d /usr/local/bin && rm /tmp/bun.zip \
    && chmod +x /usr/local/bin/bun && ln -sf /usr/local/bin/bun /usr/local/bin/bunx && \
    case "${TERMINAL_BACKEND}" in \
      none) ;; \
      hc) \
        curl -fsSL -o /tmp/hc.tar.gz \
          "https://releases.herdr.dev/core/${HC_VERSION}/herdr-core-linux-${HERDR_ASSET}.tar.gz" \
        && echo "${HC_SHA256}  /tmp/hc.tar.gz" | sha256sum -c - \
        && tar -xz -C /usr/local/bin -f /tmp/hc.tar.gz herdr-core && rm /tmp/hc.tar.gz \
        && chmod +x /usr/local/bin/herdr-core && ln -sf herdr-core /usr/local/bin/hc ;; \
      herdr) \
        curl -fsSL -o /usr/local/bin/herdr \
          "https://github.com/herdrdev/herdr/releases/download/v${HERDR_VERSION}/herdr-linux-${HERDR_ASSET}" \
        && echo "${HERDR_SHA256}  /usr/local/bin/herdr" | sha256sum -c - \
        && chmod +x /usr/local/bin/herdr ;; \
      *) echo "unsupported TERMINAL_BACKEND: ${TERMINAL_BACKEND}" >&2; exit 1 ;; \
    esac

# bun global packages install their launchers into $BUN_INSTALL/bin
ENV BUN_INSTALL=/usr/local

# The messenger stays a published npm package; OMP is the bound source toolchain below.
RUN bun install -g agent-messenger@${AGENT_MESSENGER_VERSION}

# .dockerignore admits source inputs only; no host state, credentials or node_modules.
COPY . /opt/omp-cataly
RUN set -eu; \
    bun install --frozen-lockfile --cwd /opt/omp-cataly \
    && bun install --frozen-lockfile --cwd /opt/omp-cataly/skills/cataly-mode/scripts \
    && bun install --frozen-lockfile --cwd /opt/omp-cataly/extension \
    && printf '#!/bin/sh\nexec bun /opt/omp-cataly/skills/cataly-mode/scripts/src/cli.ts "$@"\n' > /usr/local/bin/cataly \
    && printf '#!/bin/sh\nexec bun /opt/omp-cataly/src/cli.ts "$@"\n' > /usr/local/bin/cataly-harness \
    && chmod +x /usr/local/bin/cataly /usr/local/bin/cataly-harness
RUN ln -s /opt/omp-cataly/scripts/consumer/omp /usr/local/bin/omp

# run as a normal user; all state lives in the volumes named in compose.yaml
# the state dirs are pre-created with cataly ownership so fresh named volumes inherit it
# If hc was requested, notes = false prevents it from typing into a parent agent on its own.
RUN useradd -m -s /bin/bash cataly \
    && mkdir -p /home/cataly/projects /home/cataly/.cataly /home/cataly/.omp/agent/extensions \
      /home/cataly/.agents/skills /home/cataly/.config/gh /home/cataly/.config/agent-messenger \
    && ln -s /opt/omp-cataly/skills/cataly-mode /home/cataly/.agents/skills/cataly-mode \
    && ln -s /opt/omp-cataly/extension /home/cataly/.omp/agent/extensions/omp-cataly \
    && if [ "${TERMINAL_BACKEND}" = hc ]; then \
         mkdir -p /home/cataly/.config/herdr-core \
         && echo 'notes = false' > /home/cataly/.config/herdr-core/config.toml; \
       fi \
    && chown -R cataly:cataly /home/cataly /opt/omp-cataly

USER cataly
WORKDIR /home/cataly
ENV HOME=/home/cataly CATALY_TELEMETRY=0
RUN set -eu; \
    bun /opt/omp-cataly/scripts/source-dependencies.ts native /opt/omp-cataly /home/cataly >/dev/null; \
    ulw="$(bun /opt/omp-cataly/scripts/source-dependencies.ts ulw /opt/omp-cataly /home/cataly)"; \
    ln -s "$ulw" /home/cataly/.cataly/omp-ulw

# The image starts no runtime server or session. Interactive commands can use docker compose exec.
CMD ["sleep", "infinity"]
