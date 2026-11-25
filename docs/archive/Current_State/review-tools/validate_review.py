"""Validate only review artifacts and source link bounds; never execute project code."""
from pathlib import Path
import json,re,hashlib,xml.etree.ElementTree as ET
ROOT=Path(__file__).resolve().parents[2]; OUT=ROOT/'Current_State'
errors=[]; links=0
for p in OUT.rglob('*.md'):
 text=p.read_text()
 for m in re.finditer(r'\[[^\n]*?\]\(([^\s\)]+)\)',text):
  target=m.group(1); links+=1
  if target.startswith(('http:','https:','mailto:','#')):continue
  path,_,anchor=target.partition('#'); resolved=(p.parent/path).resolve()
  if not resolved.exists():errors.append(f'{p.relative_to(OUT)}: missing {target}');continue
  if re.fullmatch(r'L\d+',anchor) and resolved.is_file():
   n=int(anchor[1:]); count=len(resolved.read_text().splitlines())
   if not 1<=n<=count:errors.append(f'{p.relative_to(OUT)}: line out of bounds {target}')
  # Headings in review documents use Github slug conventions.
  elif anchor and resolved.suffix=='.md' and OUT in resolved.parents:
   headings=[]; seen={}
   for h in re.findall(r'^#{1,6}\s+(.+)$',resolved.read_text(),re.M):
    base=re.sub(r'[^\w\- ]','',h.lower()).replace(' ','-'); idx=seen.get(base,0);seen[base]=idx+1
    headings.append(base+(f'-{idx}' if idx else ''))
   if anchor not in headings:errors.append(f'{p.relative_to(OUT)}: missing heading {target}')
views=0; svg_count=0
for p in (OUT/'diagrams/source').glob('*.json'):
 v=json.loads(p.read_text());views+=1; ids={n['id'] for n in v['nodes']}
 if len(ids)!=len(v['nodes']):errors.append(f'{p.name}: duplicate node ids')
 for e in v['edges']:
  if e['from'] not in ids or e['to'] not in ids or not e['label']:errors.append(f'{p.name}: invalid edge')
  if not 1<=e['evidence']<=len(v['claims']):errors.append(f'{p.name}: invalid edge evidence')
 for e in v['evidence']:
  path=ROOT/e['path']; lines=path.read_text().splitlines()
  if e['symbol'] not in lines[e['line']-1]:errors.append(f'{p.name}: misplaced symbol {e}')
 spec=OUT/'architecture'/f'{v["id"]}.md'; svg=OUT/'diagrams/svg'/f'{v["id"]}.svg'
 if not spec.exists() or not svg.exists():errors.append(f'{p.name}: missing paired deliverable')
 else:
  tree=ET.parse(svg);tag='{http://www.w3.org/2000/svg}'; root=tree.getroot();svg_count+=1
  if root.tag!=tag+'svg' or root.find(tag+'title') is None or root.find(tag+'desc') is None:errors.append(f'{svg.name}: missing SVG accessibility structure')
  svgids=[n.attrib['id'] for n in root.iter() if 'id' in n.attrib]
  if len(svgids)!=len(set(svgids)):errors.append(f'{svg.name}: duplicate ids')
  for a in root.iter(tag+'a'):
   path=a.attrib.get('href','').split('#')[0]
   if not (svg.parent/path).resolve().exists():errors.append(f'{svg.name}: missing SVG link {path}')
manifest=OUT/'BASELINE-MANIFEST.sha256'; hashed=0
if manifest.exists():
 for line in manifest.read_text().splitlines():
  want,path=line.split('  ',1);p=OUT/path;hashed+=1
  if not p.exists() or hashlib.sha256(p.read_bytes()).hexdigest()!=want:errors.append(f'Frozen baseline mismatch: {path}')
print(json.dumps({'markdown_links_checked':links,'architecture_views':views,'valid_svg_xml_documents':svg_count,'baseline_hashes_checked':hashed,'errors':errors},indent=2))
raise SystemExit(bool(errors))
