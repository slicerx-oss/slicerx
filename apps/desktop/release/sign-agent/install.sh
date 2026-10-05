#!/bin/zsh
# SPDX-License-Identifier: Apache-2.0
# Copyright (C) 2026 The SlicerX contributors
# Installs the sign-mac LaunchAgent for the current user, in the desktop session. No sudo, no reboot.
#   zsh install.sh              install and load
#   zsh install.sh --remove     unload and remove
set -euo pipefail
here=${0:A:h}
label=dev.suby.sign-mac
plist=$HOME/Library/LaunchAgents/$label.plist
uid=$(id -u)
if [[ ${1:-} == --remove ]]; then
  launchctl bootout gui/$uid "$plist" 2>/dev/null || true
  rm -f "$plist" "$HOME/bin/sign-mac-agent" "$HOME/bin/sign-mac-request"
  print "removed. Requests and results stay in ~/Library/Application Support/sign-mac"
  exit 0
fi
mkdir -p "$HOME/bin" "$HOME/Library/LaunchAgents" "$HOME/Library/Application Support/sign-mac/requests" "$HOME/Library/Application Support/sign-mac/results"
cp "$here/sign-mac-agent" "$here/sign-mac-request" "$HOME/bin/"
cp "$here/../../../../scripts/sign-mac" "$HOME/bin/sign-mac"
chmod +x "$HOME/bin/sign-mac-agent" "$HOME/bin/sign-mac-request" "$HOME/bin/sign-mac"
sed "s#__HOME__#$HOME#g" "$here/$label.plist" > "$plist"
plutil -lint "$plist" > /dev/null
launchctl bootout gui/$uid "$plist" 2>/dev/null || true
launchctl bootstrap gui/$uid "$plist"
print "loaded $label. Test: sign-mac-request ~/builds/<something>.app"
