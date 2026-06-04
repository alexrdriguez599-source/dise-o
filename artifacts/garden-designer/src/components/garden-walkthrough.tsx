/**
 * GardenWalkthrough — Modo recorrido 3D en primera persona.
 *
 * Convierte el diseño CAD (polígonos + plantas) a una escena Three.js
 * navegable en primera persona con controles FPS (WASD + mouse) y
 * soporte táctil para móvil.
 */

import { useRef, useEffect, useState, useMemo, useCallback } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PointerLockControls, Sky } from "@react-three/drei";
import * as THREE from "three";
import { X, Eye, Gamepad2 } from "lucide-react";
import type { DesignItem, Material } from "@/context/app-context";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WTPolygon {
  id: string;
  points: { x: number; y: number }[];
  materialId: string;
  closed: boolean;
}

export interface WTInventoryItem {
  id: number;
  name: string;
  itemType?: string | null;
  category?: string | null;
}

export interface GardenWalkthroughProps {
  polygons: WTPolygon[];
  designItems: DesignItem[];
  gardenImage: string | null;
  imageWidth: number;
  imageHeight: number;
  ppm: number | null;
  materials: Material[];
  inventoryItems: WTInventoryItem[];
  onClose: () => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CAMERA_HEIGHT  = 1.6;
const MOVE_SPEED     = 5.0;
const FRICTION       = 0.80;
const MOUSE_SENSITIVITY = 0.002;

// ─── Plant classifier ─────────────────────────────────────────────────────────

type PlantKind = "palm" | "tree" | "shrub" | "groundcover" | "other";

function classifyKind(name: string, itemType?: string | null): PlantKind {
  const s = `${name} ${itemType ?? ""}`.toLowerCase();
  if (/palma|palm|coco|cycas|fénix|fenix|washingtonia/.test(s)) return "palm";
  if (/árbol|arbol|ficus|laurel|magnolia|piru|jacaranda|pirúl/.test(s)) return "tree";
  if (/arbusto|shrub|bougainvillea|bugambilia|helecho|agave|nopal|cactus|yuca/.test(s)) return "shrub";
  if (/pasto|grass|cesped|cespéd|zacate|kikuyu|bermuda/.test(s)) return "groundcover";
  return "other";
}

const LEAF_COLORS: Record<PlantKind, number> = {
  palm:        0x2d8a2d,
  tree:        0x256325,
  shrub:       0x3a8c4a,
  groundcover: 0x7acf5a,
  other:       0x3a7d44,
};

const TRUNK_COLOR = 0x8b6914;

// ─── Procedural plant mesh ─────────────────────────────────────────────────────

function PlantMesh({ wx, wz, kind, baseScale }: {
  wx: number; wz: number; kind: PlantKind; baseScale: number;
}) {
  const leafCol = LEAF_COLORS[kind];
  const s = Math.max(0.4, Math.min(2.5, baseScale));

  if (kind === "palm") {
    const h = 5.5 * s;
    return (
      <group position={[wx, 0, wz]}>
        <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.1 * s, 0.22 * s, h, 7]} />
          <meshLambertMaterial color={TRUNK_COLOR} />
        </mesh>
        {/* Main canopy */}
        <mesh position={[0, h + 0.6 * s, 0]} castShadow>
          <sphereGeometry args={[1.4 * s, 8, 6]} />
          <meshLambertMaterial color={leafCol} />
        </mesh>
        {/* Frond satellites */}
        {[0, 1, 2, 3, 4].map(i => {
          const a = (i / 5) * Math.PI * 2;
          return (
            <mesh key={i}
              position={[Math.cos(a) * 1.1 * s, h + 0.1 * s, Math.sin(a) * 1.1 * s]}
              castShadow
            >
              <sphereGeometry args={[0.55 * s, 6, 5]} />
              <meshLambertMaterial color={leafCol} />
            </mesh>
          );
        })}
      </group>
    );
  }

  if (kind === "tree") {
    const h = 4.0 * s;
    return (
      <group position={[wx, 0, wz]}>
        <mesh position={[0, h / 2, 0]} castShadow receiveShadow>
          <cylinderGeometry args={[0.16 * s, 0.28 * s, h, 7]} />
          <meshLambertMaterial color={TRUNK_COLOR} />
        </mesh>
        <mesh position={[0, h + 0.9 * s, 0]} castShadow>
          <sphereGeometry args={[1.6 * s, 10, 8]} />
          <meshLambertMaterial color={leafCol} />
        </mesh>
        <mesh position={[0, h - 0.4 * s, 0]} castShadow>
          <sphereGeometry args={[0.9 * s, 8, 6]} />
          <meshLambertMaterial color={leafCol} />
        </mesh>
      </group>
    );
  }

  if (kind === "shrub") {
    const clusters = [
      [-0.28, 0, -0.18], [0.22, 0.08, 0.1], [-0.1, 0.12, 0.3], [0.32, 0, 0.24], [0, 0.1, -0.3],
    ];
    return (
      <group position={[wx, 0, wz]}>
        {clusters.map(([ox, oy, oz], i) => (
          <mesh key={i} position={[ox * s, 0.5 * s + oy * s, oz * s]} castShadow>
            <sphereGeometry args={[0.42 * s, 7, 6]} />
            <meshLambertMaterial color={leafCol} />
          </mesh>
        ))}
      </group>
    );
  }

  if (kind === "groundcover") {
    return (
      <group position={[wx, 0, wz]}>
        <mesh position={[0, 0.12 * s, 0]}>
          <cylinderGeometry args={[0.4 * s, 0.5 * s, 0.24 * s, 8]} />
          <meshLambertMaterial color={leafCol} />
        </mesh>
      </group>
    );
  }

  // other — generic bush
  return (
    <group position={[wx, 0, wz]}>
      <mesh position={[0, 0.7 * s, 0]} castShadow>
        <sphereGeometry args={[0.6 * s, 8, 7]} />
        <meshLambertMaterial color={leafCol} />
      </mesh>
    </group>
  );
}

// ─── Scene (mounted inside Canvas) ───────────────────────────────────────────

interface SceneProps {
  polygons: WTPolygon[];
  designItems: DesignItem[];
  gardenImage: string | null;
  imgW: number;
  imgH: number;
  ppm: number;
  inventoryItems: WTInventoryItem[];
  moveRef: React.MutableRefObject<{ fwd: boolean; bwd: boolean; left: boolean; right: boolean }>;
  touchRef: React.MutableRefObject<{ moveDx: number; moveDy: number; lookDx: number; lookDy: number }>;
  speedRef: React.MutableRefObject<number>;
  isMobile: boolean;
}

function Scene({ polygons, designItems, gardenImage, imgW, imgH, ppm,
                 inventoryItems, moveRef, touchRef, speedRef, isMobile }: SceneProps) {
  const { camera } = useThree();
  const vel = useRef(new THREE.Vector3());
  const euler = useRef(new THREE.Euler(0, 0, 0, "YXZ"));

  const worldW = imgW / ppm;
  const worldH = imgH / ppm;

  // Bounding box from all closed polygons
  const bounds = useMemo(() => {
    const pts = polygons.filter(p => p.closed).flatMap(p => p.points);
    if (!pts.length) return { x0: -15, x1: 15, z0: -15, z1: 15 };
    const xs = pts.map(p => (p.x - imgW / 2) / ppm);
    const zs = pts.map(p => (p.y - imgH / 2) / ppm);
    return {
      x0: Math.min(...xs) - 1,
      x1: Math.max(...xs) + 1,
      z0: Math.min(...zs) - 1,
      z1: Math.max(...zs) + 1,
    };
  }, [polygons, imgW, imgH, ppm]);

  // Spawn in center of garden
  const spawn = useMemo(() => {
    const pts = polygons.filter(p => p.closed).flatMap(p => p.points);
    if (!pts.length) return { x: 0, z: 0 };
    const ax = pts.reduce((s, p) => s + (p.x - imgW / 2) / ppm, 0) / pts.length;
    const az = pts.reduce((s, p) => s + (p.y - imgH / 2) / ppm, 0) / pts.length;
    return { x: ax, z: az };
  }, [polygons, imgW, imgH, ppm]);

  // Place camera on mount
  useEffect(() => {
    camera.position.set(spawn.x, CAMERA_HEIGHT, spawn.z);
    euler.current.set(0, 0, 0);
    camera.quaternion.setFromEuler(euler.current);
    (camera as THREE.PerspectiveCamera).fov = 75;
    (camera as THREE.PerspectiveCamera).updateProjectionMatrix();
  }, [camera, spawn]);

  // Ground texture from gardenImage (base64)
  const groundTex = useMemo(() => {
    if (!gardenImage) return null;
    const t = new THREE.TextureLoader().load(gardenImage);
    t.wrapS = THREE.ClampToEdgeWrapping;
    t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  }, [gardenImage]);

  // Plants
  // Note: designItem.x / .y are percentages (0–100) of the design canvas container.
  // Divide by 100 to convert to fraction of image before mapping to world coords.
  const invMap = useMemo(() => new Map(inventoryItems.map(i => [i.id, i])), [inventoryItems]);
  const plants = useMemo(() =>
    designItems.map(item => {
      const inv = typeof item.inventoryItemId === "number" ? invMap.get(item.inventoryItemId) : undefined;
      const kind = classifyKind(item.name, inv?.category ?? inv?.itemType);
      // x/y stored as 0-100 (percentage of container) → convert to 0-1 fraction first
      const fx = (item.x ?? 50) / 100;
      const fy = (item.y ?? 50) / 100;
      const wx = (fx * imgW - imgW / 2) / ppm;
      const wz = (fy * imgH - imgH / 2) / ppm;
      return { id: item.id, wx, wz, kind, baseScale: item.scale ?? 1.0 };
    }),
  [designItems, invMap, imgW, imgH, ppm]);

  // Movement & look every frame
  useFrame((_, dt) => {
    const ms  = moveRef.current;
    const ti  = touchRef.current;
    const spd = speedRef.current;

    // Mobile look via right joystick
    if (isMobile) {
      euler.current.y -= ti.lookDx * dt * 1.8;
      euler.current.x -= ti.lookDy * dt * 1.2;
      euler.current.x = Math.max(-Math.PI / 3, Math.min(Math.PI / 3, euler.current.x));
      camera.quaternion.setFromEuler(euler.current);
    }

    // Build forward/right vectors from yaw only
    const yaw = isMobile ? euler.current.y : camera.rotation.y;
    const fwd   = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right  = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const move   = new THREE.Vector3();

    // Keyboard
    if (ms.fwd)   move.addScaledVector(fwd,   spd * dt);
    if (ms.bwd)   move.addScaledVector(fwd,  -spd * dt);
    if (ms.left)  move.addScaledVector(right, -spd * dt);
    if (ms.right) move.addScaledVector(right,  spd * dt);

    // Touch move joystick
    if (Math.abs(ti.moveDx) > 0.08 || Math.abs(ti.moveDy) > 0.08) {
      move.addScaledVector(right, ti.moveDx * spd * dt);
      move.addScaledVector(fwd, -ti.moveDy * spd * dt);
    }

    vel.current.add(move);
    vel.current.multiplyScalar(FRICTION);

    // Clamp to garden bounds
    camera.position.x = Math.max(bounds.x0, Math.min(bounds.x1, camera.position.x + vel.current.x));
    camera.position.z = Math.max(bounds.z0, Math.min(bounds.z1, camera.position.z + vel.current.z));
    camera.position.y = CAMERA_HEIGHT;
  });

  return (
    <>
      {/* Sky */}
      <Sky distance={4500} sunPosition={[100, 80, 50]} turbidity={6} rayleigh={1.5} mieCoefficient={0.005} mieDirectionalG={0.8} />

      {/* Sun light with shadows */}
      <directionalLight
        position={[15, 25, 10]}
        intensity={2.0}
        color="#fff8e0"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={0.5}
        shadow-camera-far={120}
        shadow-camera-left={-40}
        shadow-camera-right={40}
        shadow-camera-top={40}
        shadow-camera-bottom={-40}
        shadow-bias={-0.0005}
      />

      {/* Ambient fill */}
      <ambientLight intensity={0.55} color="#d0e8ff" />

      {/* Hemisphere sky/ground fill */}
      <hemisphereLight args={["#87ceeb", "#4a7a2a", 0.4]} />

      {/* Garden ground plane with photo texture */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, 0]} receiveShadow>
        <planeGeometry args={[worldW, worldH]} />
        {groundTex
          ? <meshLambertMaterial map={groundTex} />
          : <meshLambertMaterial color="#5a8a3a" />
        }
      </mesh>

      {/* Infinite surrounding ground */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.005, 0]} receiveShadow>
        <planeGeometry args={[600, 600]} />
        <meshLambertMaterial color="#4a7a2a" />
      </mesh>

      {/* Thin border wall to visually mark garden edges */}
      {polygons.filter(p => p.closed).map(poly => {
        const pts = poly.points;
        return pts.map((pt, i) => {
          const next = pts[(i + 1) % pts.length];
          const x1 = (pt.x   - imgW / 2) / ppm;
          const z1 = (pt.y   - imgH / 2) / ppm;
          const x2 = (next.x - imgW / 2) / ppm;
          const z2 = (next.y - imgH / 2) / ppm;
          const mx = (x1 + x2) / 2, mz = (z1 + z2) / 2;
          const len = Math.hypot(x2 - x1, z2 - z1);
          const angle = Math.atan2(x2 - x1, z2 - z1);
          return (
            <mesh key={`${poly.id}-${i}`} position={[mx, 0.05, mz]} rotation={[0, angle, 0]} receiveShadow castShadow>
              <boxGeometry args={[0.08, 0.1, len]} />
              <meshLambertMaterial color="#6b8e23" />
            </mesh>
          );
        });
      })}

      {/* Plants */}
      {plants.map(p => (
        <PlantMesh key={p.id} wx={p.wx} wz={p.wz} kind={p.kind} baseScale={p.baseScale} />
      ))}

      {/* Desktop pointer-lock controls (handles mouse look automatically) */}
      {!isMobile && <PointerLockControls />}
    </>
  );
}

// ─── Virtual Joystick ─────────────────────────────────────────────────────────

function VirtualJoystick({
  side, label, color, onInput,
}: {
  side: "left" | "right";
  label: string;
  color: string;
  onInput: (dx: number, dy: number) => void;
}) {
  const baseRef  = useRef<HTMLDivElement>(null);
  const stickRef = useRef<HTMLDivElement>(null);
  const touchId  = useRef<number | null>(null);
  const MAX = 38;

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (touchId.current !== null) return;
    touchId.current = e.changedTouches[0].identifier;
    e.preventDefault();
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchId.current === null || !baseRef.current || !stickRef.current) return;
    const t = Array.from(e.changedTouches).find(x => x.identifier === touchId.current);
    if (!t) return;
    const r = baseRef.current.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let dx = (t.clientX - cx) / MAX;
    let dy = (t.clientY - cy) / MAX;
    const mag = Math.sqrt(dx * dx + dy * dy);
    if (mag > 1) { dx /= mag; dy /= mag; }
    onInput(dx, dy);
    stickRef.current.style.transform = `translate(${dx * MAX}px, ${dy * MAX}px)`;
    e.preventDefault();
  }, [onInput, MAX]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!Array.from(e.changedTouches).find(x => x.identifier === touchId.current)) return;
    touchId.current = null;
    onInput(0, 0);
    if (stickRef.current) stickRef.current.style.transform = "translate(0,0)";
    e.preventDefault();
  }, [onInput]);

  return (
    <div
      ref={baseRef}
      className={`absolute bottom-14 ${side === "left" ? "left-10" : "right-10"} w-28 h-28 rounded-full flex items-center justify-center select-none`}
      style={{ background: "rgba(255,255,255,0.12)", border: `2px solid ${color}40` }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <div
        ref={stickRef}
        className="w-12 h-12 rounded-full"
        style={{
          background: color,
          opacity: 0.7,
          transition: "none",
          willChange: "transform",
        }}
      />
      <span
        className="absolute -bottom-6 text-xs font-medium"
        style={{ color: `${color}cc` }}
      >
        {label}
      </span>
    </div>
  );
}

// ─── Speed HUD ────────────────────────────────────────────────────────────────

function SpeedControl({ speed, onChange }: { speed: number; onChange: (v: number) => void }) {
  return (
    <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-3 bg-black/50 rounded-full px-4 py-2 border border-white/10">
      <span className="text-white/50 text-xs">Velocidad</span>
      <input
        type="range" min={1} max={10} step={0.5} value={speed}
        onChange={e => onChange(Number(e.target.value))}
        className="w-20 accent-emerald-400"
      />
      <span className="text-white/50 text-xs w-6">{speed.toFixed(0)}</span>
    </div>
  );
}

// ─── Main export ──────────────────────────────────────────────────────────────

export default function GardenWalkthrough({
  polygons, designItems, gardenImage, imageWidth, imageHeight, ppm, materials, inventoryItems, onClose,
}: GardenWalkthroughProps) {
  const effectivePPM = ppm ?? Math.max(imageWidth, imageHeight) / 30;

  const moveRef  = useRef({ fwd: false, bwd: false, left: false, right: false });
  const touchRef = useRef({ moveDx: 0, moveDy: 0, lookDx: 0, lookDy: 0 });
  const speedRef = useRef(MOVE_SPEED);
  const [locked, setLocked] = useState(false);
  const [speed, setSpeed] = useState(MOVE_SPEED);
  const [isMobile] = useState(() =>
    /Mobi|Android/i.test(navigator.userAgent) || window.matchMedia("(pointer: coarse)").matches
  );

  // Keyboard listener
  useEffect(() => {
    const d = (e: KeyboardEvent) => {
      const ms = moveRef.current;
      if (e.code === "KeyW" || e.code === "ArrowUp")    ms.fwd   = true;
      if (e.code === "KeyS" || e.code === "ArrowDown")  ms.bwd   = true;
      if (e.code === "KeyA" || e.code === "ArrowLeft")  ms.left  = true;
      if (e.code === "KeyD" || e.code === "ArrowRight") ms.right = true;
    };
    const u = (e: KeyboardEvent) => {
      const ms = moveRef.current;
      if (e.code === "KeyW" || e.code === "ArrowUp")    ms.fwd   = false;
      if (e.code === "KeyS" || e.code === "ArrowDown")  ms.bwd   = false;
      if (e.code === "KeyA" || e.code === "ArrowLeft")  ms.left  = false;
      if (e.code === "KeyD" || e.code === "ArrowRight") ms.right = false;
    };
    window.addEventListener("keydown", d);
    window.addEventListener("keyup", u);
    return () => { window.removeEventListener("keydown", d); window.removeEventListener("keyup", u); };
  }, []);

  // Pointer lock state
  useEffect(() => {
    if (isMobile) return;
    const fn = () => setLocked(!!document.pointerLockElement);
    document.addEventListener("pointerlockchange", fn);
    return () => document.removeEventListener("pointerlockchange", fn);
  }, [isMobile]);

  const hasPolygons = polygons.some(p => p.closed);
  const plantCount  = designItems.length;

  return (
    <div className="fixed inset-0 z-[200] bg-black select-none" style={{ touchAction: "none" }}>

      {/* ── 3D Canvas ─────────────────────────────────────────────────────── */}
      <Canvas
        shadows
        camera={{ fov: 75, near: 0.05, far: 800, position: [0, CAMERA_HEIGHT, 0] }}
        gl={{ antialias: true, powerPreference: "high-performance" }}
        style={{ width: "100%", height: "100%" }}
      >
        <Scene
          polygons={polygons}
          designItems={designItems}
          gardenImage={gardenImage}
          imgW={imageWidth}
          imgH={imageHeight}
          ppm={effectivePPM}
          inventoryItems={inventoryItems}
          moveRef={moveRef}
          touchRef={touchRef}
          speedRef={speedRef}
          isMobile={isMobile}
        />
      </Canvas>

      {/* ── Close button ─────────────────────────────────────────────────── */}
      <button
        onClick={onClose}
        className="absolute top-4 right-4 z-20 flex items-center gap-2 px-4 py-2 rounded-full bg-black/70 text-white border border-white/20 hover:bg-red-900/70 hover:border-red-400/40 transition-all text-sm font-medium"
      >
        <X className="w-4 h-4" />
        Salir
      </button>

      {/* ── Info badge ───────────────────────────────────────────────────── */}
      <div className="absolute top-4 left-4 z-20 flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/60 border border-emerald-500/30 text-xs text-emerald-300">
        <Eye className="w-3.5 h-3.5" />
        {plantCount > 0
          ? `${plantCount} elemento${plantCount !== 1 ? "s" : ""} · ${polygons.filter(p => p.closed).length} zona${polygons.filter(p => p.closed).length !== 1 ? "s" : ""}`
          : `${polygons.filter(p => p.closed).length} zona${polygons.filter(p => p.closed).length !== 1 ? "s" : ""} · sin elementos`}
      </div>

      {/* ── Desktop click-to-lock overlay ─────────────────────────────────── */}
      {!isMobile && !locked && (
        <div
          className="absolute inset-0 z-10 flex items-center justify-center bg-black/65 cursor-pointer"
          onClick={() => {
            const c = document.querySelector<HTMLCanvasElement>("canvas");
            c?.requestPointerLock();
          }}
        >
          <div className="bg-black/85 border border-emerald-500/40 rounded-2xl p-8 max-w-xs w-full text-center space-y-5 shadow-2xl">
            <div className="text-5xl">🌿</div>
            <h2 className="text-white text-xl font-semibold tracking-tight">Recorrido virtual</h2>
            <p className="text-white/60 text-sm">Haz clic aquí para activar los controles del ratón</p>

            <div className="grid grid-cols-2 gap-2 text-xs text-white/50 border-t border-white/10 pt-4">
              <div className="bg-white/5 rounded-lg p-2 text-center">
                <div className="font-bold text-white/80 mb-1">Moverse</div>
                <kbd className="bg-white/10 px-1.5 py-0.5 rounded text-white/70">W A S D</kbd>
              </div>
              <div className="bg-white/5 rounded-lg p-2 text-center">
                <div className="font-bold text-white/80 mb-1">Mirar</div>
                <span className="bg-white/10 px-1.5 py-0.5 rounded text-white/70">Mouse</span>
              </div>
              <div className="bg-white/5 rounded-lg p-2 text-center col-span-2">
                <kbd className="bg-white/10 px-1.5 py-0.5 rounded text-white/70">Esc</kbd>
                <span className="ml-2">→ Liberar mouse / Salir</span>
              </div>
            </div>

            {!hasPolygons && plantCount === 0 && (
              <p className="text-yellow-400/80 text-xs bg-yellow-900/20 rounded-lg p-2">
                ⚠ Coloca elementos o dibuja zonas en el CAD para ver contenido en 3D
              </p>
            )}
            {!hasPolygons && plantCount > 0 && (
              <p className="text-emerald-400/80 text-xs bg-emerald-900/20 rounded-lg p-2">
                🌿 {plantCount} elemento{plantCount !== 1 ? "s" : ""} de Diseño cargado{plantCount !== 1 ? "s" : ""}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ── Mobile joysticks ─────────────────────────────────────────────── */}
      {isMobile && (
        <>
          <VirtualJoystick
            side="left" label="Moverse" color="#22c55e"
            onInput={(dx, dy) => { touchRef.current.moveDx = dx; touchRef.current.moveDy = dy; }}
          />
          <VirtualJoystick
            side="right" label="Mirar" color="#60a5fa"
            onInput={(dx, dy) => { touchRef.current.lookDx = dx; touchRef.current.lookDy = dy; }}
          />
        </>
      )}

      {/* ── Locked status hint ───────────────────────────────────────────── */}
      {!isMobile && locked && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 text-white/35 text-xs bg-black/35 px-4 py-1.5 rounded-full pointer-events-none">
          Presiona <kbd className="bg-white/10 px-1.5 rounded">Esc</kbd> para liberar el mouse
        </div>
      )}

      {/* ── Speed slider ─────────────────────────────────────────────────── */}
      <SpeedControl speed={speed} onChange={v => { setSpeed(v); speedRef.current = v; }} />
    </div>
  );
}
