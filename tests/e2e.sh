#!/usr/bin/env bash
# End-to-end tests against the fixture editor (tests/fixtures/mini-editor). Sourced by run-tests.sh,
# which provides ROOT, FX, TMP, PIDS, t, and start_server.
#
# They run the real harness through the real --connect path: a headless Chrome is started with a custom
# debugging port and a custom profile directory, the harness attaches to it, and the six shots are taken
# from an editor that honors the P1 editor's DOM contract. No P1, Figma, or Google access is used.
#
# The fixture is not P1: these tests prove the harness's logic and its fail-closed behavior, not that the
# live editor still matches the contract. That needs the live smoke test (references/second-user-smoke-test.md).

find_chrome() {
  # A headless shell first: launching the full Chrome app with a fresh profile makes macOS ask to change the default browser.
  local shell
  shell=$(ls -d "$HOME"/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell "$HOME"/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-*/chrome-headless-shell "$HOME"/.cache/puppeteer/chrome-headless-shell/*/chrome-headless-shell-*/chrome-headless-shell 2>/dev/null | sort -r | head -1)
  for c in "${CHROME_BIN:-}" "$shell" "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium" "$(command -v google-chrome 2>/dev/null)" "$(command -v google-chrome-stable 2>/dev/null)" "$(command -v chromium 2>/dev/null)" "$(command -v chromium-browser 2>/dev/null)"; do
    [ -n "$c" ] && [ -x "$c" ] && { echo "$c"; return 0; }
  done
  return 1
}

CDP_PORT=9777
E2E_PROFILE="$TMP/e2e-profile"
E2E_CFG="$TMP/e2e.json"
E="$TMP/e2e"
mkdir -p "$E"

echo "== editor fixture end to end (real --connect path, custom port and profile)"
CHROME=$(find_chrome) || { echo "FAIL  no Chrome found for the end-to-end tests (set CHROME_BIN)"; fail=$((fail + 1)); CHROME=""; }
if [ -n "$CHROME" ]; then
  start_server 4301 "$FX/mini-editor/server.mjs" 4301 || exit 1
  start_server 4302 "$FX/mini-editor/server.mjs" 4302 --publish "Publish page now" || exit 1
  start_server 4303 "$FX/mini-editor/server.mjs" 4303 --bug neighbor || exit 1
  "$CHROME" --headless=new --no-sandbox --no-first-run --no-default-browser-check --remote-debugging-port=$CDP_PORT --user-data-dir="$E2E_PROFILE" about:blank >/dev/null 2>&1 & CHROME_PID=$!
  PIDS+=($CHROME_PID)
  for _ in $(seq 1 40); do curl -s -m 1 "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null && break; sleep 0.3; done
  python3 - "$TMP" "$E2E_PROFILE" "$CDP_PORT" <<'EOF'
import json,sys
tmp,profile,port=sys.argv[1],sys.argv[2],int(sys.argv[3])
json.dump({"topic":"fixture-editor","baseUrl":"http://localhost:4301","projectName":"Fixture Project","workstream":"qa-workstream","pagePath":"/about",
  "blockType":"PullQuote","chrome":{"profileDir":profile,"cdpPort":port},
  "figma":{"fileKey":"QaQaQaQaQaQaQaQaQaQaQa","pageNamePattern":"{topic} · {release} · {runId}"},
  "docs":{"handoffDir":tmp+"/e2e-notes","format":"markdown"}},open(tmp+'/e2e.json','w'))
EOF
  cap() { local out=$1; shift; node scripts/capture.mjs --brief briefs/p1-editor.json --config "$E2E_CFG" --out-dir "$out" "$@"; }
  chk() { python3 "$ROOT/tests/assert-report.py" "$@"; }

  t "six shots are captured through the attached Chrome on a custom port (deep-linked page, workstream, block, collapse, menu)" bash -c "cd '$ROOT' && node scripts/capture.mjs --brief briefs/p1-editor.json --config '$E2E_CFG' --out-dir '$E/runA' >'$E/a.log' 2>&1 || { tail -20 '$E/a.log'; exit 1; }"
  t "report records the custom project, workstream and page; all six shots are PNGs; nothing skipped" python3 - "$E/runA" <<'EOF'
import json,sys,os
d=json.load(open(sys.argv[1]+'/capture-report.json'))
assert d['projectName']=='Fixture Project' and d['workstream']=='qa-workstream' and d['pagePath']=='/about', d
assert d['skipped']==[] and len(d['results'])==6 and all(x['ok'] for x in d['results'])
assert [x['slug'] for x in d['results']]==['editor-shell','blocks-browser','block-selected-properties','block-selected-canvas-context','workstream-selector-open','publish-menu-open']
for x in d['results']: assert os.path.getsize(x['file'])>2000 and x['finalUrl'].endswith('/p1/about'), x
EOF
  t "the custom Chrome profile directory was really used" bash -c "[ -f '$E2E_PROFILE/Local State' ] || [ -d '$E2E_PROFILE/Default' ]"
  t "no editor menu item was ever clicked (the delete item stays untouched)" bash -c "[ \"\$(curl -s http://localhost:4301/__clicks)\" = '[]' ]"
  t "the capture opened and closed only its own tabs (the attached Chrome is still up)" bash -c "curl -s http://127.0.0.1:$CDP_PORT/json/version | grep -q Browser"

  echo "== editor fixture: wrong page, workstream, project, or wording fails closed"
  t "pageNavigation=manual opens the editor route only, so the wrong page is rejected" bash -c "cd '$ROOT' && node scripts/capture.mjs --brief briefs/p1-editor.json --config '$E2E_CFG' --set pageNavigation=manual --only editor-shell --out-dir '$E/manual' >'$E/m.log' 2>&1; [ \$? -eq 1 ] && grep -q 'page-selector' '$E/m.log' && [ -z \"\$(ls '$E/manual'/*.png 2>/dev/null)\" ]"
  t "an unknown workstream is rejected and saves no PNG" bash -c "cd '$ROOT' && node scripts/capture.mjs --brief briefs/p1-editor.json --config '$E2E_CFG' --set workstream=no-such-workstream --only editor-shell --out-dir '$E/ws' >'$E/w.log' 2>&1; [ \$? -eq 1 ] && [ -z \"\$(ls '$E/ws'/*.png 2>/dev/null)\" ]"
  t "a different project name is rejected (the header must show the configured project)" bash -c "cd '$ROOT' && node scripts/capture.mjs --brief briefs/p1-editor.json --config '$E2E_CFG' --set projectName='Some Other Project' --only editor-shell --out-dir '$E/proj' >'$E/p.log' 2>&1; [ \$? -eq 1 ] && grep -q 'site-label' '$E/p.log'"
  t "a publish menu without the configured wording is rejected" bash -c "cd '$ROOT' && node scripts/capture.mjs --brief briefs/p1-editor.json --config '$E2E_CFG' --set publishMenuLabel='Publish elsewhere' --only publish-menu-open --out-dir '$E/lbl' >'$E/l.log' 2>&1; [ \$? -eq 1 ] && grep -q 'role=menu' '$E/l.log'"

  echo "== editor fixture: selecting a neighboring block is rejected (blockType and blockSelector)"
  cap "$E/bug" --set baseUrl=http://localhost:4303 >"$E/bug.log" 2>&1
  t "a broken editor that selects the NEXT block fails both block shots and keeps the others" chk "$E/bug" neighbor-rejected
  cap "$E/bugsel" --set baseUrl=http://localhost:4303 --set blockType= --set blockSelector='[data-puck-component^=PullQuote-]' --only block-selected-properties >"$E/bugsel.log" 2>&1
  t "the same neighbor bug is rejected when the block is chosen by selector" chk "$E/bugsel" shot-failed block-selected-properties "different block is selected"
  echo "== mutation check: without the instance and panel proofs the neighbor bug gets through"
  rm -rf "$TMP/mut-noproof" && mkdir -p "$TMP/mut-noproof" && cp -R scripts "$TMP/mut-noproof/scripts" && cp -R briefs "$TMP/mut-noproof/briefs" && ln -s "$ROOT/node_modules" "$TMP/mut-noproof/node_modules"
  python3 - "$TMP/mut-noproof/scripts/capture.mjs" <<'EOF'
import sys
p=sys.argv[1]; s=open(p).read()
a="  if (!probe.ok) throw await fail("; b="  if (!text.toLowerCase().includes(type.toLowerCase())) throw await fail("
assert a in s and b in s
s=s.replace(a,"  if (false) throw await fail(",1).replace(b,"  if (false) throw await fail(",1)
open(p,'w').write(s)
EOF
  t "MUTATION: with both block proofs disabled, the neighbor-selecting editor is wrongly accepted (so the real checks are what reject it)" bash -c "cd '$TMP/mut-noproof' && node scripts/capture.mjs --brief briefs/p1-editor.json --config '$E2E_CFG' --set baseUrl=http://localhost:4303 --out-dir '$E/mutbug' >'$E/mutbug.log' 2>&1; python3 '$ROOT/tests/assert-report.py' '$E/mutbug' shot-ok block-selected-properties && ! python3 '$ROOT/tests/assert-report.py' '$E/mutbug' neighbor-rejected >/dev/null 2>&1"
  cap "$E/okselector" --set blockType= --set blockSelector='[data-puck-component^=Stats-] h2' --only block-selected-properties >"$E/oks.log" 2>&1
  t "a selector that points inside a block selects that block and is proven (instance-level)" chk "$E/okselector" shot-ok block-selected-properties
  cap "$E/nosel" --set blockType= --set blockSelector='.not-in-a-block' --only block-selected-properties >"$E/nosel.log" 2>&1
  t "a selector that matches nothing is rejected, not silently skipped" chk "$E/nosel" shot-failed block-selected-properties

  echo "== release rehearsal: a UI wording change is caught, then handled by updating the config"
  cap "$E/runB-stale" --set baseUrl=http://localhost:4302 >"$E/bstale.log" 2>&1
  t "release B with the old wording fails only the publish-menu shot (closed, not shipped)" chk "$E/runB-stale" only-failed publish-menu-open
  t "release B with updated wording captures 6/6" bash -c "cd '$ROOT' && node scripts/capture.mjs --brief briefs/p1-editor.json --config '$E2E_CFG' --set baseUrl=http://localhost:4302 --set publishMenuLabel='Publish page now' --out-dir '$E/runB' >'$E/b.log' 2>&1; [ \$? -eq 0 ]"
  t "compare-runs reports exactly the shot whose wording changed; the rest are identical" bash -c "cd '$ROOT' && node scripts/compare-runs.mjs --old '$E/runA' --new '$E/runB' --json '$E/cmp.json' >'$E/cmp.log' 2>&1; python3 - '$E/cmp.json' <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); s={r['slug']:r for r in d['rows']}
assert s['publish-menu-open']['status']=='changed' and s['publish-menu-open']['diffPercent']>0, s['publish-menu-open']
assert all(r['status']=='identical' for k,r in s.items() if k!='publish-menu-open'), {k:r['status'] for k,r in s.items()}
PY"
  t "compare-runs --fail-on-change exits 2 on a change and 0 on identical runs" bash -c "cd '$ROOT' && node scripts/compare-runs.mjs --old '$E/runA' --new '$E/runB' --fail-on-change >/dev/null 2>&1; a=\$?; node scripts/compare-runs.mjs --old '$E/runA' --new '$E/runA' --fail-on-change >/dev/null 2>&1; b=\$?; [ \$a -eq 2 ] && [ \$b -eq 0 ]"
  python3 - "$E" <<'EOF'
import json,sys,datetime
e=sys.argv[1]
# Two real runs happen at different times; the fixture runs happened seconds apart, so give B a later time.
r=json.load(open(e+'/runB/capture-report.json')); t=datetime.datetime.fromisoformat(r['capturedAt'].replace('Z','+00:00'))+datetime.timedelta(hours=2)
r['capturedAt']=t.isoformat().replace('+00:00','Z'); json.dump(r,open(e+'/runB/capture-report.json','w'))
EOF
  t "each release gets its own run ID and Figma page name, from the release label; the destination is unchanged" bash -c "cd '$ROOT' && node scripts/figma-plan.mjs --dir '$E/runA' --config '$E2E_CFG' --release '1.0' >/dev/null 2>&1 && node scripts/figma-plan.mjs --dir '$E/runB' --config '$E2E_CFG' --release '1.1' >/dev/null 2>&1 && python3 - '$E' <<'PY'
import json,sys
e=sys.argv[1]; a=json.load(open(e+'/runA/figma-plan.json')); b=json.load(open(e+'/runB/figma-plan.json'))
assert a['runId']!=b['runId'], (a['runId'],b['runId'])
assert a['pageName']=='fixture-editor · 1.0 · '+a['runId'] and b['pageName']=='fixture-editor · 1.1 · '+b['runId'], (a['pageName'],b['pageName'])
assert a['pageName']!=b['pageName'] and a['destination']['fileKey']==b['destination']['fileKey']=='QaQaQaQaQaQaQaQaQaQaQa'
assert a['release']=='1.0' and b['release']=='1.1'
PY"
  t "a pattern that uses {release} fails clearly when no --release is given" bash -c "cd '$ROOT' && node scripts/figma-plan.mjs --dir '$E/runA' --config '$E2E_CFG' >'$E/nr.log' 2>&1; [ \$? -eq 1 ] && grep -q -- '--release' '$E/nr.log'"
  t "the generated Figma code for both releases coexists, and the earlier release's page is never touched" bash -c "cd '$ROOT' && node tests/figma-sandbox.mjs '$E/runA' '$E/runB' >'$E/sb.log' 2>&1; cat '$E/sb.log'; grep -q '^ok' '$E/sb.log'"
  t "the handoff note for release B names the release, the previous run, and the changed shot" bash -c "cd '$ROOT' && node scripts/handoff.mjs --skip-annotation test-fixture --config '$E2E_CFG' --dir '$E/runB' --previous '$E/runA' --release '1.1' >'$E/h.log' 2>&1 && f=\$(ls '$TMP'/e2e-notes/handoff-*.md | head -1) && grep -q '1.1' \"\$f\" && grep -q \"\$(python3 -c \"import json;print(json.load(open('$E/runA/figma-plan.json'))['runId'])\")\" \"\$f\" && grep -q 'publish-menu-open.*CHANGED' \"\$f\" && [ \"\$(grep -c '| unchanged |' \"\$f\")\" = 5 ] && ! grep -q '{{' \"\$f\""

  echo "== screenshot comparison: noise vs real change (synthetic images)"
python3 - "$TMP" <<'EOF'
import json, sys, zlib, struct, os, random
tmp = sys.argv[1]


def png(path, w, h, paint):
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            row += bytes(paint(x, y))
        rows.append(bytes(row))

    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    open(path, 'wb').write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(b''.join(rows))) + chunk(b'IEND', b''))


W, H = 320, 200
random.seed(7)
noise = set()
while len(noise) < 12:  # 12 scattered pixels, none within the same 16x16 square as another
    p = (random.randrange(W), random.randrange(H))
    if all((p[0] // 16, p[1] // 16) != (q[0] // 16, q[1] // 16) for q in noise):
        noise.add(p)
patch = {(x, y) for x in range(100, 112) for y in range(60, 68)}  # a 12x8 cluster, like a changed word


def base(x, y): return (240, 240, 244)
def noisy(x, y): return (200, 0, 0) if (x, y) in noise else (240, 240, 244)
def changed(x, y): return (20, 20, 20) if (x, y) in patch else (240, 240, 244)


def mk(name, paint):
    d = f'{tmp}/cmp-{name}'
    os.makedirs(d, exist_ok=True)
    png(d + '/s.png', W, H, paint)
    json.dump({"capturedAt": "2026-01-01T00:00:00.000Z", "results": [{"slug": "s", "side": "next", "ok": True, "file": d + '/s.png'}]}, open(d + '/capture-report.json', 'w'))


mk('base', base)
mk('noisy', noisy)
mk('changed', changed)
EOF
t "isolated pixel noise is ignored, and reported as noise" bash -c "cd '$ROOT' && node scripts/compare-runs.mjs --old '$TMP/cmp-base' --new '$TMP/cmp-noisy' --json '$TMP/cn.json' >/dev/null 2>&1 && python3 -c \"import json;r=json.load(open('$TMP/cn.json'))['rows'][0];assert r['status']=='identical' and r['noisePixels']==12, r\""
t "a dense cluster of changed pixels is reported as a change" bash -c "cd '$ROOT' && node scripts/compare-runs.mjs --old '$TMP/cmp-base' --new '$TMP/cmp-changed' --json '$TMP/cc.json' >/dev/null 2>&1 && python3 -c \"import json;r=json.load(open('$TMP/cc.json'))['rows'][0];assert r['status']=='changed' and r['changedBlocks']>=1, r\""
t "--exact treats even isolated noise as a change" bash -c "cd '$ROOT' && node scripts/compare-runs.mjs --old '$TMP/cmp-base' --new '$TMP/cmp-noisy' --exact --fail-on-change >/dev/null 2>&1; [ \$? -eq 2 ]"

echo "== second contributor and second project (shipped example config, a second Chrome, a second fixture project)"
t "the shipped second-contributor example config passes preflight as it is" node scripts/preflight.mjs --config examples/second-project.config.example.json --need capture,figma,handoff --brief briefs/p1-editor.json
if [ -n "$CHROME" ]; then
  start_server 4304 "$FX/mini-editor/server.mjs" 4304 --project "Second Project" --workstreams "trunk,second-workstream" --category "Layout" || exit 1
  "$CHROME" --headless=new --no-sandbox --no-first-run --no-default-browser-check --remote-debugging-port=9778 --user-data-dir="$TMP/second-profile" about:blank >/dev/null 2>&1 & PIDS+=($!)
  for _ in $(seq 1 40); do curl -s -m 1 "http://127.0.0.1:9778/json/version" >/dev/null && break; sleep 0.3; done
  python3 - "$TMP" <<'EOF'
import json,sys
tmp=sys.argv[1]; c=json.load(open('examples/second-project.config.example.json'))
c['baseUrl']='http://localhost:4304'; c['chrome']={"profileDir":tmp+"/second-profile","cdpPort":9778}; c['docs']['handoffDir']=tmp+'/second-notes'
json.dump(c,open(tmp+'/second.json','w'))
EOF
  t "the second project's six shots are captured from its own config, on its own port and profile" bash -c "cd '$ROOT' && node scripts/capture.mjs --brief briefs/p1-editor.json --config '$TMP/second.json' --out-dir '$E/second' >'$E/s.log' 2>&1; [ \$? -eq 0 ]"
  t "the second project's report holds only its own values (nothing from the first project)" python3 - "$E/second" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1]+'/capture-report.json')); blob=json.dumps(d)
assert d['projectName']=='Second Project' and d['workstream']=='second-workstream' and d['pagePath']=='/docs/guide' and len(d['results'])==6 and all(x['ok'] for x in d['results']), d
assert all(x['finalUrl'].endswith('/p1/docs/guide') for x in d['results'])
for first in ('Fixture Project','qa-workstream','/about','9777','4301'): assert first not in blob, first
EOF
  t "the second project's Figma run ID and page name follow its own patterns and destination" bash -c "cd '$ROOT' && node scripts/figma-plan.mjs --dir '$E/second' --config '$TMP/second.json' >/dev/null 2>&1 && python3 - '$E/second' <<'PY'
import json,re,sys
p=json.load(open(sys.argv[1]+'/figma-plan.json'))
assert re.fullmatch(r'second-project-editor-\d{4}-\d{8}',p['runId']), p['runId']
assert p['pageName'].startswith('Second Project · second-workstream · ') and p['pageName'].endswith(' · '+p['runId']), p['pageName']
assert p['destination']['fileKey']=='ZxZxZxZxZxZxZxZxZxZxZx'
PY"
  t "the second project's handoff note is written in its own directory and format (json)" bash -c "cd '$ROOT' && node scripts/handoff.mjs --skip-annotation test-fixture --config '$TMP/second.json' --dir '$E/second' --release 'Second 1.0' >/dev/null 2>&1 && python3 -c \"import json,glob;d=json.load(open(glob.glob('$TMP/second-notes/handoff-*.json')[0]));assert d['release']=='Second 1.0' and d['projectName']=='Second Project' and d['pagePath']=='/docs/guide', d\""
  t "both Chrome instances ran side by side on their own ports and profiles" bash -c "curl -s http://127.0.0.1:9777/json/version | grep -q Browser && curl -s http://127.0.0.1:9778/json/version | grep -q Browser && [ -d '$TMP/second-profile' ] && [ -d '$E2E_PROFILE' ] && [ '$TMP/second-profile' != '$E2E_PROFILE' ]"

  echo "== inventory-driven workflow end to end (fixture editor): brief, capture, record, gallery, Figma plan, handoff"
  INV="$E/inv.json"; mkdir -p "$E"
  cp "$FX/inventory/inventory.valid.json" "$INV"; cp "$INV" "$E/inv.pre.json"
  t "a capture brief is generated from the approved records for the configured target" bash -c "cd '$ROOT' && node scripts/inventory.mjs brief --inventory '$INV' --config '$E2E_CFG' --release 2026.10 --out '$E/inv-brief.json' >'$E/ib.log' 2>&1; [ \$? -eq 0 ]"
  t "a config for another workstream gets no shots from the inventory (the target must match)" bash -c "cd '$ROOT' && node scripts/inventory.mjs brief --inventory '$INV' --config '$E2E_CFG' --set workstream=other-ws --out '$E/inv-brief2.json' >'$E/ib2.log' 2>&1; [ \$? -eq 1 ] && grep -q 'none matches' '$E/ib2.log' && [ ! -f '$E/inv-brief2.json' ]"
  t "the harness executes only the brief's shots; both capture and the report carry ID, release, caption, and alt text unchanged" bash -c "cd '$ROOT' && node scripts/capture.mjs --brief '$E/inv-brief.json' --config '$E2E_CFG' --out-dir '$E/invrun' >'$E/ir.log' 2>&1; [ \$? -eq 0 ] && python3 - '$E/invrun' '$INV' <<'PY'
import json,sys
rep=json.load(open(sys.argv[1]+'/capture-report.json')); inv={r['screenshot_id']:r for r in json.load(open(sys.argv[2]))['records']}
ids=sorted(r['slug'] for r in rep['results'])
assert ids==['p1.editor.blocks-browser','p1.editor.workstream-selector'], ids
for r in rep['results']:
    rec=inv[r['slug']]
    assert r['ok'] and r['screenshotId']==r['slug'] and r['release']=='2026.10', r
    assert r['caption']==rec['content']['caption'] and r['altText']==rec['content']['alt_text'], r
assert rep['inventory']['target']=='Fixture Project | qa-workstream | /about', rep['inventory']
PY"
  t "recording the run sets checksum, size, time, and path from the real PNGs, and moves both records to captured" bash -c "cd '$ROOT' && node scripts/inventory.mjs record-capture --inventory '$INV' --run '$E/invrun' --assets-dir '$E/inv-assets' >'$E/rc.log' 2>&1 && python3 - '$E/invrun' '$INV' '$E/inv-assets' <<'PY'
import json,sys,hashlib,os
run,inv,assets=sys.argv[1:4]
recs={r['screenshot_id']:r for r in json.load(open(inv))['records']}
for i in ('p1.editor.blocks-browser','p1.editor.workstream-selector'):
    r=recs[i]; a=r['asset']
    png=open(f'{run}/{i}.png','rb').read()
    assert r['status']=='captured', r['status']
    assert a['sha256']==hashlib.sha256(png).hexdigest() and a['path']==f'screenshots/{i}/2026.10.png' and a['width']>0 and a['height']>0 and a['source']=='capture'
    assert open(os.path.join(assets,a['path']),'rb').read()==png
PY"
  t "the recorded inventory still validates" node scripts/inventory.mjs validate --inventory "$INV"
  t "recording a capture is refused when the record's caption changed after the brief was made" bash -c "cd '$ROOT' && python3 - '$E/inv.pre.json' '$E/inv.tamper.json' <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for r in d['records']:
    if r['screenshot_id']=='p1.editor.blocks-browser': r['content']['caption']='A different caption written after the capture.'
json.dump(d,open(sys.argv[2],'w'))
PY
node scripts/inventory.mjs record-capture --inventory '$E/inv.tamper.json' --run '$E/invrun' >'$E/rt.log' 2>&1; [ \$? -eq 1 ] && grep -q 'caption differs' '$E/rt.log'"
  t "the gallery shows each screenshot ID and uses the inventory alt text verbatim" bash -c "cd '$ROOT' && node scripts/make-gallery.mjs --dir '$E/invrun' >/dev/null 2>&1 && python3 - '$E/invrun/index.html' '$INV' <<'PY'
import sys,json,html
page=open(sys.argv[1]).read(); recs=json.load(open(sys.argv[2]))['records']
for r in recs:
    if r['screenshot_id'] in ('p1.editor.blocks-browser','p1.editor.workstream-selector'):
        assert 'data-screenshot-id=\"'+r['screenshot_id']+'\"' in page, r['screenshot_id']
        assert 'alt=\"'+html.escape(r['content']['alt_text'],quote=True)+'\"' in page, r['screenshot_id']
PY"
  t "the Figma plan carries the stable ID and frame name, writes a manifest, and marks everything planned, never uploaded" bash -c "cd '$ROOT' && node scripts/figma-plan.mjs --dir '$E/invrun' --config '$E2E_CFG' --release 2026.10 --inventory '$INV' >'$E/ip.log' 2>&1 && python3 - '$E/invrun' <<'PY'
import json,sys
d=sys.argv[1]; plan=json.load(open(d+'/figma-plan.json')); man=json.load(open(d+'/figma-manifest.json'))
recs=plan['inventory']['records']
assert [r['screenshot_id'] for r in recs]==['p1.editor.blocks-browser','p1.editor.workstream-selector'], recs
assert man['records']==recs
for r in recs:
    assert r['this_run']['state']=='planned' and r['this_run']['capture_png_sha256']==r['asset']['sha256'] and r['this_run']['inventory_sha256_matches'] is True, r['this_run']
    assert r['figma']['evidence_state']=='unverified' and r['figma']['node_id'] is None and r['figma']['file_url'] is None, r['figma']
    assert r['figma']['clean_frame_name'].startswith('['+r['screenshot_id']+'] — ') and r['figma']['clean_frame_name'].endswith(' — 2026.10 — clean')
assert {x['screenshotId'] for x in plan['rows']}=={'p1.editor.blocks-browser','p1.editor.workstream-selector'}
assert 'uploaded' not in json.dumps(man).replace('not uploaded','').replace('Nothing is uploaded','').replace('recorded as uploaded','')
code=open(d+'/figma-page.js').read()
assert '[p1.editor.blocks-browser] — Blocks browser — 2026.10 — clean' in code
PY"
  t "the generated Figma code for an inventory run passes the same sandbox checks (rectangles keep their upload keys)" node tests/figma-sandbox.mjs "$E/invrun"
  t "a captured shot with no inventory record stops the Figma plan as an inventory gap" bash -c "cd '$ROOT' && python3 - '$INV' '$E/inv.gap.json' <<'PY'
import json,sys
d=json.load(open(sys.argv[1])); d['records']=[r for r in d['records'] if r['screenshot_id']!='p1.editor.blocks-browser']
json.dump(d,open(sys.argv[2],'w'))
PY
rm -f '$E/invrun/figma-manifest.json'; node scripts/figma-plan.mjs --dir '$E/invrun' --config '$E2E_CFG' --release 2026.10 --inventory '$E/inv.gap.json' >'$E/ig.log' 2>&1; [ \$? -eq 1 ] && grep -q 'inventory gap' '$E/ig.log' && [ ! -f '$E/invrun/figma-manifest.json' ]"
  t "the docs handoff note lists the article, heading, image slot, caption, and alt text from the inventory, unchanged" bash -c "cd '$ROOT' && node scripts/handoff.mjs --skip-annotation test-fixture --config '$E2E_CFG' --dir '$E/invrun' --release 2026.10 --inventory '$INV' --set docs.handoffDir='$E/inv-notes' >'$E/ih.log' 2>&1 && python3 - '$INV' \$(ls '$E'/inv-notes/handoff-*.md) <<'PY'
import sys,json
recs={r['screenshot_id']:r for r in json.load(open(sys.argv[1]))['records']}; note=open(sys.argv[2]).read()
for i in ('p1.editor.blocks-browser','p1.editor.workstream-selector'):
    r=recs[i]
    assert r['content']['caption'] in note and r['content']['alt_text'] in note, i
    assert '| \`'+i+'\` |' in note and r['source']['docs_heading'] in note and r['publication']['docs_image_slot'] in note, i
    assert 'export the annotated frame \`['+i+']' in note and 'embed it' in note, i
assert 'TO FILL' in note and 'Docs destinations' in note
PY"
  t "the handoff refuses to run when an alt text is removed from the inventory (no generic fallback, no note written)" bash -c "cd '$ROOT' && python3 - '$INV' '$E/inv.noalt.json' <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
for r in d['records']:
    if r['screenshot_id']=='p1.editor.workstream-selector': r['content']['alt_text']='TO FILL'
json.dump(d,open(sys.argv[2],'w'))
PY
node scripts/handoff.mjs --skip-annotation test-fixture --config '$E2E_CFG' --dir '$E/invrun' --release 2026.10 --inventory '$E/inv.noalt.json' --set docs.handoffDir='$E/inv-notes2' >'$E/ina.log' 2>&1; [ \$? -ne 0 ] && grep -qi 'alt_text\|placeholder' '$E/ina.log' && [ -z \"\$(ls '$E'/inv-notes2/handoff-* 2>/dev/null)\" ]"
  t "a run without --inventory still hands off with the slug-based suggestions (backward compatible)" bash -c "cd '$ROOT' && node scripts/handoff.mjs --skip-annotation test-fixture --config '$E2E_CFG' --dir '$E/runA' --release 2026.10 --set docs.handoffDir='$E/compat-notes' >/dev/null 2>&1 && grep -q 'Suggested alt text' '$E'/compat-notes/handoff-*.md"
  t "the release report separates records that need action from inventory gaps using real run comparison" bash -c "cd '$ROOT' && node scripts/inventory.mjs release --inventory '$INV' --release 2026.10 --old '$E/invrun' --new '$E/runA' >'$E/irel.log' 2>&1; [ \$? -eq 2 ] && grep -q 'INVENTORY GAPS' '$E/irel.log' && grep -q 'p1.editor.blocks-browser  REFRESH' '$E/irel.log'"
fi

echo "== output safety: capture output can't be committed by accident; cleanup is safe"
  git init -q "$TMP/guardrepo"
  t "an out-dir inside a git repository that doesn't ignore it is refused before any browser work" bash -c "cd '$ROOT' && node scripts/capture.mjs --brief briefs/p1-editor.json --config '$E2E_CFG' --out-dir '$TMP/guardrepo/shots' >'$E/g.log' 2>&1; [ \$? -eq 1 ] && grep -q 'git repository' '$E/g.log' && [ ! -e '$TMP/guardrepo/shots/capture-report.json' ]"
  echo "shots/" > "$TMP/guardrepo/.gitignore"
  t "the same out-dir is allowed once git ignores it" bash -c "cd '$ROOT' && node scripts/capture.mjs --brief briefs/p1-editor.json --config '$E2E_CFG' --only editor-shell --out-dir '$TMP/guardrepo/shots' >'$E/g2.log' 2>&1; [ \$? -eq 0 ] && [ -f '$TMP/guardrepo/shots/capture-report.json' ] && [ -z \"\$(git -C '$TMP/guardrepo' status --short | grep -v gitignore)\" ]"
  t "cleanup lists output folders and removes nothing without --yes" bash -c "cd '$ROOT' && node scripts/cleanup.mjs --out-dir '$E/runB-stale' >'$E/c1.log' 2>&1; [ \$? -eq 0 ] && grep -q 'would remove' '$E/c1.log' && [ -d '$E/runB-stale' ]"
  t "cleanup refuses a folder that isn't a capture output folder" bash -c "mkdir -p '$TMP/not-output' && cd '$ROOT' && node scripts/cleanup.mjs --out-dir '$TMP/not-output' --yes >/dev/null 2>&1; [ \$? -eq 1 ] && [ -d '$TMP/not-output' ]"
  t "cleanup refuses to remove the Chrome profile while that Chrome is still running" bash -c "cd '$ROOT' && node scripts/cleanup.mjs --config '$E2E_CFG' --profile --yes >'$E/c2.log' 2>&1; [ \$? -eq 1 ] && grep -q 'still running' '$E/c2.log' && [ -d '$E2E_PROFILE' ]"
  t "cleanup removes a capture folder with --yes and never touches handoff notes" bash -c "cd '$ROOT' && node scripts/cleanup.mjs --out-dir '$E/runB-stale' --yes >/dev/null 2>&1 && [ ! -e '$E/runB-stale' ] && [ -n \"\$(ls '$TMP'/e2e-notes/handoff-*.md)\" ]"
  mkdir -p "$TMP/old-profile/Default" && echo x > "$TMP/old-profile/Local State"
  python3 - "$TMP" <<'EOF'
import json,sys
tmp=sys.argv[1]; c=json.load(open(tmp+'/e2e.json')); c['chrome']={"profileDir":tmp+"/old-profile","cdpPort":9888}; json.dump(c,open(tmp+'/cleanup.json','w'))
c['chrome']['profileDir']=tmp+'/random-dir'; json.dump(c,open(tmp+'/cleanup-bad.json','w'))
EOF
  mkdir -p "$TMP/random-dir" && echo precious > "$TMP/random-dir/notes.txt"
  t "cleanup removes an idle Chrome profile with --yes, and refuses a directory that isn't a Chrome profile" bash -c "cd '$ROOT' && node scripts/cleanup.mjs --config '$TMP/cleanup.json' --profile >/dev/null 2>&1 && [ -d '$TMP/old-profile' ] && node scripts/cleanup.mjs --config '$TMP/cleanup.json' --profile --yes >/dev/null 2>&1 && [ ! -e '$TMP/old-profile' ]; node scripts/cleanup.mjs --config '$TMP/cleanup-bad.json' --profile --yes >/dev/null 2>&1; [ \$? -eq 1 ] && [ -f '$TMP/random-dir/notes.txt' ]"
fi

echo "== page navigation (derived editor URL)"
python3 - "$TMP" <<'EOF'
import json,sys
tmp=sys.argv[1]; base=json.load(open(tmp+'/cfg.json')); base['blockType']='QaBlock'
for name,pp,extra in [('url-root','/',{}),('url-about','/about',{}),('url-nested','/docs/guide',{}),('url-trailing','/docs/guide/',{}),('url-custom-route','/about',{'editorRoute':'/editor'}),('url-manual','/about',{'pageNavigation':'manual'})]:
    c=dict(base); c['pagePath']=pp; c.update(extra); json.dump(c,open(f'{tmp}/{name}.json','w'))
EOF
t "pages map to editor URLs the way the editor mounts them: / -> /p1, /about -> /p1/about, nested and trailing slashes, a custom route, and manual mode" python3 - "$TMP" <<'EOF'
import json,subprocess,sys
tmp=sys.argv[1]
want={'url-root':'/p1','url-about':'/p1/about','url-nested':'/p1/docs/guide','url-trailing':'/p1/docs/guide','url-custom-route':'/editor/about','url-manual':'/p1'}
for name,url in want.items():
    r=subprocess.run(['node','scripts/capture.mjs','--brief','briefs/p1-editor.json','--config',f'{tmp}/{name}.json','--dry-run'],capture_output=True,text=True)
    d=json.loads(r.stdout); urls={s['url'] for s in d['shots']}
    assert urls=={url}, (name,urls)
EOF

echo "== Figma: generated code, uploads, and parameterized destinations (no Figma access)"
python3 - "$TMP" "$OUT" <<'EOF'
import json,sys,shutil,os
tmp,out=sys.argv[1:3]
d=tmp+'/sandbox'; shutil.copytree(out,d,dirs_exist_ok=True)
r=json.load(open(d+'/capture-report.json'))
for x in r['results']:
    if 'file' in x: x['file']=d+'/'+('baseline/' if x['side']=='baseline' else '')+x['slug']+'.png'
r.update(projectName='QA Project',workstream='qa-workstream',pagePath='/docs/example')
for x in r['results']:
    if x['slug']=='02-pricing' and x['side']=='baseline': x.update(ok=False,error='simulated failure'); x.pop('file',None)
r['results']=[x for x in r['results'] if not (x['slug']=='01-home' and x['side']=='baseline')]
json.dump(r,open(d+'/capture-report.json','w'))
EOF
rm -f "$TMP/sandbox/figma-plan.json" "$TMP/sandbox/figma-page.js"
node scripts/figma-plan.mjs --dir "$TMP/sandbox" --config "$TMP/cfg.json" >/dev/null 2>&1
t "the generated Figma code makes one named rectangle per upload, clears wrapper fills, marks attention rows, and returns node IDs in upload order" node tests/figma-sandbox.mjs "$TMP/sandbox"
t "the duplicate guard rejects a repeat run before creating any node, and a second run coexists (executed against a Figma API mock)" bash -c "node tests/figma-sandbox.mjs '$TMP/sandbox' | grep -q 'duplicate rejected, second run coexists'"
echo "== mutation checks: the tests above fail when the guarded behavior is removed"
mutant() { # mutant <name>: a scratch copy of scripts/, so a source edit never touches the real files
  rm -rf "$TMP/mut-$1" && mkdir -p "$TMP/mut-$1" && cp -R scripts "$TMP/mut-$1/scripts" && ln -s "$ROOT/node_modules" "$TMP/mut-$1/node_modules" && cp package.json "$TMP/mut-$1/"
}
mutant nofill
python3 - "$TMP/mut-nofill/scripts/figma-plan.mjs" <<'EOF'
import sys
p=sys.argv[1]; s=open(p).read(); old="f.fills = []; return f;"
assert old in s; open(p,'w').write(s.replace(old,"return f;",1))
EOF
rm -rf "$TMP/sandbox-nofill" && cp -R "$TMP/sandbox" "$TMP/sandbox-nofill" && rm -f "$TMP/sandbox-nofill/figma-plan.json" "$TMP/sandbox-nofill/figma-page.js"
node "$TMP/mut-nofill/scripts/figma-plan.mjs" --dir "$TMP/sandbox-nofill" --config "$TMP/cfg.json" >/dev/null 2>&1
t "MUTATION: leaving the default white fill on wrapper frames makes the Figma sandbox test fail" bash -c "cd '$ROOT' && [ -f '$TMP/sandbox-nofill/figma-page.js' ] && ! node tests/figma-sandbox.mjs '$TMP/sandbox-nofill' >/dev/null 2>&1"
mutant noguard
python3 - "$TMP/mut-noguard/scripts/figma-plan.mjs" <<'EOF'
import sys
p=sys.argv[1]; s=open(p).read(); old="p.name === DATA.pageName)"
assert old in s; open(p,'w').write(s.replace(old,"p.name === DATA.pageName + '-never')",1))
EOF
rm -rf "$TMP/sandbox-noguard" && cp -R "$TMP/sandbox" "$TMP/sandbox-noguard" && rm -f "$TMP/sandbox-noguard/figma-plan.json" "$TMP/sandbox-noguard/figma-page.js"
node "$TMP/mut-noguard/scripts/figma-plan.mjs" --dir "$TMP/sandbox-noguard" --config "$TMP/cfg.json" >/dev/null 2>&1
t "MUTATION: a duplicate guard that never matches makes the Figma sandbox test fail" bash -c "cd '$ROOT' && [ -f '$TMP/sandbox-noguard/figma-page.js' ] && ! node tests/figma-sandbox.mjs '$TMP/sandbox-noguard' >/dev/null 2>&1"
t "the plan carries the configured Figma destination" python3 - "$TMP/sandbox" <<'EOF'
import json,sys
p=json.load(open(sys.argv[1]+'/figma-plan.json')); assert p['destination']['fileKey']=='QaQaQaQaQaQaQaQaQaQaQa', p['destination']
EOF
start_server 4401 "$FX/upload-server.mjs" 4401 || exit 1
python3 - "$TMP" <<'EOF'
import json,sys
tmp=sys.argv[1]; p=json.load(open(tmp+'/sandbox/figma-plan.json'))
n=len(p['chunks'][0]); json.dump(['http://127.0.0.1:4401/ok/%d'%i for i in range(n)],open(tmp+'/up-ok.json','w'))
json.dump(['http://127.0.0.1:4401/fail/0']+['http://127.0.0.1:4401/ok/%d'%i for i in range(1,n)],open(tmp+'/up-one-fail.json','w'))
EOF
t "uploads send each PNG's real bytes as image/png and exit 0" bash -c "P1_UPLOAD_ALLOW_LOOPBACK=1 node scripts/figma-upload.mjs --dir '$TMP/sandbox' --urls '$TMP/up-ok.json' >'$TMP/u1.log' 2>&1 && python3 - '$TMP' <<'PY'
import json,sys,urllib.request,os
tmp=sys.argv[1]; p=json.load(open(tmp+'/sandbox/figma-plan.json'))
got=json.load(urllib.request.urlopen('http://127.0.0.1:4401/__stats'))
assert len(got)==len(p['uploads']), (len(got),len(p['uploads']))
assert sorted(g['bytes'] for g in got)==sorted(os.path.getsize(u['file']) for u in p['uploads'])
assert all(g['contentType']=='image/png' and g['pngSignature']=='89504e470d0a1a0a' for g in got)
PY"
t "one failed upload exits 1, names the file, and prints a --only retry for just that file" bash -c "P1_UPLOAD_ALLOW_LOOPBACK=1 node scripts/figma-upload.mjs --dir '$TMP/sandbox' --urls '$TMP/up-one-fail.json' >'$TMP/u2.log' 2>&1; [ \$? -eq 1 ] && grep -q 'HTTP 500' '$TMP/u2.log' && grep -q -- '--only' '$TMP/u2.log'"

echo "== skill validator"
t "the in-repo skill validator passes on this tool" node scripts/validate-skill.mjs
rm -rf "$TMP/skillcopy" && mkdir -p "$TMP/skillcopy/screenshots-to-docs" && cp -R SKILL.md references scripts templates examples briefs tests "$TMP/skillcopy/screenshots-to-docs/" 2>/dev/null
SC="$TMP/skillcopy/screenshots-to-docs"
t "the validator accepts an intact copy" node scripts/validate-skill.mjs "$SC"
sed -i.bak 's/^name: screenshots-to-docs/name: some-other-name/' "$SC/SKILL.md" && rm -f "$SC/SKILL.md.bak"
t "the validator rejects a name that doesn't match the folder" bash -c "node scripts/validate-skill.mjs '$SC' >/dev/null 2>&1; [ \$? -eq 1 ]"
sed -i.bak 's/^name: some-other-name/name: screenshots-to-docs/' "$SC/SKILL.md" && rm -f "$SC/SKILL.md.bak"
echo 'See `references/does-not-exist.md`.' >> "$SC/SKILL.md"
t "the validator rejects a link to a file that doesn't exist" bash -c "node scripts/validate-skill.mjs '$SC' >'$TMP/v.log' 2>&1; [ \$? -eq 1 ] && grep -q 'does-not-exist' '$TMP/v.log'"
sed -i.bak '/does-not-exist/d' "$SC/SKILL.md" && rm -f "$SC/SKILL.md.bak"
echo "orphan" > "$SC/references/orphan.md"
t "the validator rejects a reference that SKILL.md doesn't link" bash -c "node scripts/validate-skill.mjs '$SC' >'$TMP/v2.log' 2>&1; [ \$? -eq 1 ] && grep -q 'orphan.md' '$TMP/v2.log'"
