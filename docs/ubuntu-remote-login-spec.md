# Ubuntu remote login through GDM

Status: F design draft; official existing Remote Login selected; independent review pending.
Date: 2026-10-03. Baseline: `d164aaf` on `feat/remote-desktop`.
The owner approved the F workflow and the direction of normal Ubuntu login.
Implementation starts only after this specification converges in independent
review and the owner agrees to it. This document is not an implementation plan.

## Problem and intended result

The existing installer starts `gnome-shell` directly in a lingering user manager.
Adding Ubuntu mode, environment export and a graphical target restored visible
desktop features, but did not create a normal authenticated Ubuntu login session.
The observed default keyring is locked. The application that requested its access
has not been established. The account itself is password-locked; its separate RDP
password cannot authenticate an operating-system login.

Use Ubuntu's GNOME Remote Login integration: system GNOME Remote Desktop (GRD)
accepts the RDP connection, GDM presents its login screen, and password PAM starts
the user's Ubuntu session. Ubuntu's session manager owns shell startup, services,
environment and teardown. Gome Remote remains the embedded viewer and access
gateway, rather than becoming another login manager.

The result must provide a monitorless Ubuntu desktop, working Settings and
Firefox, Ubuntu wallpaper and the bottom dock, and remote input. Disconnecting
the viewer must preserve the logged-in session and running applications. Logging
out deliberately ends them. Reboot or compositor failure does not preserve
process memory. Existing account files and encrypted keyrings must survive the
transition; an old independently encrypted keyring may still need its own password.

Windows/macOS clients, macOS VNC hosts, native menus, local F11 handling and the
single remote cursor remain supported. No toolbar may cover remote desktop pixels.

## Evidence and limits

Read-only inventory on the target host found:

- Ubuntu GNOME Shell/GDM 50.1, GRD 50.2 and PAM GNOME Keyring 50.0 installed.
- Both GDM and system GRD already active. System GRD listens on `*:3389` and uses
  its own existing credentials/certificate. A wildcard listener is evidence of
  binding, not proof of reachability through the host/network firewall.
- The app's legacy GRD is separate, in a private network namespace behind a
  `127.0.0.1:33490` socket. Its user manager is not a GDM graphical login session.
- The installed Ubuntu Wayland entry supports headless operation and runs
  `gnome-session --session=ubuntu`. The Ubuntu session target requires Ubuntu
  shell mode. The packaged GRD handover service is distinct from the headless
  and desktop-sharing user services masked by the old installer.
- `gdm-password` includes `pam_gnome_keyring.so` and standard session PAM;
  `common-session` includes `pam_systemd`. No custom PAM module is required.
- Effective SSH policy for the dedicated account currently excludes it through
  `AllowUsers`; password and keyboard-interactive SSH authentication are disabled.
  Recheck actual policy before enabling its OS password.
- The pinned guacd 1.6.0 image contains FreeRDP 2.11.7. Successful direct headless
  RDP access has not proved GDM handover or reconnection compatibility.
- QEMU and KVM are available for isolated rehearsal. No rehearsal guest has yet
  been built, and no GDM login or keyring-unlock result is claimed here.

Official GRD documentation describes system RDP authentication followed by GDM
user authentication. The GNOME 50 source passes connections to session handover
daemons and sends routing tokens, replacement credentials and certificate data.
Its system D-Bus name and GDM integration are shared host infrastructure. A second
system GRD instance on another TCP port is not a supported isolation strategy.

## Login architecture

### Login and session ownership

```text
Windows / macOS app
  -> Tailscale HTTPS -> authenticated loopback gateway -> loopback guacd
  -> system GRD endpoint -> GDM greeter -> password PAM
  -> Ubuntu GNOME session -> Settings / Firefox / portals / keyring
```

GDM must start the installed Ubuntu Wayland session, not an upstream GNOME-only
session. Select Ubuntu through supported GDM/account session preferences, without
rewriting system session definitions or inventing another shell wrapper. Preserve
the dedicated user's bottom-dock preferences and normal `/home` directory.

The legacy direct-shell unit, its automatic startup, and the app's old headless
GRD service are retired for a migrated account. They must never run concurrently
with its new GDM session: both would share the user's D-Bus/systemd environment.
The official handover service is managed by the Ubuntu session. A blanket unmask
or enable of all user GRD services is prohibited: desktop sharing must not acquire
an unintended listener. Reconcile only app-owned settings and masks after checking
the packaged dependency graph; retain desktop-sharing restrictions.

Use password authentication, with no autologin, empty-password keyring, fabricated
PAM environment, or application script that sends an OS password to a keyring
daemon. Normal login must be attributable to a GDM/PAM logind session, not merely
the presence of `graphical-session.target`.

### Three credential purposes

1. The existing gateway token authorizes use of configured targets.
2. System GRD credentials authorize entry to the host's remote login screen.
   These are entered in the app's connection dialog and may use its existing
   encrypted native vault. They are not assumed equal to the old per-user RDP
   credentials or the Linux account password.
3. The dedicated user's OS password is entered into GDM within the remote image.
   The application adds no separate OS-password API or persistent password store.
   The gateway and guacd remain trusted: they relay the desktop and input.

The existing system credentials are never silently overwritten. If the owner
does not have them, a credential replacement affects every existing Remote Login
client and needs an explicit, concrete approval separate from this design.
Do not expose credentials in argv, logs, review material or public configuration.
Tests use independently generated disposable credentials.

Provision a normal password for the dedicated, non-administrator OS account via
an interactive protected prompt (or a private stdin channel in disposable tests).
Keep its UID, groups and home. Do not add sudo, change another account or store
the login password in the gateway configuration or legacy receipt. Capture its
prior lock/aging state privately for rollback; a new account receives no SSH keys.
Before enabling the password, prove that effective host SSH/account policy does
not unintentionally open another login path. A host that needs SSH policy changes
must stop before mutation and present the exact account-scoped change.

### Keyring behavior

PAM uses the login password to unlock or initialize the login keyring. This is the
behavior the new normal login path must establish. It cannot decrypt a different
existing keyring password. Preserve all existing keyring files and secrets; never
delete or rename them to make a success check pass.

On the retained account, inspect collection aliases and locked state without
reading secret items. If the default collection remains independently locked,
the owner supplies its original password once in the normal Ubuntu UI and chooses
whether to integrate it with login. Do not reset the default alias behind their
back. Unknown old passwords are an explicit unresolved data-access condition,
not permission to discard encrypted data. Report normal login success separately
from any unresolved legacy keyring.

### Client behavior and access scope

The connection dialog distinguishes a Remote Login target from a legacy direct
desktop and explains the next Ubuntu login screen. Use a new target ID for this
migration so stored legacy RDP credentials cannot be silently submitted to the
system service. Server configuration supplies this profile; clients cannot turn
arbitrary destinations into Remote Login targets or change transport settings.

Disconnect closes the tunnel only. Reconnect goes through the system service and
the supported GDM session-resume flow, with user authentication when required.
The app must not cache routing tokens as durable session identifiers or implement
its own duplicate-session selection. Verify that reconnect reaches the same user
session; otherwise the persistence requirement is not met.

Remove legacy app-owned settings that disable normal locking/idle behavior after
backing up their exact values. Use normal Ubuntu policy and verify lock/unlock
and reconnect. Do not disable locking to hide reconnection failures. Preserve
unrelated user preferences, including the bottom dock.

System Remote Login exposes GDM's normal set of eligible accounts. A gateway
target does not restrict GDM to one username; OS authentication is the boundary.
This remains a single trusted owner's app, not tenant isolation. Do not claim
target-level authorization restricts which account a valid GDM password can open.

## Selected system service ownership

The owner selected official Remote Login on 2026-10-03 after being presented with
reuse versus app-only conversion. Reuse the already running Ubuntu system service.
This changes the earlier isolation invariant: the app no longer owns a separate
per-user RDP listener. Preserve existing direct clients and shared service policy.

Keep GDM/system GRD configuration, credentials, certificate and port unchanged.
guacd connects to `127.0.0.1:3389`; adding the app's target needs no host service
restart or new listener. System GRD's network exposure remains host-administered.
The app's HTTPS remains tailnet-only, but this profile cannot claim that raw
system RDP is unreachable outside the app. State that distinction in setup and
operations documentation.

After successful migration, retire the legacy loopback 33490 proxy and per-user
headless daemon. The setup command validates an already configured system Remote
Login service; it does not take ownership of it or reset it on rerun. Fresh hosts
must first configure Ubuntu's normal Remote Login and host network policy
explicitly. Missing prerequisites produce a read-only diagnostic, not a fallback
to a bare shell or automatic network-policy mutation.

A second system daemon, a replacement display manager, and nesting the user's
production desktop in a VM are outside this design. The VM below is solely a
synthetic rehearsal environment. Any later request to make the shared system RDP
app-only is a separate service conversion with impact on existing direct clients.

## Compatibility prerequisite

GDM creates a greeter and hands off to a logged-in session through RDP redirection.
Prove the entire path using the actual app/gateway/guacd stack. A TCP check, direct
FreeRDP client success or screenshot of the old desktop is insufficient.

First evaluate the currently pinned guacd image in a disposable Ubuntu 26.04 /
GNOME 50 guest. The guest contains only synthetic user files and test credentials;
it never receives production homes, keyrings, TLS keys or gateway configuration.
Keep guest forwarding on explicit loopback addresses. Do not restart host GDM,
stock GRD or the user's running session for a feasibility experiment.

If the image fails handover, identify the failure and evaluate guacd 1.6.0 built
with a pinned supported FreeRDP 3 release using upstream support. Record source
revisions, checksums and resulting image digest. Do not use floating tags, spoof
another RDP client's identity to bypass security negotiation, weaken authentication
or create an unreviewed upstream fork. A compatible image, if needed, becomes a
reviewed implementation deliverable and must retain Mac VNC behavior. If upstream
supported components cannot satisfy the flow, stop and revise this specification.

Verify that the installed GRD/FreeRDP combination reconnects only to the same
configured loopback endpoint during both handovers. Do not enable arbitrary
multi-host RDP brokerage or widen the target address allowlist. The profile is
restricted to co-located, administrator-controlled system GRD. The gateway and
this local server share the same trusted host boundary; protection from a
compromised root-owned local GRD redirecting its trusted client is not claimed.
The initial Node allowlist is configuration validation, not a native-client egress
firewall. Unexpected cross-host handover blocks this profile's deployment.

## Migration, failure and rollback

The implementation must provide a read-only inspection mode and an explicit
account migration mode; an existing account is never treated as a fresh install.
Bind migration to the legacy root-owned receipt and expected UID/home/unit
ownership. Reject mismatches, symlink substitutions, unrelated existing resources
and unexpected active sessions before changing anything. A lock serializes the
app's migration operations. It does not replace rechecking observed host state.

There are four operational boundaries:

1. **Prepared:** rehearsal passed; capture sanitized inventory and protected
   backups of app-owned units, enablement/masks, relevant account state, dconf,
   gateway target configuration and credential-receipt metadata. Validate rollback
   material. Account home backup must be made consistent when its writers stop.
2. **Legacy stopped:** after a concrete maintenance-window approval, stop only
   this account's custom desktop/GRD/proxy. Save user work first: running processes
   cannot migrate between compositors. Do not terminate other users' sessions or
   restart GDM. Take the final consistent home/keyring snapshot before conversion.
3. **Account ready:** disable legacy automatic startup; reconcile only app-owned
   settings/masks/linger state needed by the new lifecycle; provision the OS
   password and Ubuntu session preference. Start the account only through GDM.
   Record completed changes in a root-only operation receipt after each step.
4. **Cut over:** prove live normal login and session resume, then switch the
   allowlisted gateway target to a new ID. A gateway restart drops its existing
   tunnels; document any other targets affected before scheduling it. Healthz and
   a TCP-open result alone are not acceptance. Retain rollback data after success.

Failure before stopping the legacy desktop leaves it running. Failure afterward
leaves a precise phase receipt; rerunning must inspect and resume or roll back,
not create a second account or overwrite unknown state. Restore app-owned units,
target configuration and this account's prior lock state when rolling back.
Do not overwrite global passwd/shadow files or restore whole system configuration.

If the new GDM session has started, stop only that dedicated session before
restoring the legacy shell, with the same user-work checkpoint. Never run both.
Preserve the current home and new user work by default: restoring service state
does not mean replacing the home with an older snapshot. A full data restore is
a separate explicit destructive decision. A newly created login keyring must
also be preserved if service rollback is needed.

Shared system GRD and GDM stay untouched during migration/rollback. There is no
automatic reboot or forced shared-session logout.

## Acceptance and evidence

Acceptance is the real end-user path, with the tested package/image revisions:

- No physical monitor; a fresh GDM login starts the installed Ubuntu session with
  a real logind session and normal session services, not a lingering bare shell.
- Wrong system RDP credentials and wrong Linux passwords fail at their respective
  boundaries. Fresh login unlocks the login keyring through PAM. A mismatched
  synthetic legacy keyring stays preserved and prompts instead of being discarded.
- Settings, Snap Firefox, portal activation, wallpaper, bottom dock, keyboard,
  pointer and explicit paste work through the embedded app.
- Disconnect/reconnect and gateway restart preserve the same graphical session
  and a running application with unsaved synthetic content. Lock/unlock works;
  deliberate logout ends the session and next login creates a normal new one.
- A guest reboot allows a fresh remote login without autologin or a monitor.
  Host reboot validation requires its own maintenance window, not a claim based
  solely on enabling systemd units.
- No added unintended listener, no redirection around the target access boundary,
  and no changes to unrelated host users, SSH access, Serve routes or Mac targets.
- Rehearsal covers interruption at migration boundaries and rollback, including
  a new-session-written file surviving service rollback and other accounts intact.

Unit/contract tests support these outcomes but cannot substitute for GDM/PAM and
handover evidence. Record unverified native Windows/macOS paths explicitly. The
retained Windows client can only be declared compatible after its login flow is
checked; any required new client package must be identified and delivered.

Synchronize README setup, credential meanings, network ownership, operations and
removal instructions, plus docs/verification.md and versioned sanitized evidence.
Keep prior verified results distinguishable from the new architecture's results.

## Review and approval boundaries

The owner chose F and official Remote Login on 2026-10-03. Existing-service reuse
is selected. The owner selected Codex 3 for this redesign on 2026-10-03. Use that
engine throughout its review stages. Three independent reviewers must approve this spec with no
open major/blocker. After owner agreement, write the implementation plan; the
plan is not independently reviewed. Implementation receives its own pushed-diff
gate. A changed diff after convergence requires review of those changes.

Design agreement authorizes implementation and disposable rehearsal. It does
not silently authorize interruption of the user's current desktop, shared service
credential replacement, keyring deletion, or a host reboot. Request a concrete
cutover approval only after the reviewed implementation and rehearsal evidence
make the affected services and expected downtime reviewable.

## Primary references

- [GNOME Remote Desktop configuration](https://github.com/GNOME/gnome-remote-desktop/blob/main/docs/configuration.md)
- [GNOME 50 release notes](https://release.gnome.org/50/)
- [GNOME Keyring PAM integration](https://wiki.gnome.org/Projects/GnomeKeyring/Pam)
- [GNOME 50 system daemon handover](https://github.com/GNOME/gnome-remote-desktop/blob/gnome-50/src/grd-daemon-system.c)
- [GNOME 50 RDP redirection](https://github.com/GNOME/gnome-remote-desktop/blob/gnome-50/src/grd-session-rdp.c)
- [Guacamole 1.6.0 RDP client](https://github.com/apache/guacamole-server/blob/1.6.0/src/protocols/rdp/rdp.c)
- [Guacamole 1.6.0 image build](https://github.com/apache/guacamole-server/blob/1.6.0/Dockerfile)

Upstream branch URLs describe the inspected mechanism; implementation evidence
must record immutable installed/source/image versions rather than assuming future
branch contents remain identical.
