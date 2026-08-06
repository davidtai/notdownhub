# notdownhub fleet runner — joins a hub and executes GitHub Actions jobs.
# Build:  docker build -t ndh-runner docker/runner
# Run:    docker run -d --restart unless-stopped \
#           -e NDH_HUB_URL=http://hub-host:4949 -e NDH_TOKEN=<registration-token> \
#           -e NDH_NAME=my-docker-runner -e NDH_LABELS=self-hosted,linux,ARM64,docker \
#           ndh-runner
FROM node:22-bookworm

ARG RUNNER_SERVER_VERSION=3.14.0

RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates jq unzip \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable

RUN useradd -m runner
WORKDIR /home/runner/ndh

# dpkg arch (arm64/amd64) instead of BuildKit's TARGETARCH: works with the legacy builder too.
RUN ARCH=$([ "$(dpkg --print-architecture)" = "arm64" ] && echo arm64 || echo x64) \
    && curl -fsSL -o /tmp/rs.tar.gz "https://github.com/ChristopherHX/runner.server/releases/download/v${RUNNER_SERVER_VERSION}/runner.server-linux-${ARCH}.tar.gz" \
    && mkdir -p bin && tar -xzf /tmp/rs.tar.gz -C bin && rm /tmp/rs.tar.gz \
    && chown -R runner:runner /home/runner

COPY entrypoint.sh /entrypoint.sh
RUN chmod 755 /entrypoint.sh
USER runner
ENTRYPOINT ["/entrypoint.sh"]
