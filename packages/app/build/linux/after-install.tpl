#!/bin/bash
# ORCA's Debian postinst (#853), in place of electron-builder's after-install.tpl. It differs
# in three ways, each deliberate:
#   - chrome-sandbox is never made setuid. electron-builder's template falls back to
#     `chmod 4755` when a root-run `unshare --user` probe fails; this package supports only
#     Chromium's namespace sandbox, with the scoped AppArmor profile below where the system
#     restricts unprivileged user namespaces.
#   - No update-mime-database / update-desktop-database: the package ships no MIME types
#     and its desktop entry declares none, and dpkg's triggers in shared-mime-info
#     (/usr/share/mime/packages) and desktop-file-utils (/usr/share/applications) already
#     refresh both caches for the paths this package installs.
#   - Where the restriction is on (outside a chroot), it must load its own packaged profile
#     and see it active; any failure refuses the install with a message rather than leaving
#     an app that aborts at launch, and a stale profile from an earlier version can never
#     stand in for it.
# ${executable} and ${sanitizedProductName} are filled in by electron-builder, single-quote
# escaped.
set -e

EXECUTABLE='/opt/${sanitizedProductName}/${executable}'
HELPER='/opt/${sanitizedProductName}/chrome-sandbox'

if type update-alternatives >/dev/null 2>&1; then
    # Remove a previous link that does not use update-alternatives.
    if [ -L '/usr/bin/${executable}' ] && [ -e '/usr/bin/${executable}' ] && [ "$(readlink '/usr/bin/${executable}')" != '/etc/alternatives/${executable}' ]; then
        rm -f '/usr/bin/${executable}'
    fi
    update-alternatives --install '/usr/bin/${executable}' '${executable}' "$EXECUTABLE" 100 || ln -sf "$EXECUTABLE" '/usr/bin/${executable}'
else
    ln -sf "$EXECUTABLE" '/usr/bin/${executable}'
fi

# Never setuid, whatever the archive or an earlier version left behind.
chmod 0755 "$HELPER"

in_chroot() { [ -x /usr/bin/ischroot ] && /usr/bin/ischroot; }

refuse() {
    echo "${executable}: $1" >&2
    echo "Chromium's sandbox needs that profile on this system, so the app would not start." >&2
    echo "Check that AppArmor 4 (apparmor_parser) is installed and working, then reinstall." >&2
    echo "The sandbox is not disabled and the helper is not made setuid." >&2
    exit 1
}

restricted() { [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null)" = 1 ]; }

# The AppArmor exception. Where the system restricts unprivileged user namespaces (Ubuntu
# 24.04+) outside a chroot, this install must load its own packaged profile and see it
# loaded: every step that fails refuses, so a profile an earlier version left loaded can
# never stand in for this one. Elsewhere it is best effort: a chroot cannot load profiles
# live, and a system without the restriction (or whose AppArmor cannot parse abi/4.0, as on
# Ubuntu 22.04) needs none.
PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
PROFILE_TARGET='/etc/apparmor.d/${executable}'
# -W -T as dh_apparmor, so abstraction updates are pulled in.
load_profile() { apparmor_parser --replace --write-cache --skip-read-cache "$PROFILE_TARGET"; }

if ! in_chroot && restricted; then
    apparmor_status --enabled > /dev/null 2>&1 \
        || refuse "this system restricts unprivileged user namespaces, but AppArmor is not enabled to grant ${executable} its exception."
    hash apparmor_parser 2>/dev/null \
        || refuse "this system restricts unprivileged user namespaces, but apparmor_parser is not installed to load ${executable}'s AppArmor profile."
    apparmor_parser --skip-kernel-load --debug "$PROFILE_SOURCE" > /dev/null 2>&1 \
        || refuse "this system's AppArmor cannot parse ${executable}'s packaged profile $PROFILE_SOURCE."
    cp -f "$PROFILE_SOURCE" "$PROFILE_TARGET"
    load_profile || refuse "apparmor_parser could not load the AppArmor profile $PROFILE_TARGET."
    grep -q '^${executable} ' /sys/kernel/security/apparmor/profiles 2>/dev/null \
        || refuse "the AppArmor profile $PROFILE_TARGET was loaded but is not listed as active."
elif apparmor_status --enabled > /dev/null 2>&1 && apparmor_parser --skip-kernel-load --debug "$PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$PROFILE_SOURCE" "$PROFILE_TARGET"
    if ! in_chroot; then
        load_profile || refuse "apparmor_parser could not load the AppArmor profile $PROFILE_TARGET."
    fi
fi

exit 0
