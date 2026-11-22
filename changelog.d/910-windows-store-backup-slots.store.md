Windows store format carryover is built but stays switched off: a Windows ORCA refuses to change
a store's format (`UNDURABLE`), touching nothing, until an automated power-cut test proves it.
The design writes the backup as one ZIP archive into a backup slot file
(`format-backups/store-backup-1.zip` or `-2.zip`) that survived a Windows restart, checked by the
slot's recorded file ID and Windows `BootId`, flushed before the format marker is created. The
archive names its conversion, so if a power cut loses the marker it either finishes the
conversion (store unchanged) or refuses (`INTERRUPTED`) and keeps the only pre-upgrade backup.
Every Windows start creates the two slots if they are missing. There is no supported way to
restore a slot archive yet: extracting it by hand does not restore the store's access rules.
