/* Windows NTFS-only async storage. No path fallback, ACL repair or capture policy. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <winternl.h>
#include <node_api.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <errno.h>
#include <wchar.h>
#define MAX_BYTES 1064960
#define MAX_FILES 4
#define MAX_ENTRIES 16
#undef PATH_MAX
#define PATH_MAX 2048
#define MAX_COMPONENTS 64
#define NT_OPEN 1
#define NT_CREATE 2
#define NT_OPEN_IF 3
#define NT_DIRECTORY 1
#define NT_WRITE_THROUGH 2
#define NT_SYNCHRONOUS 32
#define NT_NON_DIRECTORY 64
#define NT_OPEN_REPARSE 0x00200000
/* Windows Interlocked is available in both MSVC C11 and the local GNU toolchain. */
#define atomic_init(target,value) (*(target)=(value))
#define atomic_load(target) InterlockedCompareExchange((target),0,0)
#define atomic_store(target,value) InterlockedExchange((target),(value))
#define atomic_exchange(target,value) InterlockedExchange((target),(value))
#define atomic_fetch_add(target,value) InterlockedExchangeAdd((target),(LONG)(value))
#define atomic_fetch_sub(target,value) InterlockedExchangeAdd((target),-(LONG)(value))
typedef NTSTATUS (NTAPI *create_file_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS (NTAPI *set_information_fn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
typedef struct { uint64_t st_dev, st_ino, st_size; unsigned st_uid, st_mode, st_nlink, kind; } win_stat;
typedef struct { HANDLE fd[MAX_COMPONENTS]; unsigned count; } chain;
typedef struct handle {
  HANDLE fd, lock_fd;
  int kind;
  struct handle *owner;
  volatile LONG references, files, busy;
  chain ancestry, destination_ancestry;
  char path[PATH_MAX], destination[PATH_MAX], name[64];
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
  win_stat stat;
  char names[MAX_ENTRIES][64];
} job;

static void close_chain(chain *c) {
  while (c->count) CloseHandle(c->fd[--c->count]);
}
static HANDLE relative_open(HANDLE parent, const wchar_t *name, DWORD access,
    ULONG disposition, int directory, SECURITY_DESCRIPTOR *security, DWORD sharing) {
  create_file_fn create = NULL;
  HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
  FARPROC address = ntdll ? GetProcAddress(ntdll, "NtCreateFile") : NULL;
  memcpy(&create, &address, sizeof(create));
  size_t length = wcslen(name);
  if (!create || !length || length > 1023) { errno = EACCES; return INVALID_HANDLE_VALUE; }
  UNICODE_STRING text = { (USHORT)(length * 2), (USHORT)(length * 2), (PWSTR)name };
  OBJECT_ATTRIBUTES attributes = {0};
  attributes.Length=(ULONG)sizeof(attributes); attributes.RootDirectory=parent;
  /* The fixed drive-root bootstrap resolves the DOS device; every supplied
     component below it forbids reparsing. The resolved volume root is checked. */
  attributes.ObjectName=&text; attributes.Attributes=OBJ_CASE_INSENSITIVE|((parent && directory!=-1)?OBJ_DONT_REPARSE:0);
  attributes.SecurityDescriptor=security;
  IO_STATUS_BLOCK result;
  HANDLE fd = INVALID_HANDLE_VALUE;
  NTSTATUS status = create(&fd, access | SYNCHRONIZE, &attributes, &result, NULL,
    FILE_ATTRIBUTE_NORMAL, sharing, disposition,
    NT_SYNCHRONOUS | NT_OPEN_REPARSE | (directory==1 ? NT_DIRECTORY : directory==0 ? NT_NON_DIRECTORY : 0) |
    (access & FILE_WRITE_DATA ? NT_WRITE_THROUGH : 0), NULL, 0);
  if (status < 0) {
    /* Closed status inventory: no exception text, path or NT status escapes. */
    errno = (status == (NTSTATUS)0xc0000034 || status == (NTSTATUS)0xc000003a) ? ENOENT :
      status == (NTSTATUS)0xc0000035 ? EEXIST :
      (status == (NTSTATUS)0xc0000043 || status == (NTSTATUS)0xc0000054) ? EBUSY : EACCES;
    return INVALID_HANDLE_VALUE;
  }
  return fd;
}
static int wide(const char *text, wchar_t *result, unsigned capacity) {
  return MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, result, (int)capacity) > 0;
}
static int component(const wchar_t *part) {
  size_t length = wcslen(part);
  if (!length || length > 255 || part[length-1] == L'.' || part[length-1] == L' ') return 0;
  for (size_t i=0; i<length; ++i)
    if (part[i] < 32 || wcschr(L"\\/:*?\"<>|", part[i])) return 0;
  wchar_t stem[256]; wcscpy(stem, part);
  wchar_t *dot = wcschr(stem,L'.'); if (dot) *dot = 0;
  if (!_wcsicmp(stem,L"CON") || !_wcsicmp(stem,L"PRN") || !_wcsicmp(stem,L"AUX") || !_wcsicmp(stem,L"NUL")) return 0;
  if (wcslen(stem)==4 && ((!_wcsnicmp(stem,L"COM",3)) || (!_wcsnicmp(stem,L"LPT",3))) && stem[3]>=L'1' && stem[3]<=L'9') return 0;
  return 1;
}
/* Fixed buffers, explicit current token and simple ACEs only. Unknown ACLs refuse. */
typedef struct { unsigned char token[256], system[SECURITY_MAX_SID_SIZE], admin[SECURITY_MAX_SID_SIZE], installer[SECURITY_MAX_SID_SIZE]; } identities;
static int user_identities(identities *ids) {
  HANDLE token;
  DWORD length = (DWORD)sizeof(ids->token), system = (DWORD)sizeof(ids->system), admin = (DWORD)sizeof(ids->admin);
  if (!OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token)) return 0;
  int ok = GetTokenInformation(token,TokenUser,ids->token,length,&length);
  CloseHandle(token);
  /* Derive one fixed local Windows service principal; no account-name lookup or network. */
  typedef NTSTATUS (NTAPI *service_sid_fn)(PUNICODE_STRING, PSID, PULONG);
  service_sid_fn service_sid=NULL;
  FARPROC address=GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"RtlCreateServiceSid");
  memcpy(&service_sid,&address,sizeof(service_sid));
  wchar_t service[]=L"TrustedInstaller";
  UNICODE_STRING name={(USHORT)(sizeof(service)-sizeof(wchar_t)),(USHORT)sizeof(service),service};
  ULONG installer=(ULONG)sizeof(ids->installer);
  return ok && IsValidSid(((TOKEN_USER*)ids->token)->User.Sid) && service_sid &&
    service_sid(&name,ids->installer,&installer)>=0 && installer<=sizeof(ids->installer) && IsValidSid(ids->installer) &&
    CreateWellKnownSid(WinLocalSystemSid,NULL,ids->system,&system) &&
    CreateWellKnownSid(WinBuiltinAdministratorsSid,NULL,ids->admin,&admin);
}
static int trusted_sid(PSID sid, const identities *ids, int private_object) {
  return IsValidSid(sid) && (EqualSid(sid,((const TOKEN_USER*)ids->token)->User.Sid) ||
    EqualSid(sid,(PSID)ids->system) || (!private_object && (EqualSid(sid,(PSID)ids->admin) || EqualSid(sid,(PSID)ids->installer))));
}
static int safe_acl(HANDLE fd, int private_object) {
  identities ids;
  unsigned char bytes[8192]; DWORD required = 0;
  PSID owner; BOOL defaulted, present; PACL acl;
  if (!user_identities(&ids) || !GetKernelObjectSecurity(fd, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      bytes,(DWORD)sizeof(bytes),&required) || required>sizeof(bytes) ||
      !IsValidSecurityDescriptor(bytes) || !GetSecurityDescriptorOwner(bytes,&owner,&defaulted) ||
      !GetSecurityDescriptorDacl(bytes,&present,&acl,&defaulted) || !present || !acl || !IsValidAcl(acl) ||
      acl->AceCount>128 || !IsValidSid(owner) ||
      (private_object ? !EqualSid(owner,((TOKEN_USER*)ids.token)->User.Sid) : !trusted_sid(owner,&ids,0))) return 0;
  /* Ancestor ownership can be TrustedInstaller; its effective DACL must still forbid
     untrusted mutation of existing children/ancestry. New-child creation alone is OK. */
  for (unsigned i=0; i<acl->AceCount; ++i) {
    ACE_HEADER *header;
    if (!GetAce(acl,i,(void**)&header) || header->AceSize<sizeof(ACCESS_ALLOWED_ACE)) return 0;
    if (header->AceFlags & INHERIT_ONLY_ACE) continue;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) return 0;
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE*)header;
    PSID sid = &ace->SidStart;
    if (!IsValidSid(sid) || sizeof(ACCESS_ALLOWED_ACE)-sizeof(DWORD)+GetLengthSid(sid)>header->AceSize) return 0;
    if (!trusted_sid(sid,&ids,private_object) &&
        (private_object || (ace->Mask & (GENERIC_ALL|GENERIC_WRITE|DELETE|WRITE_DAC|WRITE_OWNER|FILE_DELETE_CHILD|FILE_WRITE_ATTRIBUTES|FILE_WRITE_EA)))) return 0;
  }
  return 1;
}
static int new_security(SECURITY_DESCRIPTOR *descriptor, unsigned char *acl_bytes, identities *ids) {
  PSID user = ((TOKEN_USER*)ids->token)->User.Sid;
  return InitializeSecurityDescriptor(descriptor,SECURITY_DESCRIPTOR_REVISION) &&
    InitializeAcl((PACL)acl_bytes,256,ACL_REVISION) &&
    AddAccessAllowedAceEx((PACL)acl_bytes,ACL_REVISION,OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE,FILE_ALL_ACCESS,user) &&
    AddAccessAllowedAceEx((PACL)acl_bytes,ACL_REVISION,OBJECT_INHERIT_ACE|CONTAINER_INHERIT_ACE,FILE_ALL_ACCESS,ids->system) &&
    SetSecurityDescriptorOwner(descriptor,user,FALSE) &&
    SetSecurityDescriptorDacl(descriptor,TRUE,(PACL)acl_bytes,FALSE) &&
    SetSecurityDescriptorControl(descriptor,SE_DACL_PROTECTED,SE_DACL_PROTECTED);
}
static int info(HANDLE fd, win_stat *st) {
  BY_HANDLE_FILE_INFORMATION value;
  if (fd == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(fd,&value)) return 0;
  st->st_dev = value.dwVolumeSerialNumber;
  st->st_ino = ((uint64_t)value.nFileIndexHigh<<32)|value.nFileIndexLow;
  st->st_size = ((uint64_t)value.nFileSizeHigh<<32)|value.nFileSizeLow;
  st->st_nlink = value.nNumberOfLinks; st->st_uid = 0;
  st->kind = (value.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ? 3 :
    (value.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) ? 2 : 1;
  st->st_mode = st->kind==2 ? 0700 : 0600;
  return st->st_size <= UINT64_C(9007199254740991);
}
static int identity(const win_stat *a, const win_stat *b) { return a->st_dev==b->st_dev && a->st_ino==b->st_ino; }
static int file_safe(HANDLE fd, win_stat *st) {
  if(!info(fd,st) || st->kind!=1 || st->st_nlink!=1 || st->st_size>MAX_BYTES || !safe_acl(fd,1)) return 0;
  return 1;
}
static int directory(const char *path, int create, int private_root, chain *out) {
  wchar_t copy[1024];
  if (!wide(path,copy,1024) || wcslen(copy)<4 || copy[1]!=L':' || copy[2]!=L'\\' ||
      !((copy[0]>=L'A'&&copy[0]<=L'Z')||(copy[0]>=L'a'&&copy[0]<=L'z'))) { errno=EACCES; return 0; }
  wchar_t drive[] = L"\\??\\C:\\"; drive[4]=copy[0];
  HANDLE first = relative_open(NULL,drive,FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES|READ_CONTROL,NT_OPEN,1,NULL,FILE_SHARE_READ|FILE_SHARE_WRITE);
  if (first==INVALID_HANDLE_VALUE) return 0;
  out->fd[out->count++]=first;
  wchar_t volume[128];
  DWORD volume_length=GetFinalPathNameByHandleW(first,volume,128,FILE_NAME_NORMALIZED|VOLUME_NAME_GUID);
  if(!volume_length || volume_length>=128 || wcsncmp(volume,L"\\\\?\\Volume{",11) || volume_length!=49 || wcscmp(volume+47,L"}\\")) { errno=EACCES; goto refused; }
  wchar_t fs[32];
  if (!GetVolumeInformationByHandleW(first,NULL,0,NULL,NULL,NULL,fs,32) || wcscmp(fs,L"NTFS")) { errno=EACCES; goto refused; }
  wchar_t *part=copy+3;
  while (*part) {
    wchar_t *end=wcschr(part,L'\\'); if (end) *end=0;
    if (!component(part) || out->count>=MAX_COMPONENTS || (end && !end[1])) { errno=EACCES; goto refused; }
    SECURITY_DESCRIPTOR sd; unsigned char acl[256]; identities ids;
    SECURITY_DESCRIPTOR *security=NULL;
    if (create && !end) {
      if (!user_identities(&ids) || !new_security(&sd,acl,&ids)) { errno=EACCES; goto refused; }
      security=&sd;
    }
    HANDLE next=relative_open(out->fd[out->count-1],part,FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES|READ_CONTROL,
      NT_OPEN,1,NULL,FILE_SHARE_READ|FILE_SHARE_WRITE);
    if (next==INVALID_HANDLE_VALUE && errno==ENOENT && security)
      next=relative_open(out->fd[out->count-1],part,FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES|READ_CONTROL,
        NT_CREATE,1,security,FILE_SHARE_READ|FILE_SHARE_WRITE);
    if (next==INVALID_HANDLE_VALUE) goto refused;
    out->fd[out->count++]=next;
    win_stat st;
    if (!info(next,&st) || st.kind!=2 || !safe_acl(next,private_root && !end)) { errno=EACCES; goto refused; }
    if (!end) break;
    part=end+1;
  }
  return 1;
refused:
  close_chain(out); return 0;
}
static int name_limit(const char *name) {
  const char *controls[]={"setting.json","setting.json.tmp","manifest.json","manifest.json.tmp","control.key","control.key.tmp","export.json","export.json.tmp","writer.lock",NULL};
  for(int i=0;controls[i];++i)if(!strcmp(name,controls[i]))return 4096;
  if(!strcmp(name,"export-stage.tmp"))return 1048576;
  if(strlen(name)==10 && !strncmp(name,"slot-",5) && name[5]>='0' && name[5]<='2' && !strcmp(name+6,".bin"))return MAX_BYTES;
  if(strlen(name)==13 && !strncmp(name,"session-",8) && name[8]>='0' && name[8]<='2' && !strcmp(name+9,".key"))return 4096;
  return 0;
}
static HANDLE child(handle *root, const char *name, DWORD access, ULONG disposition, DWORD sharing) {
  wchar_t text[64]; SECURITY_DESCRIPTOR sd; unsigned char acl[256]; identities ids;
  if (!name_limit(name) || !wide(name,text,64)) { errno=EACCES; return INVALID_HANDLE_VALUE; }
  SECURITY_DESCRIPTOR *security=NULL;
  if(disposition!=NT_OPEN) {
    if(!user_identities(&ids) || !new_security(&sd,acl,&ids)) { errno=EACCES; return INVALID_HANDLE_VALUE; }
    security=&sd;
  }
  return relative_open(root->fd,text,access|READ_CONTROL|FILE_READ_ATTRIBUTES,disposition,0,security,sharing);
}
static HANDLE child_stat(handle *root,const char *name) {
  wchar_t text[64];
  if(!name_limit(name) || !wide(name,text,64)) { errno=EACCES; return INVALID_HANDLE_VALUE; }
  // Only one closed basename under the held root. Inspect the leaf reparse object
  // itself, never its target; required to preserve an unsafe stage during opt-out.
  return relative_open(root->fd,text,FILE_READ_ATTRIBUTES|READ_CONTROL,NT_OPEN,-1,NULL,
    FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE);
}
static int root_safe(handle *root) {
  if (!root || root->kind!=1 || root->fd==INVALID_HANDLE_VALUE || !root->ancestry.count) { errno=EACCES; return 0; }
  for(unsigned i=0;i<root->ancestry.count;++i) {
    win_stat st;
    if(!info(root->ancestry.fd[i],&st) || st.kind!=2 || !safe_acl(root->ancestry.fd[i],i==root->ancestry.count-1)) { errno=EACCES; return 0; }
  }
  if(root->lock_fd!=INVALID_HANDLE_VALUE) {
    HANDLE current=child(root,"writer.lock",FILE_READ_ATTRIBUTES,NT_OPEN,FILE_SHARE_READ|FILE_SHARE_WRITE);
    win_stat held, entry;
    int safe=current!=INVALID_HANDLE_VALUE && file_safe(root->lock_fd,&held) && held.st_size<=4096 && info(current,&entry) && identity(&held,&entry);
    if(current!=INVALID_HANDLE_VALUE)CloseHandle(current);
    if(!safe) { errno=EACCES; return 0; }
  }
  return 1;
}
static void release_handle(handle *h) {
  if(!h || atomic_fetch_sub(&h->references,1)!=1)return;
  if(h->lock_fd!=INVALID_HANDLE_VALUE)CloseHandle(h->lock_fd);
  close_chain(&h->destination_ancestry);
  if(h->kind==1)close_chain(&h->ancestry);
  else if(h->fd!=INVALID_HANDLE_VALUE) { CloseHandle(h->fd); atomic_fetch_sub(&h->owner->files,1); }
  handle *owner=h->owner; free(h); if(owner)release_handle(owner);
}
static void finalize(napi_env env,void *data,void *hint) { (void)env; (void)hint; release_handle(data); }
static handle *new_handle(HANDLE fd,int kind,handle *owner) {
  handle *h=calloc(1,sizeof(*h)); if(!h)return NULL;
  h->fd=fd; h->lock_fd=INVALID_HANDLE_VALUE; h->kind=kind; h->owner=owner;
  atomic_init(&h->references,1); atomic_init(&h->files,0); atomic_init(&h->busy,0);
  if(owner) { atomic_fetch_add(&owner->references,1); atomic_fetch_add(&owner->files,1); }
  return h;
}
static int selected_destination(job *j,chain *selected,wchar_t *name) {
  wchar_t full[1024]; char parent[PATH_MAX];
  size_t root_length=strlen(j->root->path);
  if(!wide(j->path,full,1024) || !_strnicmp(j->root->path,j->path,root_length)) { errno=EACCES; return 0; }
  wchar_t *slash=wcsrchr(full,L'\\');
  if(!slash || !component(slash+1)) { errno=EACCES; return 0; }
  wcscpy(name,slash+1); *slash=0;
  if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,full,-1,parent,(int)sizeof(parent),NULL,NULL) || !directory(parent,0,0,selected)) return 0;
  win_stat from,to;
  HANDLE fd=selected->fd[selected->count-1];
  if(!info(j->root->fd,&from) || !info(fd,&to) || from.st_dev!=to.st_dev || identity(&from,&to))goto refused;
  HANDLE exists=relative_open(fd,name,FILE_READ_ATTRIBUTES|READ_CONTROL,NT_OPEN,0,NULL,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE);
  if(exists!=INVALID_HANDLE_VALUE) { CloseHandle(exists); goto refused; }
  if(errno!=ENOENT)goto refused;
  return 1;
refused:
  close_chain(selected); errno=EACCES; return 0;
}
static int rename_handle(HANDLE file,HANDLE parent,const wchar_t *name,int replace) {
  unsigned char bytes[sizeof(FILE_RENAME_INFO)+512];
  size_t size=wcslen(name)*sizeof(wchar_t);
  if(size>510) { errno=EACCES; return 0; }
  FILE_RENAME_INFO *rename=(FILE_RENAME_INFO*)bytes;
  memset(bytes,0,sizeof(bytes)); rename->ReplaceIfExists=(BOOLEAN)(replace!=0); rename->RootDirectory=parent;
  rename->FileNameLength=(DWORD)size; memcpy(rename->FileName,name,size);
  set_information_fn set=NULL;
  HMODULE ntdll=GetModuleHandleW(L"ntdll.dll");
  FARPROC address=ntdll?GetProcAddress(ntdll,"NtSetInformationFile"):NULL;
  memcpy(&set,&address,sizeof(set));
  if(!set) { errno=EACCES; return 0; }
  IO_STATUS_BLOCK result;
  NTSTATUS status=set(file,&result,rename,(ULONG)(sizeof(FILE_RENAME_INFO)+size),FileRenameInformation);
  if(status<0) { errno=status==(NTSTATUS)0xc0000035?EEXIST:EACCES; return 0; }
  return 1;
}
static void execute(napi_env env,void *data) {
  (void)env; job *j=data;
  if(!strcmp(j->operation,"openRoot")) {
    chain ancestry={0};
    if(!directory(j->path,j->offset==1,1,&ancestry)) { j->error=errno; return; }
    j->result=new_handle(ancestry.fd[ancestry.count-1],1,NULL);
    if(!j->result) { close_chain(&ancestry); j->error=ENOMEM; return; }
    j->result->ancestry=ancestry; strcpy(j->result->path,j->path); return;
  }
  if(!strcmp(j->operation,"closeRoot")) {
    if(atomic_load(&j->root->files)) { j->error=EBUSY; return; }
    if(j->root->lock_fd!=INVALID_HANDLE_VALUE)CloseHandle(j->root->lock_fd);
    j->root->lock_fd=INVALID_HANDLE_VALUE;
    close_chain(&j->root->destination_ancestry); close_chain(&j->root->ancestry);
    j->root->fd=INVALID_HANDLE_VALUE; return;
  }
  if(!strcmp(j->operation,"closeFile")) {
    if(j->file->fd!=INVALID_HANDLE_VALUE) { CloseHandle(j->file->fd); j->file->fd=INVALID_HANDLE_VALUE; atomic_fetch_sub(&j->root->files,1); } return;
  }
  if(!root_safe(j->root)) { j->error=errno; return; }
  if(!strcmp(j->operation,"rootStat")) { if(!info(j->root->fd,&j->stat))j->error=EACCES; return; }
  if(!strcmp(j->operation,"list")) {
    unsigned char buffer[4096]; int restart=1;
    for(unsigned page=0;page<=MAX_ENTRIES;++page) {
      if(!GetFileInformationByHandleEx(j->root->fd,restart?FileIdBothDirectoryRestartInfo:FileIdBothDirectoryInfo,buffer,(DWORD)sizeof(buffer))) {
        if(GetLastError()!=ERROR_NO_MORE_FILES)j->error=EACCES;
        return;
      }
      restart=0; unsigned offset=0;
      for(;;) {
        if(offset>sizeof(buffer)-sizeof(FILE_ID_BOTH_DIR_INFO)) { j->error=EOVERFLOW; return; }
        FILE_ID_BOTH_DIR_INFO *entry=(FILE_ID_BOTH_DIR_INFO*)(buffer+offset);
        if(entry->FileNameLength>510 || entry->FileNameLength%2 || offset+offsetof(FILE_ID_BOTH_DIR_INFO,FileName)+entry->FileNameLength>sizeof(buffer)) { j->error=EOVERFLOW; return; }
        wchar_t name[256]; memcpy(name,entry->FileName,entry->FileNameLength); name[entry->FileNameLength/2]=0;
        if(wcscmp(name,L".") && wcscmp(name,L"..")) {
          if(j->number>=MAX_ENTRIES || !WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,name,-1,j->names[j->number],64,NULL,NULL)) { j->error=EOVERFLOW; return; }
          j->number++;
        }
        if(!entry->NextEntryOffset)break;
        if(entry->NextEntryOffset<offsetof(FILE_ID_BOTH_DIR_INFO,FileName)+entry->FileNameLength || entry->NextEntryOffset>sizeof(buffer)-offset) { j->error=EOVERFLOW; return; }
        offset+=entry->NextEntryOffset;
      }
    }
    j->error=EOVERFLOW; return;
  }
  if(!strcmp(j->operation,"acquire")) {
    if(j->root->lock_fd!=INVALID_HANDLE_VALUE)return;
    HANDLE fd=child(j->root,"writer.lock",GENERIC_READ|GENERIC_WRITE,NT_OPEN_IF,FILE_SHARE_READ|FILE_SHARE_WRITE);
    win_stat st; OVERLAPPED position={0};
    if(fd==INVALID_HANDLE_VALUE) { j->error=errno; return; }
    if(!file_safe(fd,&st) || st.st_size>4096 || !LockFileEx(fd,LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY,0,MAXDWORD,MAXDWORD,&position) || !FlushFileBuffers(fd)) { CloseHandle(fd); j->error=EACCES; return; }
    j->root->lock_fd=fd; return;
  }
  if(!strcmp(j->operation,"release")) {
    if(j->root->lock_fd!=INVALID_HANDLE_VALUE)CloseHandle(j->root->lock_fd);
    j->root->lock_fd=INVALID_HANDLE_VALUE; return;
  }
  if(!strcmp(j->operation,"stopped")) { j->number=j->root->lock_fd!=INVALID_HANDLE_VALUE && atomic_load(&j->root->files)==0; return; }
  if(!strcmp(j->operation,"validateDestination")) {
    chain selected={0}; wchar_t name[256];
    if(!selected_destination(j,&selected,name))return;
    if(j->root->destination_ancestry.count && !strcmp(j->root->destination,j->path)) {
      win_stat held,actual;
      j->number=info(selected.fd[selected.count-1],&actual) && info(j->root->destination_ancestry.fd[j->root->destination_ancestry.count-1],&held) && identity(&held,&actual);
      close_chain(&selected);
    } else {
      close_chain(&j->root->destination_ancestry); j->root->destination_ancestry=selected;
      strcpy(j->root->destination,j->path); j->number=1;
    }
    return;
  }
  if(!strcmp(j->operation,"publish")) {
    j->outcome=1;
    if(j->root->lock_fd==INVALID_HANDLE_VALUE || strcmp(j->file->name,"export-stage.tmp") ||
        !j->root->destination_ancestry.count || strcmp(j->root->destination,j->path))return;
    /* A second handle forbids competing content writers throughout flush/rename.
       Rename uses this exact object, so a filename swap cannot publish another file. */
    HANDLE source=child(j->root,"export-stage.tmp",GENERIC_READ|GENERIC_WRITE|DELETE,NT_OPEN,FILE_SHARE_READ|FILE_SHARE_DELETE);
    win_stat held,current; chain selected={0}; wchar_t name[256];
    if(source==INVALID_HANDLE_VALUE)return;
    if(!file_safe(source,&current) || !file_safe(j->file->fd,&held) || !identity(&held,&current) || !current.st_size || current.st_size>1048576 || !selected_destination(j,&selected,name))goto publish_done;
    win_stat chosen,actual;
    HANDLE target=selected.fd[selected.count-1];
    if(!info(target,&actual) || !info(j->root->destination_ancestry.fd[j->root->destination_ancestry.count-1],&chosen) || !identity(&chosen,&actual) || !FlushFileBuffers(source))goto publish_done;
    if(rename_handle(source,target,name,0))j->outcome=FlushFileBuffers(source)?0:2;
    else j->outcome=errno==EEXIST?1:2;
publish_done:
    close_chain(&selected); CloseHandle(source); return;
  }
  if(!strcmp(j->operation,"fileStat") || !strcmp(j->operation,"read") || !strcmp(j->operation,"write") || !strcmp(j->operation,"sync")) {
    HANDLE current=child(j->root,j->file->name,FILE_READ_ATTRIBUTES,NT_OPEN,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE);
    win_stat held;
    int safe=current!=INVALID_HANDLE_VALUE && file_safe(j->file->fd,&held) && info(current,&j->stat) && identity(&held,&j->stat);
    if(current!=INVALID_HANDLE_VALUE)CloseHandle(current);
    if(!safe) { j->error=EACCES; return; }
    if(!strcmp(j->operation,"fileStat"))return;
    if((!strcmp(j->operation,"write") || !strcmp(j->operation,"sync")) && j->root->lock_fd==INVALID_HANDLE_VALUE) { j->error=EACCES; return; }
    if(!strcmp(j->operation,"sync")) { if(!FlushFileBuffers(j->file->fd))j->error=EACCES; return; }
    LARGE_INTEGER position; position.QuadPart=j->number;
    if(!SetFilePointerEx(j->file->fd,position,NULL,FILE_BEGIN)) { j->error=EACCES; return; }
    DWORD count=0;
    if(!strcmp(j->operation,"read")) {
      if(!ReadFile(j->file->fd,j->buffer+j->offset,(DWORD)j->length,&count,NULL))j->error=EACCES;
      else j->number=(int)count;
      return;
    }
    if(j->buffer_size>(size_t)name_limit(j->file->name) || held.st_size || j->offset || j->length!=j->buffer_size || j->number) { j->error=EOVERFLOW; return; }
    size_t written=0;
    while(written<j->buffer_size) {
      if(!WriteFile(j->file->fd,j->buffer+written,(DWORD)(j->buffer_size-written),&count,NULL) || !count) { j->error=EACCES; return; }
      written+=count;
    }
    return;
  }
  if(!name_limit(j->path) || (!strcmp(j->path,"writer.lock") && strcmp(j->operation,"stat"))) { j->error=EACCES; return; }
  if(!strcmp(j->operation,"stat")) {
    HANDLE fd=child_stat(j->root,j->path);
    if(fd==INVALID_HANDLE_VALUE) { j->error=errno; return; }
    if(!info(fd,&j->stat))j->error=EACCES;
    CloseHandle(fd); return;
  }
  if(j->root->lock_fd==INVALID_HANDLE_VALUE && strcmp(j->operation,"openRead")) { j->error=EACCES; return; }
  if(!strcmp(j->operation,"openRead") || !strcmp(j->operation,"openCreate")) {
    if(atomic_load(&j->root->files)>=MAX_FILES) { j->error=EOVERFLOW; return; }
    int reading=!strcmp(j->operation,"openRead");
    HANDLE fd=child(j->root,j->path,reading?GENERIC_READ:GENERIC_WRITE,reading?NT_OPEN:NT_CREATE,
      reading?FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE:FILE_SHARE_READ|FILE_SHARE_DELETE);
    if(fd==INVALID_HANDLE_VALUE) { j->error=errno; return; }
    win_stat st;
    if(!file_safe(fd,&st) || st.st_size>(unsigned)name_limit(j->path)) { CloseHandle(fd); j->error=EACCES; return; }
    j->result=new_handle(fd,2,j->root);
    if(!j->result) { CloseHandle(fd); j->error=ENOMEM; return; }
    strcpy(j->result->name,j->path); return;
  }
  HANDLE source=child(j->root,j->path,GENERIC_READ|GENERIC_WRITE|DELETE,NT_OPEN,FILE_SHARE_READ|FILE_SHARE_DELETE);
  if(source==INVALID_HANDLE_VALUE) { j->error=errno; return; }
  win_stat st;
  if(!file_safe(source,&st)) { j->error=EACCES; goto done; }
  if(!strcmp(j->operation,"remove")) {
    FILE_DISPOSITION_INFO disposition={TRUE};
    if(!SetFileInformationByHandle(source,FileDispositionInfo,&disposition,(DWORD)sizeof(disposition)))j->error=EACCES;
    goto done;
  }
  if(!strcmp(j->operation,"replace") && name_limit(j->second) && strcmp(j->second,"writer.lock")) {
    if(st.st_size>(unsigned)name_limit(j->second)) { j->error=EOVERFLOW; goto done; }
    HANDLE existing=child(j->root,j->second,GENERIC_READ,NT_OPEN,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE);
    win_stat target;
    if(existing!=INVALID_HANDLE_VALUE) {
      int safe=file_safe(existing,&target); CloseHandle(existing);
      if(!safe) { j->error=EACCES; goto done; }
    } else if(errno!=ENOENT) { j->error=errno; goto done; }
    wchar_t name[64];
    if(!wide(j->second,name,64) || !FlushFileBuffers(source) || !rename_handle(source,j->root->fd,name,1) || !FlushFileBuffers(source))j->error=EACCES;
    goto done;
  }
  j->error=EACCES;
done:
  CloseHandle(source);
}

_Static_assert(sizeof(handle)*(MAX_FILES+1)+sizeof(job)<=65536,"bounded_native_metadata");
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
static napi_value statistic(napi_env env,const win_stat *st) {
  if(st->st_size>UINT64_C(9007199254740991))return NULL;
  napi_value value,dev,ino;
  if(napi_create_object(env,&value)!=napi_ok || napi_create_bigint_uint64(env,(uint64_t)st->st_dev,&dev)!=napi_ok ||
      napi_create_bigint_uint64(env,(uint64_t)st->st_ino,&ino)!=napi_ok || napi_set_named_property(env,value,"dev",dev)!=napi_ok ||
      napi_set_named_property(env,value,"ino",ino)!=napi_ok || !property(env,value,"uid",st->st_uid) ||
      !property(env,value,"mode",st->st_mode) || !property(env,value,"nlink",st->st_nlink) ||
      !property(env,value,"size",(double)st->st_size) || !property(env,value,"kind",st->kind))return NULL;
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
  napi_value abi,platform,call;
  const char *name="win32";
  if(napi_create_uint32(env,1,&abi)!=napi_ok || napi_create_string_utf8(env,name,NAPI_AUTO_LENGTH,&platform)!=napi_ok ||
      napi_create_function(env,"call",NAPI_AUTO_LENGTH,dispatch,NULL,&call)!=napi_ok || napi_set_named_property(env,exports,"abi",abi)!=napi_ok ||
      napi_set_named_property(env,exports,"platform",platform)!=napi_ok || napi_set_named_property(env,exports,"call",call)!=napi_ok ||
      napi_object_freeze(env,exports)!=napi_ok)return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize)
