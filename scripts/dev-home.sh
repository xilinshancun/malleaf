#!/usr/bin/env bash

default_dev_paseo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

resolve_dev_daemon_endpoint() {
  echo "${PASEO_LISTEN/127.0.0.1:/localhost:}"
}

configure_dev_paseo_home() {
  local script_root dev_root environment
  script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
  dev_root="$script_root"
  cd "$script_root" || return 1
  # Validate paths before mkdir/config writes. The helper emits quoted values.
  environment="$(node --conditions=source --import "$script_root/node_modules/tsx/dist/loader.mjs" "$script_root/scripts/malleaf/development-environment.mts" "$dev_root" --prepare "$@")" || return 1
  eval "$environment"
}

configure_dev_command_env() {
  configure_dev_paseo_home
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  configure_dev_command_env || exit 1
  if [ "$#" -gt 0 ]; then
    exec "$@"
  fi
fi
