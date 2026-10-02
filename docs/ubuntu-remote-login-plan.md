# Ubuntu Remote Login implementation plan

Approved design: `ubuntu-remote-login-spec.md` at `b5bb77c`.
Codex design trio converged round 1; owner approved implementation on 2026-10-03.
Review engine remains Codex 3. This is the author's execution document.

## Sequence

1. Build a disposable Ubuntu 26.04 / GNOME 50 guest with synthetic credentials,
   explicit loopback forwards and a recorded upstream image checksum. Prove the
   current guacd's GDM greeter/handover compatibility before migration work.
   If needed, evaluate a pinned upstream FreeRDP 3 build. Preserve the live host.
2. Add a strictly validated, loopback-only GNOME Remote Login target profile,
   distinct client credential guidance and fresh target identity. Preserve VNC
   and viewer controls. Verify profile/config/API and credential boundaries.
3. Replace bare-shell provisioning with normal-account setup and read-only
   Remote Login inspection. Provide an explicit receipt-bound legacy migration
   with private backups, phase journal, account-scoped recovery and no shared
   GDM/GRD mutations. Disable the legacy installer entry point for new installs.
4. Rehearse fresh login/PAM keyring unlock, apps, locking, disconnection,
   same-session resume, gateway restart, guest reboot, migration interruption and
   rollback including new file preservation. Record actual outcomes and limits.
5. Synchronize README, operations and verification evidence. Run Node tests,
   Python tests, type checking, build and diff checks appropriate to changed code.
   Push implementation and run Codex 3 independent diff review to convergence.
6. Deliver reviewable client/runtime artifacts and a concrete account cutover
   procedure with affected services, backups and expected interruption. Obtain
   the required live-session interruption approval only after rehearsal/review.

## Progress

- [x] Design approval and isolated author worktree restored.
- [x] Compatibility rehearsal (pinned FreeRDP 2 works with writable ephemeral home).
- [x] Client/gateway profile (20 Node tests, type check and build passed).
- [x] Account setup, migration and rollback.
- [x] End-to-end rehearsal and failure checks (including reboot and mismatched keyring).
- [ ] Documentation, required checks and implementation review.
- [ ] Concrete production cutover ready for owner approval.

Existing runtime remains at its previously validated revision until cutover.
Do not substitute TCP health or a standalone RDP client for the embedded path.
