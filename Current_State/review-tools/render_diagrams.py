"""Render review JSON as standalone SVG; Python standard library only."""
from pathlib import Path
import json, html, textwrap
ROOT=Path(__file__).resolve().parents[1]
STYLE={'call':('#1559a1',''),'dependency':('#794b98','9 5'),'message':('#21754a','3 5'),'data':('#975523',''),'containment':('#656b73',''),'declared':('#a73d3d','9 5')}
def esc(x):return html.escape(str(x),quote=True)
def render(v):
    nodes=v['nodes']; edges=v['edges']; width=1180; graph_bottom=165+len(nodes)*100; table_y=graph_bottom+55; height=table_y+len(edges)*68+115
    out=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-labelledby="title description">',f'<title id="title">{esc(v["title"])}</title>',f'<desc id="description">Static architecture view. {esc(v["scope"])}. Numbered arrows have full labels and source evidence in the table and linked specification.</desc>', '<defs>']
    for k,(c,d) in STYLE.items():out.append(f'<marker id="arrow-{k}" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="{c}"/></marker>')
    out+=['</defs>','<rect width="100%" height="100%" fill="#fff"/>','<g font-family="sans-serif" fill="#17212c">',f'<text x="32" y="40" font-size="25" font-weight="bold">{esc(v["title"])}</text>',f'<text x="32" y="70" font-size="16">Ownership view: {esc(v["owner"])} • {esc(v["kind"])} • static inspection</text>', f'<a href="../../architecture/{v["id"]}.md"><text x="32" y="99" font-size="15" fill="#1559a1">Architecture specification, responsibilities and source evidence ↗</text></a>',f'<rect x="25" y="119" width="1130" height="{graph_bottom-119}" rx="12" fill="#f9fafc" stroke="#9aa6b3"/>']
    centers={}
    for i,n in enumerate(nodes):
        y=150+i*100; centers[n['id']]=y+35
        fill={'external':'#fff2e8','storage':'#eff7ed','process':'#e9f0ff','boundary':'#ffecec'}.get(n['type'],'#fff')
        out.append(f'<rect id="node-{n["id"]}" x="50" y="{y}" width="645" height="70" rx="{2 if n["type"]=="storage" else 9}" fill="{fill}" stroke="#526171" stroke-width="{2 if n["type"] in ("process","boundary") else 1}"/>')
        out.append(f'<text x="66" y="{y+20}" font-size="12" fill="#475666">N{n["id"]} · {esc(n["type"].upper())}</text>')
        for j,line in enumerate(textwrap.wrap(n['label'],66)):
            out.append(f'<text x="66" y="{y+43+j*18}" font-size="16">{esc(line)}</text>')
    for i,e in enumerate(edges,1):
        c,d=STYLE[e['type']]; x=740+i*43; ya=centers[e['from']]-7; yb=centers[e['to']]+7
        out.append(f'<path d="M695,{ya} H{x} V{yb} H698" fill="none" stroke="{c}" stroke-width="{3 if e["type"]=="data" else 2}" stroke-dasharray="{d}" marker-end="url(#arrow-{e["type"]})"/>')
        out.append(f'<circle cx="{x}" cy="{(ya+yb)/2}" r="13" fill="white" stroke="{c}"/><text x="{x}" y="{(ya+yb)/2+5}" text-anchor="middle" font-size="13" fill="{c}">{i}</text>')
    out.append(f'<text x="32" y="{table_y}" font-size="19" font-weight="bold">Labeled interfaces and movements</text>')
    names={n['id']:n['label'] for n in nodes}
    for i,e in enumerate(edges,1):
        y=table_y+22+(i-1)*68;c,d=STYLE[e['type']]
        out.append(f'<rect x="30" y="{y}" width="1120" height="62" rx="5" fill="#f5f7fa"/>')
        s=f'{i}. N{e["from"]} → N{e["to"]}: {e["label"]} [{e["type"]}; source claim E{e["evidence"]}]'
        out.append(f'<text x="43" y="{y+23}" font-size="16" fill="{c}">{esc(s)}</text>')
        s=f'{names[e["from"]]} → {names[e["to"]]}'
        out.append(f'<text x="43" y="{y+46}" font-size="13">{esc(s)}</text>')
    y=height-65
    out.append(f'<a href="../notation.md"><text x="32" y="{y}" font-size="14" fill="#1559a1">Legend: blue calls · purple dashed dependencies · green dotted messages · brown data · gray containment · red declared</text></a>')
    out.append(f'<text x="32" y="{y+27}" font-size="13">Outer frame = view ownership; external and process nodes retain their labeled boundaries. Not a deployment verification.</text>')
    out+=['</g>','</svg>']
    return '\n'.join(out)+'\n'
if __name__=='__main__':
    for p in sorted((ROOT/'diagrams/source').glob('*.json')):
        v=json.loads(p.read_text());(ROOT/'diagrams/svg'/f'{p.stem}.svg').write_text(render(v))
