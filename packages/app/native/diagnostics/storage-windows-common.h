/* Shared Windows handle-relative security primitives. */
#ifndef ORCA_STORAGE_WINDOWS_COMMON
#define ORCA_STORAGE_WINDOWS_COMMON
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
#include "acl-policy.h"
#define MAX_BYTES 1064960
#define MAX_FILES 4
#define MAX_ENTRIES 16
#undef PATH_MAX
#define PATH_MAX 2048
#define MAX_COMPONENTS 64
#define ORCA_FILE_RENAME_INFORMATION ((FILE_INFORMATION_CLASS)10)
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
/* What an ACL read showed. Only ACL_WRITER is a positively identified cause a person can act on; an ACL that
   could not be read, validated or understood, an untrusted owner, or a non-private private folder is ACL_UNKNOWN. */
enum { ACL_UNKNOWN = 0, ACL_SAFE = 1, ACL_WRITER = 2 };
static int safe_acl_at(HANDLE fd, int private_object, int volume_root) {
  identities ids;
  unsigned char bytes[8192]; DWORD required = 0;
  PSID owner; BOOL defaulted, present; PACL acl;
  if (!user_identities(&ids) || !GetKernelObjectSecurity(fd, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      bytes,(DWORD)sizeof(bytes),&required) || required>sizeof(bytes) ||
      !IsValidSecurityDescriptor(bytes) || !GetSecurityDescriptorOwner(bytes,&owner,&defaulted) ||
      !GetSecurityDescriptorDacl(bytes,&present,&acl,&defaulted) || !present || !acl || !IsValidAcl(acl) ||
      acl->AceCount>128 || !IsValidSid(owner) ||
      (private_object ? !EqualSid(owner,((TOKEN_USER*)ids.token)->User.Sid) : !trusted_sid(owner,&ids,0))) return ACL_UNKNOWN;
  /* Ancestor ownership can be TrustedInstaller; its effective DACL must still forbid
     untrusted mutation of existing children/ancestry. New-child creation alone is OK.
     Every ACE is read before a writer is reported, so an unreadable ACL is never labelled. */
  int writer = 0;
  for (unsigned i=0; i<acl->AceCount; ++i) {
    ACE_HEADER *header;
    if (!GetAce(acl,i,(void**)&header) || header->AceSize<sizeof(ACCESS_ALLOWED_ACE)) return ACL_UNKNOWN;
    if (header->AceFlags & INHERIT_ONLY_ACE) continue;
    if (header->AceType == ACCESS_DENIED_ACE_TYPE) continue;
    if (header->AceType != ACCESS_ALLOWED_ACE_TYPE) return ACL_UNKNOWN;
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE*)header;
    PSID sid = &ace->SidStart;
    if (!IsValidSid(sid) || sizeof(ACCESS_ALLOWED_ACE)-sizeof(DWORD)+GetLengthSid(sid)>header->AceSize) return ACL_UNKNOWN;
    if (trusted_sid(sid,&ids,private_object)) continue;
    if (private_object) return ACL_UNKNOWN;
    if (orca_untrusted_rights_refused((uint32_t)ace->Mask,volume_root)) writer = 1;
  }
  return writer ? ACL_WRITER : ACL_SAFE;
}
static int safe_acl(HANDLE fd, int private_object) { return safe_acl_at(fd, private_object, 0) == ACL_SAFE; }
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
static inline int identity(const win_stat *a, const win_stat *b) { return a->st_dev==b->st_dev && a->st_ino==b->st_ino; }
static int file_safe(HANDLE fd, win_stat *st) {
  if(!info(fd,st) || st->kind!=1 || st->st_nlink!=1 || st->st_size>MAX_BYTES || !safe_acl(fd,1)) return 0;
  return 1;
}
/* Set when directory() refused a component because another account can change it (not for other failures). */
static int ancestry_writer_refused = 0;
static int directory(const char *path, int create, int private_root, chain *out) {
  ancestry_writer_refused = 0;
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
    if (!info(next,&st) || st.kind!=2) { errno=EACCES; goto refused; }
    int verdict = safe_acl_at(next,private_root && !end,0);
    if (verdict != ACL_SAFE) { ancestry_writer_refused = verdict == ACL_WRITER; errno=EACCES; goto refused; }
    if (!end) break;
    part=end+1;
  }
  return 1;
refused:
  close_chain(out); return 0;
}

#endif
