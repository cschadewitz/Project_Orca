- **store:** recovering an interrupted switch from SQLite back to files no longer drops a
  replacement `metadata.sqlite` that a file system gave the original's inode number. The switch's
  journal now records the database's birth time with its device and inode, and recovery drops
  the database, puts the files back in front of it or ends the journal only when it can prove the
  file is the one the switch started from. Otherwise, including a journal written by 0.8.0 or a
  file system without birth times, it keeps the database and the journal and refuses
  (`INTERRUPTED`), naming the switch's backup (#1344).
