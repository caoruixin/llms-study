"""Architecture + Attention Trace v2 acceptance. No login/model APIs/production writes.
Run with Python Playwright 1.52: --base URL --output artifact-directory.
"""
import argparse, json, pathlib, re
from playwright.sync_api import sync_playwright, expect
parser=argparse.ArgumentParser()
parser.add_argument('--base', default='http://127.0.0.1:5173')
parser.add_argument('--output', default='output/playwright/attention-v2')
parser.add_argument('--browsers', nargs='+', choices=['chromium','webkit'], default=['chromium','webkit'])
args=parser.parse_args(); output=pathlib.Path(args.output); output.mkdir(parents=True,exist_ok=True)
mechanisms=['mha','mqa','gqa','mla','dsa','qsa','msa','swa','csa','hca','gdn','kda','csa2']
report=[]
GPU_TRACKING='''(() => {
 window.__gpu = {createdContexts:0, lostContexts:0}; const seen=new WeakSet();
 const original=HTMLCanvasElement.prototype.getContext;
 HTMLCanvasElement.prototype.getContext=function(kind,...args) {
   const gl=original.call(this,kind,...args);
   if(gl && /webgl/.test(kind) && !seen.has(gl)) {
     seen.add(gl); window.__gpu.createdContexts++;
     const get=gl.getExtension.bind(gl); let counted=false;
     gl.getExtension=(name)=>{const ext=get(name); if(name==='WEBGL_lose_context' && ext && !ext.__wrapped){
       ext.__wrapped=true;const lose=ext.loseContext.bind(ext);ext.loseContext=()=>{if(!counted){window.__gpu.lostContexts++;counted=true;}return lose();};
     }return ext;};
   }return gl;
 };
})();'''
OVERLAPS='''() => {
 const items=[...document.querySelectorAll('.arch-scene-labels button:not([hidden])')].map(e=>({id:e.dataset.nodeId,r:e.getBoundingClientRect()}));
 const out=[];for(let i=0;i<items.length;i++)for(let j=i+1;j<items.length;j++){
  const a=items[i].r,b=items[j].r;
  if(Math.min(a.right,b.right)-Math.max(a.left,b.left)>2 && Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>2)out.push([items[i].id,items[j].id]);
 }return out;
}'''
with sync_playwright() as p:
 for name in args.browsers:
  print('Testing',name,flush=True)
  browser=getattr(p,name).launch(headless=True)
  page=browser.new_page(viewport={'width':1440,'height':1100},reduced_motion='no-preference')
  errors=[]; api_calls=[]; scene_checks=0; screenshot_count=0
  page.add_init_script(GPU_TRACKING)
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('console',lambda m:errors.append(m.text) if m.type=='error' and not any(t in m.text for t in ['401','WebGL context','Error creating WebGL','Failed to create WebGL']) else None)
  page.on('request',lambda r:api_calls.append(r.url) if '/api/' in r.url and '/api/app/auth/me' not in r.url else None)
  page.route('**/api/app/auth/me',lambda r:r.fulfill(status=401,content_type='application/json',body='{"error":"unauthenticated"}'))
  def goto(query):
   page.goto(args.base+'/#/architecture?'+query);page.wait_for_load_state('networkidle')
   assert page.evaluate('typeof window.__gpu')=='object','GPU instrumentation did not initialize'
  def no_overflow(): assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'document overflow'
  def seek(f):
   page.get_by_label('Trace position',exact=True).fill(str(f));expect(page.get_by_test_id('trace-position')).to_have_text(f'{f+1} / 48')
  def capture(m,label):
   global screenshot_count
   scene=page.get_by_test_id('scene-'+m);scene.scroll_into_view_if_needed();scene.screenshot(path=str(output/f'{name}-{m}-{label}.png'));screenshot_count+=1
  def labels_clear(m):
   page.get_by_test_id('scene-'+m).scroll_into_view_if_needed()
   # Wait on actual RAF projection, not a guessed screenshot delay.
   page.evaluate('() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
   overlap=page.evaluate(OVERLAPS);assert not overlap,(m,overlap)
  goto('tab=evolution')
  total=page.locator('.arch-model').count();assert total>=22
  page.get_by_label('Search models').fill('N-gram');assert 1<=page.locator('.arch-model').count()<total
  page.get_by_label('Provider',exact=True).select_option('Qwen');page.get_by_label('Architecture feature').select_option('gdn');assert page.locator('.arch-model').count()>=1
  page.get_by_label('Search models').fill('xyz-no-match');expect(page.get_by_text('没有匹配的模型。',exact=False)).to_be_visible()
  page.get_by_role('button',name='清除筛选',exact=True).click();assert page.locator('.arch-model').count()==total
  boxes=page.get_by_role('checkbox');boxes.nth(0).check();boxes.nth(1).check();boxes.nth(2).check();expect(boxes.nth(3)).to_be_disabled()
  page.reload();page.wait_for_load_state('networkidle');expect(page.get_by_role('region',name='Model comparison')).to_be_visible()
  page.get_by_role('button',name='Clear',exact=True).click();page.locator('.arch-model-toggle').filter(has_text='DeepSeek-V4.1-Flash').click()
  expect(page.get_by_text('Parameter accounting',exact=False)).to_be_visible()
  page.locator('.arch-model.is-open .arch-mechanism-link').first.click();expect(page.get_by_label('Primary mechanism')).to_have_value('csa2')
  # Old five-phase links migrate once by token + meaning, not by raw frame index.
  goto('tab=attention&mechanism=mha&frame=37')
  expect(page.get_by_test_id('trace-position')).to_have_text('46 / 48');expect(page).to_have_url(re.compile(r'trace=2'))
  expect(page.get_by_label('Inspect MHA Q Head')).to_have_value('all')
  expect(page.get_by_test_id('scene-mha')).to_have_attribute('data-active-heads','0,1,2,3')
  page.get_by_label('Inspect MHA Q Head').select_option('3');expect(page).to_have_url(re.compile(r'head=3'))
  expect(page.get_by_test_id('scene-mha')).to_have_attribute('data-active-heads','0,1,2,3')
  page.reload();page.wait_for_load_state('networkidle');expect(page.get_by_label('Inspect MHA Q Head')).to_have_value('3')
  # Picking a different KV group must display that object's actual ID, not H0's cache.
  page.get_by_label('Inspect MHA tensor').select_option('kv:g2:t5');expect(page.locator('.arch-inspector')).to_contain_text('Object ID: kv:g2:t5')
  page.get_by_label('Inspect MHA Q Head').select_option('all')
  # External hash navigation cancels a pending playhead write, including legacy migration.
  for target in [37,32,27]:
   seek(0)
   page.evaluate('(f) => { location.hash = "/architecture?tab=attention&mechanism=mha&frame=" + f }',target)
   migrated=(target//5)*6+3
   expect(page.get_by_test_id('trace-position')).to_have_text(f'{migrated+1} / 48')
   expect(page).to_have_url(re.compile(r'frame='+str(migrated)+r'(?:&|$)'))
  for m in mechanisms:
   page.get_by_label('Primary mechanism').select_option(m)
   for phase in range(6):
    seek(42+phase);scene=page.get_by_test_id('scene-'+m)
    expect(scene).to_have_attribute('data-stage',str(phase));expect(page.locator('canvas')).to_have_count(1)
    if m!='csa2':
     expect(page.locator('.arch-head-outputs button')).to_have_count(4)
     if phase in [0,3,4,5]:expect(scene).to_have_attribute('data-active-heads','0,1,2,3')
     if phase<5:assert page.locator('[data-edge-to="concat"]').count()==0
     if phase==5:assert page.locator('[data-edge-to="concat"]').count()==4
     if m in ['gdn','kda'] and phase<5:assert 'Pending' in page.locator('.arch-head-outputs').inner_text()
    else:
     assert page.locator('.arch-head-outputs').count()==0
     expect(page.locator('.arch-fidelity')).to_have_text('Structure only')
    scene_checks+=1;no_overflow()
    if phase in [3,5]:labels_clear(m);capture(m,'desktop-phase'+str(phase))
   page.get_by_role('button',name='Switch to 2D',exact=True).click();expect(page.get_by_test_id('fallback-scene')).to_be_visible();expect(page.locator('canvas')).to_have_count(0)
   assert page.locator('.arch-node-grid [data-node-id="output"]').count()==(0 if m=='csa2' else 1)
   page.get_by_role('button',name='2D step view',exact=True).click();expect(page.locator('canvas')).to_have_count(1)
   cycle_gpu=page.evaluate('window.__gpu');assert cycle_gpu['createdContexts']-cycle_gpu['lostContexts']==1,cycle_gpu
  # Shared phase clock, pause stability, replay and keyboard.
  page.get_by_label('Primary mechanism').select_option('gqa');page.get_by_label('Compare mechanism').select_option('mla')
  seek(33);page.get_by_label('Playback speed').select_option('2');page.get_by_role('button',name='Play animation').click()
  page.wait_for_timeout(350);page.get_by_role('button',name='Pause animation').click()
  frozen=page.locator('.arch-phase-progress span').get_attribute('style');paused=page.get_by_test_id('trace-position').inner_text();page.wait_for_timeout(250)
  assert page.locator('.arch-phase-progress span').get_attribute('style')==frozen
  assert page.get_by_test_id('trace-position').inner_text()==paused
  assert page.get_by_test_id('scene-gqa').get_attribute('data-stage')==page.get_by_test_id('scene-mla').get_attribute('data-stage')
  page.get_by_role('group',name='Playback · Space play/pause, left/right step').focus();page.keyboard.press('ArrowRight')
  expect(page.get_by_test_id('trace-position')).not_to_have_text(paused)
  seek(35);before=page.locator('.arch-head-outputs').all_inner_texts()
  page.get_by_role('button',name='Previous step',exact=True).click();page.get_by_role('button',name='Next step',exact=True).click();assert before==page.locator('.arch-head-outputs').all_inner_texts()
  page.get_by_label('Inspect MLA Q Head').select_option('2');expect(page).to_have_url(re.compile(r'head2=2'));page.reload();page.wait_for_load_state('networkidle');expect(page.get_by_label('Inspect MLA Q Head')).to_have_value('2')
  seek(47);page.get_by_role('button',name='Play animation').click();expect(page.get_by_test_id('trace-position')).to_have_text('1 / 48');page.get_by_role('button',name='Pause animation').click()
  page.get_by_role('button',name='Decode · t6–t8').click();expect(page.get_by_test_id('trace-position')).to_have_text('31 / 48')
  page.get_by_role('button',name='Prefill · t1–t5').click();expect(page.get_by_test_id('trace-position')).to_have_text('1 / 48')
  # Fast scrubbing stays immediate, then persists one final URL instead of flooding WebKit history.
  for f in range(20):seek(f)
  expect(page).to_have_url(re.compile(r'frame=19(?:&|$)'))
  page.reload();page.wait_for_load_state('networkidle');expect(page.get_by_test_id('trace-position')).to_have_text('20 / 48')
  # Orbit/zoom and camera reset use a real canvas.
  box=page.locator('canvas').first.bounding_box();page.mouse.move(box['x']+box['width']*.4,box['y']+box['height']*.6);page.mouse.down();page.mouse.move(box['x']+box['width']*.55,box['y']+box['height']*.7,steps=5);page.mouse.up();page.mouse.wheel(0,70)
  page.get_by_role('button',name='Reset camera').click()
  page.get_by_label('Compare mechanism').select_option('')
  page.set_viewport_size({'width':390,'height':1000})
  for m in mechanisms:
   page.get_by_label('Primary mechanism').select_option(m);seek(45);no_overflow();labels_clear(m);capture(m,'mobile')
   # Real UI tensor inspector and formula expansion must remain contained on mobile.
   page.locator('.arch-formula > summary').click();no_overflow();page.locator('.arch-formula > summary').click()
  page.get_by_label('Compare mechanism').select_option('mha');expect(page.locator('.arch-lab-panel')).to_have_count(2);no_overflow()
  page.emulate_media(reduced_motion='reduce');expect(page.get_by_test_id('fallback-scene')).to_have_count(2);expect(page.locator('canvas')).to_have_count(0)
  page.get_by_role('tab',name='模型演进',exact=True).click();page.wait_for_timeout(100)
  gpu=page.evaluate('window.__gpu');assert gpu['createdContexts']==gpu['lostContexts'],gpu
  assert not errors,errors;assert not api_calls,api_calls
  report.append({'browser':name,'models':total,'mechanisms':len(mechanisms),'phaseChecks':scene_checks,'screenshots':screenshot_count,'labelOverlaps':0,'webglRendered':True,'contextCycleChecks':len(mechanisms),'contextsReleased':gpu,'errors':errors,'passed':True})
  print(json.dumps(report[-1]),flush=True);browser.close()
 browser=p.chromium.launch(headless=True);page=browser.new_page()
 page.add_init_script("const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,...a){return /webgl/.test(t)?null:original.call(this,t,...a)}")
 page.route('**/api/app/auth/me',lambda r:r.fulfill(status=401,body='{}'))
 page.goto(args.base+'/#/architecture?tab=attention&mechanism=mha&trace=2&frame=47');page.wait_for_load_state('networkidle')
 expect(page.get_by_test_id('fallback-scene')).to_have_count(1);expect(page.get_by_text('WebGL unavailable',exact=False)).to_be_visible();browser.close()
 report.append({'webglFailureFallback':True})
(output/'acceptance.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
