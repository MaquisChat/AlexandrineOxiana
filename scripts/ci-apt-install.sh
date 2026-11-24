#!/usr/bin/env bash
# Installs apt packages on a CI runner without depending on one Ubuntu mirror.
#
# Usage: bash scripts/ci-apt-install.sh [apt options, e.g. --no-install-recommends] <packages...>
#
# What was seen (17-18 November 2026): the runner's mirror (us-east-2.ec2.archive.ubuntu.com) answered
# `apt-get update` and then stalled on the packages; the step hit its time limit and three of four runs
# were lost (a healthy run fetches the same 134 MB in 15 seconds). Earlier (11 November) the Ubuntu
# names did not resolve at all.
#
# So: the download is done on its own, with a time limit (stopping apt while it only downloads is safe;
# stopping it while it unpacks is not). If the download fails or is too slow, the Ubuntu mirrors in the
# apt sources are replaced by mirrors.edge.kernel.org for this run, and the download is tried a second time.
# If that also fails or is too slow, the same is done with Ubuntu's own archive (archive.ubuntu.com).
# Only then are the packages installed, from what was downloaded.
#
# What was seen (23-24 November 2026): the runners' mirror and mirrors.edge.kernel.org both lacked, for
# more than nine hours, a package file (libssh 0.10.6-2ubuntu0.6) that Ubuntu's own archive had and that
# every index named: `404 Not Found` on both tries, and every run on such a runner failed. So a third
# try, from archive.ubuntu.com, was added.
#
# Packages are still verified against Ubuntu's signing keys, so another mirror cannot substitute anything.
set -euo pipefail

APT_OPTS=(-o Acquire::Retries=3 -o Acquire::http::Timeout=20)

if [ -n "${CI_APT_SOURCE_FILES:-}" ]; then
  # shellcheck disable=SC2206
  FILES=($CI_APT_SOURCE_FILES)
else
  shopt -s nullglob
  FILES=(/etc/apt/apt-mirrors.txt /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list)
fi

use_other_mirror() {
  echo "::warning::$1; using mirrors.edge.kernel.org for this run."
  local f
  for f in "${FILES[@]}"; do
    if [ -f "$f" ]; then
      sudo sed -i -E 's#https?://([a-z0-9-]+\.)*(archive|security)\.ubuntu\.com/ubuntu/?#https://mirrors.edge.kernel.org/ubuntu/#g' "$f"
    fi
  done
}

use_primary_archive() {
  echo "::warning::$1; using archive.ubuntu.com (Ubuntu's own archive) for this run."
  local f
  for f in "${FILES[@]}"; do
    if [ -f "$f" ]; then
      sudo sed -i -E 's#https://mirrors\.edge\.kernel\.org/ubuntu/?#http://archive.ubuntu.com/ubuntu/#g' "$f"
    fi
  done
}

if ! getent hosts azure.archive.ubuntu.com >/dev/null; then
  use_other_mirror "Ubuntu's package mirrors do not resolve on this runner"
fi

sudo apt-get update "${APT_OPTS[@]}"

if ! sudo timeout "${CI_APT_FIRST_TRY_SECONDS:-120}" apt-get install -y --download-only "${APT_OPTS[@]}" "$@"; then
  use_other_mirror "The runner's package mirror failed or was too slow"
  sudo apt-get update "${APT_OPTS[@]}"
  if ! sudo timeout "${CI_APT_SECOND_TRY_SECONDS:-300}" apt-get install -y --download-only "${APT_OPTS[@]}" "$@"; then
    use_primary_archive "The fallback mirror mirrors.edge.kernel.org also failed or was too slow"
    sudo apt-get update "${APT_OPTS[@]}"
    sudo timeout "${CI_APT_THIRD_TRY_SECONDS:-300}" apt-get install -y --download-only "${APT_OPTS[@]}" "$@"
  fi
fi

sudo apt-get install -y "${APT_OPTS[@]}" "$@"
