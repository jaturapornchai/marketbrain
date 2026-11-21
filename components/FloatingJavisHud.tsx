"use client";

import { useEffect, useRef } from "react";

export type FloatingHudState = "idle" | "listening" | "searching" | "thinking" | "speaking" | "error";

type FloatingJavisHudProps = {
  state: FloatingHudState;
  /** True when the live mic call is active and not muted. */
  micLive: boolean;
  /** Ref providing current mic RMS (0..1) while listening. */
  userLevelRef: React.MutableRefObject<number>;
  /** Ref returning current bot voice level (0..1) while speaking. */
  botLevelGetterRef: React.MutableRefObject<() => number>;
  /** Incremented or changed whenever a new team job runs to add a colored orbiting dot. */
  satelliteEvent?: { id: string; color: string } | null;
  /** Single click (without drag) toggles live voice / mute. */
  onClickToggle?: () => void;
};

const LABEL: Record<FloatingHudState, string> = {
  idle: "พร้อมคุย",
  listening: "กำลังฟัง…",
  searching: "กำลังคิด…",
  thinking: "กำลังคิด…",
  speaking: "กำลังพูด…",
  error: "ลองใหม่",
};

const SPIN: Record<FloatingHudState, number> = {
  idle: 0.15,
  listening: 0.3,
  searching: 1.2,
  thinking: 1.2,
  speaking: 0.5,
  error: 0.15,
};

const RATE = [8, -14, 26]; // degrees/sec at rest, alternating directions (same as bctest01 HUD)

// Default orbiting satellites representing Nong Tee's core workers (orange brain + pink decimal calc)
const INITIAL_SATS: Array<{ color: string; a: number; sp: number }> = [
  { color: "#fb923c", a: -1.42, sp: 0.38 },
  { color: "#fb923c", a: -1.16, sp: 0.44 },
  { color: "#fb923c", a: -2.42, sp: 0.34 },
  { color: "#fb923c", a: 3.05, sp: 0.41 },
  { color: "#fb923c", a: -0.48, sp: 0.36 },
  { color: "#e879f9", a: 0.56, sp: 0.48 },
];

export default function FloatingJavisHud({
  state,
  micLive,
  userLevelRef,
  botLevelGetterRef,
  satelliteEvent,
  onClickToggle,
}: FloatingJavisHudProps) {
  const hudRef = useRef<HTMLDivElement>(null);
  const r1Ref = useRef<SVGGElement>(null);
  const r2Ref = useRef<SVGGElement>(null);
  const r3Ref = useRef<SVGGElement>(null);
  const coreRef = useRef<SVGCircleElement>(null);
  const pingRef = useRef<SVGCircleElement>(null);
  const satsRef = useRef<SVGGElement>(null);

  const effectiveState: FloatingHudState = state === "listening" && !micLive ? "idle" : state;
  const stateRef = useRef<FloatingHudState>(effectiveState);
  const pulseRef = useRef(0);
  const satsListRef = useRef<Array<{ c: SVGCircleElement; a: number; sp: number }>>([]);
  const customPosRef = useRef<{ x: number; y: number; s: number } | null>(null);
  const onClickRef = useRef(onClickToggle);
  onClickRef.current = onClickToggle;

  // Trigger pulse ring on every state change
  useEffect(() => {
    if (stateRef.current !== effectiveState) {
      pulseRef.current = Math.max(pulseRef.current, 0.65);
    }
    stateRef.current = effectiveState;
  }, [effectiveState]);

  // Add a colored satellite dot on the outer ring when a worker job runs
  useEffect(() => {
    if (!satelliteEvent || !satsRef.current) return;
    const ns = "http://www.w3.org/2000/svg";
    const c = document.createElementNS(ns, "circle");
    c.setAttribute("r", "5.5");
    c.setAttribute("fill", satelliteEvent.color);
    satsRef.current.appendChild(c);
    satsListRef.current.push({ c, a: Math.random() * Math.PI * 2, sp: 0.45 + Math.random() * 0.55 });
    while (satsListRef.current.length > 6) {
      satsListRef.current.shift()?.c.remove();
    }
  }, [satelliteEvent]);

  // Main animation loop + initial satellites + drag / resize / double-click reset
  useEffect(() => {
    const hud = hudRef.current;
    const satsGroup = satsRef.current;
    if (!hud || !satsGroup) return;

    // Seed initial glowing dots so the HUD matches the signature Javis ring from first paint
    const ns = "http://www.w3.org/2000/svg";
    satsGroup.replaceChildren();
    satsListRef.current = INITIAL_SATS.map((seed) => {
      const c = document.createElementNS(ns, "circle");
      c.setAttribute("r", "5.5");
      c.setAttribute("fill", seed.color);
      c.setAttribute("cx", (Math.cos(seed.a) * 88).toFixed(1));
      c.setAttribute("cy", (Math.sin(seed.a) * 88).toFixed(1));
      satsGroup.appendChild(c);
      return { c, a: seed.a, sp: seed.sp };
    });

    const placeHud = (p: { x: number; y: number; s: number }) => {
      const s = Math.max(64, Math.min(p.s, 480, window.innerWidth, window.innerHeight - 48));
      const x = Math.max(0, Math.min(p.x, window.innerWidth - s));
      const y = Math.max(46, Math.min(p.y, window.innerHeight - s));
      hud.style.left = `${x}px`;
      hud.style.right = "auto";
      hud.style.top = `${y}px`;
      hud.style.bottom = "auto";
      hud.style.width = `${s}px`;
      return { x, y, s };
    };

    const onResize = () => {
      if (customPosRef.current) customPosRef.current = placeHud(customPosRef.current);
    };
    window.addEventListener("resize", onResize);

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const r = hud.getBoundingClientRect();
      const x0 = e.clientX;
      const y0 = e.clientY;
      const grip = (e.target as HTMLElement | null)?.classList.contains("jv-float-grip") ?? false;
      let moved = false;
      let at: { x: number; y: number; s: number } | null = null;
      hud.setPointerCapture(e.pointerId);
      hud.classList.add("drag");

      const onMove = (m: PointerEvent) => {
        const dx = m.clientX - x0;
        const dy = m.clientY - y0;
        if (!moved && Math.hypot(dx, dy) < 5) return;
        moved = true;
        at = placeHud(grip ? { x: r.left, y: r.top, s: r.width + Math.max(dx, dy) } : { x: r.left + dx, y: r.top + dy, s: r.width });
      };
      const onUp = () => {
        hud.removeEventListener("pointermove", onMove);
        hud.removeEventListener("pointerup", onUp);
        hud.removeEventListener("pointercancel", onUp);
        hud.classList.remove("drag");
        if (at) customPosRef.current = at;
        else if (!moved && !grip) onClickRef.current?.();
      };
      hud.addEventListener("pointermove", onMove);
      hud.addEventListener("pointerup", onUp);
      hud.addEventListener("pointercancel", onUp);
    };

    const onDblClick = () => {
      customPosRef.current = null;
      hud.removeAttribute("style");
    };

    hud.addEventListener("pointerdown", onPointerDown);
    hud.addEventListener("dblclick", onDblClick);

    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const rings = [r1Ref.current, r2Ref.current, r3Ref.current];
    const turn = [0, 0, 0];
    let amp = 0;
    let spin = 0.15;
    let last = performance.now();
    let rafId = 0;

    const frame = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const st = stateRef.current;
      spin += (SPIN[st] - spin) * Math.min(1, dt * 3);
      const target =
        st === "listening"
          ? userLevelRef.current
          : st === "speaking"
            ? botLevelGetterRef.current()
            : st === "idle"
              ? 0.03
              : 0.12;
      amp += (Math.min(1, target * 2.5) - amp) * Math.min(1, dt * 10);

      if (!still) {
        rings.forEach((g, i) => {
          if (!g) return;
          turn[i] = (turn[i] + dt * RATE[i] * (1 + spin * 3)) % 360;
          g.setAttribute("transform", `rotate(${turn[i].toFixed(2)})`);
        });
      }
      if (coreRef.current) {
        coreRef.current.setAttribute("transform", `scale(${(1 + amp * 0.18).toFixed(3)})`);
        coreRef.current.style.opacity = String(0.55 + amp * 0.45);
      }
      pulseRef.current = Math.max(0, pulseRef.current - dt * 1.5);
      if (pingRef.current) {
        pingRef.current.setAttribute("transform", `scale(${(1 + (1 - pulseRef.current) * 0.75).toFixed(3)})`);
        pingRef.current.style.opacity = String(pulseRef.current);
      }
      if (!still) {
        for (const s of satsListRef.current) {
          s.a += dt * s.sp * (1 + spin);
          s.c.setAttribute("cx", (Math.cos(s.a) * 88).toFixed(1));
          s.c.setAttribute("cy", (Math.sin(s.a) * 88).toFixed(1));
        }
      }
      rafId = window.requestAnimationFrame(frame);
    };
    rafId = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener("resize", onResize);
      hud.removeEventListener("pointerdown", onPointerDown);
      hud.removeEventListener("dblclick", onDblClick);
    };
  }, [userLevelRef, botLevelGetterRef]);

  return (
    <div
      ref={hudRef}
      className="jv-float-hud"
      data-s={effectiveState}
      role="button"
      tabIndex={0}
      aria-label={`น้องตี๋: ${LABEL[effectiveState]} — กดเพื่อเปิดหรือปิดไมค์ ลากเพื่อย้าย`}
      title="กดเพื่อเปิด/ปิดไมค์ · ลากเพื่อย้าย · ลากมุมขวาล่างเพื่อย่อขยาย · ดับเบิลคลิกเพื่อคืนที่เดิม"
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClickToggle?.();
        }
      }}
    >
      <svg viewBox="-100 -100 200 200" fill="none" stroke="currentColor" aria-hidden="true">
        <g ref={r1Ref}>
          <circle r="97" strokeWidth="5" strokeDasharray="0.8 4.28" opacity=".45" />
          <circle r="96" strokeWidth="9" strokeDasharray="1 24.13" opacity=".9" />
        </g>
        <g ref={r2Ref}>
          <circle r="88" strokeWidth="3" strokeDasharray="60 8 20 8 110 30 14 8 90 40 30 8 128 11" opacity=".85" />
        </g>
        <g ref={r3Ref}>
          <circle r="77" strokeWidth="1.5" strokeDasharray="300 184" />
          <circle r="77" strokeWidth="6" strokeDasharray="2 3.4 2 3.4 2 3.4 2 467" opacity=".9" />
        </g>
        <circle r="69" strokeWidth="6" strokeDasharray="2 3.42" opacity=".25" />
        <circle ref={coreRef} r="56" strokeWidth="3" />
        <circle ref={pingRef} r="56" strokeWidth="2" opacity="0" />
        <g ref={satsRef} stroke="none" />
      </svg>
      <div className="jv-float-pill" role="status" aria-live="polite">
        {LABEL[effectiveState]}
      </div>
      <i className="jv-float-grip" aria-hidden="true" />
    </div>
  );
}
