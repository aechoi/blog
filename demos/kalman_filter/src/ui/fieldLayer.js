import { fieldAt } from "../models.js";
import { COLORS } from "./canvas.js";

// The flow visualisation behind the state plot: particles advected by
// the same continuous-time F the filter discretises, so the streaks are
// the actual flow that A advances the state along.

function rk4(model, p, h) {
  const k1 = fieldAt(model, p[0], p[1]);
  const k2 = fieldAt(model, p[0] + (h / 2) * k1[0], p[1] + (h / 2) * k1[1]);
  const k3 = fieldAt(model, p[0] + (h / 2) * k2[0], p[1] + (h / 2) * k2[1]);
  const k4 = fieldAt(model, p[0] + h * k3[0], p[1] + h * k3[1]);
  return [
    p[0] + (h / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]),
    p[1] + (h / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]),
  ];
}

const TRAIL_LENGTH = 9;

// Particles are seeded across a region larger than the viewport, and
// culled across a larger one still.
//
// Seeding inside the viewport alone leaves the edges and corners
// visibly bare. Every one of these flows transports particles, so the
// region is not in equilibrium under uniform reseeding: for an inward
// flow the corners drain toward the centre and nothing arrives from
// outside to replace them, because there IS no outside. Seeding beyond
// the frame gives the border something to flow in from, and the
// on-screen density evens out. The cull margin sits outside the spawn
// margin so a particle that drifts just off-frame is not immediately
// killed and respawned.
const SPAWN_MARGIN = 0.35; // fraction of viewport size added on each side
const CULL_MARGIN = 0.6;

function pad(bounds, m) {
  const w = bounds.x1 - bounds.x0;
  const h = bounds.y1 - bounds.y0;
  return {
    x0: bounds.x0 - w * m,
    x1: bounds.x1 + w * m,
    y0: bounds.y0 - h * m,
    y1: bounds.y1 + h * m,
  };
}

// Opacity levels the per-particle birth/death fade is quantised to for
// batching. Six is enough that the steps are invisible against a fade
// that already only spans a fraction of a second.
const FADE_BUCKETS = 6;

// `count` is scaled by the spawn region's area, (1 + 2*margin)^2 times
// the viewport, since only a fraction of the population is on screen at
// any moment.
//
// That fraction is NOT simply 1/(1+2*margin)^2, and measuring it is the
// only way to know: the flow itself redistributes the population, so a
// contracting model ends up drawing roughly twice the on-screen ink of
// an area-preserving one from the same particle count. Measured at this
// count and viewport: ~11k segments/frame for the stable spiral, ~8k
// for the centre, ~7k for the saddle, in ~1.6 ms of JS.
export function createParticleField(count = Math.round(620 * (1 + 2 * SPAWN_MARGIN) ** 2)) {
  let particles = [];
  // Reused across frames: rebuilding these every frame would churn a
  // few thousand array allocations per second for no benefit.
  const groups = Array.from({ length: TRAIL_LENGTH * FADE_BUCKETS }, () => []);

  function spawn(region, seeded) {
    const p = [
      region.x0 + Math.random() * (region.x1 - region.x0),
      region.y0 + Math.random() * (region.y1 - region.y0),
    ];
    return {
      p,
      // A trail of past positions, not just the previous one. Drawing
      // only the last frame's segment renders each particle as an
      // isolated dash whose length encodes speed — which reads as
      // scattered noise rather than as flow. The polyline through
      // several frames is what actually looks like a streamline.
      trail: [p],
      // Staggering the initial ages stops every particle from being
      // born and dying on the same frame, which reads as a distracting
      // global flicker rather than a steady flow.
      age: seeded ? Math.random() * 3 : 0,
      life: 2.2 + Math.random() * 2.6,
    };
  }

  return {
    reset() {
      particles = [];
    },
    step(model, bounds, dt) {
      const spawnRegion = pad(bounds, SPAWN_MARGIN);
      const cullRegion = pad(bounds, CULL_MARGIN);
      if (particles.length !== count) {
        particles = Array.from({ length: count }, () => spawn(spawnRegion, true));
      }
      // A large dt (tab was backgrounded, or a slow first frame) would
      // let RK4 leap a particle clean across the field; cap it so the
      // flow resumes smoothly instead of scattering.
      const h = Math.min(dt, 1 / 30);
      for (let i = 0; i < particles.length; i++) {
        const q = particles[i];
        q.p = rk4(model, q.p, h);
        q.trail.push(q.p);
        if (q.trail.length > TRAIL_LENGTH) q.trail.shift();
        q.age += h;
        const out =
          q.p[0] < cullRegion.x0 ||
          q.p[0] > cullRegion.x1 ||
          q.p[1] < cullRegion.y0 ||
          q.p[1] > cullRegion.y1;
        if (out || q.age > q.life || !Number.isFinite(q.p[0]) || !Number.isFinite(q.p[1])) {
          particles[i] = spawn(spawnRegion, false);
        }
      }
    },
    draw(ctx, tf, bounds) {
      // Most particles are off-frame by design (see SPAWN_MARGIN), so
      // skip them rather than issuing canvas calls that clip to nothing.
      const visible = pad(bounds, 0.06);

      // Segments are batched by (trail slot, opacity bucket) instead of
      // being stroked one at a time.
      //
      // A stroke() per segment meant ~7000 canvas calls per frame, since
      // every segment wants its own globalAlpha and lineWidth. But those
      // two values only depend on the slot (fixed set) and the
      // particle's fade (continuous, though indistinguishable once
      // quantised), so the whole field collapses to a fixed
      // SLOTS x BUCKETS grid of paths -- around 50 stroke calls total,
      // whatever the particle count. That is what makes seeding well
      // outside the viewport affordable.
      for (const group of groups) group.length = 0;

      for (const q of particles) {
        if (q.trail.length < 2) continue;
        if (
          q.p[0] < visible.x0 ||
          q.p[0] > visible.x1 ||
          q.p[1] < visible.y0 ||
          q.p[1] > visible.y1
        ) {
          continue;
        }
        // Fade in at birth and out at death so respawns are invisible.
        const t = q.age / q.life;
        const fade = Math.min(1, t * 6) * Math.min(1, (1 - t) * 3.5);
        if (fade <= 0.02) continue;
        const bucket = Math.min(FADE_BUCKETS - 1, Math.floor(fade * FADE_BUCKETS));

        for (let i = 1; i < q.trail.length; i++) {
          const a = tf.toScreen(q.trail[i - 1]);
          const b = tf.toScreen(q.trail[i]);
          const g = groups[i * FADE_BUCKETS + bucket];
          g.push(a[0], a[1], b[0], b[1]);
        }
      }

      ctx.save();
      ctx.lineCap = "round";
      ctx.strokeStyle = COLORS.field;
      for (let i = 1; i < TRAIL_LENGTH; i++) {
        // Segments nearer the head are wider and more opaque, which is
        // what gives each streak a readable direction.
        const along = i / TRAIL_LENGTH;
        ctx.lineWidth = 0.9 + 1.3 * along;
        for (let b = 0; b < FADE_BUCKETS; b++) {
          const g = groups[i * FADE_BUCKETS + b];
          if (g.length === 0) continue;
          ctx.globalAlpha = ((b + 0.5) / FADE_BUCKETS) * along ** 1.6;
          ctx.beginPath();
          for (let j = 0; j < g.length; j += 4) {
            ctx.moveTo(g[j], g[j + 1]);
            ctx.lineTo(g[j + 2], g[j + 3]);
          }
          ctx.stroke();
        }
      }
      ctx.restore();
    },
  };
}
