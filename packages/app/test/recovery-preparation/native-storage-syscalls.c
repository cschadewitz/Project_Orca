/* Exact production syscall core; Linux fixture cannot establish Darwin ACL/flush proof. */
#define ORCA_STORAGE_STANDALONE
#include "../../native/diagnostics/storage.c"
#include <assert.h>
#include <sys/wait.h>

static job run(handle *root, handle *file, const char *operation, const char *path, const char *second) {
  job j = {0}; j.root = root; j.file = file;
  strcpy(j.operation, operation); strcpy(j.path, path); strcpy(j.second, second);
  execute(NULL, &j); return j;
}
static handle *root_at(const char *path) {
  job j = {0}; strcpy(j.operation,"openRoot"); strcpy(j.path,path); j.offset=1;
  execute(NULL,&j); assert(!j.error && j.result); return j.result;
}
static void close_file(handle *root, handle *file) {
  assert(!run(root,file,"closeFile","","").error); release_handle(file);
}
int main(int argc, char **argv) {
  assert(argc==2);
  char path[PATH_MAX],stage[PATH_MAX],output[PATH_MAX],moved[PATH_MAX];
  assert(snprintf(path,sizeof(path),"%s/private",argv[1])<(int)sizeof(path));
  assert(snprintf(stage,sizeof(stage),"%s/export-stage.tmp",path)<(int)sizeof(stage));
  assert(snprintf(output,sizeof(output),"%s/report.json",argv[1])<(int)sizeof(output));
  assert(snprintf(moved,sizeof(moved),"%s/moved",argv[1])<(int)sizeof(moved));
  handle *root=root_at(path);
  assert(!run(root,NULL,"acquire","","").error);
  handle *other=root_at(path);
  assert(run(other,NULL,"acquire","","").error);
  assert(!run(other,NULL,"closeRoot","","").error); release_handle(other);
  pid_t child=fork(); assert(child>=0);
  if(!child) {
    close(root->fd); close(root->lock_fd);
    handle *second=root_at(path);
    _exit(run(second,NULL,"acquire","","").error?0:1);
  }
  int status; assert(waitpid(child,&status,0)==child && WIFEXITED(status) && WEXITSTATUS(status)==0);
  /* Closed native files release their descriptor budget without waiting for GC. */
  for(int i=0;i<20;++i) {
    job created=run(root,NULL,"openCreate","setting.json.tmp",""); assert(!created.error);
    job write_job = {0}; write_job.root=root; write_job.file=created.result; strcpy(write_job.operation,"write");
    write_job.buffer=(unsigned char*)"exact"; write_job.buffer_size=5; execute(NULL,&write_job); assert(!write_job.error);
    assert(!run(root,created.result,"sync","","").error);
    close_file(root,created.result);
    assert(!run(root,NULL,"replace","setting.json.tmp","setting.json").error);
    job reading=run(root,NULL,"openRead","setting.json",""); assert(!reading.error);
    unsigned char bytes[5]={0}; job read={0}; read.root=root; read.file=reading.result;
    strcpy(read.operation,"read"); read.buffer=bytes; read.buffer_size=5; read.length=5;
    execute(NULL,&read); assert(!read.error && read.number==5 && !memcmp(bytes,"exact",5));
    close_file(root,reading.result);
  }
  assert(run(root,NULL,"stopped","","").number==1);
  handle *readers[MAX_FILES];
  for(int i=0;i<MAX_FILES;++i) {
    job reader=run(root,NULL,"openRead","setting.json",""); assert(!reader.error); readers[i]=reader.result;
  }
  assert(run(root,NULL,"openRead","setting.json","").error==EOVERFLOW);
  assert(run(root,NULL,"closeRoot","","").error==EBUSY);
  for(int i=0;i<MAX_FILES;++i)close_file(root,readers[i]);
  assert(run(root,NULL,"openCreate","../foreign","").error);
  assert(run(root,NULL,"remove","writer.lock","").error);
  assert(!symlink("/etc/passwd",stage));
  assert(run(root,NULL,"openRead","export-stage.tmp","").error);
  assert(run(root,NULL,"remove","export-stage.tmp","").error);
  assert(!unlink(stage));
  job created=run(root,NULL,"openCreate","export-stage.tmp",""); assert(!created.error);
  job write_job={0}; write_job.root=root; write_job.file=created.result; strcpy(write_job.operation,"write");
  write_job.buffer=(unsigned char*)"exact"; write_job.buffer_size=5; execute(NULL,&write_job); assert(!write_job.error);
  assert(!run(root,created.result,"sync","","").error);
  close_file(root,created.result);
  assert(!link(stage,output));
  assert(run(root,NULL,"openRead","export-stage.tmp","").error);
  assert(!unlink(output));
  int existing=open(output,O_CREAT|O_EXCL|O_WRONLY,0600); assert(existing>=0); close(existing);
  assert(run(root,NULL,"validateDestination",output,"").number==0);
  assert(!unlink(output));
  assert(run(root,NULL,"validateDestination",output,"").number==1);
  job opened=run(root,NULL,"openRead","export-stage.tmp",""); assert(!opened.error);
  char selected[PATH_MAX],replaced[PATH_MAX],selected_file[PATH_MAX];
  assert(snprintf(selected,sizeof(selected),"%s/selected",argv[1])<(int)sizeof(selected));
  assert(snprintf(replaced,sizeof(replaced),"%s/selected-moved",argv[1])<(int)sizeof(replaced));
  assert(snprintf(selected_file,sizeof(selected_file),"%s/report.json",selected)<(int)sizeof(selected_file));
  assert(!mkdir(selected,0700));
  assert(run(root,NULL,"validateDestination",selected_file,"").number==1);
  assert(!rename(selected,replaced)); assert(!mkdir(selected,0700));
  assert(run(root,opened.result,"publish",selected_file,"").outcome==1);
  assert(access(selected_file,F_OK) && errno==ENOENT);
  assert(run(root,NULL,"validateDestination",selected_file,"").number==0);
  assert(run(root,NULL,"validateDestination",output,"").number==1);
  assert(run(root,opened.result,"publish",output,"").outcome==0);
  close_file(root,opened.result);
  assert(!access(output,F_OK));
  assert(access(stage,F_OK) && errno==ENOENT);
  /* A replacement pathname never redirects an operation into the new directory. */
  assert(!rename(path,moved)); assert(!mkdir(path,0700));
  assert(run(root,NULL,"openCreate","control.key","").error);
  assert(!run(root,NULL,"closeRoot","","").error); release_handle(root);
  handle *fresh=root_at(path); assert(!run(fresh,NULL,"acquire","","").error);
  for(int i=0;i<17;++i) {
    char entry[PATH_MAX]; assert(snprintf(entry,sizeof(entry),"%s/x%d",path,i)<(int)sizeof(entry));
    int fd=open(entry,O_CREAT|O_EXCL|O_WRONLY,0600); assert(fd>=0); close(fd);
  }
  assert(run(fresh,NULL,"list","","").error==EOVERFLOW);
  assert(!run(fresh,NULL,"closeRoot","","").error); release_handle(fresh);
  int ready[2],hold[2]; assert(!pipe(ready) && !pipe(hold));
  child=fork(); assert(child>=0);
  if(!child) {
    close(ready[0]); close(hold[1]);
    handle *writer=root_at(path); assert(!run(writer,NULL,"acquire","","").error);
    assert(write(ready[1],"x",1)==1); close(ready[1]);
    char signal; (void)read(hold[0],&signal,1);
    _exit(0);
  }
  close(ready[1]); close(hold[0]);
  char signal; assert(read(ready[0],&signal,1)==1); close(ready[0]);
  assert(!kill(child,SIGKILL)); close(hold[1]);
  assert(waitpid(child,&status,0)==child && WIFSIGNALED(status) && WTERMSIG(status)==SIGKILL);
  fresh=root_at(path); assert(!run(fresh,NULL,"acquire","","").error);
  assert(!run(fresh,NULL,"closeRoot","","").error); release_handle(fresh);
  puts("native storage syscall fixture passed"); return 0;
}
