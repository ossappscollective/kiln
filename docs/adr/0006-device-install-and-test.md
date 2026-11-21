# ADR 0006: Install and test builds on devices

Status: proposed. Documentation only: no code, table or route exists for any of this. Everything
under "What was verified" was read on 2026-11-18 from the pages linked there; nothing was run
against a phone, an emulator, a simulator or Xcode (this environment has none).

The request that started this ADR (from the maintainer): "add a feature to install/test builds on
devices (like auto install bundle/ipa on connected/known device)".

## Context

The tool does not build or sign ([architecture.md](../architecture.md)); GitHub Actions or EAS does,
and the planned build-linking feature ties a store build to the workflow run (and so the commit)
that made it. The next question a team asks after "which run made build 241?" is "put it on my
phone". Today that is a manual download, an unzip and an `adb install` or an Xcode drag.

Three facts shape the design:

1. **A hosted server cannot reach a USB cable.** A person with an Android phone on the desk and a
   server in a data center needs a small program on the desk side that the server can send work to.
   The desktop app (Tauri shell plus a local server, [ADR 0003](0003-single-user-mode.md),
   [ADR 0004](0004-desktop-sidecar.md)) is the same problem with a shorter wire.
2. **Installing is running someone's code on a device.** Whoever can make the install happen can
   put arbitrary software on a phone that holds the tester's accounts. The design has to say what a
   compromised server, a poisoned CI artifact or a malicious pull request can and cannot do.
3. **iOS decides, not us.** A physical iPhone only runs an IPA whose provisioning profile includes
   its UDID (or an enterprise profile), with Developer Mode on. The tool will not manage
   certificates, profiles or device registration in v1. It can explain why an install will fail,
   and it can do the parts that need no signing work (simulator builds, builds already signed for
   the device).

## Decision (summary)

1. **A device agent, `mrm-agent`**, in a new package that runs as a **separate process** on the
   machine that has the devices: as a standalone Node CLI, or as a second sidecar of the desktop
   app. It only makes **outbound** HTTPS calls, pairs once with a code, and then holds a token that
   can do nothing except `devices.agent` actions. Same protocol on the desktop and on a headless
   Mac mini; the hosted server never touches USB.
2. **A fixed set of operations**, never a command channel: `list_devices` (reported by the agent),
   `install`, `launch`, `collect_logs`. Each is a fixed argv template with validated arguments, run
   without a shell, on an artifact of a **linked build** whose SHA-256 the server recorded at link
   time. The agent also has a local policy file that the server cannot change.
3. **Android first** with `adb` (APK, split APKs, emulators); an AAB goes through `bundletool` as a
   later, optional step. **iOS second**: the simulator through `simctl`, physical devices through
   `devicectl` on macOS, with a **provisioning pre-check** read from the IPA before anything is sent.
   Non-Mac iOS (libimobiledevice and friends) is a separate, later decision.
4. **No signing management in v1.** No certificate, profile or device registration writes. Read-only
   App Store Connect device listing is allowed as a registry source.
5. **TestFlight and Play internal testing stay the sanctioned beta paths**; this feature is for
   "this exact CI build on this exact device, now", for the people who build it.
6. **Roles:** `devices.read` and `devices.install` for member and up; `devices.manage` (pair or
   revoke agents, edit the registry and policy) for admin and up. Every install is audited.

Reasons are in the sections below; the maintainer's open decisions are at the end.

## What was verified, and what was not

Method: `WebFetch` and `WebSearch` against official pages. The fetch tool returns a **summary made by
a small model**, and for long pages only the first part (about 100,000 characters); several Apple
pages render with JavaScript and were read through their `.md` or `tutorials/data` forms. Where a
summary said "not on the page", that is recorded as not verified, not as false. Quotes below are as
the tool returned them.

### Android

| Claim                                                                                                                                                                                                                                                                                                                                                                                                               | Status                                                                                                                                                                                                   | Source                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adb install path_to_apk`; "You must use the `-t` option with the `install` command when you install a test APK."                                                                                                                                                                                                                                                                                                   | Verified                                                                                                                                                                                                 | https://developer.android.com/tools/adb                                                                                                                                             |
| `pm install` options `-r` ("Reinstall an existing app, keeping its data."), `-d` ("Allow version code downgrade."), `-t`, `-g` ("Grant all permissions listed in the app manifest."), `--user user_id`, `-i installer_package_name`, `--install-location`                                                                                                                                                           | Verified (listed under the package manager, run through `adb shell pm install`; the page does not list the `adb install` flag set separately)                                                            | same                                                                                                                                                                                |
| `install-multiple` exists for several APKs of one app, "useful if you download all the APKs for a specific device for your app from the Play Console"                                                                                                                                                                                                                                                               | Verified; its syntax and flags were not on the visible part of the page                                                                                                                                  | same                                                                                                                                                                                |
| `adb -s <serial> install ...`; `$ANDROID_SERIAL`; "adb: more than one device/emulator" without a target; `-e` and `-d` select emulator or hardware device                                                                                                                                                                                                                                                           | Verified                                                                                                                                                                                                 | same                                                                                                                                                                                |
| Device states `offline`, `device`, `no device`                                                                                                                                                                                                                                                                                                                                                                      | Verified. `unauthorized` is **not** on the fetched part of the page (the page mentions the RSA key dialog); it is well known from use and must be confirmed on a phone                                   | same                                                                                                                                                                                |
| Emulator serials `emulator-5554`, `emulator-5556`; network devices appear as `ip:port`                                                                                                                                                                                                                                                                                                                              | Verified                                                                                                                                                                                                 | same                                                                                                                                                                                |
| Wireless debugging: Android 11 (API 30) or higher for phones, same network, "adb pair ipaddr:port" with the pairing code shown on the device, "You only need to pair once", authorization can be revoked on the device ("Revoke adb debugging authorizations")                                                                                                                                                      | Verified                                                                                                                                                                                                 | https://developer.android.com/tools/adb#wireless-android11-command-line                                                                                                             |
| After pairing, the current page says the device and workstation "connect automatically" through mDNS discovery (needs `adb server-status` with `mdns_enabled: true`, adb 37.0.0 or newer for the new Wi-Fi mode); it does **not** document a manual `adb connect` for Android 11+. Older docs and common practice use `adb connect ip:port`.                                                                        | Verified as the page's text; behaviour on a real network (mDNS is often blocked) unverified                                                                                                              | same                                                                                                                                                                                |
| `am start -n com.example.app/.ExampleActivity`, `-W` ("Wait for launch to complete"), `pm list packages`, `pm uninstall`                                                                                                                                                                                                                                                                                            | Verified                                                                                                                                                                                                 | https://developer.android.com/studio/command-line/adb#am                                                                                                                            |
| `adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1` to launch without knowing the activity                                                                                                                                                                                                                                                                                                        | **Not verified**: not on the fetched part of the page. Common practice.                                                                                                                                  | n/a                                                                                                                                                                                 |
| `adb logcat` is shorthand for `adb shell logcat`; filter specs `tag:priority` such as `MyApp:D *:S`; buffers `-b main,system,crash,all`; `-v` formats; the page's example `adb logcat -b all -v color -d`                                                                                                                                                                                                           | Verified. `-d` (dump and exit), `-t N` and `--pid` are not explained on the page                                                                                                                         | https://developer.android.com/tools/logcat                                                                                                                                          |
| `bundletool build-apks --connected-device --bundle=... --output=....apks`; `--device-id` when several devices are connected; `--mode=universal`; `--device-spec` / `get-device-spec`; `bundletool install-apks --apks=...`; `--local-testing`                                                                                                                                                                       | Verified                                                                                                                                                                                                 | https://developer.android.com/tools/bundletool                                                                                                                                      |
| Signing of the generated APKs: the docs say "If you don't specify signing information, `bundletool` attempts to sign your APKs with a debug key for you." The source says: "Try to use debug keystore if present", prints "The APKs will be signed with the debug keystore found at ..." and otherwise warns "The APKs won't be signed and thus not installable unless you also pass a keystore via the flag --ks." | Verified from the docs and from `BuildApksCommand.java` (the helper that finds the keystore, `DebugKeystoreUtils`, was not in the fetched text, so the exact path the tool looks in is **not verified**) | https://developer.android.com/tools/bundletool and https://github.com/google/bundletool/blob/master/src/main/java/com/android/tools/build/bundletool/commands/BuildApksCommand.java |
| Android Studio creates the debug keystore in `$HOME/.android/debug.keystore`; apps signed with the debug certificate are not accepted by Google Play                                                                                                                                                                                                                                                                | Verified (Studio's behaviour, not bundletool's lookup)                                                                                                                                                   | https://developer.android.com/studio/publish/app-signing#debug-mode                                                                                                                 |
| What an AAB needs: the docs say to sign the bundle with `jarsigner`, not `apksigner`; they list no other requirement. An AAB's own signature is not what the installed APKs carry (bundletool signs the APKs).                                                                                                                                                                                                      | Partly verified; the "needs Java and the bundletool jar on the agent machine" part is from the tool's nature, not a fetched statement                                                                    | https://developer.android.com/tools/bundletool                                                                                                                                      |
| Emulator: `emulator -list-avds`, `emulator @name`, `-no-snapshot`, `-wipe-data`                                                                                                                                                                                                                                                                                                                                     | Verified. `-no-window`, `-no-audio` and `adb shell getprop sys.boot_completed` for "boot finished" are **not** on the fetched part                                                                       | https://developer.android.com/studio/run/emulator-commandline                                                                                                                       |
| `INSTALL_FAILED_VERSION_DOWNGRADE`, `INSTALL_FAILED_INSUFFICIENT_STORAGE`, `INSTALL_FAILED_UPDATE_INCOMPATIBLE` and similar failure strings                                                                                                                                                                                                                                                                         | **Not verified** from an official page (the API reference fetch did not reach the constants). Taken from memory and secondary sources; the classifier table is a starting list to fill from real runs    | n/a                                                                                                                                                                                 |

### iOS

| Claim                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Source                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `devicectl` manages simulated and physical devices without Xcode running; `--json-output` writes a versioned, backward compatible JSON file, and "don't rely on or parse the Terminal output from these commands, because the output may not be consistent in each release"                                                                                                                                                                                                                                                                                                                   | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | https://developer.apple.com/documentation/xcode/interacting-with-devices-using-the-command-line                                     |
| `devicectl list devices`; `devicectl device info details --device <uuid\|ecid\|udid\|name>`; `devicectl device info lockState`; `devicectl device install app --device ... <path>`; `devicectl device process launch --device ... <bundle-id-or-path>` (also `--environment-variables`); `devicectl manage pair`; "unlock the device before entering devicectl commands"                                                                                                                                                                                                                      | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | same                                                                                                                                |
| Crash logs: `devicectl device info files --domain-type systemCrashLogs`, then `devicectl device copy from ...`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | same                                                                                                                                |
| `--device` takes a UUID, ECID, UDID or name. Which JSON field holds the UDID, and whether the CoreDevice UUID differs from it, is **not verified**                                                                                                                                                                                                                                                                                                                                                                                                                                            | Not verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | same                                                                                                                                |
| `devicectl device install app` accepts an `.ipa` (not only an `.app`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **Not verified from Apple.** Apple's page speaks of an app path from Xcode's Products. A third-party wrapper (emerge CLI) runs `xcrun devicectl device install app --device <id> "<ipa_path>"` and rejects non-`.ipa` paths, which suggests it works. A forum thread shows error 3000 "not a valid bundle" and 3002 "Failed to install the app on the device" for a bad `.app`.                                                                                                                                             | https://www.rubydoc.info/gems/emerge/EmergeCLI%2FXcodePhysicalDevice:install_app ; https://developer.apple.com/forums/thread/737286 |
| CoreDevice and `devicectl` arrived with Xcode 15; they work with iOS 17 and later (the secondary article says "iOS, iPadOS, tvOS 17 ~" and watchOS 8.7.1); first pairing needs a cable; the device "must be opted into Developer Mode to connect wirelessly" (Apple engineer's guidance in a forum thread)                                                                                                                                                                                                                                                                                    | Secondary sources; Apple's own minimum iOS for `devicectl` was not found                                                                                                                                                                                                                                                                                                                                                                                                                                                    | https://zenn.dev/scenee/articles/df3a6d9fb18465 ; https://developer.apple.com/forums/thread/737286                                  |
| Developer Mode: needed to run an app from Xcode, or "installing an `.ipa` file with Apple Configurator"; turned on in Settings > Privacy & Security > Developer Mode, needs a restart and a passcode; it "only appears in Settings if you initiate pairing or if you previously paired the device to a Mac"; it does not affect the App Store or TestFlight                                                                                                                                                                                                                                   | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device                                                 |
| An IPA installed on a registered device needs Developer Mode on that device; the team has "a limited number of devices per product family per year"; an ad hoc profile lets you choose a subset of registered devices, and "Testers can run your app only on the devices that you add to the provisioning profile"                                                                                                                                                                                                                                                                            | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices                                         |
| A provisioning profile is a property list in a CMS signature (`security cms -D -i`); `ProvisionedDevices` lists device UDIDs (example `00008030-001544522E60802E`); App Store profiles have no `ProvisionedDevices`; Developer ID and In-House profiles have `ProvisionsAllDevices`; `ExpirationDate`; `Entitlements` incl. `get-task-allow`; the profile of an app is at `MyApp.app/embedded.mobileprovision`; modern systems treat the `DER-Encoded-Profile` property as the source of truth, and "The exact format of provisioning profiles isn't documented and could change at any time" | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | https://developer.apple.com/tutorials/data/documentation/technotes/tn3125-inside-code-signing-provisioning-profiles.md              |
| Telling development from ad hoc by `get-task-allow` (true in the example development profile)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Partly: the technote shows it true for a development profile; "false in ad hoc" is conventional knowledge, not stated there                                                                                                                                                                                                                                                                                                                                                                                                 | same                                                                                                                                |
| `xcrun simctl help`; `simctl boot <udid>`, `booted` as a device alias, `list --json`, `shutdown`, `io booted screenshot`                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Verified (NSHipster, 2018 article "reviewed" 2026; Apple's page only points at `xcrun simctl help`)                                                                                                                                                                                                                                                                                                                                                                                                                         | https://nshipster.com/simctl/ ; the Apple page above                                                                                |
| `simctl install booted <app>` and `simctl launch`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | **Not verified** on a fetched page (not in the article). Expo's page says `eas build:run` installs a build on the simulator but does not name the command it runs                                                                                                                                                                                                                                                                                                                                                           | https://docs.expo.dev/build-reference/simulators/                                                                                   |
| `ios-deploy`: macOS only, needs full Xcode and a development certificate, "Designed to work on un-jailbroken devices running iOS versions prior to iOS17"; Apple "created their own command-line tools that can largely replace ios-deploy"; the 1.x branch is archived                                                                                                                                                                                                                                                                                                                       | Verified (README)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | https://github.com/ios-control/ios-deploy                                                                                           |
| libimobiledevice: LGPL-2.1, tested on Linux, macOS, Windows and Android, README dated 2024-10-22, no statement about iOS 17, RSD or tunnels; `ideviceinstaller` is GPL-2.0 and "Supports latest device firmware releases" without detail                                                                                                                                                                                                                                                                                                                                                      | Verified; **iOS 17 and later behaviour of `ideviceinstaller` is not verified**                                                                                                                                                                                                                                                                                                                                                                                                                                              | https://github.com/libimobiledevice/libimobiledevice ; https://github.com/libimobiledevice/ideviceinstaller                         |
| iOS 17 changed the transport: CoreDevice, RemoteXPC, RSD (Remote Service Discovery), a tunnel over a USB network interface (CDC-NCM), "setting up such a tunnel requires a pairing relationship", "Apple's iOS/iPadOS policy only allows pairing over the NCM interface, so pairing still needs USB", "the new CoreDevice support makes usbmux redundant" (the article's words, about Frida's needs)                                                                                                                                                                                          | Verified as a secondary source (NowSecure, 2024)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | https://www.nowsecure.com/blog/2024/08/14/the-road-to-frida-ios-17-support-and-beyond/                                              |
| pymobiledevice3 (pure Python, runs on Windows, Linux and macOS) has "DDI/DVT developer tooling (iOS 17+ over a tunnel)"; whether it can install an app, and whether tunnels need administrator rights, was **not** found on the fetched pages                                                                                                                                                                                                                                                                                                                                                 | Verified in part                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | https://github.com/doronz88/pymobiledevice3 ; https://github.com/doronz88/pymobiledevice3/blob/master/misc/RemoteXPC.md             |
| App Store Connect `GET /v1/devices` (also `GET /v1/devices/{id}`): query parameters `fields[devices]` (`name`, `platform`, `udid`, `deviceClass`, `status`, `model`, `addedDate`), `filter[id]`, `filter[name]`, `filter[platform]` (`IOS`, `MAC_OS`, `UNIVERSAL`), `filter[status]` (`ENABLED`, `DISABLED`), `filter[udid]`, `limit` (maximum 200), `sort` (`name`, `platform`, `udid`, `status`, `id`, each with `-`). Errors 400, 401, 403, 429. Which API key role may call it was **not** on the page                                                                                    | Verified from Apple's page data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | https://developer.apple.com/tutorials/data/documentation/appstoreconnectapi/get-v1-devices.json                                     |
| Over-the-air install: link form `itms-services://?action=download-manifest&url=https://.../manifest.plist`; the manifest is an XML property list; the app must be downloaded "from a website whose address begins with HTTPS" with a certificate trusted by the device ("Installation fails if a self-signed certificate doesn't have a trusted anchor"); do not link to the `.ipa` directly; MIME types `application/octet-stream` for `.ipa` and `text/xml` for `.plist`; in-house profiles expire after 12 months                                                                          | Verified, but Apple's page is the **in-house (Enterprise) guide**; it does not list the manifest keys (it points to the MDM Install Application command) and it does not say that ad hoc builds may use the same mechanism. Ad hoc over the air is common practice and is **not verified from an Apple page**. The manifest keys (`items`, `assets` with `kind` `software-package` and `url`, `metadata` with `bundle-identifier`, `bundle-version`, `kind` `software`, `title`) are from a developer forum post, not Apple | https://support.apple.com/guide/deployment/depce7cefc4d/web ; https://developer.apple.com/forums/thread/76054                       |
| TestFlight: internal testers "up to 100 App Store Connect users", external "up to 10,000", builds testable "for up to 90 days", the first build for external testers may need beta review                                                                                                                                                                                                                                                                                                                                                                                                     | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview                                          |
| Play internal testing: "up to 100 testers per app", new bundles "available to testers within minutes", the first test link "can take several hours", and "Internal tests might not be subject to standard Play policy or security reviews"                                                                                                                                                                                                                                                                                                                                                    | Verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | https://support.google.com/googleplay/android-developer/answer/9845334                                                              |

### Where builds come from

| Claim                                                                                                                                                                                                                                                                                                                                                                              | Status                                                 | Source                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List a run's artifacts: `GET /repos/{owner}/{repo}/actions/runs/{run_id}/artifacts` (`per_page` up to 100, `name` filter). Download: `GET /repos/{owner}/{repo}/actions/artifacts/{artifact_id}/zip`; "The `:archive_format` must be `zip`"; the response is a `302` and the `Location` URL "expires after 1 minute"; `410` is documented                                          | Verified                                               | https://docs.github.com/en/rest/actions/artifacts                                                                                                                   |
| Permissions: fine-grained token or GitHub App needs repository permission **Actions: read** to list and download (write only to delete); classic tokens need the `repo` scope for download (for list only on private repositories)                                                                                                                                                 | Verified                                               | same                                                                                                                                                                |
| Artifact fields in the examples: `size_in_bytes`, `expired`, `expires_at`, `digest` (example `sha256:...`), `workflow_run.head_sha`. The page does not define `digest` or promise it is always present                                                                                                                                                                             | Verified as examples only                              | same                                                                                                                                                                |
| `actions/upload-artifact` returns a `digest` output, "a SHA256 digest of the Artifact you uploaded", and `download-artifact` checks it; artifacts are immutable in v4                                                                                                                                                                                                              | Verified                                               | https://docs.github.com/en/actions/tutorials/store-and-share-data                                                                                                   |
| Retention: default 90 days; 1 to 90 days on public repositories, 1 to 400 days on private; `retention-days` cannot exceed the repository, organization or enterprise limit                                                                                                                                                                                                         | Verified                                               | https://docs.github.com/en/organizations/managing-organization-settings/configuring-the-retention-period-for-github-actions-artifacts-and-logs-in-your-organization |
| Artifact size and count limits                                                                                                                                                                                                                                                                                                                                                     | **Not verified** (not on the fetched pages)            | n/a                                                                                                                                                                 |
| EAS: `eas build:list --json --non-interactive` with `--platform android\|ios\|all`, `--status` (new, in-queue, in-progress, pending-cancel, errored, finished, canceled), `--limit` (default 10, capped at 50); `eas build:download` has `--json` too. The shape of the JSON (the artifact URL field) and how long EAS keeps artifacts were **not** found                          | Flags verified; JSON fields and retention not verified | https://docs.expo.dev/eas/cli/                                                                                                                                      |
| EAS builds Android as an AAB by default ("can't be installed directly on your device"); `android.buildType: "apk"` or `distribution: "internal"` gives an APK; install by opening the APK URL on the device or `adb install`                                                                                                                                                       | Verified                                               | https://docs.expo.dev/build-reference/apk/ ; https://docs.expo.dev/build/internal-distribution/                                                                     |
| EAS iOS simulator builds: `ios.simulator: true`, `eas build:run -p ios [--latest]` installs on the simulator. The artifact format was not stated                                                                                                                                                                                                                                   | Verified in part                                       | https://docs.expo.dev/build-reference/simulators/                                                                                                                   |
| EAS iOS internal distribution is ad hoc: a profile "containing an allow-list of device UDIDs, and only those devices in the list at build time will be able to install it"; a new device needs a new build or a re-sign; a share URL installs it, identified by a 32-character UUID and open to anyone who has it unless "Unauthenticated access to internal builds" is turned off | Verified                                               | https://docs.expo.dev/build/internal-distribution/                                                                                                                  |
| Maestro: `maestro test` has global options `--device` / `--udid` (iOS example `00008030-...`), `--platform`, `--format=junit`, `--test-output-dir`; `runScript` "executes a specified JavaScript file" (whether that script can reach the host or the network was not on the page)                                                                                                 | Verified in part                                       | https://docs.maestro.dev/maestro-cli/maestro-cli-commands-and-options ; https://docs.maestro.dev/api-reference/commands/runscript                                   |

### Not verified anywhere in this ADR

Everything about real devices. Concretely: that any command below works as described on a phone;
`unauthorized` and every `INSTALL_FAILED_*` string; the exact text of Developer Mode and profile
errors from `devicectl`; `devicectl` JSON field names and its minimum iOS version; `.ipa` input to
`devicectl`; wireless debugging on a real network; bundletool's debug keystore path and the
behaviour of an AAB install over a Play-installed copy; `ideviceinstaller` on iOS 17 or later; the
GitHub artifact size limits; the EAS artifact JSON and retention; the manifest keys for over-the-air
installs from an Apple page; and the V2 screenshots-with-Maestro design, which is **not in this
repository's documents** (searched for "maestro" under `docs/` and `README.md`: no match), so the
seam in "Test part" is written against the idea as described in the task, not against a document.

## Design

### 1. The device agent (`mrm-agent`)

**What it is.** A Node program in a new workspace package (proposed name `@kiln/agent`), written in
the same TypeScript as the server so it can share types from `@kiln/core` (device and job shapes,
failure classes). Two ways to start it, one code path:

- **Standalone CLI:** `mrm-agent pair <server-url> <code>` once, then `mrm-agent run`. For a Mac
  mini on a shelf, a Linux box with an Android lab, or a developer who only uses the hosted server.
- **Desktop sidecar:** the Tauri shell starts it next to the server, as it starts the server today
  ([ADR 0004](0004-desktop-sidecar.md): `std::process::Command`, secrets in the environment never
  argv, `NODE_OPTIONS` removed, exits when the shell's stdin closes). In single-user mode the shell
  mints the agent token itself over the loopback launch path ([ADR 0003](0003-single-user-mode.md)),
  so there is no pairing code to type. The desktop agent is still a **separate process speaking the
  same HTTP protocol**, not a function call into the server, so the hosted and local paths cannot
  drift and a bug in adb handling cannot take down the server.

**Where it must run.** Android needs `adb` (platform-tools) on the machine; iOS needs macOS with
Xcode 15 or newer for `devicectl` and `simctl`. The agent never downloads tools: it finds them
(configured path, then `PATH`), reports versions, and reports a device capability as unavailable
with a reason ("adb not found") rather than failing a job later.

**Pairing.** An admin (`devices.manage`) creates a pairing code in the web UI. The agent exchanges it
once:

- The code is single use, expires after 10 minutes, has at least 40 bits of entropy (for example 8
  characters from a 32 symbol alphabet; the server stores only its hash), and the exchange is rate
  limited with the existing limiter (`apps/server/src/limiter.ts`, a separate instance so it cannot
  evict sign-in limits).
- The response is an `agentId` and a **token**, shown once. The server stores only the token's
  SHA-256, as it does for API tokens. The agent keeps the token in the OS keychain where available
  (macOS Keychain; Windows Credential Manager and Linux Secret Service are open questions) and
  otherwise in a `0600` file in its own data folder.
- The agent pins the server origin at pairing. It refuses plain `http` unless the host is loopback,
  and it does not follow redirects to another origin.
- Revoking an agent (UI, `devices.manage`) invalidates the token at once and fails its running jobs.
  Tokens can be rotated without re-pairing.

**Token assumptions** (another agent is building API tokens and the event stream; I read the
uncommitted working tree on 2026-11-18, and all of this may have moved):

- `api_tokens` (migration 8) are workspace scoped, store only a hash, carry a role ceiling that is
  never `owner`, an optional `actions` allowlist and optional `app_ids`; `canToken(ceiling,
  allowlist, action)` in `packages/core/src/roles.ts` also has a never-allowed list
  (`tokenForbiddenActions`). A token "acts for the person who made it".
- **Assumption A1:** an agent credential is a token whose allowlist is exactly `['devices.agent']`
  and nothing else. Because a token with a null allowlist gets everything its ceiling allows, the
  server must **refuse to create an agent token with any other action**, and `devices.agent` must be
  on the never-allowed list for ordinary tokens so a user's token cannot impersonate an agent. A
  separate `device_agents` table (below) is the record of the agent; whether its token lives in
  `api_tokens` or in its own column is an implementation detail for whoever owns tokens.
- **Assumption A2:** `app_ids` on the token can restrict which apps an agent may receive jobs for
  (an agent on a contractor's laptop sees one app only).
- **Assumption A3:** the existing server-sent events route (`apps/server/src/routes/events.ts`, with
  `Last-Event-ID`, `?since=` resume and heartbeats) is the model for job delivery, not the same
  stream: a per-agent stream carries only that agent's jobs. Delivery is **SSE with a long-poll
  fallback** (`GET .../jobs/next?wait=25`) because reverse proxies buffer or cut event streams, and
  an agent behind a corporate proxy must still work. If the stream does not exist when this is
  built, long-poll alone is enough.

**Protocol sketch** (names are provisional; no route exists). All requests carry the agent token.

| Call                                                                          | Purpose                                                                                                 |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST /api/agents/pair` (no token; body: code, agent name, OS, agent version) | exchange a pairing code for `agentId` and token                                                         |
| `PUT /api/agents/:id/devices`                                                 | report the full device list (idempotent snapshot, sent on change and as a heartbeat, at most every 5 s) |
| `GET /api/agents/:id/jobs/stream` and `GET .../jobs/next?wait=25`             | receive jobs                                                                                            |
| `POST /api/agents/jobs/:jobId/claim`                                          | claim with a lease (for example 60 s), renewed by progress calls                                        |
| `GET /api/agents/jobs/:jobId/artifact`                                        | stream the artifact bytes for this job (see below)                                                      |
| `POST /api/agents/jobs/:jobId/progress`                                       | step name, a short message, optional log excerpt                                                        |
| `POST /api/agents/jobs/:jobId/result`                                         | success, or a failure class (below) with a redacted excerpt                                             |

Job delivery follows the queue's existing semantics ([architecture.md](../architecture.md), "Store
sync and the job queue"): claiming is optimistic, delivery is at least once, a job whose lease
lapses is recovered and may run twice, and only the claiming attempt can finish it. `install` is safe
to repeat; `launch` twice is a nuisance, not a hazard. The job row carries `attempt`, and the agent
sends it back so a late result from an old attempt is ignored.

**Device reporting.** The agent reports, per device: a stable `deviceKey` it derives (never the
server's id), `platform` (`ios` or `android`, matching the apps API), `kind` (`physical`, `emulator`,
`simulator`), `name`, `model`, `osVersion`, `connection` (`usb`, `wifi`, `network`, `local`), an
`identifier` (adb serial or UDID), and an authorization state: `ready`, `unauthorized` (Android RSA
prompt not accepted), `offline`, `locked`, `untrusted` (iOS not paired), `developer_mode_off`,
`unknown`. Android is read by polling `adb devices -l` (a documented command; `adb track-devices` is
an optimization that was not verified). iOS is read through `devicectl list devices --json-output -`
(documented) plus `devicectl device info details` and `lockState`, parsed from the **JSON file only**,
never from the terminal text, because Apple says the text is not stable. Which JSON keys carry the
UDID, connection and Developer Mode state is not verified and is the first thing P2 records
(fixtures from a real run, as the store connectors' fixtures were meant to be).

**Install flow, as the agent runs it.**

1. Receive an `install` job: job id, attempt, `deviceKey`, build reference (app id, platform,
   version, build number, commit SHA, run id), artifact descriptor (`kind`, `sizeBytes`, `sha256`,
   `entry` path inside the archive), options (`allowDowngrade`, `launch`, `collectLogs`), expiry.
2. **Local policy check** (below). Refuse before downloading if the policy says no.
3. Claim, then download through the server (`/jobs/:jobId/artifact`), streaming to a file in a fresh
   `0700` job directory, counting bytes against `sizeBytes` and a local cap, hashing as it goes.
   Compare the SHA-256 with the one in the job; a mismatch is `artifact_changed`, nothing is
   extracted.
4. Open the archive with a hardened reader (see threat model), select **exactly the one entry** the
   job names, write it under a fixed name in the job directory.
5. Platform pre-check (iOS: provisioning, below), then the fixed command:
   `adb -s <serial> install -r [-d] <apk>` (split sets: `adb -s <serial> install-multiple -r ...`);
   `xcrun devicectl device install app --device <id> <ipa>`; `xcrun simctl install <udid> <app>`.
6. Optionally launch and collect a log excerpt (Test part).
7. Report the result, delete the job directory, in a `finally`.

**Why the agent downloads from the server, not from GitHub.** The server holds the GitHub credential
(App installation token or PAT, [docs/credentials.md](../credentials.md)); the agent must never
receive it. GitHub's download endpoint answers `302` with a URL that "expires after 1 minute", so the
server could hand the agent that URL and keep no bytes. Reasons to proxy anyway: the agent needs no
GitHub network access or egress rule, the server enforces the size cap and the digest at one
place, and an expired artifact (`410`, or `expired: true`) is reported by the server as a clear
failure instead of a download error on a desk. The cost is server bandwidth for each install, and a
hosted instance may not want that. A **redirect handoff** (server fetches the 302 `Location` and
gives the agent that URL, which the agent downloads from directly) is the alternative; both keep the
token on the server, and the choice is open decision 6. The agent verifies the SHA-256 either way.

**What the server records at link time.** When a build is linked to a CI run (the in-progress
build-linking feature), the server also records an **artifact row**: source (`github_run` or `eas`),
the external artifact id, size, the archive SHA-256, the entry path of the installable file, its
kind (`apk`, `apk_set`, `aab`, `ipa`, `sim_app_archive`), the head SHA and branch of the run, and the
time. The SHA-256 comes from the `digest` GitHub returns for the artifact when present (shown in the
API's examples; not documented as guaranteed) and otherwise from streaming the download once on the
server, hashing and discarding. This proves "the same bytes as when a person linked the build", not
"a trustworthy build". GitHub says artifacts are immutable in `upload-artifact` v4, so the hash is a
second guard against a later swap, a proxy fault or a truncated transfer, and the only guard for
EAS URLs, whose stability and retention are not verified.

### 2. Threat model

Assets: the test devices and what is signed in on them; the agent machine (a developer's laptop with
SSH keys, a signing identity and the whole login session); the pairing token; the workspace's
artifacts; the audit log.

Attackers considered: (a) a **compromised or malicious server** (or a stolen agent token); (b) a
**poisoned artifact** (a PR build from a fork, or a workflow someone changed); (c) a **member who
abuses `devices.install`**; (d) a **network attacker** between agent and server; (e) a **hostile zip**.

**Fixed operations, no command channel.** The job schema is a closed union
(`install | launch | collect_logs`) validated with `zod` on the agent as well as on the server. The
agent has no "run this command" job, no shell, no plugin loader. Each operation maps to a fixed argv
array built from validated fields: the adb serial and UDID match `^[A-Za-z0-9._:-]{1,64}$` and must
equal a device the agent itself reported in its last 60 seconds (a job cannot name an arbitrary
host:port to `adb connect`; `adb connect` is never issued from a job); package names and bundle ids
match the platform's identifier grammar; the file argument is the agent's own job-directory path;
flags come from an allowlist (`-r`, `-d`, `-t`, `--user <int>`; never `-g` unless the local policy
turns it on for that package). Child processes run with `spawn` and an argv array (no `shell: true`),
a minimal environment (`PATH`, `HOME`, `ANDROID_HOME` or `ANDROID_SERIAL` as needed), a timeout and
an output cap, killed as a process group, as `GitCloneReader` does
([ADR 0005](0005-local-clone-reads.md)).

**Local policy file (the control a compromised server cannot change).** `agent.json` in the agent's
data folder, edited by a person on that machine or by the desktop UI, never by the server:
allowed workspaces and server origin; allowed operations; **allowed application identifiers** as
exact names or `com.acme.*` style prefixes (an Android package or an iOS bundle id, read from the
artifact's manifest before install); maximum artifact size; per-device allowlist; an `ask` mode
(a desktop confirmation the first time an app or build source is installed on a device, and always on
iOS physical devices if the person wants); log collection on or off. Defaults are strict for a
standalone agent (`ask` on, no identifiers allowed until configured) and relaxed only for the
desktop's own agent in single-user mode, where the user is the operator.

| Threat                                                                        | What limits it                                                                                                                                                                                                                                                                                                                                                                            | Residual                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compromised server sends an install of an attacker's APK to a connected phone | Local policy: application identifier allowlist and `ask`; sha256 must match; `-g` never default; installs only on devices the agent reported; token has only `devices.agent`, so the agent cannot be used to read credentials or other API data                                                                                                                                           | On an Android phone with USB debugging authorized, any APK can be installed; if the policy allows the identifier, a malicious server can install a malicious build of **that app**. iOS: only a build signed for that device runs. This is why the identifier allowlist is local |
| Compromised server tries to run commands on the agent machine                 | No command channel; closed job union; argv templates; no shell                                                                                                                                                                                                                                                                                                                            | A vulnerability in `adb`, `devicectl`, bundletool or the zip reader. Keep tools current; unprivileged user; do not run the agent as root                                                                                                                                         |
| Stolen agent token                                                            | Only `devices.agent` actions; revocable at once; bound to one workspace and optionally to some apps; jobs go only to the claiming agent id, and the server accepts device reports only for that agent                                                                                                                                                                                     | The thief can pose as that agent, claim its jobs and download the artifacts of those jobs. The local policy protects only the machine it is on                                                                                                                                   |
| Network attacker                                                              | TLS only (loopback excepted), origin pinned, no redirect to another origin; agent never sends a secret except its own token                                                                                                                                                                                                                                                               | Corporate TLS inspection with an installed CA is trusted as the OS trusts it                                                                                                                                                                                                     |
| Artifact tampered after link                                                  | SHA-256 recorded at link time and checked by the agent before extraction                                                                                                                                                                                                                                                                                                                  | A server that records a wrong hash at link time. A person linking a build is trusting the run                                                                                                                                                                                    |
| Malicious build from a fork or feature branch                                 | The picker shows the run's branch, event (`pull_request`, `push`, `workflow_dispatch`) and actor; installs are offered only for artifacts of **linked builds** (a build number the store reported or a run a person linked), not for any run; local identifier allowlist                                                                                                                  | A member can link and install their own branch build to a shared device; that is what the role permits. Shared lab devices should be `ask`                                                                                                                                       |
| Zip slip, absolute paths, `..`, symlink entries                               | The agent never extracts by entry name. It reads the central directory, picks the one entry whose name equals the job's `entry` exactly (no wildcards from the server beyond a fixed suffix check), and writes it to a fixed file name it chose. Reject: encrypted entries, symlink and special-file entries, duplicate names, names with `..`, a drive letter, a leading `/` or `\`, NUL | The zip reader dependency (open decision 9)                                                                                                                                                                                                                                      |
| Zip bomb and disk fill                                                        | Caps: archive size (default 500 MB, a local setting), entries scanned (at most 10,000), selected entry size, compression ratio (at most 200:1), free disk space checked before extraction; a job timeout                                                                                                                                                                                  | Large legitimate IPAs; GitHub's own size limits were not verified                                                                                                                                                                                                                |
| Temp file handling                                                            | One `0700` directory per job under the agent's data folder (not the shared `/tmp`), random name, files `0600`, deleted in `finally`, and swept at agent start; the agent refuses a data folder that is a symlink or world writable                                                                                                                                                        | A crash between steps leaves a directory until the next start                                                                                                                                                                                                                    |
| Secrets in logs                                                               | Log excerpts are cut to 200 lines and 64 KiB, filtered by pid or package where the platform allows, passed through the redaction the server already applies to errors, and **never** include the agent token. `adb shell` logcat can see the whole device's log, so collection is by package and pid or tag, not a blanket dump                                                           | Redaction is pattern based; an app that logs a secret in a new format leaks it into the excerpt. Collection is a per-agent opt-in                                                                                                                                                |
| Provisioning profile parsing                                                  | The profile is read in memory only (1 MiB cap), the XML plist parser is a safe one without external entities; the profile result is advisory and never a security decision                                                                                                                                                                                                                | A parser bug; treat the plist as hostile input                                                                                                                                                                                                                                   |
| Member abuses the install action                                              | `devices.install` is audited per install with who, which build, which device and the result; rate limited per workspace and per device                                                                                                                                                                                                                                                    | Spam to a device; the audit trail is the answer                                                                                                                                                                                                                                  |
| Someone installs on a device they should not touch                            | Devices belong to a workspace; the registry has an owner and notes; `ask` mode; the picker lists only devices of agents the person's token may use                                                                                                                                                                                                                                        | Ownership is advisory until a policy feature exists                                                                                                                                                                                                                              |

**Server authenticity and job signing.** Considered and **not adopted for v1**. A per-workspace
signing key held by the server protects against a network attacker (TLS already does) and nothing
against a compromised server, because the key lives where the attacker is. A signature by a key held
away from the server would need a human to sign each job, which is what the local `ask` mode already
is, with better UX. So v1 binds each job to the agent and device (`agentId`, `deviceKey`,
`artifact.sha256`, expiry of 15 minutes, `attempt`) in the envelope the agent validates, and relies on
TLS plus the local policy. Reconsider if a design ever lets a second party (a CI system, a customer's
approval service) enqueue installs.

**Audit.** The existing log ([architecture.md](../architecture.md), rule 3) records every write with an
actor. New actions (provisional names):

- `device.agent_pair_code_created`, `device.agent_paired`, `device.agent_revoked`
- `device.registered`, `device.updated`, `device.removed` (manual or imported; agent-seen devices are
  not audited each time they appear, only when first added to the registry)
- `install.requested` (who asked), `install.started`, `install.succeeded`, `install.failed`,
  `install.launch`, `install.logs_collected`

Detail on each install event, no secrets: registry device id, platform, the device's last four
identifier characters, build id (or app id, version, build number), run id, commit SHA, artifact
SHA-256, agent id, options (`allowDowngrade`, `launch`), result class, duration, and `requestedBy`.
Actor: the user who asked for `install.requested`; the **agent's token** for results it reports
(the wrapper in `services/audit.ts` already records a token as actor with `onBehalfOf`). Whether the
agent deserves its own actor type next to `user`, `token`, `assistant`, `system` is open decision 8.
Install events also feed the events stream and webhooks, so a team can post "build 241 installed on
Pixel 8 by Dana" to chat.

**Roles** (the table in `packages/core/src/roles.ts`):

| Action                                                                                                                                     | viewer | member | admin / owner | Why                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ------ | ------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devices.read`: list devices, agents (not tokens), install history                                                                         | no     | yes    | yes           | A device name and UDID identify a person's hardware; viewers today read apps and plans only                                                                                                                                                                                                |
| `devices.install`: install, launch and collect logs on a registered device                                                                 | no     | yes    | yes           | Same trust level as `ci.dispatch` and `apps.sync`, which members have: it acts on artifacts the workspace's own CI built, touches no credential and no store, and the blast radius is a test device. Controls that make `member` safe: linked builds only, local policy, audit, rate limit |
| `devices.manage`: pair, rotate and revoke agents, edit or delete registry devices and agent policy defaults, import from App Store Connect | no     | no     | yes           | An agent is a long-lived credential and a standing path to hardware                                                                                                                                                                                                                        |
| `devices.agent`: what an agent token may do                                                                                                | no     | no     | no            | Token only, never given by role; on the never-allowed list for ordinary tokens                                                                                                                                                                                                             |

Members cannot add devices in v1: devices appear from agents (paired by an admin) or are added by an
admin, so a member cannot make an install target of an arbitrary identifier. Open decision 5 asks
whether members may add notes to, or "claim", a device.

### 3. Data model sketch (tables only, no migration)

Rule 6 of the architecture holds: text ids, epoch-millisecond times, JSON as text, so SQLite and
Postgres share one model. Names are provisional.

`devices` (the registry):

| Column                                     | Notes                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------- |
| `id`                                       | text                                                                       |
| `workspace_id`                             | references `workspaces`                                                    |
| `name`                                     | what people call it ("Dana's Pixel 8")                                     |
| `platform`                                 | `ios` or `android` (the apps API's values)                                 |
| `kind`                                     | `physical`, `emulator`, `simulator`                                        |
| `identifier`                               | adb serial or UDID; unique per workspace and platform together with `kind` |
| `model`, `os_version`                      | last reported                                                              |
| `owner_user_id`                            | nullable                                                                   |
| `notes`                                    | text                                                                       |
| `source`                                   | `agent`, `manual`, `appstoreconnect`                                       |
| `agent_id`                                 | the agent that currently sees it, nullable                                 |
| `connection`, `auth_state`                 | last reported (see device reporting)                                       |
| `last_seen_at`, `created_at`, `updated_at` |                                                                            |

A registry row is the durable thing; connection and authorization are a cache of the last report.
Emulators and simulators are rows too (they appear and disappear), with `identifier` as the adb
serial (`emulator-5554`, which is **not stable across restarts**) or the simulator UDID, and are
matched on AVD name where the agent can provide it. For `source = appstoreconnect` the row means
"this UDID is registered with the team", not "this device is reachable".

`device_agents`: `id`, `workspace_id`, `name`, `os`, `agent_version`, `token_id` (or token hash),
`app_ids` (JSON, null for all), `policy_summary` (JSON: what the agent last reported of its local
policy, informational), `capabilities` (JSON: adb version, Xcode version, bundletool present),
`created_by`, `created_at`, `last_seen_at`, `revoked_at`.

`agent_pairing_codes`: `id`, `workspace_id`, `code_hash`, `created_by`, `expires_at`, `used_at`,
`agent_id` (set on use).

`build_artifacts` (written at link time, by the build-linking feature or beside it): `id`,
`workspace_id`, `app_id`, `build_link_id` (nullable; whatever the build-linking feature calls its
row), `ci_run_id` (nullable, its workflow run row), `source` (`github_run` or `eas`),
`external_id` (artifact id or EAS build id), `kind`, `entry_path`, `size_bytes`, `sha256`,
`head_sha`, `head_branch`, `run_event`, `expires_at` (from the artifact), `recorded_at`.

`install_jobs`: `id`, `workspace_id`, `device_id`, `agent_id` (the claimant), `build_artifact_id`,
`op` (`install`, `launch`, `collect_logs`), `options` (JSON), `status` (`queued`, `claimed`,
`running`, `succeeded`, `failed`, `cancelled`, `expired`), `attempt`, `lease_until`,
`failure_class`, `failure_detail` (redacted, short), `requested_by`, `created_at`, `started_at`,
`finished_at`. It could reuse the existing `jobs` table (`apps/server/src/jobs.ts`) with a queue name
`device.install`; the difference that matters is that these jobs are claimed by a remote agent,
not the in-process worker, so a separate table (or `jobs` plus a `claimed_by_agent` column) is
needed. Open decision 7.

`install_job_events`: `id`, `job_id`, `at`, `step`, `message`, `excerpt` (capped text). The progress
drawer reads this; it is a log, trimmed after 30 days.

Later (P5): `test_runs` (`install_job_id`, `runner` = `manual`, `maestro`, `status`, `commit_sha`,
`locale`, `device_class`), and `test_assets` linking a screenshot or report asset to the run.

### 4. iOS reality

What works with **no signing management**:

- **Simulator builds.** An app built for the simulator needs no profile and installs on any booted
  simulator on a Mac. EAS produces one with `ios.simulator: true` (verified), and the Expo CLI
  installs it itself. The agent can boot a simulator and install and launch the app through `simctl`
  (`install` and `launch` unverified). No Developer Mode, no UDID. This is the P2 starting point
  and the only iOS path that does not depend on what the team's signing looks like.
- **Builds already signed for the device.** A development or ad hoc IPA whose profile lists the
  device's UDID, installed on a paired device in Developer Mode, through `devicectl`. The tool
  moves the file; it does not touch the signing.
- **EAS internal distribution.** Already a hosted install page for ad hoc builds (verified); the
  tool can show its link instead of re-hosting.

What does not, and why the tool does not try:

- An App Store or TestFlight signed build has no `ProvisionedDevices` and **cannot** be run
  locally (TN3125). It is for TestFlight, and the picker says so.
- A device that is not in the profile cannot install the build, whatever tool pushes it. Fixing
  that means registering the device with the team, adding it to a profile, and **re-signing or
  rebuilding** (EAS says so explicitly: "Adding a device requires a new build or a re-sign", and a
  new device may take 24 to 72 hours to become installable on newer memberships). That is
  certificate, profile and device-registration management, and a **non-goal for v1**: it needs write
  access to Apple (a new write path, which the architecture's read-before-write rule holds back)
  and secret handling for signing keys, which the tool deliberately does not have. The ADR does not
  rule it out for a later phase; it rules out doing it by accident.

**Provisioning pre-check (read from the IPA, before anything is installed).** Goal: tell the person
"this build will not install on this iPhone" without a failed install and an opaque CoreDevice error.

1. Open the IPA's central directory in memory; find exactly one `Payload/<Name>.app/` at depth one;
   read `Payload/<Name>.app/embedded.mobileprovision` (TN3125 gives the location) and
   `Payload/<Name>.app/Info.plist`, each capped (1 MiB). No extraction to disk.
2. The profile is a CMS (PKCS#7) signed blob around a plist. On a Mac, `security cms -D -i` decodes
   it (verified). The agent should not need a Mac for the check (the server could run it in the
   future, and a Linux agent should), so the design is: locate the embedded XML plist by its
   `<?xml` ... `</plist>` markers in the DER bytes, parse it with a safe parser, fall back to `openssl
   smime -verify -noverify -inform der` if present. Whether the plist is always stored uncompressed
   and findable that way is **not verified**; if not, the fallback is a minimal DER reader. The
   signature is **not** verified: the check is advisory, and iOS stays the authority.
3. Read `ProvisionedDevices`, `ProvisionsAllDevices`, `ExpirationDate`, `Entitlements`
   (`application-identifier`, `get-task-allow`), `Name`, `TeamIdentifier`. Classify:
   `ProvisionedDevices` present and `get-task-allow` true: development; present and false: ad hoc;
   `ProvisionsAllDevices` true: enterprise; none of them: App Store or TestFlight (not installable on
   a device this way). The `get-task-allow` split is conventional, not stated by Apple's technote.
4. Compare the device's UDID with `ProvisionedDevices`, case-insensitively, hyphens as they are. The
   UDID formats seen are `00008030-001544522E60802E` (newer, in the technote) and 40 hex digits
   (older). The device's UDID has to come from the agent's device report, so this relies on
   `devicectl` exposing it as a field (not verified).
5. Outcomes shown in the picker, each with its reason: `eligible`; `device_not_in_profile`;
   `profile_expired` (`ExpirationDate` past, or within 7 days as a warning); `appstore_build`;
   `profile_missing`; `simulator_only` (a simulator build and a physical device, or the reverse);
   `developer_mode_off`; `device_locked`; `not_paired`; `unknown` (could not read the profile; try
   anyway or not, the person decides). Pre-check failure never blocks an install by itself unless the
   outcome is one that cannot work (`device_not_in_profile`, `appstore_build`).

Apple's own note applies: the profile format "isn't documented and could change at any time", and
modern systems treat the DER form as the source of truth. So the pre-check is written as a table of
rules over a dictionary with every key optional, and a failure to understand a profile gives
`unknown`, never a wrong "not eligible".

**Later: hosted install pages (P4).** Both are separate from the agent, and both turn the hosted server
into a file host for installable builds:

- _iOS ad hoc or enterprise, over the air._ A page with a QR code and a link
  `itms-services://?action=download-manifest&url=https://.../manifest.plist`. Requirements (verified
  for in-house; ad hoc not verified from Apple): the manifest and the IPA over HTTPS with a
  certificate the device trusts (no self-signed), the right MIME types, a link to the manifest and
  not to the IPA. The manifest is made by the server from the build's metadata. Same signing rules
  as any install: only devices in the profile (ad hoc) can use it. The server needs an artifact store
  for the IPA (or a streaming proxy to the CI artifact), signed expiring URLs, and authentication
  that is not a guessable link (EAS's own links are open to anyone with the 32-character UUID by
  default, which is a choice we should not copy). A deployment behind a plain `http` proxy or a
  self-signed certificate cannot offer this; the page says so.
- _Android direct download._ A page with the APK over HTTPS and an instruction to allow installing
  from the browser. The "install unknown apps" setting and the Play Protect prompt were not verified
  here. Play internal testing is the sanctioned route (up to 100 testers, verified); the page is for
  the CI APK that is not on Play yet.

### 5. The "test" part

After an install, in order of cost:

1. **Launch.** Android: `adb shell am start -W -n <package>/<activity>` when the activity is known,
   otherwise `adb shell monkey -p <package> -c android.intent.category.LAUNCHER 1` (monkey not
   verified). iOS: `devicectl device process launch --device <id> <bundle-id>` (verified), or
   `simctl launch` for a simulator (not verified).
2. **Collect an excerpt.** Android: after a short wait (default 10 s), `adb logcat -d` limited by
   package or pid and by priority (`-b crash` for crashes; the flags `-b`, `-v`, filter specs and the
   `-d` example are verified, `-d`'s meaning and `--pid` are not), at most 200 lines. iOS: `devicectl`
   can list and copy crash logs (`systemCrashLogs`, verified); live stdout through `--console` was
   not verified and a forum thread reports problems routing stdout. The result says what it did not
   do: "no crash found in the first 10 s" is not "the app works".
3. **Manual smoke test.** A checklist item on a release plan (the plans feature already exists on
   the server: `plans.read` and `plans.write`), "Smoke test on a real device", that a person ticks
   with the install job attached as evidence (device, OS, build, time). No automation is needed for
   this and it is the cheapest honest test.
4. **Automated flow (not v1): Maestro.** The seam: the agent's closed operation set gains `run_flow`
   with these fixed inputs: a **flow file from the linked commit** read through the clone reader
   ([ADR 0005](0005-local-clone-reads.md), by SHA, never from the server's say-so), the install job
   it follows, and a device from the registry. Maestro takes a device with `--device` and writes JUnit
   and a test output directory (verified); the agent would run it with those fixed options and a
   timeout. The V2 screenshots-with-Maestro design is not in this repo's documents; the seam it needs
   is that a captured asset records **the install job, the device class, the locale and the commit
   SHA**, which is exactly what `test_runs` and `test_assets` above carry, so screenshots captured
   for store listings and screenshots captured as test evidence are the same kind of row.
   Why it stays out of v1: a Maestro flow can call `runScript`, which "executes a specified
   JavaScript file" (what that runtime may reach was not on the page). That is repository-controlled
   code running on the agent machine, which breaks the "no arbitrary execution" rule. It needs its own
   decision: refuse flows that use script commands, or run Maestro in a restricted way. Until then
   there is no `run_flow`.

### 6. The UI, in words

**Devices screen** (workspace sidebar, visible to member and up). A table: name, platform and kind,
model and OS, connection (USB, Wi-Fi, local), state as a badge (`ready`, `unauthorized`,
`developer mode off`, `offline`, `locked`), agent, last seen, source. Filters for platform and state.
Rows from an offline agent are greyed with "last seen 2 hours ago". Empty state: "No devices yet.
Pair an agent on the computer your phone is plugged into" and a primary button, **Pair an agent**
(admin), which shows the one-time code and the exact `mrm-agent pair` command with a copy button, and
a live "waiting for agent" line that turns into the agent's name when it pairs. A second tab, Agents,
lists agents with version, tool versions (adb, Xcode, bundletool), last seen, and **Revoke**. Admin
only: **Add device manually** (platform, name, identifier) and **Import from App Store Connect**
(read-only list, shown as "registered with your Apple team", not reachable).

**Install on device** (on a linked build, in the app's build list and on the release screen). Opens a
popover with a device picker. Each device is a row; the ineligible ones stay visible, disabled, with
the reason in plain words under the name: "Pixel 7: not authorized. Unlock the phone and accept the
USB debugging prompt", "iPhone 15 (Dana): this build's profile does not include this device (ad hoc,
expires 12 Mar)", "iPhone 12: Developer Mode is off (Settings > Privacy & Security)", "iPhone 14:
App Store build, install it through TestFlight", "Pixel 8 (agent offline since 09:12)", "Simulator
iPhone 16: this build is for devices". Eligible rows are sorted first. Below the picker: checkboxes
**Launch after install** (default on) and **Collect a log excerpt** (default on), and an **Allow
downgrade** link that expands to a warning ("replaces a newer version; sets -d on Android, which only
works for some apps"). The primary button says what will happen: "Install build 241 on Pixel 8". It
is disabled with a reason when the person lacks `devices.install`.

**Progress drawer.** Opens at the right on click and stays reachable from a small indicator in the
header while jobs run. Steps with state: _Queued_, _Waiting for agent_, _Downloading (38 of 91 MB)_,
_Verifying checksum_, _Checking provisioning_, _Installing_, _Launching_, _Collecting logs_,
_Done_. A log excerpt in a monospace block with **Copy**. On failure the step that failed is red, the
class is a sentence with the next action ("The installed copy is signed with a different key. Uninstall
it on the device, or install a build signed with the same key"), the raw excerpt is behind **Show
details**, and there is a **Retry** and, only where it applies, **Retry with downgrade**. The same
history is a tab on the device and on the build ("Installs": who, when, which device, result).

### 7. Failure classes

The agent reports one class; the server and UI own the wording. The mapping is **table driven**
(like `packages/connectors/src/mappings.ts`): an output that matches no row stays `unknown` and its
raw excerpt is kept, never guessed.

| Class                     | Android signal (all from memory or secondary sources, not verified; confirm on a phone) | iOS signal (mostly unverified)                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `device_not_authorized`   | state `unauthorized`; install says "device unauthorized"                                | not paired or not trusted; `devicectl manage pair` needed                                                                  |
| `device_unavailable`      | `offline`, `no devices`, "more than one device/emulator" (verified text)                | CoreDeviceError 1000 "The specified device was not found" (seen in a forum thread); timeouts                               |
| `device_locked`           | rare                                                                                    | `devicectl device info lockState` reports locked; Apple: "unlock the device before entering devicectl commands" (verified) |
| `developer_mode_off`      | n/a                                                                                     | install or launch refused until Developer Mode is on (verified as a requirement; the exact text is not)                    |
| `profile_excludes_device` | n/a                                                                                     | pre-check; `devicectl` error text unverified                                                                               |
| `profile_expired`         | n/a                                                                                     | pre-check; device error text unverified                                                                                    |
| `signature_mismatch`      | `INSTALL_FAILED_UPDATE_INCOMPATIBLE`                                                    | not applicable to a fresh install; a changed team id on update                                                             |
| `version_downgrade`       | `INSTALL_FAILED_VERSION_DOWNGRADE` (the `-d` flag is verified)                          | newer build already installed                                                                                              |
| `insufficient_storage`    | `INSTALL_FAILED_INSUFFICIENT_STORAGE`                                                   | device storage error text unverified                                                                                       |
| `incompatible_device`     | `INSTALL_FAILED_OLDER_SDK`, ABI mismatch                                                | minimum OS version, device family                                                                                          |
| `artifact_expired`        | server side: GitHub `410` or `expired: true`                                            | same                                                                                                                       |
| `artifact_changed`        | SHA-256 mismatch (agent side)                                                           | same                                                                                                                       |
| `artifact_invalid`        | zip refused by the hardened reader, no installable entry, not an APK or IPA             | same; CoreDeviceError 3000 "not a valid bundle" seen in a forum thread                                                     |
| `policy_refused`          | local policy said no (identifier, size, device)                                         | same                                                                                                                       |
| `tool_missing`            | `adb` or `bundletool` not found                                                         | Xcode or `devicectl` not found                                                                                             |
| `timeout`                 | step timed out                                                                          | same                                                                                                                       |
| `unknown`                 | anything else, raw excerpt kept                                                         | same                                                                                                                       |

### 8. Alternatives considered

- **Server talks to devices directly** (USB passthrough, adb server exposed over the network): not
  possible for a hosted server, and an exposed adb port is remote code execution on the device.
  Rejected.
- **Desktop app only, no agent** (everything inside Tauri): simplest for one person, but the team's
  Mac mini and Linux lab cannot be served, and a hosted server has no way to reach it. Kept as the
  first deployment of the same agent, not a separate design.
- **Agent as a thin remote shell** (server sends command lines): the fastest to build and exactly
  what the threat model forbids. Rejected.
- **Agent embedded in the server process in desktop mode** (a function call): one fewer process, but a
  different code path from the hosted case and a device-tool crash or hang inside the server. Rejected
  for a separate process with the same protocol.
- **Server downloads the artifact and pushes it to the agent** (push over a websocket): needs an inbound
  channel or a bidirectional socket; the agent behind NAT is easier with outbound SSE and long-poll.
- **Agent downloads straight from GitHub with a token it is given**: puts a repository credential on
  every desk. Rejected. The redirect handoff (open decision 6) keeps the token on the server.
- **Job signing with a server-held key**: no protection against the threat that matters
  (see above). Rejected for v1.
- **Install through fastlane or Firebase App Distribution or Diawi**: adds a vendor and an upload path
  for a thing the team's CI already has; a possible integration, not a replacement for "install on the
  phone next to me". Not researched.
- **`ios-deploy`**: documented only for iOS before 17 and the 1.x branch is archived; Apple says its own
  tools "can largely replace" it. Rejected for P2; revisit only if `devicectl` proves unusable.
- **libimobiledevice, `ideviceinstaller`, `pymobiledevice3` for macOS**: unnecessary where `devicectl`
  works. Kept as the P3 candidate for Linux and Windows (below).
- **Managing profiles, certificates and device registration (v1)**: see iOS reality; deferred.
- **Using Apple Configurator or Xcode's Device Hub through UI scripting**: fragile, not automatable
  on a headless machine. Rejected.

## Phased plan

The phases are also in [docs/phase-5-devices.md](../phase-5-devices.md) with checkboxes. A gate is a
list of things that must be observed, with the output saved as a fixture or note, before the next
phase starts. **No gate can be passed in this environment**: there is no phone, emulator, simulator,
Xcode or adb here, and the repository has never been run against a live device.

| Phase  | Scope                                                                                                                                                                                                                                                                                                                                       | Exit gate                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0** | This ADR and the plan. Decide the open decisions that block P1 (1, 2, 3, 6, 9)                                                                                                                                                                                                                                                              | Maintainer answers; the token and build-linking features have landed (the agent depends on both)                                                                                                                                                                                                                                                                                                                                                                                   |
| **P1** | Android: `@kiln/agent` with adb on the desktop and as a CLI; pairing, device report, claim, download with SHA-256, hardened zip reader, install of an APK (and `install-multiple`), launch, log excerpt, failure classes; emulator; **manual** device registry; `devices.*` actions and audit; the Devices screen, the picker and the drawer | On a real Android phone (USB) and one emulator: install a CI debug APK, a reinstall (`-r`), a downgrade refused and then allowed (`-d`), an unauthorized device shown as such, a launch, a crash excerpt, an update over a build with a different key (signature mismatch), and the same on a phone over wireless debugging. Unit tests: zip hostile cases (slip, bomb, symlink, duplicate, encrypted), argv builders, policy. Recorded: real `adb` outputs for each class         |
| **P2** | iOS on macOS: `simctl` (simulator `.app` from an EAS or CI archive), `devicectl` for physical devices, the provisioning pre-check, App Store Connect device import (read-only, `GET /v1/devices`)                                                                                                                                           | On a Mac with Xcode 15 or newer (record the version) and a real iPhone on iOS 17 or newer: a development IPA installs and launches; an ad hoc IPA installs; the pre-check gives `device_not_in_profile` for a device outside the profile **before** any install; Developer Mode off is detected and worded correctly; a locked device; the JSON field for UDID and Developer Mode recorded; `.ipa` input to `devicectl` confirmed or the extraction fallback added. Fixtures saved |
| **P3** | The non-Mac iOS path (Linux and Windows agents): decide whether to do it at all, then libimobiledevice tools or `pymobiledevice3` as an external program, never linked                                                                                                                                                                      | A written decision after testing iOS 17+ install from Linux and Windows: tunnel setup, privileges, pairing over USB, a Developer Disk Image where needed. If no stable route exists, iOS stays Mac-only and the UI says so                                                                                                                                                                                                                                                         |
| **P4** | Hosted install pages: iOS over the air (`itms-services`, ad hoc and enterprise) and Android direct download, with QR codes; an artifact store or proxy with signed expiring URLs                                                                                                                                                            | A real HTTPS deployment with a trusted certificate: an ad hoc build installs from the QR code on a registered iPhone; an unregistered device fails with an understandable message; links expire; the page does not appear on a plain `http` deployment. Android APK from the page on a phone, including the "unknown apps" prompt, recorded                                                                                                                                        |
| **P5** | Test runs: launch plus log or crash excerpt as evidence, the manual smoke test checklist item on a release plan, the `test_runs` and `test_assets` rows; the Maestro `run_flow` seam, only after its own decision on script commands                                                                                                        | A smoke test ticked on a release plan with an install job as evidence; a crash on launch produces an excerpt on a real device; if Maestro is in scope, a flow run on an emulator and a simulator with the JUnit output stored and the asset linked to job, device class, locale and commit SHA                                                                                                                                                                                     |

### What each phase needs verified on real hardware

Until someone runs these on a phone, treat them as **unverified**:

- Android: that `adb install -r` on a recent Android release behaves as the options list says; the
  `unauthorized` state and every `INSTALL_FAILED_*` text; `adb track-devices` or polling cost;
  wireless pairing and automatic connect on a network with and without mDNS; `monkey` launching; the
  `-t` need for Gradle debug APKs; `-g` behaviour; installs from a work profile or secondary user
  (`--user`); the `-d` downgrade on Android 14 or newer for non-debuggable apps (not looked up);
  bundletool with a debug keystore that exists, one that does not, and an AAB installed over a
  Play-installed copy.
- iOS: everything `devicectl` (fields, states, errors, `.ipa` input, minimum OS, behaviour under
  `sudo` or over SSH, what a headless Mac with no logged-in user does); Developer Mode and trust
  errors; profile parsing on real `embedded.mobileprovision` files of all four kinds; the UDID
  formats; `simctl install` and `launch`; wireless installs.
- Builds: that GitHub artifacts of a real workflow contain what P1 assumes (a zip with one file),
  the GitHub `digest` field, the size limits, expiry behaviour (`410`); EAS artifact URLs and JSON.

### Risks

1. **iOS 17+ tooling churn.** `devicectl` text output is explicitly unstable; Apple renamed or moved
   things between releases (Apple's current documentation already speaks of "Device Hub"); the
   open-source route had to be rebuilt for iOS 17 (RSD, tunnels). Mitigation: parse only `--json-output`,
   record the Xcode version in every job result, treat unknown output as `unknown`, and keep
   fixtures per Xcode version.
2. **Windows (and Linux) support.** adb works there; `devicectl` and `simctl` do not exist, so iOS
   is Mac-only until P3. Paths, process groups, `0700` temp folders and keychain storage differ; the
   agent should be tested on Windows before it is called supported. A Windows desktop app is not
   shipping yet ([ADR 0004](0004-desktop-sidecar.md): Windows is not covered).
3. **User confusion about signing.** "It said installed on the other phone, why not mine?" is the
   whole iOS support burden. The pre-check, plain-worded reasons in the picker and a short
   "what makes an iOS build installable" help page are part of P2, not polish.
4. **A new long-lived credential on developer machines.** The agent token and the local policy are
   the attack surface this ADR creates. Defaults must be strict, and revocation must be easy to find.
5. **Server load and storage** if the proxy download is chosen (open decision 6); a 200 MB IPA per
   install from a small hosted instance is not free.
6. **Scope creep toward signing and device farms.** Every iOS failure invites "just register the
   device and re-sign". The explicit non-goal exists so that this is a decision, not a drift.
7. **Licensing of helper tools.** libimobiledevice is LGPL-2.1 and `ideviceinstaller` GPL-2.0
   (verified from their pages). The agent would call them as **separate programs the user installs**,
   not link or bundle them, which keeps the Apache-2.0 repository clean; bundling them in the desktop
   app needs a licensing review first. bundletool's license was not checked.
8. **Dependency choice for zip reading** with network installs disabled here and a security
   sensitive use (open decision 9).

## Consequences

- A new package, a new long-running process, a new credential type and about eight tables. The
  server's hosted path grows an agent-facing API with its own rate limits and audit.
- Installs become a first-class audited operation; webhooks and the event stream can announce them.
- The desktop app can finally do something a browser tab cannot: the agent runs where the USB
  cable is.
- The tool stays honest about iOS: it will say "this build cannot install on this phone, and why"
  rather than promising one-click installs it cannot deliver.
- `docs/architecture.md` and `docs/api/` need a devices section and an API note when P1 starts. This
  ADR did not edit them.

## Open decisions for the maintainer

1. **Agent shape for P1:** standalone CLI plus desktop sidecar from the same package (recommended),
   or desktop sidecar only first. The CLI is what makes the hosted server useful.
2. **Local policy defaults:** strict for standalone agents (identifier allowlist and `ask` mode
   required before the first install), relaxed only for the desktop's own agent. Agree, or make `ask`
   always on for physical iOS devices?
3. **Role split:** `devices.install` for members (recommended) or admin only until the feature has run
   in real teams. Members cannot add devices in v1; agree?
4. **Artifacts of which runs?** Linked builds only (recommended), or any run's artifact picked by hand.
   And whether pull request and fork runs are ever offered.
5. **Device registry ownership:** may a member add a note or "claim" a device, or is the registry
   admin and agent only?
6. **Artifact download path:** server proxy (recommended for P1: the token and the digest check stay on
   the server, costs bandwidth) or redirect handoff to GitHub's one-minute URL. And for EAS, a new
   credential type (an Expo access token) is needed to list or fetch builds: allowed?
7. **Install jobs table:** reuse the `jobs` table with an agent claim column, or a separate
   `install_jobs` table (recommended: the claimant is remote and the lifecycle differs).
8. **Actor for agent-reported results:** `token` with the agent's id (works today) or a new `agent`
   actor type in `@kiln/core` (no migration needed, `audit_events.actor_type` is text).
9. **Zip reader:** add a small, audited dependency, or write a minimal central-directory reader with
   `node:zlib` (about 200 lines, ours to maintain and fuzz). Needs a network install either way if a
   dependency.
10. **AAB support:** include bundletool in P1b (needs Java and the jar on the agent machine, and the
    debug-key signature means the installed app is not signed like the Play build), or require CI to
    publish an APK or universal APK for testing and leave AABs to Play internal testing.
11. **Non-Mac iOS (P3):** pursue it, or state that physical iOS installs need a Mac agent for good.
12. **Over-the-air pages (P4):** is the hosted server allowed to store IPAs and APKs, or should it only
    link to EAS pages and CI artifacts? If it stores them, the retention policy.
13. **Naming:** `mrm-agent` and `@kiln/agent` follow the project's placeholder scope; they change with
    the project name ([phase-0.md](../phase-0.md)).
