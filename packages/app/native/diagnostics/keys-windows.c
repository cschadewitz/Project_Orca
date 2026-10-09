/* Current-user DPAPI only. No application/profile key, UI, machine scope or plaintext fallback. */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <wincrypt.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  napi_async_work work;
  napi_deferred deferred;
  unsigned char input[4088];
  size_t length;
  DATA_BLOB output;
  bool protecting, ok;
} key_job;
static LONG key_jobs;
/* Public domain separator, not a password or independently stored key authority. */
static const unsigned char domain[] = "ORCA diagnostics key v1";

static napi_value key_failure(napi_env env) {
  napi_value text, error;
  if (napi_create_string_utf8(env,"unavailable",NAPI_AUTO_LENGTH,&text)!=napi_ok ||
      napi_create_error(env,NULL,text,&error)!=napi_ok) return NULL;
  return error;
}
static void key_cleanup(napi_env env,key_job *job) {
  if (job->output.pbData) {
    SecureZeroMemory(job->output.pbData,job->output.cbData);
    LocalFree(job->output.pbData);
  }
  if (job->work) napi_delete_async_work(env,job->work);
  SecureZeroMemory(job,sizeof(*job));
  free(job);
  InterlockedDecrement(&key_jobs);
}
static void key_execute(napi_env env,void *data) {
  (void)env;
  key_job *job=(key_job*)data;
  DATA_BLOB input={(DWORD)job->length,job->input};
  DATA_BLOB entropy={(DWORD)sizeof(domain),(BYTE*)domain};
  job->ok = job->protecting
    ? CryptProtectData(&input,NULL,&entropy,NULL,NULL,CRYPTPROTECT_UI_FORBIDDEN,&job->output)!=0
    : CryptUnprotectData(&input,NULL,&entropy,NULL,NULL,CRYPTPROTECT_UI_FORBIDDEN,&job->output)!=0;
  if (job->ok) job->ok = job->protecting
    ? job->output.cbData>32 && job->output.cbData<=4088
    : job->output.cbData==32;
  SecureZeroMemory(job->input,sizeof(job->input));
}
static void key_complete(napi_env env,napi_status status,void *data) {
  key_job *job=(key_job*)data;
  napi_value result=NULL;
  if (status==napi_ok && job->ok &&
      napi_create_buffer_copy(env,job->output.cbData,job->output.pbData,NULL,&result)==napi_ok)
    napi_resolve_deferred(env,job->deferred,result);
  else {
    napi_value error=key_failure(env);
    if (error) napi_reject_deferred(env,job->deferred,error);
  }
  key_cleanup(env,job);
}
static napi_value key_dispatch(napi_env env,napi_callback_info info) {
  napi_value args[2],promise,resource;
  size_t count=2,length=0;
  void *mode=NULL,*bytes=NULL;
  bool buffer=false;
  if (napi_get_cb_info(env,info,&count,args,NULL,&mode)!=napi_ok) return NULL;
  /* Allocate only after validating the exact bounded Buffer contract. */
  bool protecting=mode!=NULL;
  if (count!=1 || napi_is_buffer(env,args[0],&buffer)!=napi_ok || !buffer ||
      napi_get_buffer_info(env,args[0],&bytes,&length)!=napi_ok ||
      (protecting ? length!=32 : length<=32 || length>4088)) {
    napi_throw_error(env,NULL,"unavailable"); return NULL;
  }
  if (InterlockedIncrement(&key_jobs)>4) {
    InterlockedDecrement(&key_jobs); napi_throw_error(env,NULL,"unavailable"); return NULL;
  }
  key_job *job=(key_job*)calloc(1,sizeof(*job));
  if (!job) {
    InterlockedDecrement(&key_jobs); napi_throw_error(env,NULL,"unavailable"); return NULL;
  }
  if (napi_create_promise(env,&job->deferred,&promise)!=napi_ok) { key_cleanup(env,job); return NULL; }
  job->protecting=protecting; job->length=length;
  memcpy(job->input,bytes,length);
  if (napi_create_string_utf8(env,"orca-diagnostics-dpapi",NAPI_AUTO_LENGTH,&resource)!=napi_ok ||
      napi_create_async_work(env,NULL,resource,key_execute,key_complete,job,&job->work)!=napi_ok ||
      napi_queue_async_work(env,job->work)!=napi_ok) {
    napi_value error=key_failure(env);
    if (error) napi_reject_deferred(env,job->deferred,error);
    key_cleanup(env,job);
  }
  return promise;
}
bool register_windows_keys(napi_env env,napi_value exports) {
  napi_value version,protect,unprotect;
  return napi_create_uint32(env,1,&version)==napi_ok &&
    napi_create_function(env,"protectKey",NAPI_AUTO_LENGTH,key_dispatch,(void*)(uintptr_t)1,&protect)==napi_ok &&
    napi_create_function(env,"unprotectKey",NAPI_AUTO_LENGTH,key_dispatch,NULL,&unprotect)==napi_ok &&
    napi_set_named_property(env,exports,"keyProtection",version)==napi_ok &&
    napi_set_named_property(env,exports,"protectKey",protect)==napi_ok &&
    napi_set_named_property(env,exports,"unprotectKey",unprotect)==napi_ok;
}
