import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { HEADS, TOKENS, isLatent, isRecurrent, kvHeadCount, type AttentionStep } from '../../lib/attention/engine'
import type { MechanismId } from '../../data/architectureTypes'

export interface SceneProps { playing: boolean; mechanism: MechanismId; step: AttentionStep; stage: number; head: number; selection: string; onSelect: (id: string) => void; cameraReset: number; onUnavailable: () => void }
const PALETTE = ['#9e2b3a', '#6d28d9', '#147d80', '#b06d14']
const tokenX = (i: number) => -5 + i * 1.42
export default function TraceScene(props: SceneProps) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef(props); latest.current = props
  const api = useRef<{ refresh: () => void; reset: () => void }>()
  useEffect(() => {
    const element = host.current!
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); if (!renderer.getContext()) throw new Error('No WebGL') }
    catch { latest.current.onUnavailable(); return }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2)); renderer.setClearColor('#f6f3ea')
    renderer.outputColorSpace = THREE.SRGBColorSpace
    element.appendChild(renderer.domElement)
    renderer.domElement.setAttribute('aria-label', '3D Attention scene · 拖动旋转，滚轮缩放；下方提供可键盘操作的等价选择器')
    const scene = new THREE.Scene(); scene.background = new THREE.Color('#f6f3ea')
    const camera = new THREE.PerspectiveCamera(39, 1, .1, 100)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.dampingFactor = .12; controls.minDistance = 9; controls.maxDistance = 33
    controls.maxPolarAngle = Math.PI * .83; controls.enablePan = false
    const reset = () => { camera.position.set(7, 11, 17); controls.target.set(0, .4, 0); controls.update(); invalidate() }
    const ambient = new THREE.HemisphereLight('#ffffff', '#bbb2a1', 2.4); scene.add(ambient)
    const light = new THREE.DirectionalLight('#ffffff', 3); light.position.set(4, 12, 8); scene.add(light)
    const group = new THREE.Group(); scene.add(group)
    let clickable: THREE.Object3D[] = [], animation = 0, disposed = false
    const particles: { mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; phase: number }[] = []
    let animatedUntil = 0
    function render(now = performance.now()) {
      animation = 0
      if (disposed || document.hidden) return
      const moving = controls.update()
      particles.forEach(p => { const f = (latest.current.playing ? ((now / 1700 + p.phase) % 1) : .5); p.mesh.position.copy(p.from).lerp(p.to, f); p.mesh.position.y += Math.sin(f * Math.PI) * .6 })
      renderer.render(scene, camera)
      if (!animation && (moving || latest.current.playing && now < animatedUntil)) animation = requestAnimationFrame(render)
    }
    function invalidate() { if (!disposed && !animation && !document.hidden) animation = requestAnimationFrame(render) }
    const resize = () => { const width = element.clientWidth, height = element.clientHeight; if (!width || !height) return; renderer.setSize(width, height); camera.aspect = width / height; camera.updateProjectionMatrix(); invalidate() }
    const observer = new ResizeObserver(resize); observer.observe(element)
    controls.addEventListener('change', invalidate)
    function disposeGroup() {
      group.traverse(object => {
        const mesh = object as THREE.Mesh
        mesh.geometry?.dispose()
        if (mesh.material) (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).forEach(m => { const texture = (m as THREE.MeshBasicMaterial).map; texture?.dispose(); m.dispose() })
      }); group.clear(); clickable = []; particles.length = 0
    }
    function label(text: string, x: number, y: number, z: number, color = '#50493f', width = 2) {
      const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d')!
      ctx.font = '600 38px system-ui, sans-serif'; canvas.width = Math.ceil(ctx.measureText(text).width + 24); canvas.height = 64
      ctx.font = '600 38px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = color; ctx.fillText(text, canvas.width / 2, 32)
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true })); const fittedWidth = Math.min(width, .55 * canvas.width / 64); sprite.scale.set(fittedWidth, fittedWidth * 64 / canvas.width, 1); sprite.position.set(x, y, z); group.add(sprite)
    }
    function box(id: string, position: number[], size: number[], color: string, opacity = 1) {
      const selected = latest.current.selection === id
      const mat = new THREE.MeshStandardMaterial({ color, roughness: .6, metalness: .04, transparent: opacity < 1, opacity, emissive: selected ? '#f5b25d' : '#000000', emissiveIntensity: selected ? .3 : 0 })
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size as [number, number, number]), mat); mesh.position.set(...position as [number, number, number]); mesh.userData.id = id; group.add(mesh)
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: selected ? '#c67618' : color, transparent: true, opacity: selected ? 1 : .35 })); edges.position.copy(mesh.position); edges.scale.setScalar(1.01); group.add(edges)
      if (id) clickable.push(mesh)
      return mesh
    }
    function path(from: THREE.Vector3, to: THREE.Vector3, color: string, active: boolean, phase: number) {
      const mid = from.clone().lerp(to, .5); mid.y += .7
      const curve = new THREE.QuadraticBezierCurve3(from, mid, to)
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(20)), new THREE.LineBasicMaterial({ color, transparent: true, opacity: active ? .55 : .1 })))
      if (active) { const mesh = new THREE.Mesh(new THREE.SphereGeometry(.06, 8, 6), new THREE.MeshBasicMaterial({ color })); group.add(mesh); particles.push({ mesh, from, to, phase }) }
    }
    const refresh = () => {
      disposeGroup()
      const { mechanism, step, head, stage } = latest.current, recurrent = isRecurrent(mechanism), latent = isLatent(mechanism), h = step.heads[head]
      // Depth plates communicate layers; only one layer's numerical operator is evaluated.
      for (let layer = 3; layer >= 0; layer--) {
        box('', [0, -1.1 - layer * .48, -.5], [12.5, .07, 6.4], layer === 0 ? '#e1d8c5' : '#e9e2d5', .26 + (3 - layer) * .05)
        label(step.layerModes.length ? `L${layer + 1} · ${step.layerModes[layer]}` : `Layer ${layer + 1}`, -6.2, -1.1 - layer * .48, 3.6, '#787062', 2.1)
      }
      const grid = new THREE.GridHelper(12, 24, '#d6cdbd', '#e6dfd2'); grid.position.y = -1; group.add(grid)
      if (recurrent) {
        const r = h.recurrent!, matrix = stage === 0 ? r.before : stage < 3 ? r.decayed : r.after
        for (let row = 0; row < 4; row++) for (let col = 0; col < 4; col++) {
          const v = matrix[row][col]; box(`state-${row}-${col}`, [(col - 1.5) * 1.0, .18, (row - 1.5) * .95 - .7], [.9, .2 + Math.abs(v) * .5, .82], v < 0 ? '#147d80' : PALETTE[head], .25 + Math.min(.75, Math.abs(v)))
          label(v.toFixed(2), (col - 1.5) * 1, .8, (row - 1.5) * .95 - .7, '#403b35', .74)
        }
        label(`S · 4 × 4 · H${head}`, 0, .4, -3.3, PALETTE[head], 3)
        label(stage === 1 ? 'State Decay' : stage === 2 ? 'Prediction Error' : stage === 3 ? 'Delta Write' : 'Recurrent State', 0, 1.3, -4.1, '#655746', 3.6)
      } else {
        const count = kvHeadCount(mechanism)
        for (let kv = 0; kv < count; kv++) {
          const z = count === 1 ? -.5 : (kv - (count - 1) / 2) * 1.15 - .5
          const activeGroup = kv === h.kvHead
          label(latent ? 'Latent KV + RoPE' : `KV ${kv}`, -6, .3, z, PALETTE[kv], latent ? 2.5 : 1)
          // Entries, not raw-token copies: compressed summaries occupy a single storage block.
          for (const e of h.entries) {
            const x = e.tokens.reduce((sum, t) => sum + tokenX(t), 0) / e.tokens.length
            const isNew = e.tokens.includes(step.t), opacity = activeGroup ? e.selected ? .9 : .22 : .23
            const color = e.kind === 'summary' ? '#b06d14' : PALETTE[kv]
            const mesh = box(`entry-${e.id}`, [x, 0, z], [e.kind === 'summary' ? 1.15 : .92, isNew && stage < 4 ? .2 : .45, .7], color, opacity)
            const cells = latent ? 4 : 8
            for (let c = 0; c < cells; c++) box(`entry-${e.id}`, [x - .3 + (c % 4) * .2, .27, z - .18 + Math.floor(c / 4) * .26], [.13, .055, .16], '#ffffff', .45)
            if (activeGroup) { label(e.kind === 'summary' ? `${e.label} · ${e.tokens.map(t => t + 1).join(',')}` : `t${e.tokens[0] + 1}`, x, .6, z, color, 1.1); if (e.selected) path(mesh.position.clone(), new THREE.Vector3((head - 1.5) * 1.5, .55, 4.3), PALETTE[head], stage >= 1 && stage <= 3, e.tokens[0] / 8) }
          }
        }
        step.evictedTokens.forEach(t => { box(`token-${t}`, [tokenX(t), -.05, -.5], [.85, .04, .7], '#d0c7b8', .3); label('Evicted', tokenX(t), .4, -.5, '#948a7a', 1) })
        label(mechanism === 'csa2' ? 'Shared Global KV · 1 copy' : 'KV Cache · Time →', 0, .3, -4.1, '#766653', 4)
      }
      for (let qh = 0; qh < HEADS; qh++) {
        const x = (qh - 1.5) * 1.5, chosen = qh === head
        box(`head-${qh}`, [x, .55, 4.3], [1.08, .35, .9], PALETTE[qh], chosen ? .95 : .25)
        for (let c = 0; c < 4; c++) box(`head-${qh}`, [x - .28 + c % 2 * .42, .76, 4.1 + Math.floor(c / 2) * .4], [.25, .04, .24], '#ffffff', .6)
        label(`Q${qh} → ${recurrent ? 'S' + qh : 'KV' + step.heads[qh].kvHead}`, x, 1.25, 4.3, PALETTE[qh], 1.7)
      }
      const out = box('output', [5, .55, 4.3], [1.0, .5, 1.0], '#147d80', stage >= 3 ? .95 : .25)
      label('Output', 5, 1.25, 4.3, '#147d80', 1.7)
      path(new THREE.Vector3((head - 1.5) * 1.5, .55, 4.3), out.position, '#147d80', stage >= 3, .1)
      if (recurrent) path(new THREE.Vector3(0, .8, 0), new THREE.Vector3((head - 1.5) * 1.5, .55, 4.3), PALETTE[head], stage >= 1, .5)
      if (step.layerModes.length) { path(new THREE.Vector3(5.8, 0, 0), new THREE.Vector3(5.8, -2.55, 0), '#147d80', true, .7); label('Cross-layer sharing', 5.9, -.9, -2.9, '#147d80', 2.7) }
      animatedUntil = performance.now() + 1800; invalidate()
    }
    const raycaster = new THREE.Raycaster(), pointer = new THREE.Vector2(); let start = [0, 0]
    const down = (e: PointerEvent) => { start = [e.clientX, e.clientY] }
    const pick = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 5) return
      const rect = renderer.domElement.getBoundingClientRect(); pointer.set((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1); raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObjects(clickable)[0]; if (hit) latest.current.onSelect(hit.object.userData.id)
    }
    const lost = (e: Event) => { e.preventDefault(); latest.current.onUnavailable() }
    const visibility = () => { if (document.hidden) { cancelAnimationFrame(animation); animation = 0 } else invalidate() }
    renderer.domElement.addEventListener('pointerdown', down); renderer.domElement.addEventListener('pointerup', pick); renderer.domElement.addEventListener('webglcontextlost', lost); document.addEventListener('visibilitychange', visibility)
    api.current = { refresh, reset }; reset(); resize(); refresh()
    return () => { disposed = true; cancelAnimationFrame(animation); observer.disconnect(); document.removeEventListener('visibilitychange', visibility); renderer.domElement.removeEventListener('pointerdown', down); renderer.domElement.removeEventListener('pointerup', pick); renderer.domElement.removeEventListener('webglcontextlost', lost); controls.dispose(); disposeGroup(); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); api.current = undefined }
  }, [])
  useEffect(() => { api.current?.refresh() }, [props.mechanism, props.step, props.stage, props.head, props.selection, props.playing])
  useEffect(() => { api.current?.reset() }, [props.cameraReset])
  return <div ref={host} className="arch-three-scene" data-testid={`scene-${props.mechanism}`}><div className="arch-scene-caption">Time × KV Heads × Layers <span>Drag to orbit · Scroll to zoom</span></div><span className="sr-only">{TOKENS[props.step.t]}，当前步骤 {props.stage + 1}</span></div>
}
