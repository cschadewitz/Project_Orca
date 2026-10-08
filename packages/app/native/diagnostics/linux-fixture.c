/* Linux disposable test adapter: bounded handle-relative no-replace publication.
 * This is not a macOS/Windows acceptance claim or a shipped capture capability.
 * Compile: cc -std=c11 -O2 -Wall -Wextra -Werror linux-fixture.c -o <temporary helper>
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE 1
#endif

/* Walk every component from a held directory handle, never following symlinks.
 * Root/system sticky ancestors are permitted; a selected parent/root must be
 * owned by the current user and must not permit other users to mutate it.
 */
static int directory(const char *path, int private_root) {
  if (!path || path[0] != '/' || strlen(path) >= PATH_MAX) return -1;
  char copy[PATH_MAX];
  strcpy(copy, path);
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat system_root;
  if (fstat(fd, &system_root)) { close(fd); return -1; }
  int isolated = 0;
  char *part = copy + 1;
  while (*part) {
    char *end = strchr(part, '/');
    if (end) *end = '\0';
    if (!*part || !strcmp(part, ".") || !strcmp(part, "..")) { close(fd); return -1; }
    int next = openat(fd, part, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(fd);
    if (next < 0) return -1;
    fd = next;
    struct stat st;
    if (fstat(fd, &st) || !S_ISDIR(st.st_mode) ||
        (!isolated && (st.st_mode & 0022) && !(st.st_uid == system_root.st_uid && (st.st_mode & S_ISVTX)))) { close(fd); return -1; }
    /* An owner-only ancestor already excludes other-account access to every
     * descendant; mode bits beneath that boundary cannot grant such access.
     */
    if (st.st_uid == getuid() && !(st.st_mode & 0077)) isolated = 1;
    if (!end) break;
    part = end + 1;
  }
  struct stat st;
  if (fstat(fd, &st) || st.st_uid != getuid() ||
      (private_root && (st.st_mode & 0077))) { close(fd); return -1; }
  return fd;
}

static int target(const char *path, char *name) {
  if (!path || strlen(path) >= PATH_MAX) return -1;
  char parent[PATH_MAX];
  strcpy(parent, path);
  char *slash = strrchr(parent, '/');
  if (!slash || !slash[1] || strlen(slash + 1) > NAME_MAX ||
      !strcmp(slash + 1, ".") || !strcmp(slash + 1, "..")) return -1;
  strcpy(name, slash + 1);
  *slash = '\0';
  return directory(parent[0] ? parent : "/", 0);
}

static int clock_read(void) {
  struct timespec now;
  if (clock_gettime(CLOCK_BOOTTIME, &now) || now.tv_sec < 0 ||
      (uint64_t)now.tv_sec > UINT64_C(9007199254740)) return 2;
  int fd = open("/proc/sys/kernel/random/boot_id", O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) return 2;
  char id[64];
  ssize_t size = read(fd, id, sizeof(id));
  close(fd);
  if (size != 37 || id[36] != '\n') return 2;
  id[36] = '\0';
  for (int i = 0; i < 36; ++i) if (!(id[i] == '-' || (id[i] >= '0' && id[i] <= '9') || (id[i] >= 'a' && id[i] <= 'f'))) return 2;
  uint64_t ms = (uint64_t)now.tv_sec * 1000 + (uint64_t)now.tv_nsec / 1000000;
  if (ms > UINT64_C(9007199254740991)) return 2;
  printf("%s %llu\n", id, (unsigned long long)ms);
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 2 && !strcmp(argv[1], "clock")) return clock_read();
  if (argc < 3 || strlen(argv[2]) >= PATH_MAX) return 2;
  int root = directory(argv[2], 1);
  if (root < 0) return 2;
  if (argc == 3 && !strcmp(argv[1], "verify")) { close(root); puts("verified"); return 0; }
  if (argc != 6 || strcmp(argv[1], "move")) { close(root); return 2; }
  struct stat stage, parent;
  int file = openat(root, "export-stage.tmp", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  if (file < 0 || fstat(file, &stage) || !S_ISREG(stage.st_mode) || stage.st_nlink != 1 ||
      stage.st_uid != getuid() || (stage.st_mode & 0077) || stage.st_size < 1 || stage.st_size > 1048576) {
    if (file >= 0) close(file);
    close(root); return 2;
  }
  char *end;
  errno = 0;
  unsigned long long dev = strtoull(argv[4], &end, 10);
  if (errno || *end || (unsigned long long)stage.st_dev != dev) { close(file); close(root); return 2; }
  unsigned long long ino = strtoull(argv[5], &end, 10);
  if (errno || *end || (unsigned long long)stage.st_ino != ino) { close(file); close(root); return 2; }
  char name[NAME_MAX + 1];
  int destination = target(argv[3], name);
  if (destination < 0 || fstat(destination, &parent) || stage.st_dev != parent.st_dev) {
    if (destination >= 0) close(destination);
    close(file); close(root); return 2;
  }
  /* Verify identity again against the source directory entry immediately before
   * syscall. The private root disallows other-user replacement of that entry.
   */
  struct stat current;
  if (fstatat(root, "export-stage.tmp", &current, AT_SYMLINK_NOFOLLOW) ||
      current.st_dev != stage.st_dev || current.st_ino != stage.st_ino) {
    close(destination); close(file); close(root); return 2;
  }
  int result = (int)syscall(SYS_renameat2, root, "export-stage.tmp", destination, name, RENAME_NOREPLACE);
  int error = errno;
  if (!result) {
    /* A failed directory flush means publication happened but durability is
     * uncertain. The source cannot be retried automatically.
     */
    int durable = !fsync(root) && !fsync(destination);
    close(destination); close(file); close(root);
    puts(durable ? "saved" : "unknown"); return 0;
  }
  close(destination); close(file); close(root);
  puts(error == EEXIST || error == EXDEV || error == ENOSYS || error == EINVAL ? "refused" : "unknown");
  return 0;
}
