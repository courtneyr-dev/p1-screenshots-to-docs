#!/usr/bin/env bash
# Regression and portability tests for the capture harness, planner, uploader, configuration,
# and handoff generator.
#
# Runs against local fixture sites on ports 4201-4203, so it needs Node, the tool's npm
# dependencies (bash scripts/setup.sh, in this tool directory), and Google Chrome.
# It needs no P1, Figma, or Google access. The live signed-in capture and the Figma push are
# not covered here; see references/known-limitations.md.
#
# Usage: npm test   (or: bash tests/run-tests.sh)

set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SKILL="$ROOT"
FX="$ROOT/tests/fixtures"
TMP=$(mktemp -d)
PIDS=()
pass=0
fail=0

cleanup() { for p in "${PIDS[@]:-}"; do [ -n "$p" ] && { kill "$p" 2>/dev/null; wait "$p" 2>/dev/null; }; done; if [ -n "${KEEP_TMP:-}" ]; then echo "kept test files: $TMP"; else rm -rf "$TMP"; fi; }
trap cleanup EXIT

t() { # t "name" command...  (passes when the command exits 0)
  local name=$1; shift
  if "$@" >"$TMP/last.log" 2>&1; then echo "PASS  $name"; pass=$((pass + 1)); else echo "FAIL  $name"; sed 's/^/        /' "$TMP/last.log" | head -10; fail=$((fail + 1)); fi
}

start_server() { # start_server port file args...
  local port=$1; shift
  node "$@" >/dev/null 2>&1 & PIDS+=($!)
  for _ in $(seq 1 30); do curl -s -o /dev/null "http://localhost:$port/" && return 0; sleep 0.2; done
  echo "server on $port didn't start (port busy?)"; return 1
}

cd "$SKILL" || exit 1
[ -d node_modules ] || { echo "Run: bash scripts/setup.sh (in $SKILL)"; exit 1; }

echo "== static"
for f in capture capture-window preflight chrome handoff record-annotation compare-runs cleanup validate-skill check-identity figma-plan figma-upload make-gallery routes verify-site inventory publish-markdown draft-alt figma-export gdocs-manifest setup build-figma-plugin watch; do t "node --check scripts/$f.mjs" node --check "scripts/$f.mjs"; done
for f in config presets release-sources watch; do t "node --check scripts/lib/$f.mjs" node --check "scripts/lib/$f.mjs"; done
t "JSON files parse" python3 -c "
import json,glob
for p in glob.glob('briefs/*.json')+glob.glob('scripts/presets/*.json')+glob.glob('watchlists/*.json')+glob.glob('templates/*.json')+glob.glob('examples/**/*.json',recursive=True)+glob.glob('$FX/*.json')+['package.json']: json.load(open(p))"
t "no preset step clicks a delete/destructive item" python3 - <<'EOF'
import json,re
a=json.load(open('scripts/presets/p1-editor.json'))['actions']
for n,d in a.items():
    for s in d.get('steps',[]):
        blob=json.dumps(s).lower()
        assert not re.search(r'delete|remove|archive|discard', blob), (n, s)
EOF

echo "== configuration: missing and invalid values (no browser opens)"
git init -q "$TMP/repo"
python3 - "$TMP" "$ROOT" <<'EOF'
import json,sys
tmp,root=sys.argv[1:3]
cfg={"topic":"qa-editor","baseUrl":"http://localhost:3000","projectName":"QA Project","workstream":"qa-workstream","pagePath":"/docs/example",
     "blockType":"QaBlock","chrome":{"profileDir":tmp+"/qa-profile","cdpPort":9555},
     "figma":{"fileKey":"QaQaQaQaQaQaQaQaQaQaQa","pageNamePattern":"{topic} · {workstream} · {runId}","runIdPattern":"{topic}_{yyyymmdd}_{hhmm}"},
     "docs":{"handoffDir":tmp+"/notes","format":"markdown"}}
json.dump(cfg,open(tmp+'/cfg.json','w')); json.dump({},open(tmp+'/empty.json','w'))
EOF
t "preflight passes for a complete config and the generic brief" node scripts/preflight.mjs --config "$TMP/cfg.json" --need capture,figma,handoff --brief briefs/p1-editor.json
t "preflight reports every missing value at once" bash -c "node scripts/preflight.mjs --config '$TMP/empty.json' --need capture,figma,handoff >'$TMP/pf.log' 2>&1; [ \$? -eq 1 ] && for k in topic baseUrl projectName workstream pagePath chrome.profileDir chrome.cdpPort figma.fileKey docs.handoffDir; do grep -q \"\$k\" '$TMP/pf.log' || { echo \"not reported: \$k\"; exit 1; }; done"
t "each required value is reported when it is the only one missing" python3 - "$TMP" <<'EOF'
import json,subprocess,sys,copy
tmp=sys.argv[1]; base=json.load(open(tmp+'/cfg.json'))
for key,stage in [('topic','capture'),('baseUrl','capture'),('projectName','capture'),('workstream','capture'),('pagePath','capture'),
                  ('chrome.profileDir','capture'),('chrome.cdpPort','capture'),('figma.fileKey','figma'),('docs.handoffDir','handoff')]:
    c=copy.deepcopy(base); o=c
    parts=key.split('.')
    for p in parts[:-1]: o=o[p]
    del o[parts[-1]]
    json.dump(c,open(tmp+'/one.json','w'))
    r=subprocess.run(['node','scripts/preflight.mjs','--config',tmp+'/one.json','--need',stage],capture_output=True,text=True)
    assert r.returncode==1 and key in r.stdout+r.stderr, (key, r.returncode, r.stdout, r.stderr)
EOF
t "the example config is a placeholder template: preflight refuses it and says so" bash -c "node scripts/preflight.mjs --config examples/config.example.json --need capture,figma,handoff >'$TMP/ex.log' 2>&1; [ \$? -eq 1 ] && grep -q placeholder '$TMP/ex.log'"
t "unsafe, invalid, and credential-like values are each refused with a clear reason" python3 - "$TMP" "$ROOT" <<'EOF'
import json,subprocess,sys,copy
tmp,root=sys.argv[1:3]; base=json.load(open(tmp+'/cfg.json'))
def with_(mut):
    c=copy.deepcopy(base); mut(c); return c
cases=[
 ("regular Chrome profile", lambda c:c['chrome'].update(profileDir='~/Library/Application Support/Google/Chrome/Default'),'capture'),
 ("inside this tool", lambda c:c['chrome'].update(profileDir=root+'/profile'),'capture'),
 ("inside a git repository", lambda c:c['chrome'].update(profileDir=tmp+'/repo/profile'),'capture'),
 ("1024 to 65535", lambda c:c['chrome'].update(cdpPort=80),'capture'),
 ("1024 to 65535", lambda c:c['chrome'].update(cdpPort=70000),'capture'),
 ("integer", lambda c:c['chrome'].update(cdpPort='9222'),'capture'),
 ("username or password", lambda c:c.update(baseUrl='http://user:pw@localhost:3000'),'capture'),
 ("http", lambda c:c.update(baseUrl='localhost:3000'),'capture'),
 ("credential", lambda c:c.update(cookie='abc'),'capture'),
 ("credential", lambda c:c['chrome'].update(sessionToken='abc'),'capture'),
 ("credential", lambda c:c['figma'].update(apiKey='abc'),'figma'),
 ("unknown key", lambda c:c.update(workstrem='typo'),'capture'),
 ("not both", lambda c:c.update(blockSelector='.x'),'capture'),
 ("must start with", lambda c:c.update(pagePath='about'),'capture'),
 ("runId", lambda c:c['figma'].update(pageNamePattern='{topic} {date}'),'figma'),
 ("unknown token", lambda c:c['figma'].update(pageNamePattern='{topic} {runId} {bogus}'),'figma'),
 ("hhmm", lambda c:c['figma'].update(runIdPattern='{topic}-{yyyymmdd}'),'figma'),
 ("Figma file key", lambda c:c['figma'].update(fileKey='short'),'figma'),
 ("markdown", lambda c:c['docs'].update(format='pdf'),'handoff'),
 ("inside this tool", lambda c:c['docs'].update(handoffDir=root+'/notes'),'handoff'),
 ("placeholder", lambda c:c.update(workstream='<your workstream>'),'capture'),
]
for want,mut,stage in cases:
    json.dump(with_(mut),open(tmp+'/bad.json','w'))
    r=subprocess.run(['node','scripts/preflight.mjs','--config',tmp+'/bad.json','--need',stage],capture_output=True,text=True)
    out=r.stdout+r.stderr
    assert r.returncode==1 and want in out, (want, r.returncode, out)
EOF
t "a missing config file is reported with how to create one" bash -c "node scripts/preflight.mjs --config '$TMP/nope.json' >'$TMP/nf.log' 2>&1; [ \$? -eq 1 ] && grep -q 'examples/config.example.json' '$TMP/nf.log'"
t "the generic brief without --config fails before a browser opens and names --config" bash -c "node scripts/capture.mjs --brief briefs/p1-editor.json --out-dir '$TMP/x' >'$TMP/nc.log' 2>&1; [ \$? -eq 1 ] && grep -q -- '--config' '$TMP/nc.log' && [ ! -e '$TMP/x/capture-report.json' ]"

echo "== portability: custom project, workstream, page, block, Chrome profile and port"
node scripts/capture.mjs --brief briefs/p1-editor.json --config "$TMP/cfg.json" --dry-run >"$TMP/dry.json" 2>"$TMP/dry.err"
t "custom workstream, page, project and block flow into every shot; nothing else leaks in" python3 - "$TMP" <<'EOF'
import json,sys
tmp=sys.argv[1]; d=json.load(open(tmp+'/dry.json')); blob=json.dumps(d)
assert d['workstream']=='qa-workstream' and d['pagePath']=='/docs/example' and d['project']=='QA Project', d
assert len(d['shots'])==6 and d['skipped']==[], (len(d['shots']), d['skipped'])
assert blob.count('qa-workstream')>=6, blob.count('qa-workstream')
assert '"/docs/example"' in blob and 'QA Project' in blob and 'QaBlock' in blob
for bad in ('courtneyr','Trogdor','trogdor','Live','9222','P1PullQuote'): assert bad not in blob, bad
EOF
t "custom CDP port becomes the connect URL; no fixed port remains" python3 - "$TMP" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1]+'/dry.json')); assert d['connect']=='http://127.0.0.1:9555', d['connect']
EOF
node scripts/capture.mjs --brief briefs/p1-editor.json --config "$TMP/cfg.json" --set workstream=other-workstream --set chrome.cdpPort=9666 --dry-run >"$TMP/dry2.json" 2>/dev/null
t "--set overrides a value for one command" python3 - "$TMP" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1]+'/dry2.json')); blob=json.dumps(d)
assert d['connect']=='http://127.0.0.1:9666' and 'other-workstream' in blob and 'qa-workstream' not in blob
EOF
python3 - "$TMP" <<'EOF'
import json,sys
tmp=sys.argv[1]; c=json.load(open(tmp+'/cfg.json')); c.pop('blockType'); json.dump(c,open(tmp+'/noblock.json','w'))
c['blockSelector']='[data-puck-component^=Qa-]'; json.dump(c,open(tmp+'/selector.json','w'))
EOF
node scripts/capture.mjs --brief briefs/p1-editor.json --config "$TMP/noblock.json" --dry-run >"$TMP/nb.json" 2>"$TMP/nb.err"
t "without a block, the block shots are skipped and reported (not failed), with a warning" python3 - "$TMP" <<'EOF'
import json,sys
tmp=sys.argv[1]; d=json.load(open(tmp+'/nb.json'))
assert [s['slug'] for s in d['shots']]==['editor-shell','blocks-browser','workstream-selector-open','publish-menu-open'], [s['slug'] for s in d['shots']]
assert {s['slug'] for s in d['skipped']}=={'block-selected-properties','block-selected-canvas-context'}, d['skipped']
assert 'blockType' in open(tmp+'/nb.err').read()
EOF
node scripts/capture.mjs --brief briefs/p1-editor.json --config "$TMP/selector.json" --dry-run >"$TMP/sel.json" 2>/dev/null
t "a blockSelector selects through the selector variant of the shots" python3 - "$TMP" <<'EOF'
import json,sys
d=json.load(open(sys.argv[1]+'/sel.json')); blob=json.dumps(d)
assert len(d['shots'])==6 and '[data-puck-component^=Qa-]' in blob and 'QaBlock' not in blob
EOF
t "chrome.mjs prints the launch command with the configured profile and port" bash -c "node scripts/chrome.mjs --config '$TMP/cfg.json' >'$TMP/ch.log' 2>&1; [ \$? -eq 0 ] && grep -q -- '--remote-debugging-port=9555' '$TMP/ch.log' && grep -q '$TMP/qa-profile' '$TMP/ch.log' && grep -q 'http://localhost:3000/p1' '$TMP/ch.log' && ! grep -q 9222 '$TMP/ch.log'"
t "chrome.mjs --check exits 1 when nothing listens on the configured port" bash -c "node scripts/chrome.mjs --config '$TMP/cfg.json' --check >/dev/null 2>&1; [ \$? -eq 1 ]"

echo "== action validation (no browser opens)"
python3 - "$TMP" <<'EOF'
import json,sys
tmp=sys.argv[1]
b=json.load(open('briefs/p1-editor.json'))
b['shots']=[{"slug":"t","url":"/p1","actions":["selectWorkstrem"]}]; json.dump(b,open(tmp+'/bad-name.json','w'))
b['shots']=[{"slug":"t","url":"/p1","actions":[{"selectWorkstream":{}}]}]; json.dump(b,open(tmp+'/bad-param.json','w'))
EOF
t "unknown action fails with exit 1" bash -c "node scripts/capture.mjs --brief '$TMP/bad-name.json' --config '$TMP/cfg.json' --dry-run 2>&1 | grep -q 'unknown action'; [ \${PIPESTATUS[0]} -eq 1 ]"
t "missing action parameter fails with exit 1" bash -c "node scripts/capture.mjs --brief '$TMP/bad-param.json' --config '$TMP/cfg.json' --dry-run 2>&1 | grep -q 'needs name'; [ \${PIPESTATUS[0]} -eq 1 ]"

echo "== fixture parity capture"
start_server 4201 "$FX/server.mjs" 4201 new '#0a7' || exit 1
start_server 4202 "$FX/server.mjs" 4202 old '#c50' || exit 1
OUT="$TMP/parity"
t "parity capture completes (6/6)" node scripts/capture.mjs --brief "$FX/parity-brief.json" --out-dir "$OUT"
t "report has slug, side, file, status, finalUrl, dpr; intentional 404 is a captured shot" python3 - "$OUT" <<'EOF'
import json,sys,os
r=json.load(open(sys.argv[1]+'/capture-report.json'))['results']
assert len(r)==6, len(r)
for x in r:
    assert x['ok'] is True
    for k in ('slug','side','file','status','finalUrl','dpr'): assert k in x, (x['slug'],k)
    assert os.path.getsize(x['file'])>1000
legacy=[x for x in r if x['slug']=='03-legacy' and x['side']=='next'][0]
assert legacy['status']==404
EOF

echo "== planner"
rm -f "$OUT/figma-plan.json" "$OUT/figma-page.js"
t "plan from a real report succeeds with the default naming" node scripts/figma-plan.mjs --dir "$OUT"
t "default run ID and page name keep the original convention" python3 - "$OUT" <<'EOF'
import json,re,sys
p=json.load(open(sys.argv[1]+'/figma-plan.json'))
assert re.fullmatch(r'fixture-parity-\d{8}-\d{4}',p['runId']), p['runId']
assert re.fullmatch(r'fixture-parity · \d{4}-\d{2}-\d{2} \d{2}:\d{2} · fixture-parity-\d{8}-\d{4}',p['pageName']), p['pageName']
assert p['destination']['fileKey'] is None
EOF
t "attention row sorts first and is marked; 6 uploads; duplicate guard present" python3 - "$OUT" <<'EOF'
import json,sys
p=json.load(open(sys.argv[1]+'/figma-plan.json'))
assert p['rows'][0]['slug']=='03-legacy' and p['rows'][0]['attention'] is True
assert len(p['uploads'])==6 and len(p['chunks'])==1
code=open(sys.argv[1]+'/figma-page.js').read()
assert "Page already exists" in code and code.index("Page already exists") < code.index("figma.createPage()")
assert "NEEDS ATTENTION" in code
EOF
cp -R "$OUT" "$TMP/corrupt"
python3 - "$TMP/corrupt" <<'EOF'
import json,sys
d=sys.argv[1]; r=json.load(open(d+'/capture-report.json'))
for x in r['results']: x['file']=d+'/'+('baseline/' if x['side']=='baseline' else '')+x['slug']+'.png'
json.dump(r,open(d+'/capture-report.json','w'))
open(d+'/01-home.png','w').write('not a png')
EOF
rm -f "$TMP/corrupt/figma-plan.json"
t "planner exits 1 and writes nothing for a corrupt 'captured' PNG" bash -c "node scripts/figma-plan.mjs --dir '$TMP/corrupt' >'$TMP/c.log' 2>&1; [ \$? -eq 1 ] && grep -q unusable '$TMP/c.log' && [ ! -e '$TMP/corrupt/figma-plan.json' ]"
rm -f "$TMP/corrupt/01-home.png"
t "planner exits 1 for a missing 'captured' PNG" bash -c "node scripts/figma-plan.mjs --dir '$TMP/corrupt' >'$TMP/m.log' 2>&1; [ \$? -eq 1 ] && grep -q 'file is missing' '$TMP/m.log'"

echo "== portability: custom Figma destination and naming"
cp -R "$OUT" "$TMP/named"
python3 - "$TMP/named" "$TMP" <<'EOF'
import json,sys
d,tmp=sys.argv[1:3]; d_out=d
r=json.load(open(d+'/capture-report.json'))
for x in r['results']: x['file']=d+'/'+('baseline/' if x['side']=='baseline' else '')+x['slug']+'.png'
r.update(projectName='QA Project',workstream='qa-workstream',pagePath='/docs/example'); r['skipped']=[{"slug":"block-selected-properties","reason":"needs blockType"}]
json.dump(r,open(d+'/capture-report.json','w'))
EOF
rm -f "$TMP/named/figma-plan.json" "$TMP/named/figma-page.js"
t "custom page name and run ID patterns and the Figma destination are used" bash -c "node scripts/figma-plan.mjs --dir '$TMP/named' --config '$TMP/cfg.json' >'$TMP/np.log' 2>&1 && python3 - '$TMP/named' <<'EOF'
import json,re,sys
d=sys.argv[1]; p=json.load(open(d+'/figma-plan.json'))
assert re.fullmatch(r'fixture-parity_\d{8}_\d{4}',p['runId']), p['runId']
assert p['pageName']=='fixture-parity · qa-workstream · '+p['runId'], p['pageName']
assert p['destination']['fileKey']=='QaQaQaQaQaQaQaQaQaQaQa'
assert p['workstream']=='qa-workstream' and p['skipped'][0]['slug']=='block-selected-properties'
assert p['pageName'] in open(d+'/figma-page.js').read()
EOF"
t "a pattern that needs the workstream fails clearly when the report doesn't record it" bash -c "node scripts/figma-plan.mjs --dir '$OUT' --config '$TMP/cfg.json' >'$TMP/nw.log' 2>&1; [ \$? -eq 1 ] && grep -q 'workstream' '$TMP/nw.log'"
t "an invalid page name pattern is refused before planning" bash -c "node scripts/figma-plan.mjs --dir '$TMP/named' --config '$TMP/cfg.json' --set figma.pageNamePattern='{topic} {bogus}' >'$TMP/bp.log' 2>&1; [ \$? -eq 1 ] && grep -q 'unknown token' '$TMP/bp.log'"

echo "== portability: docs handoff location and format"
t "handoff note is written to the configured directory with the run's values and no unfilled placeholders" bash -c "node scripts/handoff.mjs --skip-annotation test-fixture --config '$TMP/cfg.json' --dir '$TMP/named' --release 'QA release' --author 'QA Author' >'$TMP/h.log' 2>&1 && f=\$(ls '$TMP'/notes/handoff-*.md) && grep -q 'QA release' \"\$f\" && grep -q 'qa-workstream' \"\$f\" && grep -q 'QA Project' \"\$f\" && grep -q 'fixture-parity_' \"\$f\" && grep -q 'TO FILL' \"\$f\" && grep -q 'unverified' \"\$f\" && grep -q 'needs blockType' \"\$f\" && ! grep -q '{{' \"\$f\""
t "the handoff note's shot table is one contiguous markdown table with a row per shot of the run" python3 - "$TMP" <<'EOF'
import glob,sys
t=open(glob.glob(sys.argv[1]+'/notes/handoff-*.md')[0]).read().split('\n')
i=[k for k,l in enumerate(t) if l.startswith('| #')][0]
rows=[]
for l in t[i:]:
    if not l.startswith('|'): break
    rows.append(l)
assert len(rows)==2+3, len(rows)  # header, separator, and the fixture run's three shots
EOF
t "json handoff format parses" bash -c "node scripts/handoff.mjs --skip-annotation test-fixture --config '$TMP/cfg.json' --set docs.format=json --dir '$TMP/named' --release 'QA release' >'$TMP/hj.log' 2>&1 && python3 -c \"import json,glob;d=json.load(open(glob.glob('$TMP/notes/handoff-*.json')[0]));assert d['release']=='QA release' and d['workstream']=='qa-workstream'\""
t "handoff needs a release name" bash -c "node scripts/handoff.mjs --skip-annotation test-fixture --config '$TMP/cfg.json' --dir '$TMP/named' >/dev/null 2>&1; [ \$? -eq 1 ]"
t "handoff refuses a directory inside the tool folder" bash -c "node scripts/handoff.mjs --skip-annotation test-fixture --config '$TMP/cfg.json' --set docs.handoffDir='$ROOT/notes' --dir '$TMP/named' --release x >'$TMP/hb.log' 2>&1; [ \$? -eq 1 ] && grep -q 'inside this tool' '$TMP/hb.log' && [ ! -e '$ROOT/notes' ]"
echo "== annotation gate: a handoff needs an annotated frame for every shot"
rm -rf "$TMP/gate" "$TMP/gnotes"; cp -R "$TMP/named" "$TMP/gate"; rm -f "$TMP/gate/annotation-record.json"
GATE_SLUGS=$(python3 -c "import json;print(' '.join(dict.fromkeys(r['slug'] for r in json.load(open('$TMP/gate/figma-plan.json'))['rows'])))")
GATE_FIRST=${GATE_SLUGS%% *}
gate_h() { node scripts/handoff.mjs --config "$TMP/cfg.json" --set docs.handoffDir="$TMP/gnotes" --dir "$TMP/gate" --release 'QA release' "$@"; }
t "handoff refuses when no shot is annotated, says how to record one, and writes nothing" bash -c "$(declare -f gate_h); TMP='$TMP'; gate_h >'$TMP/g1.log' 2>&1; [ \$? -eq 1 ] && grep -q 'annotation is required' '$TMP/g1.log' && grep -q 'record-annotation.mjs' '$TMP/g1.log' && [ ! -e '$TMP/gnotes' ]"
t "record-annotation refuses without the kit-only and redacted attestations" bash -c "node scripts/record-annotation.mjs --dir '$TMP/gate' --slug $GATE_FIRST --annotated-node-id 87:2 >/dev/null 2>&1; [ \$? -eq 1 ]"
t "record-annotation refuses an annotated node ID that equals the clean node ID" bash -c "node scripts/record-annotation.mjs --dir '$TMP/gate' --slug $GATE_FIRST --annotated-node-id 87:2 --clean-node-id 87:2 --kit-only --redacted >/dev/null 2>&1; [ \$? -eq 1 ]"
t "record-annotation refuses a slug that is not in the run" bash -c "node scripts/record-annotation.mjs --dir '$TMP/gate' --slug not-a-shot --annotated-node-id 87:2 --kit-only --redacted >/dev/null 2>&1; [ \$? -eq 1 ]"
t "handoff still refuses while any shot is unrecorded" bash -c "node scripts/record-annotation.mjs --dir '$TMP/gate' --slug $GATE_FIRST --annotated-node-id 87:2 --clean-node-id 84:13 --kit-only --redacted >/dev/null 2>&1; set -- $GATE_SLUGS; [ \$# -lt 2 ] && exit 0; $(declare -f gate_h); TMP='$TMP'; gate_h >/dev/null 2>&1; [ \$? -eq 1 ]"
t "handoff passes once every shot is recorded, and the note lists the annotated frames" bash -c "for s in $GATE_SLUGS; do node scripts/record-annotation.mjs --dir '$TMP/gate' --slug \$s --annotated-node-id 88:2 --kit-only --redacted >/dev/null || exit 1; done; $(declare -f gate_h); TMP='$TMP'; gate_h >/dev/null 2>&1 && grep -q 'Annotation: Complete' '$TMP'/gnotes/handoff-*.md && grep -q '88:2' '$TMP'/gnotes/handoff-*.md"
t "a record that is not attested as redacted is refused" bash -c "python3 - <<PY
import json
p='$TMP/gate/annotation-record.json'; d=json.load(open(p)); d['frames']['$GATE_FIRST']['redacted']=False; json.dump(d,open(p,'w'))
PY
$(declare -f gate_h); TMP='$TMP'; gate_h >'$TMP/g2.log' 2>&1; [ \$? -eq 1 ] && grep -q 'not attested as redacted' '$TMP/g2.log'"
t "--skip-annotation needs a reason" bash -c "$(declare -f gate_h); TMP='$TMP'; gate_h --skip-annotation '' >/dev/null 2>&1; [ \$? -eq 1 ]"
t "--skip-annotation with a reason writes the note and says the annotation was skipped" bash -c "rm -rf '$TMP/gnotes'; rm -f '$TMP/gate/annotation-record.json'; $(declare -f gate_h); TMP='$TMP'; gate_h --skip-annotation 'release freeze' >/dev/null 2>&1 && grep -q 'Annotation: SKIPPED by request: release freeze' '$TMP'/gnotes/handoff-*.md"

echo "== blocked shots (HTTP 403)"
start_server 4203 "$FX/forbidden-server.mjs" || exit 1
t "403 shot fails, exits 1, records blocked: http-403, saves no PNG" bash -c "node scripts/capture.mjs --brief '$FX/forbidden-brief.json' --out-dir '$TMP/forbidden' >/dev/null 2>&1; [ \$? -eq 1 ] && python3 -c \"
import json,glob
r=json.load(open('$TMP/forbidden/capture-report.json'))['results'][0]
assert r['ok'] is False and r['blocked']=='http-403'
assert not glob.glob('$TMP/forbidden/*.png')\""
t "planner refuses a report with no usable shots" bash -c "node scripts/figma-plan.mjs --dir '$TMP/forbidden' >/dev/null 2>&1; [ \$? -eq 1 ] && [ ! -e '$TMP/forbidden/figma-plan.json' ]"

echo "== uploader"
echo '["http://127.0.0.1:59999/x","http://127.0.0.1:59999/x","http://127.0.0.1:59999/x","http://127.0.0.1:59999/x","http://127.0.0.1:59999/x","http://127.0.0.1:59999/x"]' > "$TMP/urls.json"
t "refused connection exits 1 and names ECONNREFUSED and a retry command" bash -c "P1_UPLOAD_ALLOW_LOOPBACK=1 node scripts/figma-upload.mjs --dir '$OUT' --urls '$TMP/urls.json' >'$TMP/u.log' 2>&1; [ \$? -eq 1 ] && grep -q ECONNREFUSED '$TMP/u.log' && grep -q -- '--only' '$TMP/u.log'"
echo '["http://127.0.0.1:59999/x"]' > "$TMP/urls1.json"
t "wrong URL count exits 1" bash -c "node scripts/figma-upload.mjs --dir '$OUT' --urls '$TMP/urls1.json' >/dev/null 2>&1; [ \$? -eq 1 ]"

# End-to-end tests against the fixture editor, the Figma mock, and the skill validator.
. "$ROOT/tests/e2e.sh"

echo "== identity: commit metadata and files"
# Addresses are assembled at runtime so this file holds no email-shaped literal for the file scan to flag.
PERS_A="person@""gmail.com"; PERS_B="someone@""personal-mail.net"; PERS_C="me@""elsewhere.org.uk"
git init -q "$TMP/idrepo" && git -C "$TMP/idrepo" config user.name tester && git -C "$TMP/idrepo" config user.email "tester@users.noreply.github.com"
echo base > "$TMP/idrepo/a.txt" && git -C "$TMP/idrepo" add -A && git -C "$TMP/idrepo" commit -q -m "base" && git -C "$TMP/idrepo" tag base
echo ok > "$TMP/idrepo/b.txt" && git -C "$TMP/idrepo" add -A && git -C "$TMP/idrepo" commit -q -m "feat: fine" -m "Co-Authored-By: Tool <noreply@anthropic.com>"
t "check-identity passes for noreply and Pantheon addresses, including the attribution trailer" bash -c "cd '$TMP/idrepo' && node '$ROOT/scripts/check-identity.mjs' --range base..HEAD --files"
git -C "$TMP/idrepo" -c user.email="someone@pantheon.io" commit -q --allow-empty -m "chore: pantheon address"
t "check-identity accepts a Pantheon address" bash -c "cd '$TMP/idrepo' && node '$ROOT/scripts/check-identity.mjs' --range base..HEAD"
git -C "$TMP/idrepo" -c user.email="$PERS_A" commit -q --allow-empty -m "chore: personal author"
t "check-identity rejects a personal author or committer email, and names the commit" bash -c "cd '$TMP/idrepo' && node '$ROOT/scripts/check-identity.mjs' --range base..HEAD >'$TMP/id1.log' 2>&1; [ \$? -eq 1 ] && grep -q "$PERS_A" '$TMP/id1.log' && grep -q 'author email' '$TMP/id1.log'"
git -C "$TMP/idrepo" reset -q --hard HEAD~1
git -C "$TMP/idrepo" commit -q --allow-empty -m "chore: trailer" -m "Reviewed-by: Someone <$PERS_B>"
t "check-identity rejects a personal email written in a commit message" bash -c "cd '$TMP/idrepo' && node '$ROOT/scripts/check-identity.mjs' --range base..HEAD >'$TMP/id2.log' 2>&1; [ \$? -eq 1 ] && grep -q "$PERS_B" '$TMP/id2.log'"
git -C "$TMP/idrepo" reset -q --hard HEAD~1
echo "contact: $PERS_C" > "$TMP/idrepo/c.txt" && git -C "$TMP/idrepo" add -A
t "check-identity rejects a personal email in a tracked file" bash -c "cd '$TMP/idrepo' && node '$ROOT/scripts/check-identity.mjs' --files >'$TMP/id3.log' 2>&1; [ \$? -eq 1 ] && grep -q 'c.txt' '$TMP/id3.log'"
t "the real tool's files and branch commits pass check-identity (when run inside a git checkout with origin/main)" bash -c "cd '$ROOT' && { git rev-parse origin/main >/dev/null 2>&1 && node scripts/check-identity.mjs --range origin/main..HEAD --files || node scripts/check-identity.mjs --files; }"

echo "== screenshot inventory (library and commands; no browser)"
node tests/inventory-tests.mjs >"$TMP/inventory-tests.log" 2>&1
grep -E '^(PASS|FAIL)  |^        ' "$TMP/inventory-tests.log" | grep -v '^PASS  ' | head -40
inv_pass=$(grep -c '^PASS  ' "$TMP/inventory-tests.log"); inv_fail=$(grep -c '^FAIL  ' "$TMP/inventory-tests.log")
echo "      inventory tests: $inv_pass passed, $inv_fail failed (names: node tests/inventory-tests.mjs)"
pass=$((pass + inv_pass)); fail=$((fail + inv_fail))
[ "$inv_pass" -gt 0 ] || { echo "FAIL  the inventory tests did not run"; fail=$((fail + 1)); }

echo "== upload URLs: screenshots only go to Figma upload hosts"
node tests/upload-url-tests.mjs >"$TMP/upload-url-tests.log" 2>&1
grep -E '^(FAIL)  |^        ' "$TMP/upload-url-tests.log" | head -40
up_pass=$(grep -c '^PASS  ' "$TMP/upload-url-tests.log"); up_fail=$(grep -c '^FAIL  ' "$TMP/upload-url-tests.log")
echo "      upload URL tests: $up_pass passed, $up_fail failed (names: node tests/upload-url-tests.mjs)"
pass=$((pass + up_pass)); fail=$((fail + up_fail))
[ "$up_pass" -gt 0 ] || { echo "FAIL  the upload URL tests did not run"; fail=$((fail + 1)); }

echo "== path safety: symlinks cannot bypass the tool-folder check"
node tests/paths-tests.mjs >"$TMP/paths-tests.log" 2>&1
grep -E '^(FAIL|SKIP)  |^        ' "$TMP/paths-tests.log" | head -40
paths_pass=$(grep -c '^PASS  ' "$TMP/paths-tests.log"); paths_fail=$(grep -c '^FAIL  ' "$TMP/paths-tests.log")
echo "      path tests: $paths_pass passed, $paths_fail failed (names: node tests/paths-tests.mjs)"
pass=$((pass + paths_pass)); fail=$((fail + paths_fail))
[ "$paths_pass" -gt 0 ] || { echo "FAIL  the path tests did not run"; fail=$((fail + 1)); }

echo "== Markdown docs publishing: release swaps change only image files and alt text"
node tests/publish-markdown-tests.mjs >"$TMP/publish-markdown-tests.log" 2>&1
grep -E '^(FAIL)  |^        ' "$TMP/publish-markdown-tests.log" | head -40
pm_pass=$(grep -c '^PASS  ' "$TMP/publish-markdown-tests.log"); pm_fail=$(grep -c '^FAIL  ' "$TMP/publish-markdown-tests.log")
echo "      publish-markdown tests: $pm_pass passed, $pm_fail failed (names: node tests/publish-markdown-tests.mjs)"
pass=$((pass + pm_pass)); fail=$((fail + pm_fail))
[ "$pm_pass" -gt 0 ] || { echo "FAIL  the publish-markdown tests did not run"; fail=$((fail + 1)); }

echo "== Release swap: alt text from marks, Figma export, Google Docs manifest and Apps Script"
node tests/release-swap-tests.mjs >"$TMP/release-swap-tests.log" 2>&1
grep -E '^(FAIL)  |^        ' "$TMP/release-swap-tests.log" | head -40
rs_pass=$(grep -c '^PASS  ' "$TMP/release-swap-tests.log"); rs_fail=$(grep -c '^FAIL  ' "$TMP/release-swap-tests.log")
echo "      release-swap tests: $rs_pass passed, $rs_fail failed (names: node tests/release-swap-tests.mjs)"
pass=$((pass + rs_pass)); fail=$((fail + rs_fail))
[ "$rs_pass" -gt 0 ] || { echo "FAIL  the release-swap tests did not run"; fail=$((fail + 1)); }

echo "== Target presets: WordPress, Drupal, public sites, Content Publisher, P1; release sources"
node tests/presets-tests.mjs >"$TMP/presets-tests.log" 2>&1
grep -E '^(FAIL)  |^        ' "$TMP/presets-tests.log" | head -40
pr_pass=$(grep -c '^PASS  ' "$TMP/presets-tests.log"); pr_fail=$(grep -c '^FAIL  ' "$TMP/presets-tests.log")
echo "      preset tests: $pr_pass passed, $pr_fail failed (names: node tests/presets-tests.mjs)"
pass=$((pass + pr_pass)); fail=$((fail + pr_fail))
[ "$pr_pass" -gt 0 ] || { echo "FAIL  the preset tests did not run"; fail=$((fail + 1)); }

echo "== Release watch: watchlists, release-notes feeds, products"
node tests/watch-tests.mjs >"$TMP/watch-tests.log" 2>&1
grep -E '^(FAIL)  |^        ' "$TMP/watch-tests.log" | head -40
wt_pass=$(grep -c '^PASS  ' "$TMP/watch-tests.log"); wt_fail=$(grep -c '^FAIL  ' "$TMP/watch-tests.log")
echo "      watch tests: $wt_pass passed, $wt_fail failed (names: node tests/watch-tests.mjs)"
pass=$((pass + wt_pass)); fail=$((fail + wt_fail))
[ "$wt_pass" -gt 0 ] || { echo "FAIL  the watch tests did not run"; fail=$((fail + 1)); }

echo "== project skill: .claude/skills/p1-screenshot-inventory"
REPO_ROOT=$(cd "$ROOT/../.." && pwd)
if [ -f "$REPO_ROOT/.claude/skills/p1-screenshot-inventory/SKILL.md" ]; then
  t "the project skill is valid, discoverable at the Claude Code path, not git-ignored, and every tools/ path it names exists" python3 - "$REPO_ROOT" <<'EOF'
import os,re,subprocess,sys
root=sys.argv[1]; d=os.path.join(root,'.claude','skills','p1-screenshot-inventory'); f=os.path.join(d,'SKILL.md')
t=open(f,encoding='utf-8').read()
m=re.match(r'---\n(.*?)\n---\n(.*)',t,re.S); assert m,'no front matter'
fm,body=m.groups()
name=re.search(r'^name:\s*(.+)$',fm,re.M).group(1).strip(); desc=re.search(r'^description:\s*(.+)$',fm,re.M).group(1).strip()
assert name==os.path.basename(d) and re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*',name),name
assert desc.startswith('Use when') and len(desc)<=1024,len(desc)
assert len(body)>500
for p in set(re.findall(r'`(tools/[^`\s<>*]+)`',body)): assert os.path.exists(os.path.join(root,p)),p
for p in set(re.findall(r'`((?:scripts|references|inventory)/[^`\s<>*]+)`',body)):
    if '<' in p: continue
    assert os.path.exists(os.path.join(root,'tools','p1-editor-screenshots-to-docs',p.split(' ')[0])),p
assert not re.search(r'/Users/|/home/|C:\\\\|[\w.+-]+@[\w-]+\.[a-z]{2,}',t),'machine path or email in the skill'
r=subprocess.run(['git','-C',root,'check-ignore','-q',f]); assert r.returncode==1,'the skill file is git-ignored'
EOF
  t "the skill validator accepts the project skill" node scripts/validate-skill.mjs "$REPO_ROOT/.claude/skills/p1-screenshot-inventory"
else
  echo "SKIP  the project skill isn't present (this tool folder is outside the p1-docs repository)"
fi

echo "== hygiene: no personal identifiers, no secrets"
# Scan what git would commit: tracked files plus untracked ones that aren't ignored. Local configs and
# screenshots are git-ignored and hold real values by design. Outside a git checkout, scan everything.
python3 - "$ROOT" "$TMP/scan-files" <<'EOF'
import os,subprocess,sys
root,out=sys.argv[1],sys.argv[2]
r=subprocess.run(['git','-C',root,'ls-files','-co','--exclude-standard'],capture_output=True,text=True)
if r.returncode==0: files=r.stdout.splitlines()
else:
    files=[]
    for dp,dn,fn in os.walk(root):
        dn[:]=[d for d in dn if d not in ('node_modules','.git')]
        files+=[os.path.relpath(os.path.join(dp,f),root) for f in fn]
files=[f for f in files if os.path.isfile(os.path.join(root,f)) and not f.startswith('node_modules/')]
open(out,'w').write('\n'.join(files)+'\n')
EOF
t "generic files contain no personal identifiers, project values, hosted URLs, emails, UUIDs, or machine paths" python3 - "$ROOT" "$TMP/scan-files" <<'EOF'
import os,re,sys
root=sys.argv[1]
files=open(sys.argv[2]).read().splitlines()
strict=re.compile(r"courtney|courane|courtneyr|gmail\.com|/Users/|pantheonsite|live-p1-docs|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
project=re.compile(r"trogdor", re.I)
email=re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
# The only file that may name the proof of concept's demo project: the POC record.
allow_project=('references/poc-results.md',)
bad=[]
for rel in files:
    if os.path.basename(rel)=='package-lock.json' or rel=='tests/run-tests.sh': continue
    try: t=open(os.path.join(root,rel),encoding='utf-8').read()
    except Exception: continue
    for m in strict.finditer(t): bad.append((rel,m.group(0)))
    if not rel.startswith(allow_project):
        for m in project.finditer(t): bad.append((rel,m.group(0)))
    for m in email.finditer(t):
        if not re.search(r'noreply|example\.(com|org)$',m.group(0)): bad.append((rel,m.group(0)))
assert not bad, bad[:10]
EOF
t "no credentials or keys in the tool's files (gitleaks, or patterns when gitleaks is absent)" bash -c "
mkdir -p '$TMP/scan' && tar -C '$ROOT' -cf - -T '$TMP/scan-files' | tar -C '$TMP/scan' -xf - &&
if command -v gitleaks >/dev/null 2>&1; then gitleaks detect --source '$TMP/scan' --no-git --redact >'$TMP/gl.log' 2>&1; else ! grep -rIE 'gho_[A-Za-z0-9]{20}|ghp_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY|xox[baprs]-[A-Za-z0-9-]{10}' '$TMP/scan' --exclude=run-tests.sh; fi"
t ".gitignore keeps profiles, cookies, storage state, env files, upload URLs, reports, and the config out of git" python3 - <<'EOF'
g=open('.gitignore').read()
for needle in ('chrome-profile','*.cookies.json','storage-state','.env','urls.json','capture-report.json','figma-plan.json','p1-editor.config.json'):
    assert needle in g, needle
EOF
t "no profile, cookie, config, or capture artifact is tracked by git" bash -c "cd '$ROOT' && { git rev-parse --is-inside-work-tree >/dev/null 2>&1 || exit 0; bad=\$(git ls-files . | grep -E 'chrome-profile|cookies|storage-state|\.env(\.|\$)|urls\.json|capture-report\.json|figma-plan\.json|figma-page\.js|p1-editor\.config\.json|/screenshots/' | grep -v -E 'examples/|tests/fixtures/'); [ -z \"\$bad\" ] || { echo \"\$bad\"; exit 1; }; }"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
