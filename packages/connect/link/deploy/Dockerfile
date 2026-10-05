# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
#
# sx-link, the SlicerX printer hub, for a Linux box that stays on (a Raspberry Pi, a NAS, a home
# server). Build from the repository root:
#
#   docker build -f packages/connect/link/deploy/Dockerfile -t slicerx/sx-link .
#
# Run with the host's network, so the hub can reach printers on the LAN, answer mDNS and keep its
# control socket on the host's loopback (it never listens on the LAN except for the phone listener
# the app turns on). See packages/connect/link/deploy/README.md.

FROM rust:1.98.1-slim-bookworm AS build
WORKDIR /src
COPY . .
RUN cargo build --locked --release -p sx-link \
 && install -m 0755 target/release/sx-link /usr/local/bin/sx-link

FROM debian:bookworm-slim
# bzip2 unpacks Cisco's OpenH264, which the hub downloads into the volume the first time an
# H.264-only camera (Bambu Lab X1, H2) needs a still; libstdc++6 is what that library links.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates bzip2 libstdc++6 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system slicerx \
 && useradd --system --gid slicerx --home-dir /var/lib/slicerx-hub --shell /usr/sbin/nologin slicerx \
 && install -d -m 0700 -o slicerx -g slicerx /var/lib/slicerx-hub
COPY --from=build /usr/local/bin/sx-link /usr/local/bin/sx-link
USER slicerx
VOLUME ["/var/lib/slicerx-hub"]
# Everything the hub keeps (printers, queue, codes, its key, printer credentials in secrets.json,
# the audit log) lives in the volume with mode 0600 files in a 0700 directory.
ENTRYPOINT ["/usr/local/bin/sx-link", "--headless", "--secrets", "file", "--state-dir", "/var/lib/slicerx-hub"]
