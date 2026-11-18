# Phase 5: install and test builds on devices

**Goal:** put a CI build that the tool has linked to a workflow run onto a known device (a phone on
USB or Wi-Fi, an emulator, a simulator) from the web UI or the desktop app, say plainly why an
install cannot work, and keep the evidence (who, which build, which device, result). The tool does
not build or sign, and in v1 it does not manage certificates, profiles or device registration.

**Where it stands:** a proposal only. Nothing is built and nothing has touched a device. The design,
what was read in official documentation, what was not verified and the maintainer's open decisions
are in [ADR 0006](adr/0006-device-install-and-test.md). Phase 5 needs the API tokens and the
build-linking features, which are in progress.

## Shape in five lines

1. A device agent (`mrm-agent`) runs on the machine that has the devices, as a CLI or as a desktop
   sidecar. It pairs once with a code, holds a token that can only do agent work, and only makes
   outbound calls. A hosted server never touches USB.
2. Jobs are a closed set (install, launch, collect logs), run as fixed commands on an artifact whose
   SHA-256 the server recorded at link time. A local policy file the server cannot change limits
   what the agent will install.
3. Android first (`adb`), iOS next (simulator through `simctl`, physical devices through `devicectl`
   on macOS, with a provisioning pre-check read from the IPA).
4. New actions: `devices.read` and `devices.install` for members and up, `devices.manage` for admins
   and up. Every install is audited.
5. TestFlight and Play internal testing remain the sanctioned beta paths.

## Phases and exit gates

A gate needs output from real hardware, which this environment does not have.

- [ ] **P0** Maintainer answers the open decisions that block P1; token and build-linking features
      have landed.
- [ ] **P1 Android and the agent.** Agent package, pairing, device report, job claim, download with
      SHA-256, hardened zip reader, `adb install`, launch, log excerpt, failure classes, emulator,
      manual registry, Devices screen, install picker and progress drawer. **Gate:** a real phone over
      USB and wirelessly and one emulator: install, reinstall, refused and allowed downgrade,
      unauthorized state, signature mismatch, launch, crash excerpt; real `adb` outputs saved as
      fixtures.
- [ ] **P2 iOS on macOS.** `simctl` for simulator builds, `devicectl` for physical devices, the
      provisioning pre-check, read-only App Store Connect device import. **Gate:** Xcode 15 or newer
      and an iPhone on iOS 17 or newer: development and ad hoc IPAs install, the pre-check rejects a
      device outside the profile before any install, Developer Mode off and a locked device are
      recognised; `devicectl` JSON fields and `.ipa` input confirmed.
- [ ] **P3 iOS without a Mac.** A decision, then libimobiledevice or `pymobiledevice3` as external
      programs. **Gate:** a written result for iOS 17 and later, or "Mac only".
- [ ] **P4 Hosted install pages.** `itms-services` over HTTPS for ad hoc and enterprise builds and an
      Android download page, with QR codes and expiring links. **Gate:** a real HTTPS deployment, a
      registered iPhone installing from the QR code, links that expire.
- [ ] **P5 Test runs.** Launch and log evidence, a manual smoke test item on a release plan,
      `test_runs` rows, and the seam for Maestro flows (not built before its own decision on script
      commands). **Gate:** a smoke test ticked with an install job as evidence; a crash on launch
      gives an excerpt.

## Not verified (until someone runs it on a phone)

The `unauthorized` state and all `INSTALL_FAILED_*` texts; wireless debugging on a real network;
`monkey` launching; bundletool's debug keystore lookup and an AAB over a Play-installed copy;
`devicectl` JSON fields, `.ipa` input, minimum iOS and errors; Developer Mode error texts; profile
parsing on real files; `simctl install` and `launch`; `ideviceinstaller` on iOS 17 and later; GitHub
artifact size limits and the `digest` field; the EAS artifact JSON and retention. The full list with
sources is in the ADR.

## Not in this phase

Creating or renewing certificates and profiles, registering devices with Apple, re-signing builds,
building anything, uninstalling apps, and running arbitrary commands on the agent machine.
