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
#   - Where loading the profile fails, or the restriction is on and the profile is not
#     loaded, it fails the install with a message rather than leaving an app that aborts at
#     launch. A failed load refuses at once, so a stale profile from an earlier version can
#     never stand in for it.
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

# The AppArmor exception, for systems that restrict unprivileged user namespaces (Ubuntu
# 24.04+). A profile the running AppArmor cannot parse (abi/4.0 on Ubuntu 22.04) is skipped:
# those releases do not restrict user namespaces and need none.
PROFILE_SOURCE='/opt/${sanitizedProductName}/resources/apparmor-profile'
PROFILE_TARGET='/etc/apparmor.d/${executable}'
if apparmor_status --enabled > /dev/null 2>&1 && apparmor_parser --skip-kernel-load --debug "$PROFILE_SOURCE" > /dev/null 2>&1; then
    cp -f "$PROFILE_SOURCE" "$PROFILE_TARGET"
    if ! in_chroot && hash apparmor_parser 2>/dev/null; then
        # -W -T as dh_apparmor, so abstraction updates are pulled in. A failed load refuses
        # here, before the check below could pass on a profile an earlier version loaded.
        if ! apparmor_parser --replace --write-cache --skip-read-cache "$PROFILE_TARGET"; then
            refuse "apparmor_parser could not load the AppArmor profile $PROFILE_TARGET."
        fi
    fi
fi

if ! in_chroot && restricted && ! grep -q '^${executable} ' /sys/kernel/security/apparmor/profiles 2>/dev/null; then
    refuse "this system restricts unprivileged user namespaces, and the AppArmor profile that lets ${executable} use them is not loaded."
fi

exit 0
