"""Reviewed byte-only relocation recognizer; no filesystem writers.

Templates derived from pnpm/pnpm pnpm/crates/shim/src/sh.rs, pinned source
reviewed in issue #502. Only the three recorded root-prefix fields may change.
"""
import hashlib, json, re, posixpath

class Refusal(ValueError): pass

def sha(data): return hashlib.sha256(data).hexdigest()
def refuse(message): raise Refusal(message)

# Exact recognized templates from the reviewed public shell-shim generator.
HEADER = b'#!/bin/sh\n# Resolve $0 through symlinks so basedir is the shim\'s real directory.\n# Cap hops at the kernel\'s ELOOP limit so a cycle cannot hang the shim.\n#\n# A shim runs with node_modules/.bin at the front of PATH, so readlink, sed, and\n# uname go through `command -p`, which searches the system default path instead.\n# A dependency\'s bin cannot stand in for one of them and take over the shim\n# before it reaches its target. Directories come from `${link%/*}`, which needs\n# no helper at all.\nlink="$0"\n# `${link%/*}` needs a separator to strip. A bare name came from a PATH lookup\n# and stands for a file in the current directory.\ncase "$link" in\n  */*|*\\\\*) ;;\n  *) link="./$link" ;;\nesac\nhops=0\nwhile [ -L "$link" ] && [ "$hops" -lt 40 ]; do\n  hops=$((hops+1))\n  target=$(command -p readlink "$link")\n  case "$target" in\n    /*) link="$target" ;;\n    *)  link="${link%/*}/$target" ;;\n  esac\ndone\nbasedir=$(echo "$link" | command -p sed -e \'s,\\\\,/,g\')\nbasedir="${basedir%/*}"\nbasedir_win="$basedir"\nexe=""\nmsys=""\n\ncase `command -p uname -a` in\n  *CYGWIN*|*MINGW*|*MSYS*)\n    if command -v cygpath > /dev/null 2>&1; then\n      basedir_win=`cygpath -w "$basedir"`\n    fi\n    exe=".exe"\n    msys="true"\n  ;;\n  *WSL2*)\n    if command -v wslpath > /dev/null 2>&1; then\n      basedir_win="$(wslpath -w "$basedir" 2> /dev/null)"\n      if [ $? -ne 0 ] || [ -z "$basedir_win" ]; then\n        basedir_win="$basedir"\n      else\n        exe=".exe"\n      fi\n    fi\n  ;;\nesac\n\n'
NODE_TEMPLATE = 'if [ -z "$NODE_PATH" ]; then\n  export NODE_PATH="{sh_node_path}"\nelse\n  export NODE_PATH="{sh_node_path}:$NODE_PATH"\nfi'
BODY_TEMPLATE = 'if [ -n "$exe" ] && [ -x {sh_long_prog_exe} ]; then\n  exec {sh_long_prog_exe} {exec_args} {quoted_target_win} "$@"\nelif [ -x {sh_long_prog} ]; then\n  exec {sh_long_prog} {exec_args} {quoted_target} "$@"\nelif command -v {prog} >/dev/null 2>&1; then\n  exec {prog} {exec_args} {quoted_target} "$@"\nelif [ -n "$exe" ] && command -v {prog_exe} >/dev/null 2>&1; then\n  exec {prog_exe} {exec_args} {quoted_target_win} "$@"\nelse\n  exec {prog} {exec_args} {quoted_target} "$@"\nfi'

def templates():
    return HEADER, NODE_TEMPLATE, BODY_TEMPLATE

def root_ok(root):
    if not isinstance(root,str) or not re.fullmatch(r'/[A-Za-z0-9_/@+=,.-]+',root):
        refuse("ambiguous root spelling")
    if root.endswith('/') or any(x in ('','.','..') for x in root.split('/')[1:]):
        refuse("noncanonical root spelling")

def inside(path,root):
    return path==root or path.startswith(root+'/')

def path_ok(path,root,allow_dot=False):
    if not re.fullmatch(r'/[A-Za-z0-9_/@+=,.-]+',path):
        refuse("ambiguous path spelling")
    if not path.startswith(root+'/'): refuse("foreign or prefix-colliding path")
    suffix=path[len(root)+1:]
    if any(x in ('','..') or (x=='.' and not allow_dot) for x in suffix.split('/')):
        refuse("escaping or noncanonical path")
    if not inside(posixpath.normpath(path),root): refuse("escaping normalized path")

def recognize(data,expected_sha,source_root,shim_relative):
    if not re.fullmatch('[0-9a-f]{64}',expected_sha or '') or sha(data)!=expected_sha:
        refuse("recorded hash mismatch")
    root_ok(source_root)
    if not isinstance(shim_relative,str) or shim_relative.startswith('/') or any(x in ('','.','..') for x in shim_relative.split('/')) or not re.fullmatch(r'[A-Za-z0-9_/@+=,.-]+',shim_relative):
        refuse("escaping shim path")
    header,node_template,body_template=templates()
    if not data.startswith(header): refuse("unknown hardened header")
    try: text=data[len(header):].decode('utf-8')
    except UnicodeDecodeError: refuse("non-UTF8 shim")
    match=re.match(r'if \[ -z "\$NODE_PATH" \]; then\n  export NODE_PATH="([^"\n]*)"\nelse\n  export NODE_PATH="([^"\n]*)"\nfi\n',text)
    if not match: refuse("unknown NODE_PATH forms")
    value,second=match.groups()
    if not value or second!=value+':$NODE_PATH': refuse("mismatched NODE_PATH forms")
    node_block=node_template.format(sh_node_path=value)+'\n'
    if text[:match.end()]!=node_block: refuse("generator NODE_PATH template mismatch")
    components=value.split(':')
    for component in components: path_ok(component,source_root)
    remaining=text[match.end():]
    marker_match=re.search(r'# cmd-shim-target=([^\n]+)\n\Z',remaining)
    if not marker_match: refuse("unknown target marker")
    marker=marker_match.group(1); path_ok(marker,source_root,allow_dot=True)
    body=remaining[:marker_match.start()]
    target_match=re.search(r'  exec "\$basedir/node"  "\$basedir/([^"\n]+)" "\$@"\n',body)
    if not target_match: refuse("unknown runtime target/arguments")
    target=target_match.group(1)
    if not re.fullmatch(r'[A-Za-z0-9_/@+=,.-]+',target) or target.startswith('/'):
        refuse("ambiguous or absolute executable target")
    shim_parent=posixpath.dirname(source_root+'/'+shim_relative)
    normalized_target=posixpath.normpath(shim_parent+'/'+target)
    if not inside(normalized_target,source_root): refuse("escaping executable target")
    if normalized_target!=posixpath.normpath(marker): refuse("marker/target disagreement")
    expected_body=body_template.format(
        sh_long_prog_exe='"$basedir/node.exe"',sh_long_prog='"$basedir/node"',
        exec_args='',quoted_target_win='"$basedir_win/'+target+'"',
        quoted_target='"$basedir/'+target+'"',prog='node',prog_exe='node.exe')+'\n'
    if body!=expected_body: refuse("unknown generator runtime template")
    # Only root-prefix bytes in the two exports and the final marker may differ.
    spans=[]
    offset=len(header)
    for group,form in [(1,'NODE_PATH.empty'),(2,'NODE_PATH.inherited')]:
        field=match.group(group); start=offset+match.start(group); cursor=0
        for component in components:
            spans.append({'start':start+cursor,'end':start+cursor+len(source_root),'field':form})
            cursor+=len(component)+1
    marker_start=len(header)+match.end()+marker_match.start(1)
    spans.append({'start':marker_start,'end':marker_start+len(source_root),'field':'cmd-shim-target'})
    spans.sort(key=lambda x:x['start'])
    actual=[m.start() for m in re.finditer(re.escape(source_root.encode()),data)]
    if actual!=[p['start'] for p in spans]: refuse("unexpected source-root occurrence")
    return {'spans':spans,'components':components,'relative_target':target,'marker':marker,
            'normalized_target':normalized_target,'header_sha256':sha(header)}

def skeleton(data,spans):
    out=[]; offset=0
    for p in spans:
        out.extend([data[offset:p['start']],b'<ALLOWLISTED_ROOT>']);offset=p['end']
    out.append(data[offset:]);return b''.join(out)

def propose(data,expected_sha,mode,source_root,destination_root,shim_relative):
    root_ok(source_root);root_ok(destination_root)
    if inside(source_root,destination_root) or inside(destination_root,source_root):
        refuse("overlapping roots or repeated destination")
    if mode!=0o755: refuse("unexpected recorded shim mode")
    info=recognize(data,expected_sha,source_root,shim_relative)
    pieces=[]; offset=0; new_spans=[]; drift=0
    for p in info['spans']:
        pieces.extend([data[offset:p['start']],destination_root.encode()])
        new_spans.append({**p,'start':p['start']+drift,'end':p['start']+drift+len(destination_root)})
        drift+=len(destination_root)-len(source_root);offset=p['end']
    pieces.append(data[offset:]);result=b''.join(pieces)
    if skeleton(data,info['spans'])!=skeleton(result,new_spans): refuse("nonallowlisted bytes changed")
    destination_info=recognize(result,sha(result),destination_root,shim_relative)
    if info['relative_target']!=destination_info['relative_target']: refuse("executable target changed")
    if any(not inside(p,destination_root) for p in destination_info['components']): refuse("nonlocal generated search path")
    return result,{'before_sha256':sha(data),'proposed_sha256':sha(result),'mode':oct(mode),
        'spans':info['spans'],'destination_spans':new_spans,'unchanged_bytes_sha256':sha(skeleton(data,info['spans'])),
        'relative_target':info['relative_target'],'generated_component_count':len(info['components']),
        'destination_generated_paths_local':True,'header_sha256':info['header_sha256']}
