# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# sx-cloud image. Build from the repository root so the Cargo workspace is in
# the context:
#   docker build -f editions/slicerx/packages/cloud/service/Dockerfile -t sx-cloud .
# Dockerfile.dockerignore next to this file keeps node_modules, target and media out.
FROM rust:1.98.1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --release --locked -p sx-cloud

FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 10001 --no-create-home sxcloud
COPY --from=build /src/target/release/sx-cloud /usr/local/bin/sx-cloud
USER sxcloud
# Mount the resolved edition config and pass SLICERX_CONFIG; the service role
# key comes from the deployment's secret store as SX_CLOUD_SERVICE_KEY.
ARG COMMIT=main
ENV SX_CLOUD_BIND=0.0.0.0:8787 \
    SX_CLOUD_COMMIT=$COMMIT \
    SLICERX_CONFIG=/etc/slicerx/config.json
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/sx-cloud"]
