"use client";

import Link from "next/link";
import { type CSSProperties, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  GROUP_ORDER,
  MODE_OPTIONS,
  RELATION_LABEL,
  ZONE_LABEL,
  groupOf,
  matchesAudience,
  normalizeAudienceFilter,
  type Audience,
  type AudienceFilter,
  type RelationType,
} from "@/lib/groups";
import type { McpCallEvent } from "@/lib/mcp-events";
import { useJavis } from "./JavisContext";

type BrainNode = {
  slug: string;
  title: string;
  folder: string;
  audience: Audience;
  degree: number;
  keywords?: string;
  priceLabel?: string;
  unitLabel?: string;
  barcode?: string | null;
  imageUrl?: string | null;
  pos?: [number, number, number];
};

type Props = {
  nodes: BrainNode[];
  links: [number, number][];
  rels?: RelationType[];
  children?: ReactNode;
};

type Scene3D = {
  select(i: number): void;
  emphasize(set: Set<number> | null): void;
  pulse(indices: number[]): void;
  reset(): void;
  spin(on: boolean): void;
};

const R = new THREE.Vector3(6.4, 4.9, 7.6);
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function dotTexture() {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

function shellGeometry(count: number) {
  const rand = rng(7);
  const arr = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = rand() * 2 - 1;
    const th = rand() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const x = s * Math.cos(th);
    const z = s * Math.sin(th);
    const y = u < -0.4 ? -0.4 + (u + 0.4) * 0.5 : u;
    const fold = 1 + 0.05 * Math.sin(9 * x + 3 * y) * Math.cos(8 * z - 2 * y) + 0.03 * Math.sin(17 * y + 5 * z);
    const depth = 0.92 + rand() * 0.08;
    arr.set([x * R.x * fold * depth + Math.sign(x) * 0.35, y * R.y * fold * depth + 0.3, z * R.z * fold * depth], i * 3);
  }
  return new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(arr, 3));
}

function setLines(line: THREE.LineSegments, pts: THREE.Vector3[]) {
  line.geometry.dispose();
  line.geometry = new THREE.BufferGeometry().setFromPoints(pts);
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const easeOutCubic = (k: number) => 1 - (1 - k) ** 3;
const easeOutBack = (k: number) => 1 + 2.70158 * (k - 1) ** 3 + 1.70158 * (k - 1) ** 2;

export function CountUp({ to, delay = 450 }: { to: number; delay?: number }) {
  const [n, setN] = useState(to);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t0 = performance.now() + delay;
    let f = 0;
    const tick = (now: number) => {
      const k = clamp01((now - t0) / 1400);
      setN(Math.round(to * easeOutCubic(k)));
      if (k < 1) f = requestAnimationFrame(tick);
    };
    f = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(f);
  }, [to, delay]);
  return <>{n.toLocaleString("th-TH")}</>;
}

export default function Brain3D({ nodes, links, rels, children }: Props) {
  const { askNongTee } = useJavis();
  const mount = useRef<HTMLDivElement>(null);
  const tip = useRef<HTMLDivElement>(null);
  const stream = useRef<HTMLButtonElement>(null);
  const fired = useRef(-1);
  const scene3d = useRef<Scene3D | null>(null);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<AudienceFilter>("all");
  const modeRef = useRef<AudienceFilter>("all");
  modeRef.current = mode;
  const [selected, setSelected] = useState(-1);
  const [group, setGroup] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [spinning, setSpinning] = useState(true);
  const [mcpLogs, setMcpLogs] = useState<McpCallEvent[]>([]);
  const [termOpen, setTermOpen] = useState(false);
  const [termLive, setTermLive] = useState(false);
  const [testingMcp, setTestingMcp] = useState(false);
  const pickRef = useRef<(i: number) => void>(() => {});

  const slugIndex = useMemo(() => new Map(nodes.map((n, i) => [n.slug, i])), [nodes]);

  const neighbors = useMemo(() => {
    const nb = nodes.map(() => [] as { idx: number; rel: RelationType }[]);
    links.forEach(([a, b], k) => {
      const rel: RelationType = rels?.[k] ?? "related";
      nb[a].push({ idx: b, rel });
      nb[b].push({ idx: a, rel });
    });
    return nb;
  }, [nodes, links, rels]);

  const groups = useMemo(() => {
    const c = new Map<string, number>();
    nodes.forEach((n) => {
      if (matchesAudience(n.audience, mode)) c.set(n.folder, (c.get(n.folder) ?? 0) + 1);
    });
    return [...c].sort((a, b) => {
      const ia = GROUP_ORDER.indexOf(a[0]);
      const ib = GROUP_ORDER.indexOf(b[0]);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
  }, [nodes, mode]);

  const needle = q.trim().toLowerCase();
  const matches = useMemo(
    () =>
      needle
        ? nodes
            .flatMap((n, i) =>
              matchesAudience(n.audience, mode) &&
              `${n.title} ${n.slug} ${n.barcode ?? ""} ${n.keywords ?? ""}`.toLowerCase().includes(needle)
                ? [i]
                : [],
            )
            .sort((a, b) => nodes[b].degree - nodes[a].degree)
        : [],
    [nodes, needle, mode],
  );

  const visibleNeighbors = useMemo(
    () => (selected >= 0 ? neighbors[selected].filter((nb) => matchesAudience(nodes[nb.idx].audience, mode)) : []),
    [selected, neighbors, nodes, mode],
  );

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const initialMode = normalizeAudienceFilter(sp.get("mode"));
    if (initialMode !== "all") setMode(initialMode);
    const focusSlug = sp.get("focus");
    if (focusSlug) {
      const idx = slugIndex.get(focusSlug.toLowerCase());
      if (idx !== undefined) {
        setTimeout(() => pickRef.current(idx), 350);
      }
    }
  }, [slugIndex]);

  useEffect(() => {
    const el = mount.current;
    if (!el || !nodes.length) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    } catch {
      setFailed(true);
      return;
    }
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const isMobile = window.innerWidth < 768;
    renderer.setPixelRatio(Math.min(devicePixelRatio, isMobile ? 1.5 : 2));
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-label", "สมองสินค้า 3 มิติ: จุดคือเซลล์สินค้า/หมวดหมู่/หน่วยนับ เส้นคือไซแนปส์เชื่อมโยง");

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070a18);
    scene.fog = new THREE.FogExp2(0x070a18, 0.017);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 200);
    camera.position.set(0, 6, isMobile ? 48 : 42);
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(4, 6, 10);
    camera.add(sun);
    scene.add(camera, new THREE.AmbientLight(0xffffff, 1.35));
    const controls = new OrbitControls(camera, renderer.domElement);
    Object.assign(controls, {
      enableDamping: true,
      enablePan: false,
      minDistance: 5,
      maxDistance: 44,
      autoRotate: !still,
      autoRotateSpeed: 0.45,
    });

    const dot = dotTexture();
    const disposables: { dispose(): void }[] = [dot, renderer, controls];
    const add = <T extends THREE.Object3D & { geometry: THREE.BufferGeometry; material: THREE.Material }>(o: T) => {
      disposables.push(o.geometry, o.material);
      scene.add(o);
      return o;
    };
    const glow = (size: number, opacity: number, color?: number, blending: THREE.Blending = THREE.AdditiveBlending) =>
      new THREE.PointsMaterial({
        map: dot,
        size,
        transparent: true,
        opacity,
        depthWrite: false,
        blending,
        vertexColors: color === undefined,
        color: color ?? 0xffffff,
      });

    const dust = add(new THREE.Points(shellGeometry(isMobile ? 2800 : 5000), glow(0.1, still ? 0.18 : 0, 0x38bdf8)));
    const starArr = new Float32Array(700 * 3).map(() => (Math.random() - 0.5) * 90);
    const stars = add(
      new THREE.Points(new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(starArr, 3)), glow(0.12, 0.3, 0x818cf8)),
    );

    const pos = nodes.map((n) => new THREE.Vector3(n.pos?.[0] ?? 0, n.pos?.[1] ?? 0, n.pos?.[2] ?? 0));
    const colors = nodes.map((n) => new THREE.Color(groupOf(n.folder).color));
    const shown = colors.map((c) => c.clone());
    const density = Math.min(1, Math.cbrt(380 / Math.max(nodes.length, 1)));
    const baseSize = nodes.map((n) => {
      const boost = n.folder === "root" ? 2.1 : n.folder === "category" || n.folder === "unit" ? 1.3 : 1;
      return (0.09 + Math.min(n.degree, 18) * 0.011) * density * boost;
    });

    const sphereGeom = new THREE.IcosahedronGeometry(1, 1);
    const sphereMat = new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.05 });
    disposables.push(sphereGeom, sphereMat);
    const balls = new THREE.InstancedMesh(sphereGeom, sphereMat, nodes.length);
    const m = new THREE.Matrix4();
    const quat = new THREE.Quaternion();
    const s = new THREE.Vector3();
    pos.forEach((p, i) => {
      balls.setMatrixAt(i, m.compose(p, quat, s.setScalar(baseSize[i])));
      balls.setColorAt(i, colors[i]);
    });
    scene.add(balls);

    const haloCol = new THREE.BufferAttribute(new Float32Array(colors.flatMap((c) => [c.r, c.g, c.b])), 3);
    const haloGeom = new THREE.BufferGeometry().setFromPoints(pos);
    haloGeom.setAttribute("color", haloCol);
    haloGeom.computeBoundingSphere();
    const halos = add(new THREE.Points(haloGeom, glow(1.05 * density, 0.35)));

    // Render straight/curved synapse segments cleanly
    const synPts: THREE.Vector3[] = [];
    const maxDrawnLinks = isMobile ? 2600 : 4800;
    const stepLink = Math.max(1, Math.ceil(links.length / maxDrawnLinks));
    for (let li = 0; li < links.length; li += stepLink) {
      const [a, b] = links[li];
      synPts.push(pos[a], pos[b]);
    }
    const synGeom = new THREE.BufferGeometry().setFromPoints(synPts);
    const synapses = add(
      new THREE.LineSegments(synGeom, new THREE.LineBasicMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.08, depthWrite: false })),
    );

    const hiMat = new THREE.LineBasicMaterial({ color: 0xf472b6, transparent: true, opacity: 0.85 });
    disposables.push(hiMat);
    const hiLines = new THREE.LineSegments(new THREE.BufferGeometry(), hiMat);
    scene.add(hiLines);

    // Traveling sparks along synapses
    const SPARK_COUNT = Math.min(isMobile ? 20 : 40, Math.max(1, links.length));
    const sparks = Array.from({ length: SPARK_COUNT }, (_, idx) => ({
      link: (idx * 37) % Math.max(1, links.length),
      t: Math.random(),
      speed: 0.008 + Math.random() * 0.01,
      forward: Math.random() < 0.5,
    }));
    const sparkGeom = new THREE.BufferGeometry().setAttribute("position", new THREE.BufferAttribute(new Float32Array(SPARK_COUNT * 3), 3));
    const sparkPts = add(new THREE.Points(sparkGeom, glow(0.55, 0.95, 0x7ef0c8)));

    const adjacency = nodes.map(() => [] as number[]);
    links.forEach(([a, b], i) => {
      adjacency[a].push(i);
      adjacency[b].push(i);
    });

    const flash = new Float32Array(nodes.length);
    let hovered = -1;
    let picked = -1;
    let emph: Set<number> | null = null;
    const goalPos = new THREE.Vector3(0, 4, isMobile ? 27 : 22);
    const goalTarget = new THREE.Vector3();
    let flying = !still;
    const tmp = new THREE.Vector3();
    const dim = new THREE.Color();
    const WHITE = new THREE.Color(0xffffff);

    const applyEmphasis = () => {
      for (let i = 0; i < nodes.length; i++) shown[i].copy(colors[i]).multiplyScalar(!emph || emph.has(i) ? 1 : 0.12);
      synapses.material.opacity = emph ? 0.03 : 0.08;
    };

    const flyTo = (p: THREE.Vector3, dist: number) => {
      goalTarget.copy(p);
      const dir = camera.position.clone().sub(controls.target);
      if (dir.lengthSq() < 0.01) dir.set(0, 0.2, 1);
      goalPos.copy(p).add(dir.normalize().multiplyScalar(dist));
      flying = true;
    };

    scene3d.current = {
      select(i) {
        picked = i;
        if (i < 0) {
          setLines(hiLines, []);
          return;
        }
        flash[i] = 1.4;
        const pts: THREE.Vector3[] = [];
        for (const [a, b] of links) {
          if (a === i || b === i) pts.push(pos[a], pos[b]);
        }
        setLines(hiLines, pts);
        flyTo(pos[i], 8.5);
      },
      emphasize(set) {
        emph = set;
        applyEmphasis();
      },
      pulse(indices) {
        for (const idx of indices) {
          if (idx >= 0 && idx < nodes.length) flash[idx] = 1.6;
        }
      },
      reset() {
        flyTo(new THREE.Vector3(), isMobile ? 27 : 22);
      },
      spin(on) {
        controls.autoRotate = on && !still;
      },
    };

    const raycaster = new THREE.Raycaster();
    raycaster.params.Points.threshold = 0.42;
    const mouse = new THREE.Vector2(9, 9);
    let downAt = [0, 0];

    const pickHit = () => {
      raycaster.setFromCamera(mouse, camera);
      const hit = raycaster
        .intersectObject(halos)
        .find((h) => h.index !== undefined && matchesAudience(nodes[h.index].audience, modeRef.current));
      return hit?.index ?? -1;
    };

    const onMove = (e: PointerEvent) => {
      const r = renderer.domElement.getBoundingClientRect();
      mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      if (tip.current) {
        tip.current.style.left = `${Math.min(e.clientX - r.left + 14, r.width - 260)}px`;
        tip.current.style.top = `${Math.max(e.clientY - r.top - 12, 8)}px`;
      }
    };
    const onDown = (e: PointerEvent) => {
      downAt = [e.clientX, e.clientY];
      mouse.set(
        ((e.clientX - renderer.domElement.getBoundingClientRect().left) / renderer.domElement.clientWidth) * 2 - 1,
        -((e.clientY - renderer.domElement.getBoundingClientRect().top) / renderer.domElement.clientHeight) * 2 + 1,
      );
    };
    const onUp = (e: PointerEvent) => {
      if (Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) < 6) {
        const idx = pickHit();
        if (idx >= 0) pickRef.current(idx);
      }
    };
    const onStart = () => {
      flying = false;
    };
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointerup", onUp);
    controls.addEventListener("start", onStart);

    const resize = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h, false);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(el);

    let frame = 0;
    const t0 = performance.now();
    let prev = t0;
    let lastTick = 0;

    const loop = () => {
      frame = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min((now - prev) / 1000, 0.05);
      const t = (now - t0) / 1000;
      prev = now;
      const f60 = dt * 60;

      if (flying) {
        const k = 1 - 0.92 ** f60;
        camera.position.lerp(goalPos, k);
        controls.target.lerp(goalTarget, k);
        if (camera.position.distanceTo(goalPos) < 0.06) flying = false;
      }
      controls.update();

      dust.material.opacity = 0.16 * clamp01(t / 1.5);

      if (links.length > 0) {
        sparks.forEach((sp, i) => {
          sp.t += sp.speed * f60;
          if (sp.t >= 1) {
            const [a, b] = links[sp.link];
            const at = sp.forward ? b : a;
            flash[at] = 1;
            if (t - lastTick > 2.6 && stream.current && matchesAudience(nodes[at].audience, modeRef.current)) {
              lastTick = t;
              fired.current = at;
              stream.current.textContent = `${nodes[sp.forward ? a : b].title.slice(0, 32)} → ${nodes[at].title.slice(0, 32)}`;
            }
            const nextList = adjacency[at];
            const next = nextList.length ? nextList[Math.floor(Math.random() * nextList.length)] : 0;
            sp.link = next;
            sp.forward = links[sp.link][0] === at;
            sp.t = 0;
          }
          const [la, lb] = links[sp.link];
          const pa = sp.forward ? pos[la] : pos[lb];
          const pb = sp.forward ? pos[lb] : pos[la];
          tmp.lerpVectors(pa, pb, sp.t);
          sparkGeom.attributes.position.setXYZ(i, tmp.x, tmp.y, tmp.z);
        });
        sparkGeom.attributes.position.needsUpdate = true;
      }

      const h = pickHit();
      if (h !== hovered) {
        hovered = h;
        renderer.domElement.style.cursor = h >= 0 ? "pointer" : "grab";
        if (tip.current) {
          tip.current.style.opacity = h >= 0 ? "1" : "0";
          if (h >= 0) {
            const nd = nodes[h];
            tip.current.textContent = `${nd.title}${nd.priceLabel ? ` · ${nd.priceLabel}` : ""}`;
          }
        }
      }

      const decay = 0.92 ** f60;
      const introK = still ? 1 : clamp01(t / 1.2);
      const popScale = still ? 1 : easeOutBack(introK);
      for (let i = 0; i < nodes.length; i++) {
        flash[i] *= decay;
        const size = baseSize[i] * popScale * (1 + 0.65 * flash[i]) * (i === hovered || i === picked ? 1.9 : 1);
        balls.setMatrixAt(i, m.compose(pos[i], quat, s.setScalar(size)));
        dim.copy(shown[i]).lerp(WHITE, emph && !emph.has(i) ? 0 : flash[i] * 0.7);
        balls.setColorAt(i, dim);
        haloCol.setXYZ(i, dim.r, dim.g, dim.b);
      }
      balls.instanceMatrix.needsUpdate = true;
      if (balls.instanceColor) balls.instanceColor.needsUpdate = true;
      haloCol.needsUpdate = true;
      stars.rotation.y = t * 0.008;
      renderer.render(scene, camera);
    };
    loop();

    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      scene3d.current = null;
      renderer.domElement.removeEventListener("pointermove", onMove);
      renderer.domElement.removeEventListener("pointerdown", onDown);
      renderer.domElement.removeEventListener("pointerup", onUp);
      controls.removeEventListener("start", onStart);
      disposables.forEach((d) => d.dispose());
      hiLines.geometry.dispose();
      renderer.domElement.remove();
    };
  }, [nodes, links]);

  useEffect(() => {
    const modeMatch = (i: number) => matchesAudience(nodes[i].audience, mode);
    const set =
      selected >= 0
        ? new Set([selected, ...visibleNeighbors.map((nb) => nb.idx)])
        : needle
          ? new Set(matches)
          : group
            ? new Set(nodes.flatMap((n, i) => (n.folder === group && modeMatch(i) ? [i] : [])))
            : mode !== "all"
              ? new Set(nodes.flatMap((_, i) => (modeMatch(i) ? [i] : [])))
              : null;
    scene3d.current?.emphasize(set);
  }, [selected, visibleNeighbors, needle, matches, group, mode, nodes]);

  useEffect(() => scene3d.current?.select(selected), [selected]);
  useEffect(() => scene3d.current?.spin(spinning && selected < 0), [spinning, selected]);

  // Live MCP & Nong Tee pulse events
  useEffect(() => {
    const es = new EventSource("/mcp/events");
    es.onopen = () => setTermLive(true);
    es.onerror = () => setTermLive(false);
    es.addEventListener("snapshot", (msg) => {
      try {
        const list = JSON.parse((msg as MessageEvent<string>).data) as McpCallEvent[];
        if (Array.isArray(list)) setMcpLogs(list.slice(-20));
      } catch {
        // ignore
      }
    });
    es.addEventListener("mcp", (msg) => {
      try {
        const ev = JSON.parse((msg as MessageEvent<string>).data) as McpCallEvent;
        setMcpLogs((prev) => [...prev.filter((x) => x.id !== ev.id), ev].slice(-20));
        const hitIndices = ev.hits
          .map((h) => slugIndex.get(h.slug))
          .filter((idx): idx is number => idx !== undefined);
        if (hitIndices.length) {
          scene3d.current?.pulse(hitIndices);
          fired.current = hitIndices[0];
          if (stream.current) {
            stream.current.textContent = `⚡ ค้นสมอง: ${ev.hits[0]?.title ?? ev.arg}`;
          }
        }
      } catch {
        // ignore
      }
    });
    return () => es.close();
  }, [slugIndex]);

  const pick = (i: number) => {
    if (i >= 0 && !matchesAudience(nodes[i].audience, mode)) setMode("all");
    setSelected(i);
    setQ("");
  };
  pickRef.current = pick;

  const reset = () => {
    setSelected(-1);
    setGroup(null);
    setQ("");
    setMode("all");
    scene3d.current?.reset();
  };

  const triggerSampleMcp = async () => {
    if (testingMcp) return;
    setTestingMcp(true);
    try {
      await fetch("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method: "tools/call",
          params: { name: "ask_brain", arguments: { question: "น้ำจิ้มไก่ ไม่ใส่ผงชูรส ขวด", audience: "user" } },
        }),
      });
    } finally {
      setTestingMcp(false);
    }
  };

  const sel = selected >= 0 ? nodes[selected] : null;

  return (
    <>
      <div className="brain" ref={mount}>
        <div className="brain-tip" ref={tip} aria-live="polite" />
        {failed && <p className="brain-fallback">อุปกรณ์นี้ไม่รองรับ WebGL — กดปุ่มค้นหาสินค้าละเอียดด้านบนได้เลยค่ะ</p>}
      </div>

      <section className="hero">
        {children}

        <div className="mode-switch" role="group" aria-label="เลือกโซนสมอง">
          {MODE_OPTIONS.map(([m, label]) => (
            <button
              key={m}
              type="button"
              className="mode-btn"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="actions">
          <button
            type="button"
            className="btn primary btn-hero-javis"
            onClick={() => askNongTee()}
          >
            🧑‍💼 คุยสดกับน้องตี๋ (Javis)
          </button>
          <Link className="btn" href="/search">
            🔎 ค้นหาสินค้าเต็มจอ
          </Link>
          <Link className="btn hide-xs" href="/n">
            📚 สารบัญ
          </Link>
        </div>

        <form
          className="brain-search"
          role="search"
          action="/search"
          onSubmit={(e) => {
            if (matches.length) {
              e.preventDefault();
              pick(matches[0]);
            }
          }}
        >
          <input
            type="search"
            name="q"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoComplete="off"
            placeholder="ค้นเซลล์ในสมอง เช่น น้ำจิ้ม, ฮาลาล, ไม่ใส่ผงชูรส, ขวด, ลัง…"
            aria-label="ค้นหาเซลล์ในสมองสินค้า"
          />
          {needle && (
            <ul className="brain-suggest">
              {matches.slice(0, 6).map((i) => (
                <li key={i}>
                  <button type="button" onClick={() => pick(i)}>
                    <i className="dot" style={{ color: groupOf(nodes[i].folder).color }} />
                    <span className="brain-nb-label">{nodes[i].title}</span>
                    {nodes[i].priceLabel && <small className="sug-price">{nodes[i].priceLabel}</small>}
                  </button>
                </li>
              ))}
              <li>
                <Link href={`/search?q=${encodeURIComponent(q.trim())}`}>
                  🔎 ค้นในคลังสินค้าทั้งหมด 6,300+ รายการ “{q.trim()}” →
                </Link>
              </li>
            </ul>
          )}
        </form>
      </section>

      {/* Selected Neuron Card (Product / Category / Unit / Trait / Family) */}
      {sel && (
        <aside className="brain-card" aria-label="รายละเอียดเซลล์สมอง" key={selected}>
          <button className="brain-x" onClick={() => setSelected(-1)} aria-label="ปิด">
            ×
          </button>
          <p className="brain-card-group" style={{ color: groupOf(sel.folder).color }}>
            <i className="dot" />
            <span>{groupOf(sel.folder).label}</span>
            <span className={`chip zone zone-${sel.audience}`}>{ZONE_LABEL[sel.audience]}</span>
          </p>

          {sel.imageUrl && (
            <div className="bc-img-box">
              <img src={sel.imageUrl} alt={sel.title} loading="lazy" />
            </div>
          )}

          <h2>{sel.title}</h2>

          {(sel.priceLabel || sel.unitLabel || sel.barcode) && (
            <div className="bc-meta-pills">
              {sel.priceLabel && <strong className="bc-price">{sel.priceLabel}</strong>}
              {sel.unitLabel && <span className="chip">{sel.unitLabel}</span>}
              {sel.barcode && <code className="bc-code">#{sel.barcode}</code>}
            </div>
          )}

          <div className="bc-card-btns">
            <Link className="btn primary bc-btn" href={`/n/${encodeURIComponent(sel.slug)}`}>
              อ่านข้อมูลเต็ม →
            </Link>
            <button
              type="button"
              className="btn bc-btn"
              onClick={() =>
                askNongTee(
                  `ตี๋ ช่วยดูเซลล์ "${sel.title}" และหาสินค้าที่เกี่ยวข้องหรือคุ้มค่าในกลุ่มเดียวกันให้หน่อยครับ`,
                )
              }
            >
              🧑‍💼 ถามน้องตี๋
            </button>
          </div>

          {visibleNeighbors.length > 0 && (
            <>
              <h3>เชื่อมไซแนปส์ {visibleNeighbors.length} จุด — แตะเพื่อเดินสมองต่อ</h3>
              <ul>
                {visibleNeighbors.slice(0, 24).map(({ idx: j, rel }, n) => (
                  <li key={`${j}-${rel}`} style={{ "--i": n } as CSSProperties}>
                    <button type="button" onClick={() => setSelected(j)}>
                      <i className="dot" style={{ color: groupOf(nodes[j].folder).color }} />
                      <span className="brain-nb-label">{nodes[j].title}</span>
                      <span className="chip rel">{RELATION_LABEL[rel]}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>
      )}

      {/* Live MCP / Swarm Activity Terminal */}
      {termOpen && (
        <aside className="mcp-term" aria-label="บันทึกการวิ่งของไซแนปส์แบบสด">
          <div className="mcp-term-head">
            <div className="mcp-term-title">
              <span className="mcp-dots" aria-hidden="true">
                <i className="d-red" />
                <i className="d-amber" />
                <i className="d-green" />
              </span>
              <b>BRAIN LIVE</b>
              <span className={`mcp-status${termLive ? " online" : ""}`}>
                {termLive ? "ออนไลน์" : "กำลังเชื่อม…"}
              </span>
            </div>
            <div className="mcp-term-actions">
              <button type="button" className="mcp-mini-btn" onClick={triggerSampleMcp} disabled={testingMcp}>
                {testingMcp ? "กำลังยิง…" : "ทดสอบค้น"}
              </button>
              <button type="button" className="mcp-mini-btn" onClick={() => setMcpLogs([])}>
                ล้าง
              </button>
              <button type="button" className="mcp-mini-btn" onClick={() => setTermOpen(false)}>
                ✕
              </button>
            </div>
          </div>
          <div className="mcp-term-body">
            {mcpLogs.length === 0 ? (
              <p className="mcp-empty">
                <span className="mcp-prompt">$</span> รอสัญญาณค้นสมองจากน้องตี๋หรือ MCP `/mcp`…
              </p>
            ) : (
              mcpLogs.map((ev) => (
                <div className="mcp-entry" key={ev.id}>
                  <div className="mcp-cmd">
                    <span className="mcp-time">{ev.time}</span>
                    <code className="mcp-tool">{ev.tool}</code>
                    <span className="mcp-arg">&ldquo;{ev.arg}&rdquo;</span>
                    <span className="mcp-ms">{ev.ms}ms</span>
                  </div>
                  <div className="mcp-out">
                    <span className="mcp-arrow">↳</span>
                    <span className="mcp-found">พบ {ev.totalHits} รายการ</span>
                    {ev.hits.slice(0, 3).map((h) => {
                      const idx = slugIndex.get(h.slug);
                      return (
                        <button
                          key={h.slug}
                          type="button"
                          className="mcp-hit-btn"
                          style={{ color: groupOf(h.folder).color }}
                          onClick={() => idx !== undefined && pickRef.current(idx)}
                        >
                          <i className="dot" />
                          <span>{h.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>
      )}

      <div className="brain-ctrl">
        <button
          type="button"
          className={`btn mcp-toggle${termOpen ? " is-open" : ""}`}
          aria-pressed={termOpen}
          onClick={() => setTermOpen((v) => !v)}
        >
          <i className={`mcp-led${termLive ? " on" : ""}`} />
          <span>สัญญาณสมอง</span>
          {mcpLogs.length > 0 && <span className="mcp-count">{mcpLogs.length}</span>}
        </button>
        <button type="button" className="btn" onClick={() => setSpinning(!spinning)}>
          {spinning ? "หยุดหมุน" : "หมุนต่อ"}
        </button>
        <button type="button" className="btn" onClick={reset}>
          มุมเริ่มต้น
        </button>
      </div>

      <div className="brain-bottom">
        <button
          type="button"
          className="brain-stream"
          ref={stream}
          onClick={() => fired.current >= 0 && pick(fired.current)}
        />
        <div className="brain-groups" role="group" aria-label="กรองตามกลุ่มเซลล์สมอง">
          {groups.map(([f, n], idx) => (
            <button
              key={f}
              type="button"
              aria-pressed={group === f}
              style={{ color: groupOf(f).color, "--i": idx } as CSSProperties}
              onClick={() => {
                setSelected(-1);
                setGroup(group === f ? null : f);
              }}
            >
              <i className="dot" />
              <b>{groupOf(f).shortLabel}</b>
              <span>{n}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
