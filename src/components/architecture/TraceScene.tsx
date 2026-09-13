import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { SceneFrame, TraceNode } from '../../lib/attention/sceneGraph'
export interface SceneProps { graph: SceneFrame; progress: number; selection: string; focus: number | null; onSelect: (id: string) => void; cameraReset: number; onUnavailable: () => void; mechanism: string }
export const HEAD_COLORS = ['#a32b42', '#7651bb', '#168a88', '#b27519']
export default function TraceScene(props: SceneProps) {
  const host = useRef<HTMLDivElement>(null), latest = useRef(props); latest.current = props
  const api = useRef<{ refresh: () => void; reset: () => void; invalidate: () => void }>()
  useEffect(() => {
    const element = host.current!
    let renderer: THREE.WebGLRenderer
    try { renderer = new THREE.WebGLRenderer({ antialias: true }); if (!renderer.getContext()) throw new Error('No WebGL') }
    catch { latest.current.onUnavailable(); return }
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2)); renderer.setClearColor('#f6f3ea'); renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.setAttribute('aria-label', '3D Attention scene · all Heads · drag to orbit, scroll to zoom'); element.appendChild(renderer.domElement)
    const labels = document.createElement('div'); labels.className = 'arch-scene-labels'; element.appendChild(labels)
    const scene = new THREE.Scene(), group = new THREE.Group(); scene.add(group); scene.add(new THREE.HemisphereLight('#ffffff', '#c3b7a2', 2.5))
    const light = new THREE.DirectionalLight('#ffffff', 3); light.position.set(3, 15, 8); scene.add(light)
    const camera = new THREE.PerspectiveCamera(40, 1, .1, 200), controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true; controls.enablePan = true; controls.maxPolarAngle = Math.PI * .44
    let request = 0, disposed = false, bounds = new THREE.Box3(), savedShape = ''
    let clickable: THREE.Object3D[] = []
    const labelNodes: { element: HTMLButtonElement; node: TraceNode }[] = [], moving: { mesh: THREE.Mesh; curve: THREE.QuadraticBezierCurve3; segment: [number, number] }[] = []
    const projected = new THREE.Vector3()
    const invalidate = () => { if (!disposed && !request && !document.hidden) request = requestAnimationFrame(render) }
    function render() {
      request = 0; if (disposed || document.hidden) return
      const changed = controls.update(), progress = latest.current.progress
      moving.forEach(p => { const [a, b] = p.segment, f = (progress - a) / (b - a); p.mesh.visible = f >= 0 && f <= 1; if (p.mesh.visible) p.mesh.position.copy(p.curve.getPoint(f)) })
      renderer.render(scene, camera)
      labelNodes.forEach(({ element: label, node }) => {
        projected.set(node.position[0], .7, node.position[2]).project(camera)
        label.style.left = `${(projected.x + 1) * element.clientWidth / 2}px`; label.style.top = `${(1 - projected.y) * element.clientHeight / 2}px`
        label.hidden = projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > 1.05 || Math.abs(projected.y) > 1.05
        const neighbor = new THREE.Vector3(node.position[0] + (node.kind === 'memory' && node.tokens ? 1.55 : 3.85), .7, node.position[2]).project(camera)
        label.style.maxWidth = `${Math.max(25, Math.min(node.kind === 'memory' && node.tokens ? 70 : 110, Math.abs(neighbor.x - projected.x) * element.clientWidth / 2))}px`
      })
      if (changed) invalidate()
    }
    const reset = () => {
      const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3()), aspect = element.clientWidth / Math.max(1, element.clientHeight)
      const distance = Math.max((size.x + 2) / aspect, size.z + 2) / (2 * Math.tan(THREE.MathUtils.degToRad(20)))
      camera.position.copy(center).add(new THREE.Vector3(0, distance, distance * .52)); controls.target.copy(center); controls.minDistance = 8; controls.maxDistance = distance * 2.2; controls.update(); invalidate()
    }
    const resize = () => { const w = element.clientWidth, h = element.clientHeight; if (!w || !h) return; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); reset() }
    function clear() {
      group.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach(x => x.dispose()) })
      group.clear(); labels.replaceChildren(); clickable = []; labelNodes.length = 0; moving.length = 0
    }
    function refresh() {
      clear(); bounds = new THREE.Box3()
      const { graph, focus, selection } = latest.current, locations = new Map(graph.nodes.map(n => [n.id, new THREE.Vector3(...n.position)]))
      for (const n of graph.nodes) {
        const color = n.head !== undefined ? HEAD_COLORS[n.head] : n.group !== undefined ? HEAD_COLORS[n.group] : n.kind === 'output' ? '#168a88' : n.kind === 'memory' ? '#9a8260' : '#807664'
        const focused = focus === null || n.head === undefined || n.head === focus, selected = selection === n.id
        const width = n.kind === 'memory' && n.tokens ? 1.35 : n.kind === 'state' ? 2.8 : 3.1, depth = n.kind === 'state' ? 2 : .78
        const material = new THREE.MeshStandardMaterial({ color, roughness: .65, transparent: true, opacity: n.available ? focused ? .86 : .52 : .13, emissive: selected || n.active ? color : '#000000', emissiveIntensity: selected ? .35 : n.active ? .15 : 0 })
        const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, n.active ? .28 : .16, depth), material); mesh.position.set(...n.position); mesh.userData.id = n.id; group.add(mesh); clickable.push(mesh)
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: selected ? '#ba6d17' : color, transparent: true, opacity: selected ? 1 : .5 })); outline.position.copy(mesh.position); group.add(outline)
        if (n.values && n.available) {
          const values = n.values.flat(), cols = n.kind === 'state' ? 4 : Math.min(8, Math.max(1, values.length)), rows = Math.ceil(Math.min(values.length, 16) / cols)
          values.slice(0, 16).forEach((v, i) => {
            const cell = new THREE.Mesh(new THREE.BoxGeometry(width / (cols + 1) * .75, .04 + Math.min(.12, Math.abs(v) * .08), depth / (rows + 1) * .7), new THREE.MeshStandardMaterial({ color: v < 0 ? '#b4e6dd' : '#fff6de', transparent: true, opacity: .7 }))
            cell.position.set(n.position[0] + ((i % cols) - (cols - 1) / 2) * width / (cols + 1), .23, n.position[2] + (Math.floor(i / cols) - (rows - 1) / 2) * depth / (rows + 1)); cell.userData.id = n.id; group.add(cell); clickable.push(cell)
          })
        }
        const label = document.createElement('button'); label.type = 'button'; label.textContent = n.label; label.title = n.detail; label.dataset.nodeId = n.id
        label.setAttribute('aria-label', `Inspect ${n.label}`); label.className = `${n.available ? '' : 'is-pending'} ${selected ? 'is-selected' : ''} ${n.head !== undefined && !focused ? 'is-background' : ''}`
        label.style.color = color; label.style.maxWidth = n.kind === 'memory' && n.tokens ? '70px' : '110px'; label.onclick = () => latest.current.onSelect(n.id); labels.appendChild(label); labelNodes.push({ element: label, node: n })
        bounds.expandByPoint(new THREE.Vector3(n.position[0] - width / 2, 0, n.position[2] - depth / 2)); bounds.expandByPoint(new THREE.Vector3(n.position[0] + width / 2, 0, n.position[2] + depth / 2))
      }
      for (const e of graph.edges) {
        const from = locations.get(e.from), to = locations.get(e.to); if (!from || !to) continue
        const a = from.clone().setY(.4), b = to.clone().setY(.4), mid = a.clone().lerp(b, .5); mid.y += .45 + (e.head ?? 0) * .14
        const curve = new THREE.QuadraticBezierCurve3(a, mid, b), color = e.head === undefined ? '#686252' : HEAD_COLORS[e.head]
        const style = { color, transparent: true, opacity: focus === null || e.head === undefined || e.head === focus ? .65 : .32 }
        const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(32)), e.path === 'score' ? new THREE.LineDashedMaterial({ ...style, dashSize: .25, gapSize: .14 }) : new THREE.LineBasicMaterial(style)); line.computeLineDistances(); line.userData.edgeId = e.id; group.add(line)
        const point = new THREE.Mesh(new THREE.SphereGeometry(.085, 8, 6), new THREE.MeshBasicMaterial({ color })); group.add(point); moving.push({ mesh: point, curve, segment: e.segment })
        group.add(new THREE.ArrowHelper(curve.getTangent(.93).normalize(), curve.getPoint(.9), .3, color, .22, .13))
      }
      const shape = latest.current.mechanism + ':' + (graph.structural ? 'structure' : graph.nodes.some(n => n.kind === 'state') ? 'state' : graph.nodes.some(n => n.id.startsWith('latent-agg')) ? 'latent' : 'attention')
      if (savedShape !== shape) { savedShape = shape; reset() } else invalidate()
      element.dataset.nodeCount = String(graph.nodes.length); element.dataset.edgeCount = String(graph.edges.length); element.dataset.activeHeads = [...new Set(graph.edges.flatMap(e => e.head === undefined ? [] : [e.head]))].sort().join(','); element.dataset.stage = String(graph.stage)
    }
    const observer = new ResizeObserver(resize); observer.observe(element); controls.addEventListener('change', invalidate)
    const ray = new THREE.Raycaster(), pointer = new THREE.Vector2(); let start = [0, 0]
    const down = (e: PointerEvent) => { start = [e.clientX, e.clientY] }
    const pick = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - start[0], e.clientY - start[1]) > 5) return
      const r = renderer.domElement.getBoundingClientRect(); pointer.set((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1); ray.setFromCamera(pointer, camera)
      const hit = ray.intersectObjects(clickable)[0]; if (hit) latest.current.onSelect(hit.object.userData.id)
    }
    const lost = (e: Event) => { e.preventDefault(); latest.current.onUnavailable() }, visibility = () => { if (document.hidden) { cancelAnimationFrame(request); request = 0 } else invalidate() }
    renderer.domElement.addEventListener('pointerdown', down); renderer.domElement.addEventListener('pointerup', pick); renderer.domElement.addEventListener('webglcontextlost', lost); document.addEventListener('visibilitychange', visibility)
    api.current = { refresh, reset, invalidate }; refresh(); resize()
    return () => { disposed = true; cancelAnimationFrame(request); observer.disconnect(); controls.dispose(); clear(); renderer.domElement.removeEventListener('pointerdown', down); renderer.domElement.removeEventListener('pointerup', pick); renderer.domElement.removeEventListener('webglcontextlost', lost); document.removeEventListener('visibilitychange', visibility); renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove(); labels.remove(); api.current = undefined }
  }, [])
  useEffect(() => { api.current?.refresh() }, [props.graph, props.selection, props.focus])
  useEffect(() => { api.current?.invalidate() }, [props.progress])
  useEffect(() => { api.current?.reset() }, [props.cameraReset])
  return <div className="arch-three-scene" ref={host} data-testid={`scene-${props.mechanism}`}><div className="arch-scene-caption">{props.graph.structural ? 'Layers × Shared memory' : 'All Heads · one computed layer'}<span>Drag to orbit · Scroll to zoom</span></div></div>
}
