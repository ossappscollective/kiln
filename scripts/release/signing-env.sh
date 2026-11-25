# shellcheck shell=bash
# Source this in the desktop build step (`. scripts/release/signing-env.sh`), do not execute it.
#
# Secrets reach the step as environment variables, empty when the secret is not set. An empty
# APPLE_* variable can still make the Tauri bundler try to sign, so this unsets every variable
# that is not part of a complete set. It never prints a value, only which stage was reached.
#
# Sets KILN_SIGNING_STATE to: unsigned (macOS: signed ad hoc with identity "-") | signed | notarized (macOS), signed | unsigned (Windows,
# from KILN_WINDOWS_THUMBPRINT, which an earlier step sets after importing the certificate),
# unsigned (Linux: packages are not signed).

kiln_apple_vars="APPLE_CERTIFICATE APPLE_CERTIFICATE_PASSWORD APPLE_SIGNING_IDENTITY APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID"
KILN_SIGNING_STATE=unsigned

case "${RUNNER_OS:-}" in
  macOS)
    if [ -n "${APPLE_CERTIFICATE:-}" ] && [ -n "${APPLE_CERTIFICATE_PASSWORD:-}" ] && [ -n "${APPLE_SIGNING_IDENTITY:-}" ]; then
      if [ -n "${APPLE_ID:-}" ] && [ -n "${APPLE_PASSWORD:-}" ] && [ -n "${APPLE_TEAM_ID:-}" ]; then
        KILN_SIGNING_STATE=notarized
      else
        KILN_SIGNING_STATE=signed
        unset APPLE_ID APPLE_PASSWORD APPLE_TEAM_ID
      fi
    else
      # shellcheck disable=SC2086
      unset $kiln_apple_vars
      # No certificate: sign ad hoc ("-"). Apple Silicon refuses code with no signature at all
      # ("Kiln is damaged and can't be opened", even after right-click Open); an ad-hoc signature
      # makes the app launchable once Gatekeeper is told to allow it (see the release notes).
      # The state stays "unsigned": nothing identifies a developer.
      export APPLE_SIGNING_IDENTITY=-
    fi
    ;;
  Windows)
    # shellcheck disable=SC2086
    unset $kiln_apple_vars
    if [ -n "${KILN_WINDOWS_THUMBPRINT:-}" ]; then KILN_SIGNING_STATE=signed; fi
    ;;
  *)
    # shellcheck disable=SC2086
    unset $kiln_apple_vars
    ;;
esac
export KILN_SIGNING_STATE
unset kiln_apple_vars

echo "Code signing: ${KILN_SIGNING_STATE}"
if [ "$KILN_SIGNING_STATE" = unsigned ] && [ "${RUNNER_OS:-}" != Linux ]; then
  echo "::notice::No complete signing credentials: building an unsigned ${RUNNER_OS:-} app. See docs/releasing.md."
fi
