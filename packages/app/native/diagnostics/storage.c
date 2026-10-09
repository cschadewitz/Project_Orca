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
  if (!strcmp(j->operation,"openRoot")) {
    if (j->second[0] && strcmp(j->second,"replacement")) { j->error=EACCES; return; }
    /* A missing recovery root is lost authority, never implicit fresh provisioning. */
    int fd=directory(j->path,j->offset==1 && !j->second[0],1);
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
  if(strcmp(j->operation,"openRoot")) {
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
static napi_value initialize(napi_env env,napi_value exports) {
  napi_value abi,platform,call,replacement;
#ifdef __APPLE__
  const char *name="darwin";
#else
  const char *name="posix-fixture";
#endif
  if(napi_create_uint32(env,1,&abi)!=napi_ok || napi_create_string_utf8(env,name,NAPI_AUTO_LENGTH,&platform)!=napi_ok ||
      napi_create_function(env,"call",NAPI_AUTO_LENGTH,dispatch,NULL,&call)!=napi_ok || napi_set_named_property(env,exports,"abi",abi)!=napi_ok ||
      napi_set_named_property(env,exports,"platform",platform)!=napi_ok || napi_set_named_property(env,exports,"call",call)!=napi_ok ||
      napi_create_uint32(env,1,&replacement)!=napi_ok || napi_set_named_property(env,exports,"replacementStorage",replacement)!=napi_ok ||
      napi_object_freeze(env,exports)!=napi_ok)return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize)

#endif /* ORCA_STORAGE_STANDALONE */
