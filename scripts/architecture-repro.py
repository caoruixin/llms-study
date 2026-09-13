"""Local architecture acceptance: Python Playwright 1.52, Chromium + WebKit.
Start Vite first. python scripts/architecture-repro.py [--base http://127.0.0.1:5173]
No model API calls, downloads, login or production writes.
"""
import argparse, json, pathlib
from playwright.sync_api import sync_playwright, expect
parser=argparse.ArgumentParser();parser.add_argument('--base',default='http://127.0.0.1:5173');args=parser.parse_args()
output=pathlib.Path('output/playwright/architecture');output.mkdir(parents=True,exist_ok=True)
mechanisms=['mha','mqa','gqa','mla','dsa','qsa','msa','swa','csa','hca','gdn','kda','csa2']
report=[]
GPU_TRACKING='''(() => {
 window.__gpu = {createdContexts:0, lostContexts:0}; const seen=new WeakSet();
 const original=HTMLCanvasElement.prototype.getContext;
 HTMLCanvasElement.prototype.getContext=function(kind,...args) {
   const gl=original.call(this,kind,...args);
   if (gl && /webgl/.test(kind) && !seen.has(gl)) {
     seen.add(gl); window.__gpu.createdContexts++;
     const get=gl.getExtension.bind(gl); let counted=false;
     gl.getExtension=(name)=>{const ext=get(name); if(name==='WEBGL_lose_context' && ext && !ext.__wrapped){
       ext.__wrapped=true;const lose=ext.loseContext.bind(ext);ext.loseContext=()=>{if(!counted){window.__gpu.lostContexts++;counted=true;}return lose();};
     }return ext;};
   }return gl;
 };
})();'''
with sync_playwright() as p:
 for name in ['chromium','webkit']:
  print('Testing',name,flush=True)
  browser=getattr(p,name).launch(headless=True)
  page=browser.new_page(viewport={'width':1440,'height':1000},reduced_motion='no-preference')
  errors=[];api_calls=[]
  page.add_init_script(GPU_TRACKING)
  page.on('pageerror',lambda e:errors.append(str(e)))
  page.on('console',lambda m:errors.append(m.text) if m.type=='error' and not any(t in m.text for t in ['401','WebGL context','Error creating WebGL','Failed to create WebGL']) else None)
  page.on('request',lambda r:api_calls.append(r.url) if '/api/' in r.url and '/api/app/auth/me' not in r.url else None)
  page.route('**/api/app/auth/me',lambda route:route.fulfill(status=401,content_type='application/json',body='{"error":"unauthenticated"}'))
  def goto(query):
   page.goto(args.base+'/#/architecture?'+query);page.wait_for_load_state('networkidle');page.evaluate('window.scrollTo(0,0)')
  def no_overflow(): assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'document overflow'
  def shot(label): page.screenshot(path=str(output/f'{name}-{label}.png'))
  goto('tab=evolution')
  total=page.locator('.arch-model').count();assert total>=22
  page.get_by_label('Search models').fill('N-gram');assert 1 <= page.locator('.arch-model').count()<total
  page.get_by_label('Provider',exact=True).select_option('Qwen');assert page.locator('.arch-model').count()>=1
  page.get_by_label('Architecture feature').select_option('gdn');assert page.locator('.arch-model').count()>=1
  page.get_by_label('Search models').fill('xyz-no-match');expect(page.get_by_text('没有匹配的模型。',exact=False)).to_be_visible()
  page.get_by_role('button',name='清除筛选',exact=True).click();assert page.locator('.arch-model').count()==total
  checkboxes=page.get_by_role('checkbox');checkboxes.nth(0).check();checkboxes.nth(1).check();checkboxes.nth(2).check();expect(checkboxes.nth(3)).to_be_disabled();expect(page.get_by_role('region',name='Model comparison')).to_be_visible()
  page.reload();page.wait_for_load_state('networkidle');expect(page.get_by_role('region',name='Model comparison')).to_be_visible();shot('model-compare')
  page.get_by_role('button',name='Clear',exact=True).click()
  # Model button is observed via its unique title; inputs are siblings, never nested buttons.
  page.locator('.arch-model-toggle').filter(has_text='DeepSeek-V4.1-Flash').click()
  expect(page.get_by_text('Parameter accounting',exact=False)).to_be_visible();expect(page.get_by_text('552B',exact=True)).to_be_visible();expect(page.get_by_text('196B',exact=True)).to_be_visible()
  assert 'model=deepseek-v41-flash' in page.url
  page.evaluate('window.scrollTo(0,0)');shot('model-expanded')
  page.locator('.arch-model.is-open .arch-mechanism-link').first.click();expect(page.get_by_label('Primary mechanism')).to_have_value('csa2')
  page.get_by_label('Compare mechanism').select_option('gqa');expect(page.locator('.arch-lab-panel')).to_have_count(2)
  page.get_by_role('button',name='Next step',exact=True).click();pos=page.get_by_test_id('trace-position').inner_text()
  page.get_by_role('button',name='Previous step',exact=True).click();page.get_by_role('button',name='Next step',exact=True).click();assert page.get_by_test_id('trace-position').inner_text()==pos
  page.get_by_label('Trace position',exact=True).fill('30');expect(page.get_by_test_id('trace-position')).to_have_text('31 / 40')
  page.get_by_label('Playback speed').select_option('2');page.get_by_role('button',name='Play animation').click();page.wait_for_timeout(800);page.get_by_role('button',name='Pause animation').click();paused=page.get_by_test_id('trace-position').inner_text();page.wait_for_timeout(900);assert paused==page.get_by_test_id('trace-position').inner_text()
  page.get_by_role('group',name='Playback · Space play/pause, left/right step').focus();page.keyboard.press('ArrowRight');expect(page.get_by_test_id('trace-position')).not_to_have_text(paused)
  page.get_by_role('button',name='Prefill · t1–t5').click();expect(page.get_by_test_id('trace-position')).to_have_text('1 / 40')
  page.get_by_role('button',name='Decode · t6–t8').click();expect(page.get_by_test_id('trace-position')).to_have_text('26 / 40')
  page.reload();page.wait_for_load_state('networkidle');expect(page.get_by_label('Compare mechanism')).to_have_value('gqa');expect(page.get_by_test_id('trace-position')).to_have_text('26 / 40')
  page.get_by_label('Inspect CSA2 Q Head').select_option('2');page.get_by_label('Inspect CSA2 tensor').select_option('entry-token-2');expect(page.locator('.arch-inspector').first).to_contain_text('Positions 3')
  page.get_by_label('Compare mechanism').select_option('');page.get_by_label('Trace position',exact=True).fill('37')
  for mechanism in mechanisms:
   page.get_by_label('Primary mechanism').select_option(mechanism)
   page.wait_for_timeout(100)
   expect(page.locator('.arch-lab-panel')).to_have_count(1)
   assert page.locator('canvas').count()==1 or page.locator('.arch-fallback').count()==1
   no_overflow()
  page.get_by_label('Primary mechanism').select_option('gqa');page.get_by_label('Compare mechanism').select_option('mla');page.wait_for_timeout(250)
  page.evaluate('window.scrollTo(0,0)');shot('lab-desktop')
  canvases=page.locator('canvas').count()
  if canvases:
   scene=page.locator('canvas').first;scene.screenshot(path=str(output/f'{name}-3d-scene.png'));box=scene.bounding_box()
   page.mouse.move(box['x']+box['width']*.5,box['y']+box['height']*.5);page.mouse.down();page.mouse.move(box['x']+box['width']*.7,box['y']+box['height']*.55,steps=8);page.mouse.up();page.mouse.wheel(0,100)
   page.get_by_role('button',name='Reset camera').click()
  page.get_by_role('button',name='Switch to 2D',exact=True).click();expect(page.locator('.arch-fallback')).to_have_count(2);expect(page.locator('canvas')).to_have_count(0)
  page.get_by_label('Inspect GQA tensor').select_option('entry-token-2');expect(page.locator('.arch-inspector').first).to_contain_text('Positions 3')
  page.reload();page.wait_for_load_state('networkidle');expect(page.locator('.arch-fallback')).to_have_count(2)
  # Switching to a wholly different route must unmount all renderers and release contexts.
  page.get_by_role('button',name='2D step view',exact=True).click();page.wait_for_timeout(200)
  page.get_by_role('tab',name='模型演进',exact=True).click();page.wait_for_timeout(200);expect(page.locator('canvas')).to_have_count(0)
  gpu=page.evaluate('window.__gpu');assert gpu['createdContexts']==gpu['lostContexts'],gpu
  page.set_viewport_size({'width':390,'height':844})
  goto('tab=evolution&model=deepseek-v41-flash&models=deepseek-v41-flash,qwen38-flash-next')
  no_overflow();shot('model-mobile')
  goto('tab=attention&mechanism=kda&compare=csa2&frame=38')
  no_overflow();shot('lab-mobile');page.locator('.arch-lab-panel').first.screenshot(path=str(output/f'{name}-mobile-panel.png'))
  page.get_by_role('button',name='Next step',exact=True).click();expect(page.get_by_test_id('trace-position')).to_have_text('40 / 40')
  page.get_by_role('button',name='Play animation').click();expect(page.get_by_test_id('trace-position')).to_have_text('1 / 40');page.get_by_role('button',name='Pause animation').click()
  page.emulate_media(reduced_motion='reduce');expect(page.locator('.arch-fallback')).to_have_count(2);expect(page.locator('canvas')).to_have_count(0);no_overflow()
  goto('tab=attention&mechanism=unknown&compare=unknown&frame=-100')
  expect(page.get_by_label('Primary mechanism')).to_have_value('gqa');expect(page.get_by_test_id('trace-position')).to_have_text('28 / 40')
  page.get_by_role('link',name='KDA derivation',exact=False).click();assert '/kda' in page.url
  assert not errors, errors;assert not api_calls,api_calls
  report.append({'browser':name,'models':total,'mechanisms':len(mechanisms),'webglRendered':canvases==2,'contextsReleased':gpu,'errors':errors,'passed':True})
  browser.close()
 # Explicit WebGL failure path, independent of reduced-motion.
 browser=p.chromium.launch(headless=True);page=browser.new_page()
 page.add_init_script("const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(t,...a){return /webgl/.test(t)?null:original.call(this,t,...a)}")
 page.route('**/api/app/auth/me',lambda r:r.fulfill(status=401,body='{}'))
 page.goto(args.base+'/#/architecture?tab=attention&mechanism=mla');page.wait_for_load_state('networkidle');expect(page.locator('.arch-fallback')).to_have_count(1);expect(page.get_by_text('WebGL unavailable',exact=False)).to_be_visible();browser.close()
report.append({'webglFailureFallback':True})
(output/'acceptance.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report,indent=2))
