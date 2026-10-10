/* Async handle-relative private storage. Linux builds are explicit conformance fixtures. */
#define _GNU_SOURCE
#ifdef ORCA_STORAGE_STANDALONE
/* The syscall fixture compiles this exact core without a Node header download. */
typedef void *napi_env;
typedef void *napi_async_work;
typedef void *napi_deferred;
typedef void *napi_ref;
#else
#include <node_api.h>
#endif
#include <stdatomic.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <fcntl.h>
#include <dirent.h>
#include <limits.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/xattr.h>
#include <unistd.h>
#ifdef __APPLE__
#include <sys/acl.h>
#endif
#define MAX_BYTES 1064960
#define MAX_FILES 4
#define MAX_ENTRIES 16

typedef struct handle {
  int fd, kind, lock_fd, destination_fd, replacement;
  struct handle *owner;
  atomic_uint references, files;
  atomic_int busy;
  char path[PATH_MAX];
  char destination[PATH_MAX];
  char name[64];
} handle;
typedef struct job {
  napi_env env;
  napi_async_work work;
  napi_deferred deferred;
  napi_ref root_ref, file_ref, buffer_ref;
  handle *root, *file, *result;
  char operation[32], path[PATH_MAX], second[PATH_MAX];
  unsigned char *buffer;
  size_t buffer_size, offset, length;
  int error, outcome, number;
  struct stat stat;
  uint64_t pair_source_dev, pair_source_ino, pair_destination_dev, pair_destination_ino;
  char names[MAX_ENTRIES][64];
} job;

static int private_acl(int fd) {
#ifdef __APPLE__
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) return errno == ENOENT ? 1 : 0;
  if (acl_valid(acl)) { acl_free(acl); return 0; }
  acl_entry_t entry;
  unsigned count = 0;
  int status = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  int safe = 1;
  while (status == 0 && count++ < 128) {
    acl_tag_t tag;
    if (acl_get_tag_type(entry, &tag) || tag != ACL_EXTENDED_DENY) { safe = 0; break; }
    status = acl_get_entry(acl, ACL_NEXT_ENTRY, &entry);
  }
  if (status == 0 || errno != EINVAL) safe = 0;
  acl_free(acl);
  return safe;
#else
  /* Linux mode-only fixtures do not establish native ACL conformance. */
  (void)fd;
  return 1;
#endif
}
static int identity(const struct stat *a, const struct stat *b) { return a->st_dev == b->st_dev && a->st_ino == b->st_ino; }
static int file_safe(int fd, struct stat *st) {
  return !fstat(fd, st) && S_ISREG(st->st_mode) && st->st_uid == getuid() &&
    st->st_nlink == 1 && !(st->st_mode & 0077) && st->st_size >= 0 &&
    st->st_size <= MAX_BYTES && private_acl(fd);
}
static int name_limit(const handle *root, const char *name) {
  if (root->replacement) {
    if (!strcmp(name,"writer.lock")) return 4096;
    if (!strcmp(name,"replacement.enc") || !strcmp(name,"replacement.tmp")) return 40960;
    return 0;
  }
  const char *controls[] = {"setting.json","setting.json.tmp","manifest.json","manifest.json.tmp","control.key","control.key.tmp","export.json","export.json.tmp","writer.lock",NULL};
  for (int i = 0; controls[i]; ++i) if (!strcmp(name, controls[i])) return 4096;
  if (!strcmp(name,"export-stage.tmp")) return 1048576;
  if (strlen(name) == 10 && !strncmp(name,"slot-",5) && name[5] >= '0' && name[5] <= '2' && !strcmp(name+6,".bin")) return MAX_BYTES;
  if (strlen(name) == 13 && !strncmp(name,"session-",8) && name[8] >= '0' && name[8] <= '2' && !strcmp(name+9,".key")) return 4096;
  return 0;
}
/* Each component is opened relative to its predecessor. Never chmod existing objects. */
static int directory(const char *path, int create, int private_root) {
  if (!path || path[0] != '/' || !path[1] || strlen(path) >= PATH_MAX) { errno = EACCES; return -1; }
  char copy[PATH_MAX]; strcpy(copy,path);
  int fd = open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat system_root;
  if (fstat(fd,&system_root)) { close(fd); return -1; }
  char *part = copy+1;
  while (*part) {
    char *end = strchr(part,'/'); if (end) *end = 0;
    if (!*part || !strcmp(part,".") || !strcmp(part,"..")) { close(fd); errno=EACCES; return -1; }
    int next = openat(fd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    if (next < 0 && errno == ENOENT && create && !end) {
      if (mkdirat(fd,part,0700) && errno != EEXIST) { close(fd); return -1; }
      if (fsync(fd)) { close(fd); return -1; }
      next = openat(fd,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    }
    close(fd); if (next < 0) return -1; fd = next;
    struct stat st;
    if (fstat(fd,&st) || !S_ISDIR(st.st_mode) ||
        (st.st_uid != system_root.st_uid && st.st_uid != getuid()) ||
        ((st.st_mode & 0022) && !(st.st_uid == system_root.st_uid && (st.st_mode & S_ISVTX))) || !private_acl(fd)) {
      close(fd); errno=EACCES; return -1;
    }
    if (!end) break;
    part=end+1;
  }
  struct stat st;
  if (fstat(fd,&st) || st.st_uid != getuid() || (private_root && (st.st_mode & 0077))) {
    close(fd); errno=EACCES; return -1;
  }
  return fd;
}
static int root_safe(handle *root) {
  if (!root || root->kind != 1 || root->fd < 0) { errno=EACCES; return 0; }
  int current = directory(root->path,0,1);
  if (current < 0) return 0;
  struct stat held, actual;
  int safe = !fstat(root->fd,&held) && !fstat(current,&actual) && identity(&held,&actual);
  close(current);
  if (safe && root->lock_fd>=0) {
    struct stat lock,entry;
    safe=file_safe(root->lock_fd,&lock) && lock.st_size<=4096 &&
      !fstatat(root->fd,"writer.lock",&entry,AT_SYMLINK_NOFOLLOW) && identity(&lock,&entry);
  }
  if (!safe) errno=EACCES;
  return safe;
}
static void release_handle(handle *h) {
  if (!h) return;
  if (atomic_fetch_sub(&h->references,1) != 1) return;
  if (h->fd >= 0) close(h->fd);
  if (h->lock_fd >= 0) close(h->lock_fd);
  if (h->destination_fd >= 0) close(h->destination_fd);
  handle *owner=h->owner;
  if (owner && h->fd >= 0) atomic_fetch_sub(&owner->files,1);
  free(h);
  if (owner) release_handle(owner);
}
#ifndef ORCA_STORAGE_STANDALONE
static void finalize(napi_env env, void *data, void *hint) { (void)env; (void)hint; release_handle(data); }
#endif
static handle *new_handle(int fd, int kind, handle *owner) {
  handle *h=calloc(1,sizeof(*h)); if (!h) { close(fd); return NULL; }
  h->fd=fd; h->kind=kind; h->lock_fd=-1; h->destination_fd=-1; h->owner=owner;
  atomic_init(&h->references,1); atomic_init(&h->files,0); atomic_init(&h->busy,0);
  if (owner) { atomic_fetch_add(&owner->references,1); atomic_fetch_add(&owner->files,1); }
  return h;
}
static int sync_file(int fd) {
  if (fsync(fd)) return -1;
#ifdef __APPLE__
  if (fcntl(fd,F_FULLFSYNC)) return -1;
#endif
  return 0;
}

/* Complete private pair trees. No path-based rm/cp or external mount/extraction commands.
 * Root descriptors are bound to identities captured before verification, kept through
 * mutation, and rechecked against the live paths. Every traversal stays openat-relative.
 * Partial restoration is permitted only after the caller's durable whole-pair intention. */
typedef struct pair_budget { uint64_t bytes; unsigned entries; } pair_budget;
static int pair_stat(int fd, struct stat *st, int directory_only) {
  if (fstat(fd,st) || st->st_uid!=getuid() || (st->st_mode&06000) ||
      (directory_only && !S_ISDIR(st->st_mode))) { errno=EACCES; return -1; }
  return 0;
}
static ssize_t pair_listx(int fd,char *bytes,size_t size) {
#ifdef __APPLE__
  return flistxattr(fd,bytes,size,0);
#else
  return flistxattr(fd,bytes,size);
#endif
}
static ssize_t pair_getx(int fd,const char *name,void *bytes,size_t size) {
#ifdef __APPLE__
  return fgetxattr(fd,name,bytes,size,0,0);
#else
  return fgetxattr(fd,name,bytes,size);
#endif
}
static int pair_setx(int fd,const char *name,const void *bytes,size_t size) {
#ifdef __APPLE__
  return fsetxattr(fd,name,bytes,size,0,0);
#else
  return fsetxattr(fd,name,bytes,size,0);
#endif
}
static int pair_removex(int fd,const char *name) {
#ifdef __APPLE__
  return fremovexattr(fd,name,0);
#else
  return fremovexattr(fd,name);
#endif
}
static int pair_metadata(int from,int to,const struct stat *st) {
  char source[32768],destination_names[32768];
  ssize_t sn=pair_listx(from,source,sizeof(source)),dn=pair_listx(to,destination_names,sizeof(destination_names));
  if(sn<0 || dn<0 || sn==(ssize_t)sizeof(source) || dn==(ssize_t)sizeof(destination_names))return -1;
  for(ssize_t i=0;i<dn;) {
    size_t length=strnlen(destination_names+i,(size_t)(dn-i)); if(!length || length==(size_t)(dn-i)) { errno=EACCES; return -1; }
    int found=0; for(ssize_t k=0;k<sn;) { size_t n=strnlen(source+k,(size_t)(sn-k)); if(!n || n==(size_t)(sn-k)){errno=EACCES;return -1;} if(!strcmp(source+k,destination_names+i))found=1; k+=(ssize_t)n+1; }
    if(!found && pair_removex(to,destination_names+i))return -1;
    i+=(ssize_t)length+1;
  }
  for(ssize_t i=0;i<sn;) {
    size_t length=strnlen(source+i,(size_t)(sn-i)); if(!length || length==(size_t)(sn-i)){errno=EACCES;return -1;}
    ssize_t count=pair_getx(from,source+i,NULL,0); if(count<0 || count>1048576){errno=EACCES;return -1;}
    void *value=malloc(count?(size_t)count:1); if(!value)return -1;
    int result=pair_getx(from,source+i,value,(size_t)count)!=count || pair_setx(to,source+i,value,(size_t)count);
    free(value); if(result)return -1; i+=(ssize_t)length+1;
  }
#ifdef __APPLE__
  acl_t acl=acl_get_fd_np(from,ACL_TYPE_EXTENDED);
  if(!acl && errno==ENOENT)acl=acl_init(0);
  if(!acl)return -1;
  int acl_result=acl_set_fd_np(to,acl,ACL_TYPE_EXTENDED); acl_free(acl); if(acl_result)return -1;
#endif
  if(fchown(to,st->st_uid,st->st_gid) || fchmod(to,st->st_mode&07777))return -1;
#ifdef __APPLE__
  struct timespec times[2]={st->st_atimespec,st->st_mtimespec};
#else
  struct timespec times[2]={st->st_atim,st->st_mtim};
#endif
  return futimens(to,times) || (S_ISDIR(st->st_mode)?fsync(to):sync_file(to)) ? -1:0;
}
static int pair_name(const char *name) { return name[0] && strcmp(name,".") && strcmp(name,"..") && !strchr(name,'/') && !strchr(name,'\n') && !strchr(name,'\r'); }
static int pair_same_entry(int parent,const char *name,const struct stat *held) { struct stat actual; return !fstatat(parent,name,&actual,AT_SYMLINK_NOFOLLOW) && identity(held,&actual); }
static int pair_copy(int from,int to,unsigned depth,pair_budget *budget,int preserve_guard) {
  struct stat directory_stat;
  if(depth>64 || pair_stat(from,&directory_stat,1))return -1;
  int list=openat(from,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); DIR *dir=list<0?NULL:fdopendir(list);
  if(!dir){if(list>=0)close(list);return -1;}
  int result=0; struct dirent *entry;
  errno=0;
  while((entry=readdir(dir))) {
    const char *name=entry->d_name; if(!strcmp(name,".") || !strcmp(name,".."))continue;
    if(!pair_name(name) || ++budget->entries>65536){errno=EACCES;result=-1;break;}
    if(preserve_guard && !strcmp(name,".orca-update-window.json"))continue;
    struct stat original; if(fstatat(from,name,&original,AT_SYMLINK_NOFOLLOW) || original.st_uid!=getuid() || (original.st_mode&06000)){result=-1;break;}
    if(S_ISLNK(original.st_mode)) {
      char target[PATH_MAX]; ssize_t count=readlinkat(from,name,target,sizeof(target)-1);
      if(count<1 || count==(ssize_t)sizeof(target)-1){result=-1;break;} target[count]=0;
      if(target[0]=='/' || strchr(target,'\n') || strchr(target,'\r') || !pair_same_entry(from,name,&original)){errno=EACCES;result=-1;break;}
      int level=(int)depth; char copy[PATH_MAX];strcpy(copy,target);char *save=NULL,*part=strtok_r(copy,"/",&save);
      while(part){if(!strcmp(part,"..")){if(--level<0){result=-1;break;}}else if(strcmp(part,"."))++level;part=strtok_r(NULL,"/",&save);}
      if(result || symlinkat(target,to,name) || fchownat(to,name,original.st_uid,original.st_gid,AT_SYMLINK_NOFOLLOW)){result=-1;break;}
    } else if(S_ISDIR(original.st_mode)) {
      int input=openat(from,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC),output=-1;
      struct stat held;
      if(input<0 || pair_stat(input,&held,1) || !identity(&held,&original) || mkdirat(to,name,0700) || (output=openat(to,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC))<0 || pair_copy(input,output,depth+1,budget,0))result=-1;
      if(input>=0)close(input);
      if(output>=0)close(output);
      if(result)break;
    } else if(S_ISREG(original.st_mode)) {
      if(original.st_nlink!=1 || original.st_size<0 || original.st_size>1073741824 || (budget->bytes+=(uint64_t)original.st_size)>1073741824ULL){errno=EACCES;result=-1;break;}
      int input=openat(from,name,O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC),output=-1;
      struct stat held,final;
      if(input<0 || pair_stat(input,&held,0) || !identity(&held,&original) || (output=openat(to,name,O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW|O_CLOEXEC,0600))<0)result=-1;
      unsigned char buffer[65536];off_t offset=0;
      while(!result && offset<original.st_size) {
        size_t request=(size_t)(original.st_size-offset);if(request>sizeof(buffer))request=sizeof(buffer);
        ssize_t count=pread(input,buffer,request,offset);if(count<=0){result=-1;break;}
        ssize_t written=0;while(written<count){ssize_t n=pwrite(output,buffer+written,(size_t)(count-written),offset+written);if(n<=0){result=-1;break;}written+=n;}offset+=count;
      }
      if(!result && (fstat(input,&final) || final.st_size!=original.st_size || final.st_mtime!=original.st_mtime || final.st_ctime!=original.st_ctime || !pair_same_entry(from,name,&original) || pair_metadata(input,output,&original)))result=-1;
      if(input>=0)close(input);
      if(output>=0)close(output);
      if(result)break;
    } else {errno=EACCES;result=-1;break;}
    if(fsync(to)){result=-1;break;}
    errno=0;
  }
  if(!result && errno)result=-1;
  closedir(dir);
  if(!result && pair_metadata(from,to,&directory_stat))result=-1;
  return result;
}
static int pair_clear(int fd,unsigned depth,pair_budget *budget) {
  if(depth>64){errno=EACCES;return -1;}
  int list=openat(fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);DIR *dir=list<0?NULL:fdopendir(list);
  if(!dir){if(list>=0)close(list);return -1;}int result=0;struct dirent *entry;errno=0;
  while((entry=readdir(dir))) {
    const char *name=entry->d_name;if(!strcmp(name,".") || !strcmp(name,"..") || (!depth && !strcmp(name,".orca-update-window.json")))continue;
    if(!pair_name(name) || ++budget->entries>65536){errno=EACCES;result=-1;break;}
    struct stat st;if(fstatat(fd,name,&st,AT_SYMLINK_NOFOLLOW) || st.st_uid!=getuid()){result=-1;break;}
    if(S_ISDIR(st.st_mode)) {
      int child=openat(fd,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);struct stat held;
      if(child<0 || pair_stat(child,&held,1) || !identity(&held,&st) || pair_clear(child,depth+1,budget) || !pair_same_entry(fd,name,&st) || unlinkat(fd,name,AT_REMOVEDIR))result=-1;
      if(child>=0)close(child);
      if(result)break;
    } else if(!pair_same_entry(fd,name,&st) || unlinkat(fd,name,0)){result=-1;break;}
    errno=0;
  }
  if(!result && errno)result=-1;
  closedir(dir);
  if(!result && fsync(fd))result=-1;
  return result;
}
static int pair_path_matches(int fd,const char *path) { int actual=directory(path,0,0);if(actual<0)return 0;struct stat a,b;int same=!fstat(fd,&a)&&!fstat(actual,&b)&&identity(&a,&b);close(actual);return same; }
static void pair_execute(job *j) {
  int source=directory(j->path,0,0),destination_fd=-1,parent=-1;
  struct stat src,dst;char parent_path[PATH_MAX],name[NAME_MAX+1];
  if(source<0 || pair_stat(source,&src,1) || (uint64_t)src.st_dev!=j->pair_source_dev || (uint64_t)src.st_ino!=j->pair_source_ino)goto failed;
  int restore=!strcmp(j->operation,"pairRestore");
  if(restore)destination_fd=directory(j->second,0,0);
  else {
    strcpy(parent_path,j->second);char *slash=strrchr(parent_path,'/');if(!slash || !pair_name(slash+1) || strlen(slash+1)>NAME_MAX)goto failed;
    strcpy(name,slash+1);*slash=0;parent=directory(parent_path,0,1);
    if(parent<0 || fstat(parent,&dst) || (uint64_t)dst.st_dev!=j->pair_destination_dev || (uint64_t)dst.st_ino!=j->pair_destination_ino || mkdirat(parent,name,0700) || fsync(parent))goto failed;
    destination_fd=openat(parent,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  }
  if(destination_fd<0 || pair_stat(destination_fd,&dst,1) || identity(&src,&dst) || (restore && ((uint64_t)dst.st_dev!=j->pair_destination_dev || (uint64_t)dst.st_ino!=j->pair_destination_ino)))goto failed;
  if(!pair_path_matches(source,j->path) || !pair_path_matches(destination_fd,j->second))goto failed;
  pair_budget budget={0,0};
  if(restore && pair_clear(destination_fd,0,&budget))goto failed;
#ifdef ORCA_PAIR_FAULTS
  if(restore && j->number==1) { (void)write(STDOUT_FILENO,"PAIR_CLEAR\n",11); for(;;)pause(); }
#endif
  budget.bytes=0;budget.entries=0;
  if(pair_copy(source,destination_fd,0,&budget,restore) || !pair_path_matches(source,j->path) || !pair_path_matches(destination_fd,j->second))goto failed;
  if(parent>=0 && fsync(parent))goto failed;
  close(source);close(destination_fd);if(parent>=0)close(parent);return;
failed:
  j->error=errno?errno:EACCES;if(source>=0)close(source);if(destination_fd>=0)close(destination_fd);if(parent>=0)close(parent);
}

static int destination(job *j, char *name) {
  if (j->path[0] != '/' || strlen(j->path) >= PATH_MAX ||
      (!strncmp(j->path,j->root->path,strlen(j->root->path)) && j->path[strlen(j->root->path)]=='/')) { errno=EACCES; return -1; }
  char parent[PATH_MAX]; strcpy(parent,j->path);
  char *slash=strrchr(parent,'/');
  if (!slash || !slash[1] || strlen(slash+1)>NAME_MAX || !strcmp(slash+1,".") || !strcmp(slash+1,"..")) { errno=EACCES; return -1; }
  strcpy(name,slash+1); *slash=0;
  int fd=directory(parent[0]?parent:"/",0,0);
  if (fd < 0) return -1;
  struct stat from,to,exists;
  if (fstat(j->root->fd,&from) || fstat(fd,&to) || from.st_dev != to.st_dev ||
      identity(&from,&to) || !fstatat(fd,name,&exists,AT_SYMLINK_NOFOLLOW) || errno != ENOENT) { close(fd); errno=EACCES; return -1; }
  return fd;
}
static void execute(napi_env env, void *data) {
  (void)env; job *j=data;
  if(!strcmp(j->operation,"pairCopy") || !strcmp(j->operation,"pairRestore")) { pair_execute(j); return; }
  if (!strcmp(j->operation,"openRoot") || !strcmp(j->operation,"provisionReplacementRoot")) {
    if (j->second[0] && strcmp(j->second,"replacement")) { j->error=EACCES; return; }
    int provision=!strcmp(j->operation,"provisionReplacementRoot");
    if (provision && strcmp(j->second,"replacement")) { j->error=EACCES; return; }
    /* A missing recovery root is lost authority, never implicit fresh provisioning. */
    int fd=directory(j->path,provision || (j->offset==1 && !j->second[0]),1);
    if (fd<0) { j->error=errno; return; }
    j->result=new_handle(fd,1,NULL);
    if (!j->result) { j->error=ENOMEM; return; }
    j->result->replacement=!strcmp(j->second,"replacement");
    strcpy(j->result->path,j->path); return;
  }
  if (!strcmp(j->operation,"closeRoot")) {
    if (atomic_load(&j->root->files)) { j->error=EBUSY; return; }
    if (j->root->lock_fd>=0) { close(j->root->lock_fd); j->root->lock_fd=-1; }
    if (j->root->destination_fd>=0) { close(j->root->destination_fd); j->root->destination_fd=-1; }
    if (j->root->fd>=0) { close(j->root->fd); j->root->fd=-1; } return;
  }
  if (!strcmp(j->operation,"closeFile")) {
    if (j->file->fd>=0) { close(j->file->fd); j->file->fd=-1; atomic_fetch_sub(&j->root->files,1); } return;
  }
  if (!root_safe(j->root)) { j->error=errno; return; }
  if (!strcmp(j->operation,"rootStat")) { if (fstat(j->root->fd,&j->stat)) j->error=errno; return; }
  if (!strcmp(j->operation,"list")) {
    /* openat creates an independent directory offset; dup would share it. */
    int fd=openat(j->root->fd,".",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
    DIR *dir=fd<0?NULL:fdopendir(fd);
    if (!dir) { if(fd>=0)close(fd); j->error=errno; return; }
    struct dirent *entry;
    errno=0;
    while ((entry=readdir(dir))) {
      if (!strcmp(entry->d_name,".") || !strcmp(entry->d_name,"..")) continue;
      if (j->number>=MAX_ENTRIES || strlen(entry->d_name)>=64) { j->error=EOVERFLOW; break; }
      strcpy(j->names[j->number++],entry->d_name);
    }
    if (!j->error && errno) j->error=errno;
    closedir(dir); return;
  }
  if (!strcmp(j->operation,"acquire")) {
    if (j->root->lock_fd>=0) return;
    int fd=openat(j->root->fd,"writer.lock",O_CREAT|O_RDWR|O_NONBLOCK|O_NOFOLLOW|O_CLOEXEC,0600);
    if (fd<0) { j->error=errno; return; }
    struct stat st;
    if (!file_safe(fd,&st) || st.st_size>4096 || flock(fd,LOCK_EX|LOCK_NB) || fsync(j->root->fd)) { j->error=EACCES; close(fd); return; }
    j->root->lock_fd=fd; return;
  }
  if (!strcmp(j->operation,"release")) {
    if (j->root->lock_fd>=0) { close(j->root->lock_fd); j->root->lock_fd=-1; } return;
  }
  if (!strcmp(j->operation,"stopped")) { j->number=j->root->lock_fd>=0 && atomic_load(&j->root->files)==0; return; }
  if (!strcmp(j->operation,"validateDestination")) {
    if (j->root->replacement) { j->error=EACCES; return; }
    char name[NAME_MAX+1]; int fd=destination(j,name);
    if (fd>=0) {
      if (j->root->destination_fd>=0 && !strcmp(j->root->destination,j->path)) {
        struct stat selected,current;
        j->number=!fstat(fd,&current) && !fstat(j->root->destination_fd,&selected) && identity(&current,&selected);
        close(fd);
      } else {
        if(j->root->destination_fd>=0)close(j->root->destination_fd);
        j->root->destination_fd=fd; strcpy(j->root->destination,j->path); j->number=1;
      }
    }
    return;
  }
  if (!strcmp(j->operation,"publish")) {
    if (j->root->replacement) { j->error=EACCES; return; }
    char name[NAME_MAX+1]; struct stat held,current;
    if (j->root->lock_fd<0 || !file_safe(j->file->fd,&held) || held.st_size<1 || held.st_size>1048576 || strcmp(j->file->name,"export-stage.tmp") ||
        fstatat(j->root->fd,"export-stage.tmp",&current,AT_SYMLINK_NOFOLLOW) || !identity(&held,&current)) { j->outcome=1; return; }
    int fd=destination(j,name); if(fd<0) { j->outcome=1; return; }
    struct stat selected,current_parent;
    if(j->root->destination_fd<0 || strcmp(j->root->destination,j->path) ||
        fstat(fd,&current_parent) || fstat(j->root->destination_fd,&selected) || !identity(&selected,&current_parent)) {
      close(fd); j->outcome=1; return;
    }
#ifdef __APPLE__
    int result=renameatx_np(j->root->fd,"export-stage.tmp",fd,name,RENAME_EXCL);
#else
    int result=renameat2(j->root->fd,"export-stage.tmp",fd,name,RENAME_NOREPLACE);
#endif
    if (!result) j->outcome=(fsync(j->root->fd)||fsync(fd))?2:0;
    else j->outcome=(errno==EEXIST||errno==EXDEV||errno==EINVAL||errno==ENOSYS)?1:2;
    close(fd); return;
  }
  if (!strcmp(j->operation,"fileStat") || !strcmp(j->operation,"read") || !strcmp(j->operation,"write") || !strcmp(j->operation,"sync")) {
    struct stat current;
    if (j->file->fd<0 || !file_safe(j->file->fd,&current) ||
        fstatat(j->root->fd,j->file->name,&j->stat,AT_SYMLINK_NOFOLLOW) || !identity(&current,&j->stat)) { j->error=EACCES; return; }
    if (!strcmp(j->operation,"fileStat")) return;
    if ((!strcmp(j->operation,"write") || !strcmp(j->operation,"sync")) && j->root->lock_fd<0) { j->error=EACCES; return; }
    if (!strcmp(j->operation,"sync")) { if(sync_file(j->file->fd))j->error=errno; return; }
    if (!strcmp(j->operation,"read")) {
      ssize_t count=pread(j->file->fd,j->buffer+j->offset,j->length,(off_t)j->number);
      if(count<0)j->error=errno; else j->number=(int)count; return;
    }
    if (j->buffer_size>(size_t)name_limit(j->root,j->file->name) || current.st_size!=0) { j->error=EOVERFLOW; return; }
    size_t written=0;
    while(written<j->buffer_size) {
      ssize_t count=pwrite(j->file->fd,j->buffer+written,j->buffer_size-written,(off_t)written);
      if(count<=0) { j->error=count?errno:EIO; return; } written+=(size_t)count;
    }
    return;
  }
  if (!name_limit(j->root,j->path) || (!strcmp(j->path,"writer.lock") && strcmp(j->operation,"stat"))) { j->error=EACCES; return; }
  if (!strcmp(j->operation,"stat")) { if(fstatat(j->root->fd,j->path,&j->stat,AT_SYMLINK_NOFOLLOW))j->error=errno; return; }
  if (j->root->lock_fd<0 && strcmp(j->operation,"openRead")) { j->error=EACCES; return; }
  if (!strcmp(j->operation,"openRead") || !strcmp(j->operation,"openCreate")) {
    if (atomic_load(&j->root->files)>=MAX_FILES) { j->error=EOVERFLOW; return; }
    int flags=!strcmp(j->operation,"openRead")?O_RDONLY:O_CREAT|O_EXCL|O_WRONLY;
    int fd=openat(j->root->fd,j->path,flags|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK,0600);
    if(fd<0) { j->error=errno; return; }
    struct stat st;
    if(!file_safe(fd,&st) || st.st_size>name_limit(j->root,j->path)) { close(fd); j->error=EACCES; return; }
    j->result=new_handle(fd,2,j->root); if(!j->result) { j->error=ENOMEM; return; }
    strcpy(j->result->name,j->path); return;
  }
  struct stat st;
  int fd=openat(j->root->fd,j->path,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);
  if(fd<0) { j->error=errno; return; }
  if(!file_safe(fd,&st)) { close(fd); j->error=EACCES; return; }
  close(fd);
  if (!strcmp(j->operation,"remove")) {
    /* Replacement recovery never deletes evidence, including incomplete writes. */
    if (j->root->replacement) { j->error=EACCES; return; }
    if(unlinkat(j->root->fd,j->path,0)||fsync(j->root->fd))j->error=errno;
    return;
  }
  if (!strcmp(j->operation,"replace") && name_limit(j->root,j->second) && strcmp(j->second,"writer.lock")) {
    if (j->root->replacement && (strcmp(j->path,"replacement.tmp") || strcmp(j->second,"replacement.enc"))) { j->error=EACCES; return; }
    if(st.st_size>name_limit(j->root,j->second)) { j->error=EOVERFLOW; return; }
    struct stat target;
    if(!fstatat(j->root->fd,j->second,&target,AT_SYMLINK_NOFOLLOW)) {
      int existing=openat(j->root->fd,j->second,O_RDONLY|O_NOFOLLOW|O_CLOEXEC|O_NONBLOCK);
      if(existing<0 || !file_safe(existing,&target)) { if(existing>=0)close(existing); j->error=EACCES; return; }
      close(existing);
    } else if(errno!=ENOENT) { j->error=errno; return; }
    if(renameat(j->root->fd,j->path,j->root->fd,j->second)||fsync(j->root->fd))j->error=errno;
    return;
  }
  j->error=EACCES;
}

_Static_assert(sizeof(handle)*(MAX_FILES+1)+sizeof(job)<=65536,"bounded_native_metadata");

#ifndef ORCA_STORAGE_STANDALONE
static const napi_type_tag handle_tag = {UINT64_C(0x828e413729f04dca),UINT64_C(0x8f10cda605a307a1)};
static handle *unwrap(napi_env env, napi_value value) {
  bool matches=false; void *pointer=NULL;
  if(napi_check_object_type_tag(env,value,&handle_tag,&matches)!=napi_ok || !matches || napi_unwrap(env,value,&pointer)!=napi_ok) return NULL;
  return pointer;
}
static napi_value failure(napi_env env, int error) {
  const char *code=error==ENOENT?"ENOENT":error==EEXIST?"EEXIST":error==EOVERFLOW?"capacity_limited":error==EBUSY?"publication_pending":"unavailable";
  napi_value message,value,tag;
  if(napi_create_string_utf8(env,"unavailable",NAPI_AUTO_LENGTH,&message)!=napi_ok || napi_create_error(env,NULL,message,&value)!=napi_ok ||
      napi_create_string_utf8(env,code,NAPI_AUTO_LENGTH,&tag)!=napi_ok || napi_set_named_property(env,value,"code",tag)!=napi_ok) return NULL;
  return value;
}
static int property(napi_env env,napi_value object,const char *key,double number) {
  napi_value value; return napi_create_double(env,number,&value)==napi_ok && napi_set_named_property(env,object,key,value)==napi_ok;
}
static napi_value statistic(napi_env env,const struct stat *st) {
  if(st->st_size<0 || (uint64_t)st->st_size>UINT64_C(9007199254740991))return NULL;
  napi_value value,dev,ino;
  if(napi_create_object(env,&value)!=napi_ok || napi_create_bigint_uint64(env,(uint64_t)st->st_dev,&dev)!=napi_ok ||
      napi_create_bigint_uint64(env,(uint64_t)st->st_ino,&ino)!=napi_ok || napi_set_named_property(env,value,"dev",dev)!=napi_ok ||
      napi_set_named_property(env,value,"ino",ino)!=napi_ok || !property(env,value,"uid",st->st_uid) ||
      !property(env,value,"mode",st->st_mode) || !property(env,value,"nlink",st->st_nlink) ||
      !property(env,value,"size",(double)st->st_size) || !property(env,value,"kind",S_ISREG(st->st_mode)?1:S_ISDIR(st->st_mode)?2:S_ISLNK(st->st_mode)?3:0))return NULL;
  return value;
}
static void cleanup(job *j) {
  if(j->root_ref)napi_delete_reference(j->env,j->root_ref);
  if(j->file_ref)napi_delete_reference(j->env,j->file_ref);
  if(j->buffer_ref)napi_delete_reference(j->env,j->buffer_ref);
  if(j->work)napi_delete_async_work(j->env,j->work);
  free(j);
}
static void complete(napi_env env,napi_status status,void *data) {
  job *j=data; napi_value result=NULL;
  if(status!=napi_ok && !j->error)j->error=EIO;
  if(!j->error) {
    if(j->result) {
      if(napi_create_object(env,&result)!=napi_ok || napi_type_tag_object(env,result,&handle_tag)!=napi_ok ||
          napi_wrap(env,result,j->result,finalize,NULL,NULL)!=napi_ok) { result=NULL; release_handle(j->result); }
    } else if(!strcmp(j->operation,"list")) {
      if(napi_create_array_with_length(env,(size_t)j->number,&result)==napi_ok) {
        for(int i=0;i<j->number;++i) {
          napi_value name;
          if(napi_create_string_utf8(env,j->names[i],NAPI_AUTO_LENGTH,&name)!=napi_ok || napi_set_element(env,result,(uint32_t)i,name)!=napi_ok) { result=NULL; break; }
        }
      }
    } else if(!strcmp(j->operation,"rootStat") || !strcmp(j->operation,"stat") || !strcmp(j->operation,"fileStat")) result=statistic(env,&j->stat);
    else if(!strcmp(j->operation,"read")) { if(napi_create_uint32(env,(uint32_t)j->number,&result)!=napi_ok)result=NULL; }
    else if(!strcmp(j->operation,"stopped") || !strcmp(j->operation,"validateDestination")) { if(napi_get_boolean(env,j->number!=0,&result)!=napi_ok)result=NULL; }
    else if(!strcmp(j->operation,"publish")) { if(napi_create_string_utf8(env,j->outcome==0?"saved":j->outcome==1?"refused":"unknown",NAPI_AUTO_LENGTH,&result)!=napi_ok)result=NULL; }
    else if(napi_get_undefined(env,&result)!=napi_ok)result=NULL;
    if(!result)j->error=EIO;
  } else if(j->result)release_handle(j->result);
  if(j->root)atomic_store(&j->root->busy,0);
  if(!j->error && (!strcmp(j->operation,"closeFile") || !strcmp(j->operation,"closeRoot"))) {
    napi_value object; void *pointer=NULL;
    napi_ref reference=!strcmp(j->operation,"closeFile")?j->file_ref:j->root_ref;
    if(napi_get_reference_value(env,reference,&object)==napi_ok && napi_remove_wrap(env,object,&pointer)==napi_ok)release_handle(pointer);
  }
  if(j->error)napi_reject_deferred(env,j->deferred,failure(env,j->error));
  else napi_resolve_deferred(env,j->deferred,result);
  cleanup(j);
}
static int text_arg(napi_env env,napi_value value,char *target,size_t capacity) {
  size_t length;
  return napi_get_value_string_utf8(env,value,NULL,0,&length)==napi_ok && length<capacity &&
      napi_get_value_string_utf8(env,value,target,capacity,&length)==napi_ok && strlen(target)==length;
}
static int number_arg(napi_env env,napi_value value,size_t *result) {
  double number;
  if(napi_get_value_double(env,value,&number)!=napi_ok || !(number>=0 && number<=MAX_BYTES) || number!=(double)(size_t)number)return 0;
  *result=(size_t)number; return 1;
}
static napi_value dispatch(napi_env env,napi_callback_info info) {
  napi_value argv[9],promise,resource;
  size_t argc=9;
  job *j=calloc(1,sizeof(*j)); if(!j)return NULL; j->env=env;
  if(napi_create_promise(env,&j->deferred,&promise)!=napi_ok) { free(j); return NULL; }
  int owns_busy=0;
  size_t position;
  if(napi_get_cb_info(env,info,&argc,argv,NULL,NULL)!=napi_ok || argc!=9 ||
      !text_arg(env,argv[0],j->operation,sizeof(j->operation)) || !text_arg(env,argv[3],j->path,sizeof(j->path)) ||
      !text_arg(env,argv[4],j->second,sizeof(j->second)) || !number_arg(env,argv[6],&j->offset) ||
      !number_arg(env,argv[7],&j->length) || !number_arg(env,argv[8],&position))goto invalid;
  j->number=(int)position;
  if(strcmp(j->operation,"openRoot") && strcmp(j->operation,"provisionReplacementRoot") && strcmp(j->operation,"pairCopy") && strcmp(j->operation,"pairRestore")) {
    j->root=unwrap(env,argv[1]);
    if(!j->root || j->root->kind!=1 || napi_create_reference(env,argv[1],1,&j->root_ref)!=napi_ok)goto invalid;
    if(atomic_exchange(&j->root->busy,1)) { j->error=EBUSY; goto invalid; }
    owns_busy=1;
  }
  if(!strcmp(j->operation,"fileStat") || !strcmp(j->operation,"read") || !strcmp(j->operation,"write") ||
      !strcmp(j->operation,"sync") || !strcmp(j->operation,"closeFile") || !strcmp(j->operation,"publish")) {
    j->file=unwrap(env,argv[2]);
    if(!j->file || j->file->kind!=2 || j->file->owner!=j->root || napi_create_reference(env,argv[2],1,&j->file_ref)!=napi_ok)goto invalid;
  }

  if(!strcmp(j->operation,"pairCopy") || !strcmp(j->operation,"pairRestore")) {
    bool is_buffer=false;char binding[257];unsigned long long a,b,c,d;char extra;
    if(napi_is_buffer(env,argv[5],&is_buffer)!=napi_ok || !is_buffer || napi_get_buffer_info(env,argv[5],(void**)&j->buffer,&j->buffer_size)!=napi_ok || j->buffer_size>256 || !j->buffer_size)goto invalid;
    memcpy(binding,j->buffer,j->buffer_size);binding[j->buffer_size]=0;
    if(sscanf(binding,"%llu:%llu:%llu:%llu%c",&a,&b,&c,&d,&extra)!=4)goto invalid;
    j->pair_source_dev=a;j->pair_source_ino=b;j->pair_destination_dev=c;j->pair_destination_ino=d;
  }

  if(!strcmp(j->operation,"read") || !strcmp(j->operation,"write")) {
    bool is_buffer=false;
    if(napi_is_buffer(env,argv[5],&is_buffer)!=napi_ok || !is_buffer || napi_get_buffer_info(env,argv[5],(void**)&j->buffer,&j->buffer_size)!=napi_ok ||
        j->buffer_size>MAX_BYTES || j->offset>j->buffer_size || j->length>j->buffer_size-j->offset ||
        napi_create_reference(env,argv[5],1,&j->buffer_ref)!=napi_ok)goto invalid;
  }
  if(napi_create_string_utf8(env,"orca-diagnostics-storage",NAPI_AUTO_LENGTH,&resource)!=napi_ok ||
      napi_create_async_work(env,NULL,resource,execute,complete,j,&j->work)!=napi_ok || napi_queue_async_work(env,j->work)!=napi_ok)goto invalid;
  return promise;
invalid:
  if(owns_busy)atomic_store(&j->root->busy,0);
  napi_reject_deferred(env,j->deferred,failure(env,j->error?j->error:EACCES)); cleanup(j); return promise;
}

static napi_value flush_descriptor(napi_env env,napi_callback_info info) {
  napi_value value;size_t argc=1;int32_t fd;struct stat st;
  if(napi_get_cb_info(env,info,&argc,&value,NULL,NULL)!=napi_ok || argc!=1 || napi_get_value_int32(env,value,&fd)!=napi_ok || fd<0 ||
      !file_safe(fd,&st) || st.st_size>16384 || sync_file(fd)) {
    napi_throw(env,failure(env,EACCES));return NULL;
  }
  napi_get_undefined(env,&value);return value;
}

static napi_value initialize(napi_env env,napi_value exports) {
  napi_value abi,platform,call,replacement,flush;
#ifdef __APPLE__
  const char *name="darwin";
#else
  const char *name="posix-fixture";
#endif
  if(napi_create_uint32(env,1,&abi)!=napi_ok || napi_create_string_utf8(env,name,NAPI_AUTO_LENGTH,&platform)!=napi_ok ||
      napi_create_function(env,"call",NAPI_AUTO_LENGTH,dispatch,NULL,&call)!=napi_ok || napi_set_named_property(env,exports,"abi",abi)!=napi_ok ||
      napi_set_named_property(env,exports,"platform",platform)!=napi_ok || napi_set_named_property(env,exports,"call",call)!=napi_ok ||
      napi_create_uint32(env,1,&replacement)!=napi_ok || napi_set_named_property(env,exports,"replacementStorage",replacement)!=napi_ok ||
      napi_create_function(env,"flushDescriptorSync",NAPI_AUTO_LENGTH,flush_descriptor,NULL,&flush)!=napi_ok || napi_set_named_property(env,exports,"flushDescriptorSync",flush)!=napi_ok ||
      napi_object_freeze(env,exports)!=napi_ok)return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize)

#endif /* ORCA_STORAGE_STANDALONE */
