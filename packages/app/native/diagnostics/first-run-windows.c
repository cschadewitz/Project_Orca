/* Dedicated first-run boundary. No credential, diagnostics or ACL-repair exports. */
#include "storage-windows-common.h"
#include <sddl.h>

typedef struct { chain ancestry; HANDLE fd; int lifetime; } first_lock;
static const napi_type_tag lock_tag={UINT64_C(0x4c9642687ab561fd),UINT64_C(0xad810d530931efda)};
static unsigned lifetime_count=0;

/* Why the last selection was refused, for a message the person can act on. Paths are never echoed. */
enum { REFUSED_UNKNOWN, REFUSED_WRITER, REFUSED_OWNER };
static int selection_refusal=REFUSED_UNKNOWN;
static napi_value refused(napi_env env) {
  napi_throw_error(env,"FIRST_RUN_WINDOWS_UNAVAILABLE","Windows first-run identity unavailable");
  return NULL;
}
static napi_value refused_selection(napi_env env) {
  int reason=selection_refusal; selection_refusal=REFUSED_UNKNOWN;
  if(reason==REFUSED_WRITER)
    napi_throw_error(env,"FIRST_RUN_WINDOWS_UNTRUSTED_WRITER","Windows first-run folder writable by another account");
  else if(reason==REFUSED_OWNER)
    napi_throw_error(env,"FIRST_RUN_WINDOWS_NOT_OWNER","Windows first-run folder owned by another account");
  else return refused(env);
  return NULL;
}
static int text_arg(napi_env env,napi_value value,char *target,size_t capacity) {
  size_t length;
  return napi_get_value_string_utf8(env,value,NULL,0,&length)==napi_ok && length<capacity &&
    napi_get_value_string_utf8(env,value,target,capacity,&length)==napi_ok && strlen(target)==length;
}
static int field(napi_env env,napi_value object,const char *name,const char *text) {
  napi_value value;
  return napi_create_string_utf8(env,text,NAPI_AUTO_LENGTH,&value)==napi_ok && napi_set_named_property(env,object,name,value)==napi_ok;
}
/* OWNER_OTHER only when the owner was read and is a valid SID that is not the user; any failed read is OWNER_UNKNOWN. */
enum { OWNER_UNKNOWN, OWNER_SELF, OWNER_OTHER };
static int current_owner(HANDLE fd) {
  identities ids; unsigned char bytes[8192]; DWORD needed=0; PSID owner; BOOL defaulted;
  if(!user_identities(&ids) || !GetKernelObjectSecurity(fd,OWNER_SECURITY_INFORMATION,bytes,sizeof(bytes),&needed) ||
    needed>sizeof(bytes) || !IsValidSecurityDescriptor(bytes) || !GetSecurityDescriptorOwner(bytes,&owner,&defaulted) ||
    !owner || !IsValidSid(owner))return OWNER_UNKNOWN;
  return EqualSid(owner,((TOKEN_USER*)ids.token)->User.Sid) ? OWNER_SELF : OWNER_OTHER;
}
static int canonical(HANDLE fd,const char *path) {
  wchar_t actual[1024],expected[1024];
  DWORD length=GetFinalPathNameByHandleW(fd,actual,1024,FILE_NAME_NORMALIZED|VOLUME_NAME_DOS);
  return length>4 && length<1024 && !wcsncmp(actual,L"\\\\?\\",4) && wide(path,expected,1024) && !wcscmp(actual+4,expected);
}
static int selected(const char *path,int private_root,int owned,chain *held) {
  selection_refusal=REFUSED_UNKNOWN;
  if(strlen(path)<4 || path[1]!=':' || path[2]!='\\')return 0;
  wchar_t drive[4]={(wchar_t)path[0],L':',L'\\',0};
  if(GetDriveTypeW(drive)!=DRIVE_FIXED)return 0;
  if(!directory(path,0,private_root,held)) { if(ancestry_writer_refused)selection_refusal=REFUSED_WRITER; return 0; }
  for(unsigned i=0;i<held->count;++i) {
    win_stat st;
    if(!info(held->fd[i],&st) || st.kind!=2 || !st.st_ino)goto fail;
    int acl=safe_acl_at(held->fd[i],private_root && i==held->count-1,i==0);
    if(acl!=ACL_SAFE) { if(acl==ACL_WRITER)selection_refusal=REFUSED_WRITER; goto fail; }
  }
  HANDLE fd=held->fd[held->count-1];
  if(!canonical(fd,path))goto fail;
  if(owned) {
    int owner=current_owner(fd);
    if(owner!=OWNER_SELF) { if(owner==OWNER_OTHER)selection_refusal=REFUSED_OWNER; goto fail; }
  }
  return 1;
fail:
  close_chain(held); return 0;
}
static napi_value observation(napi_env env,HANDLE fd,const char *path) {
  FILE_ID_INFO id; identities ids; LPSTR sid=NULL; napi_value value=NULL;
  char dev[112],ino[48],volume_id[40]; wchar_t volume[1024];
  DWORD volume_length=GetFinalPathNameByHandleW(fd,volume,1024,FILE_NAME_NORMALIZED|VOLUME_NAME_GUID);
  if(!volume_length || volume_length>=1024 || wcsncmp(volume,L"\\\\?\\Volume{",11) || volume[47]!=L'}')return NULL;
  volume[47]=0;
  if(!WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,volume+11,-1,volume_id,sizeof(volume_id),NULL,NULL))return NULL;
  if(!GetFileInformationByHandleEx(fd,FileIdInfo,&id,sizeof(id)) || !user_identities(&ids) ||
    !ConvertSidToStringSidA(((TOKEN_USER*)ids.token)->User.Sid,&sid))return NULL;
  snprintf(dev,sizeof(dev),"win32:ntfs:%016llx:%s",(unsigned long long)id.VolumeSerialNumber,volume_id);
  strcpy(ino,"win32:file:");
  for(unsigned i=0;i<16;++i)snprintf(ino+11+i*2,3,"%02x",id.FileId.Identifier[i]);
  char uid[192]; snprintf(uid,sizeof(uid),"win32:sid:%s",sid); LocalFree(sid);
  if(napi_create_object(env,&value)!=napi_ok || !field(env,value,"path",path) || !field(env,value,"dev",dev) ||
    !field(env,value,"ino",ino) || !field(env,value,"uid",uid))return NULL;
  return value;
}
static int filename(const wchar_t *name,int writing) {
  if(!component(name))return 0;
  const wchar_t *names[]={L"orca.config.yaml",L"workflow.yaml",L"task.json",L"instruction.md",L"result.json",
    L"selection.json",L".orca-first-run-ownership.json",L"claim.json",L"writer.json",L"child.json",L"identity.json",
    L"terminal.json",L"recovery-request.json",L"recovery.json",L"ended-after-reboot.json",NULL};
  for(unsigned i=0;names[i];++i)if(!wcscmp(name,names[i]))return 1;
  if(wcslen(name)==25 && !wcsncmp(name,L"config-rebind-",14) && !wcscmp(name+20,L".json")) {
    for(unsigned i=14;i<20;++i)if(name[i]<L'0'||name[i]>L'9')return 0;
    return 1;
  }
  /* A compaction checkpoint is written aside, then renamed to checkpoint-NNNNNN.json. */
  if(wcslen(name)==25 && !wcsncmp(name,L"checkpoint-",11) && !wcscmp(name+17,L".pending")) {
    for(unsigned i=11;i<17;++i)if(name[i]<L'0'||name[i]>L'9')return 0;
    return 1;
  }
  return !writing; /* Runtime verification permits bounded regular files, never writes them. */
}
static int expected_parent(napi_env env,napi_value expected,HANDLE fd,const char *path) {
  napi_valuetype type;
  if(napi_typeof(env,expected,&type)!=napi_ok)return 0;
  if(type==napi_null)return 1;
  napi_value actual=observation(env,fd,path);
  if(!actual || type!=napi_object)return 0;
  const char *keys[]={"path","dev","ino","uid"};
  for(unsigned i=0;i<4;++i) {
    napi_value a,b; char left[PATH_MAX],right[PATH_MAX];
    if(napi_get_named_property(env,actual,keys[i],&a)!=napi_ok || napi_get_named_property(env,expected,keys[i],&b)!=napi_ok ||
      !text_arg(env,a,left,sizeof(left)) || !text_arg(env,b,right,sizeof(right)) || strcmp(left,right))return 0;
  }
  return 1;
}
static int parent_leaf(const char *path,chain *held,wchar_t *name,int private_root) {
  char parent[PATH_MAX]; wchar_t full[1024];
  if(!wide(path,full,1024))return 0;
  wchar_t *slash=wcsrchr(full,L'\\');
  if(!slash || slash-full<3 || !component(slash+1))return 0;
  wcscpy(name,slash+1); *slash=0;
  return WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,full,-1,parent,sizeof(parent),NULL,NULL) &&
    selected(parent,private_root,0,held);
}
static void unlock(first_lock *lock) {
  if(!lock || lock->lifetime)return;
  if(lock->fd!=INVALID_HANDLE_VALUE)CloseHandle(lock->fd);
  lock->fd=INVALID_HANDLE_VALUE; close_chain(&lock->ancestry);
}
static void finalize_lock(napi_env env,void *data,void *hint) {
  (void)env; (void)hint; first_lock *lock=data;
  if(lock->lifetime)return; /* Deliberately retained until kernel process teardown. */
  unlock(lock); free(lock);
}
static first_lock *unwrap_lock(napi_env env,napi_value value) {
  bool matches=false; void *pointer=NULL;
  if(napi_check_object_type_tag(env,value,&lock_tag,&matches)!=napi_ok || !matches || napi_unwrap(env,value,&pointer)!=napi_ok)return NULL;
  return pointer;
}
static napi_value call(napi_env env,napi_callback_info cb) {
  napi_value argv[3],result=NULL; size_t count=3;
  char op[24],path[PATH_MAX]; chain held={0}; HANDLE fd=INVALID_HANDLE_VALUE;
  if(napi_get_cb_info(env,cb,&count,argv,NULL,NULL)!=napi_ok || count!=3 || !text_arg(env,argv[0],op,sizeof(op)))return refused(env);
  if(!strcmp(op,"release") || !strcmp(op,"retain")) {
    first_lock *lock=unwrap_lock(env,argv[1]);
    if(!lock || lock->fd==INVALID_HANDLE_VALUE)return refused(env);
    if(!strcmp(op,"retain")) {
      if(!lock->lifetime && lifetime_count>=8)return refused(env);
      if(!lock->lifetime) { lock->lifetime=1; ++lifetime_count; }
    } else unlock(lock);
    napi_get_undefined(env,&result); return result;
  }
  if(!text_arg(env,argv[1],path,sizeof(path)))return refused(env);
  if(!strcmp(op,"host")) {
    HKEY key; wchar_t machine[64]; DWORD bytes=sizeof(machine),kind=0;
    if(RegOpenKeyExW(HKEY_LOCAL_MACHINE,L"SOFTWARE\\Microsoft\\Cryptography",0,KEY_QUERY_VALUE|KEY_WOW64_64KEY,&key)!=ERROR_SUCCESS)return refused(env);
    LSTATUS status=RegQueryValueExW(key,L"MachineGuid",NULL,&kind,(BYTE*)machine,&bytes); RegCloseKey(key);
    char text[64];
    if(status!=ERROR_SUCCESS || kind!=REG_SZ || bytes!=74 || machine[36]!=0 ||
      !WideCharToMultiByte(CP_UTF8,WC_ERR_INVALID_CHARS,machine,-1,text,sizeof(text),NULL,NULL))return refused(env);
    napi_create_string_utf8(env,text,NAPI_AUTO_LENGTH,&result); return result;
  }
  if(!strcmp(op,"project") || !strcmp(op,"parent") || !strcmp(op,"directory")) {
    if(!selected(path,!strcmp(op,"directory"),strcmp(op,"parent")!=0,&held))return refused_selection(env);
    result=observation(env,held.fd[held.count-1],path); close_chain(&held);
    return result?result:refused(env);
  }
  wchar_t name[256];
  if(!strcmp(op,"mkdir")) {
    if(!parent_leaf(path,&held,name,0))return refused(env);
    char parent[PATH_MAX]; strcpy(parent,path); *strrchr(parent,'\\')=0;
    if(!expected_parent(env,argv[2],held.fd[held.count-1],parent))goto fail;
    /* Creation only: no existing ACL can ever be changed or adopted here. */
    SECURITY_DESCRIPTOR sd; unsigned char acl[256]; identities ids;
    if(!user_identities(&ids) || !new_security(&sd,acl,&ids))goto fail;
    fd=relative_open(held.fd[held.count-1],name,FILE_LIST_DIRECTORY|FILE_READ_ATTRIBUTES|READ_CONTROL,
      NT_CREATE,1,&sd,FILE_SHARE_READ|FILE_SHARE_WRITE);
    if(fd==INVALID_HANDLE_VALUE || !safe_acl(fd,1) || !canonical(fd,path))goto fail;
    result=observation(env,fd,path); goto done;
  }
  if(!strcmp(op,"lock")) {
    if(!selected(path,1,1,&held))return refused(env);
    if(!expected_parent(env,argv[2],held.fd[held.count-1],path))goto fail;
    SECURITY_DESCRIPTOR sd; unsigned char acl[256]; identities ids; win_stat st; OVERLAPPED position={0};
    if(!user_identities(&ids) || !new_security(&sd,acl,&ids))goto fail;
    fd=relative_open(held.fd[held.count-1],L".orca-first-run-writer.lock",GENERIC_READ|GENERIC_WRITE|READ_CONTROL,
      NT_OPEN_IF,0,&sd,FILE_SHARE_READ|FILE_SHARE_WRITE);
    if(fd==INVALID_HANDLE_VALUE || !file_safe(fd,&st) || st.st_size ||
      !LockFileEx(fd,LOCKFILE_EXCLUSIVE_LOCK|LOCKFILE_FAIL_IMMEDIATELY,0,MAXDWORD,MAXDWORD,&position) || !FlushFileBuffers(fd))goto fail;
    first_lock *lock=calloc(1,sizeof(*lock)); if(!lock)goto fail;
    lock->fd=fd; lock->ancestry=held;
    if(napi_create_object(env,&result)!=napi_ok || napi_type_tag_object(env,result,&lock_tag)!=napi_ok ||
      napi_wrap(env,result,lock,finalize_lock,NULL,NULL)!=napi_ok) { free(lock); goto fail; }
    return result;
  }
  if(!parent_leaf(path,&held,name,1) || !filename(name,!strcmp(op,"write") || !strcmp(op,"replace")))goto fail;
  if(!strcmp(op,"read") || !strcmp(op,"file")) {
    fd=relative_open(held.fd[held.count-1],name,GENERIC_READ|READ_CONTROL,NT_OPEN,0,NULL,FILE_SHARE_READ);
    win_stat st;
    if(fd==INVALID_HANDLE_VALUE || !info(fd,&st) || st.kind!=1 || st.st_nlink!=1 || !safe_acl(fd,1))goto fail;
    if(!strcmp(op,"file")) { result=observation(env,fd,path); goto done; }
    uint32_t limit=0;
    if(napi_get_value_uint32(env,argv[2],&limit)!=napi_ok || !limit || limit>1048576 || st.st_size>limit)goto fail;
    char *data=calloc((size_t)st.st_size+1,1); DWORD got=0;
    if(!data)goto fail;
    int ok=ReadFile(fd,data,(DWORD)st.st_size,&got,NULL) && got==st.st_size &&
      napi_create_string_utf8(env,data,(size_t)st.st_size,&result)==napi_ok;
    free(data); if(!ok)goto fail; goto done;
  }
  if(!strcmp(op,"write") || !strcmp(op,"replace")) {
    size_t bytes=0;
    if(napi_get_value_string_utf8(env,argv[2],NULL,0,&bytes)!=napi_ok || bytes>1048576)goto fail;
    char *data=malloc(bytes+1); if(!data)goto fail;
    if(!text_arg(env,argv[2],data,bytes+1)) { free(data); goto fail; }
    SECURITY_DESCRIPTOR sd; unsigned char acl[256]; identities ids;
    if(!user_identities(&ids) || !new_security(&sd,acl,&ids)) { free(data); goto fail; }
    const wchar_t *source=name;
    wchar_t temporary[256];
    if(!strcmp(op,"replace")) {
      if(wcscmp(name,L"selection.json")) { free(data); goto fail; }
      HANDLE target=relative_open(held.fd[held.count-1],name,GENERIC_READ|READ_CONTROL,NT_OPEN,0,NULL,FILE_SHARE_READ);
      win_stat st;
      if(target!=INVALID_HANDLE_VALUE) { int safe=file_safe(target,&st); CloseHandle(target); if(!safe) { free(data); goto fail; } }
      else if(errno!=ENOENT) { free(data); goto fail; }
      wcscpy(temporary,L"selection.json.tmp"); source=temporary;
    }
    fd=relative_open(held.fd[held.count-1],source,GENERIC_WRITE|DELETE|READ_CONTROL,NT_CREATE,0,&sd,FILE_SHARE_READ);
    DWORD got=0;
    int ok=fd!=INVALID_HANDLE_VALUE && WriteFile(fd,data,(DWORD)bytes,&got,NULL) && got==bytes && FlushFileBuffers(fd);
    free(data); if(!ok)goto fail;
    if(source!=name) {
      unsigned char buffer[sizeof(FILE_RENAME_INFO)+512]; memset(buffer,0,sizeof(buffer));
      FILE_RENAME_INFO *rename=(FILE_RENAME_INFO*)buffer;
      rename->ReplaceIfExists=TRUE; rename->RootDirectory=held.fd[held.count-1];
      rename->FileNameLength=(DWORD)(wcslen(name)*sizeof(wchar_t)); memcpy(rename->FileName,name,rename->FileNameLength);
      set_information_fn set=NULL; FARPROC address=GetProcAddress(GetModuleHandleW(L"ntdll.dll"),"NtSetInformationFile");
      memcpy(&set,&address,sizeof(set)); IO_STATUS_BLOCK status;
      if(!set || set(fd,&status,rename,(ULONG)(sizeof(FILE_RENAME_INFO)+rename->FileNameLength),ORCA_FILE_RENAME_INFORMATION)<0 || !FlushFileBuffers(fd))goto fail;
    }
    napi_get_undefined(env,&result); goto done;
  }
fail:
  if(fd!=INVALID_HANDLE_VALUE)CloseHandle(fd);
  close_chain(&held); return refused(env);
done:
  if(fd!=INVALID_HANDLE_VALUE)CloseHandle(fd);
  close_chain(&held); return result?result:refused(env);
}
static napi_value initialize(napi_env env,napi_value exports) {
  napi_value abi,fn;
  if(napi_create_uint32(env,1,&abi)!=napi_ok || napi_set_named_property(env,exports,"abi",abi)!=napi_ok ||
    !field(env,exports,"platform","win32") || napi_create_function(env,"call",NAPI_AUTO_LENGTH,call,NULL,&fn)!=napi_ok ||
    napi_set_named_property(env,exports,"call",fn)!=napi_ok || napi_object_freeze(env,exports)!=napi_ok)return NULL;
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME,initialize)
