FROM node:22-bookworm AS node

FROM ubuntu:24.04

COPY --from=node /usr/local/ /usr/local/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        ca-certificates \
        clang \
        cmake \
        curl \
        fuse \
        git \
        libayatana-appindicator3-dev \
        libgtk-3-dev \
        libnspr4 \
        libnss3 \
        libfuse2 \
        libpipewire-0.3-dev \
        librsvg2-dev \
        libwebkit2gtk-4.1-dev \
        pkg-config \
        rsync \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

ENV HUTCH_HOME=/opt/hutch
RUN git config --system --add safe.directory /work
RUN installer="$(mktemp)" \
    && curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
        https://hutch.blackboard.sh/hutch/install.sh \
        --output "$installer" \
    && sh "$installer" --channel production --no-modify-path \
    && rm -f "$installer"

ENV PATH="/opt/hutch/bin:${PATH}"
WORKDIR /work

CMD ["bash", "-c", "cp -a /source/. /work/ && cd package && hutch run install && hutch build:dev && hutch check:release && cd ../npm/electrobun && node --test test/bootstrap.test.mjs test/package.test.mjs ../scripts/accept-published-bootstrap.test.mjs ../scripts/check-published-bootstrap.test.mjs && npm pack --dry-run --ignore-scripts"]
