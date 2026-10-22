#!/usr/bin/env node
/**
 * Fixture editor for the harness tests. It is NOT P1. It honors the DOM contract the tool relies on,
 * as observed in the P1 editor and in its source (see references/six-shot-workflow.md):
 *
 *   header[data-testid=p1-editor-header], [data-testid=site-label], [data-testid=page-selector]
 *   [data-testid=workstream-trigger] / -dropdown / -list / -close      (workstream chosen per tab)
 *   #publish-split-button with a "More actions" menu (role=menu, role=menuitem)
 *   [aria-label="Toggle left panel"][aria-pressed], category buttons #p1-cat-btn-*, "Expand all"
 *   iframe#preview-frame (same origin) with blocks carrying data-puck-component="<Type>-<uuid>"
 *   a selection overlay: div[data-puck-overlay] with an "--isSelected" modifier class
 *   [data-testid=inspector-collapse-button], role=tab "Page"/"Blocks", breadcrumb "Page › <Type>"
 *
 * The editor mounts pages under /p1 the way the real one does: /p1 edits "/", /p1/about edits "/about".
 * Switches (all fixed at start):
 *   --project <name>        project name in the header           (default "Fixture Project")
 *   --workstreams a,b,c     workstream names; the first is the default for a new tab
 *   --publish <text>        menu item text                        (default "Publish this page to main")
 *   --category <name>       first block category label           (default "P1 Layout")
 *   --bug neighbor          clicking a block selects the NEXT block instead (a broken editor)
 *   --panel type|label|neither   what the properties panel and breadcrumb name for a selected block: its type
 *                           (default), the component label the toolbar shows ("Pull quote" for PullQuote), or neither
 *   --toolbar label|none    whether the selected overlay holds a toolbar whose first text is the label (default label)
 *   --left open|collapsed   the left panel's state when the page loads (default open)
 *   --filler <n>            n extra categories before the last one, which starts expanded and below the fold of the
 *                           left panel, with a block grid under it that is visible only while it is expanded; the page records
 *                           whether at least half of that grid is on screen as body[data-grid-visible=true|false]
 *   --dev-overlay           adds a <nextjs-portal> element, the marker of the Next.js dev overlay
 *   --note <text>           visible text in the right panel (a stand-in for a name that leaked into the page)
 * Endpoint /__clicks returns every menu item the page recorded as clicked (a harness must never click one).
 *
 * Usage: node server.mjs <port> [switches]
 */
import http from 'node:http';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    project: { type: 'string', default: 'Fixture Project' },
    workstreams: { type: 'string', default: 'main-ws,qa-workstream' },
    publish: { type: 'string', default: 'Publish this page to main' },
    category: { type: 'string', default: 'P1 Layout' },
    bug: { type: 'string', default: 'none' },
    panel: { type: 'string', default: 'type' },
    toolbar: { type: 'string', default: 'label' },
    left: { type: 'string', default: 'open' },
    filler: { type: 'string', default: '0' },
    'dev-overlay': { type: 'boolean', default: false },
    note: { type: 'string', default: '' },
  },
});
const port = Number(positionals[0]);
const workstreams = values.workstreams.split(',');
const clicks = [];
const filler = Number(values.filler);
const collapsed = values.left === 'collapsed';
// Component labels the editor shows where the id prefix holds the type.
const LABELS = { Hero: 'Hero banner', Stats: 'Statistics', PullQuote: 'Pull quote', Cta: 'Call to action' };

// Block ids look like the real ones (<Type>-<36 character id>). They're built, not written out, so no
// literal in this file resembles a real identifier.
const fakeId = d => [8, 4, 4, 4, 12].map(n => d.repeat(n)).join('-');
const BLOCKS = [
  ['Hero', fakeId('1'), '#233', 260],
  ['Stats', fakeId('2'), '#a62', 220],
  ['PullQuote', fakeId('3'), '#2a6', 300],
  ['Cta', fakeId('4'), '#62a', 240],
];

const pageForPath = path => {
  const rest = path.replace(/^\/p1(\/edit)?/, '');
  return rest === '' || rest === '/' ? '/' : rest.replace(/\/+$/, '');
};

const editorHtml = pagePath => `<!doctype html><html><head><meta charset="utf-8"><title>P1 Editor: ${pagePath}</title>
<style>
*{box-sizing:border-box}body{margin:0;font:14px/1.4 system-ui,sans-serif;color:#111;background:#fff}
header{display:flex;gap:12px;align-items:center;padding:10px 16px;border-bottom:1px solid #ddd;height:56px}
.sub{display:flex;gap:12px;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid #eee;height:48px}
.sub .right{display:flex;gap:8px;align-items:center;position:relative}
button{font:inherit;padding:6px 10px;border:1px solid #bbb;border-radius:6px;background:#fff}
#layout{display:flex;height:calc(100vh - 104px)}
#rail{width:56px;border-right:1px solid #ddd;padding:8px}
#left{width:280px;border-right:1px solid #ddd;padding:8px;overflow:auto}#left.hidden{display:none}
#canvas{flex:1;padding:16px;background:#f4f4f6}#preview-frame{width:100%;height:100%;border:0;background:#fff}
#right{width:300px;border-left:1px solid #ddd;padding:8px}
.cat{display:flex;justify-content:space-between;width:100%;text-transform:uppercase;text-align:left;margin:4px 0}
[hidden]{display:none!important}
#ws-dd{position:absolute;top:36px;right:0;width:260px;background:#fff;border:1px solid #bbb;border-radius:8px;padding:8px;z-index:5}
#ws-dd ul{list-style:none;margin:8px 0 0;padding:0}#ws-dd li button{width:100%;text-align:left;border:0}
#menu{position:absolute;top:36px;right:0;background:#fff;border:1px solid #bbb;border-radius:8px;list-style:none;margin:0;padding:6px;z-index:5;min-width:240px}
#menu li{padding:6px 8px}
.grid{height:120px;background:#dde;margin:4px 0}.cat[aria-expanded=false]+.grid{display:none}
</style></head><body><main id="main">
<header data-testid="p1-editor-header"><b>P1</b>
<div data-testid="site-label">Site: ${values.project} ${values.project}</div>
<button data-testid="page-selector" aria-haspopup="true">${pagePath}</button></header>
<div class="sub"><div><button aria-label="Toggle left panel" aria-pressed="${!collapsed}" id="tgl">Panel</button></div>
<div class="right"><button data-testid="workstream-trigger" id="ws-trigger"></button>
<span id="publish-split-button" data-testid="publish-split-button"><button id="primary"></button><button aria-label="More actions" aria-haspopup="menu" aria-expanded="false" id="more">▾</button></span>
<div id="ws-dd" data-testid="workstream-dropdown" role="listbox" hidden><input data-testid="workstream-search" placeholder="Search workstreams..."><button data-testid="workstream-close" aria-label="Close">×</button><ul data-testid="workstream-list" id="ws-list"></ul></div>
<ul id="menu" role="menu" hidden><li role="menuitem" data-item="publish">${values.publish}</li><li role="menuitem" data-item="schedule">Schedule publish</li><li role="menuitem" data-item="delete">Delete page</li></ul></div></div>
<div id="layout"><nav id="rail"><button aria-label="Blocks">B</button></nav>
<aside id="left"${collapsed ? ' class="hidden"' : ''}><h3>Blocks</h3><div>14 categories <button id="expand">Expand all</button></div>
<button class="cat" id="p1-cat-btn-p1Layout" aria-expanded="true"><span>${values.category}</span><span>4</span></button><div id="grid-p1Layout">Accordion Columns Container Tabs</div>
<button class="cat" id="p1-cat-btn-p1Attention" aria-expanded="false"><span>P1 Attention</span><span>2</span></button>
${Array.from({ length: filler }, (_, i) => `<button class="cat" id="p1-cat-btn-filler${i}" aria-expanded="false"><span>Filler ${i + 1}</span><span>1</span></button>`).join('')}<button class="cat" id="p1-cat-btn-p1Editorial" aria-expanded="${filler ? 'true' : 'false'}"><span>P1 Editorial</span><span>6</span></button>${filler ? '<div class="grid" id="grid-p1Editorial">Heading Paragraph Quote</div>' : ''}</aside>
<section id="canvas"><iframe id="preview-frame" src="/preview?page=${encodeURIComponent(pagePath)}"></iframe></section>
<aside id="right"><button data-testid="inspector-collapse-button" aria-label="Collapse panel">»</button>
<div role="tablist"><button role="tab" aria-selected="true" id="tab-page">Page</button><button role="tab" aria-selected="false" id="tab-blocks">Blocks</button></div>
<div id="crumb"></div><div id="props">title: ${pagePath}</div>${values.note ? `<div id="note">${values.note}</div>` : ''}</aside></div></main>${values['dev-overlay'] ? '<nextjs-portal></nextjs-portal>' : ''}
<script>
const workstreams=${JSON.stringify(workstreams)};
const KEY='ws';
const cur=()=>sessionStorage.getItem(KEY)||workstreams[0];
const $=s=>document.querySelector(s);
function render(){
  $('#ws-trigger').textContent=cur();
  $('#primary').textContent=cur()===workstreams[0]?'Publish':'Review';
  const ul=$('#ws-list');ul.replaceChildren();
  for(const w of workstreams){const li=document.createElement('li'),b=document.createElement('button');b.type='button';b.setAttribute('aria-selected',String(w===cur()));b.textContent=w;li.append(b);ul.append(li)}
}
render();
$('#ws-trigger').onclick=()=>{$('#ws-dd').hidden=!$('#ws-dd').hidden;$('#menu').hidden=true};
$('[data-testid=workstream-close]').onclick=()=>{$('#ws-dd').hidden=true};
$('#ws-list').onclick=e=>{const b=e.target.closest('button');if(!b)return;const name=b.textContent;
  if(name===cur())return; // choosing the current workstream leaves the menu open, like the real editor
  sessionStorage.setItem(KEY,name);render();$('#ws-dd').hidden=true;
  $('#crumb').textContent='';$('#tab-page').setAttribute('aria-selected','true');$('#tab-blocks').setAttribute('aria-selected','false');
  const f=$('#preview-frame');f.src=f.src;};
$('#more').onclick=()=>{const m=$('#menu');m.hidden=!m.hidden;$('#more').setAttribute('aria-expanded',String(!m.hidden));$('#ws-dd').hidden=true};
$('#menu').onclick=e=>{const it=e.target.closest('[data-item]');if(it)fetch('/__log?item='+it.dataset.item)};
$('#tgl').onclick=()=>{const on=$('#tgl').getAttribute('aria-pressed')==='true';$('#tgl').setAttribute('aria-pressed',String(!on));$('#left').classList.toggle('hidden',on)};
$('#expand').onclick=()=>{const all=$('#expand').textContent==='Expand all';document.querySelectorAll('.cat').forEach(b=>b.setAttribute('aria-expanded',String(all)));$('#expand').textContent=all?'Collapse all':'Expand all'};
document.querySelectorAll('.cat').forEach(b=>b.onclick=()=>b.setAttribute('aria-expanded',String(b.getAttribute('aria-expanded')!=='true')));
const LABELS=${JSON.stringify(LABELS)},PANEL=${JSON.stringify(values.panel)};
window.selectBlock=id=>{const type=id.replace(/-[0-9a-f-]{36}$/,'');const name=PANEL==='label'?LABELS[type]:PANEL==='neither'?'selected block':type;$('#crumb').textContent='Page › '+name;
  $('#tab-page').setAttribute('aria-selected','false');$('#tab-blocks').setAttribute('aria-selected','true');$('#props').textContent='fields of '+name};
if(document.getElementById('grid-p1Editorial'))new IntersectionObserver(es=>{document.body.dataset.gridVisible=String(es.at(-1).intersectionRatio>=0.5)},{root:$('#left'),threshold:[0,0.5,1]}).observe(document.getElementById('grid-p1Editorial'));
</script></body></html>`;

const previewHtml = pagePath => {
  const blocks = BLOCKS.map(([t, u, c, h]) => `<section data-puck-component="${t}-${u}" style="height:${h}px;background:${c};color:#fff;padding:24px;position:relative"><h2>${t} on ${pagePath}</h2></section>`).join('');
  const ids = BLOCKS.map(([t, u]) => `${t}-${u}`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;font:16px system-ui,sans-serif}h1{margin:0;padding:16px;background:#eee}
.DraggableComponent--isSelected_x{position:absolute;pointer-events:none;border:3px solid #39f;z-index:9}
.tb{position:absolute;top:-28px;left:-3px;background:#39f;color:#fff;padding:2px 8px;font:12px system-ui}</style></head>
<body><h1>Preview of ${pagePath}</h1>${blocks}<script>
const ids=${JSON.stringify(ids)};const bug=${JSON.stringify(values.bug)};const toolbar=${JSON.stringify(values.toolbar)};const LABELS=${JSON.stringify(LABELS)};
function overlay(el){let o=document.querySelector('[data-puck-overlay]');if(!o){o=document.createElement('div');o.setAttribute('data-puck-overlay','true');o.className='DraggableComponent--isSelected_x';document.body.appendChild(o)}
 const type=el.getAttribute('data-puck-component').replace(/-[0-9a-f-]{36}$/,'');o.replaceChildren();if(toolbar==='label'){const t=document.createElement('div');t.className='tb';t.textContent=LABELS[type];o.appendChild(t)}
 const r=el.getBoundingClientRect();o.style.left=(r.left+scrollX)+'px';o.style.top=(r.top+scrollY)+'px';o.style.width=r.width+'px';o.style.height=r.height+'px'}
document.querySelectorAll('[data-puck-component]').forEach(el=>el.addEventListener('click',()=>{
  let id=el.getAttribute('data-puck-component');
  if(bug==='neighbor'){const i=ids.indexOf(id);id=ids[Math.min(i+1,ids.length-1)]}
  const target=document.querySelector('[data-puck-component="'+id+'"]');current=target;overlay(target);parent.selectBlock(id)}));
let current=null;const follow=()=>{if(current)overlay(current)};addEventListener('resize',follow);addEventListener('scroll',follow);new ResizeObserver(follow).observe(document.documentElement);
</script></body></html>`;
};

http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/__log') { clicks.push(u.searchParams.get('item')); r.writeHead(204); return r.end(); }
  if (u.pathname === '/__clicks') { r.writeHead(200, { 'content-type': 'application/json' }); return r.end(JSON.stringify(clicks)); }
  if (u.pathname === '/preview') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(previewHtml(u.searchParams.get('page') || '/')); }
  if (u.pathname === '/p1' || u.pathname.startsWith('/p1/')) { r.writeHead(200, { 'content-type': 'text/html' }); return r.end(editorHtml(pageForPath(u.pathname))); }
  if (u.pathname === '/') { r.writeHead(200, { 'content-type': 'text/html' }); return r.end('<h1>public site</h1>'); }
  r.writeHead(404); r.end('not found');
}).listen(port);
