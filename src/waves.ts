// Directional wave field built from real deep-water linear wave theory.
//
// The ocean is a sum of sinusoidal components. Each swell system contributes a
// narrow band of frequencies around its peak period rather than a single sine,
// which is what makes wave *groups* (sets) appear: nearby frequencies beat
// against each other and the resulting envelope travels at the group velocity.
//
// In deep water:
//   omega^2 = g*k          (dispersion)
//   c  = omega/k = g*T/2pi (phase speed — how fast an individual crest moves)
//   cg = domega/dk = c/2   (group speed — how fast the set moves)
//
// Because cg is half of c, crests are born at the back of a set, march forward
// through it, and die off the front. That is the behaviour a downwind foiler is
// reading when they pick a line, so it is modelled directly rather than faked.

import * as THREE from 'three';

export const GRAVITY = 9.81;

// Upper bound on components; the shader declares fixed-size uniform arrays.
export const MAX_COMPONENTS = 48;

// Gerstner waves self-intersect (fold over into loops) once the summed
// steepness a*k approaches 1. Amplitudes are scaled down globally to stay below
// this, which keeps big-swell settings from turning the surface inside out.
const MAX_TOTAL_STEEPNESS = 0.85;

export interface SwellSpec {
    name: string;
    enabled: boolean;
    /** Significant wave height Hs, metres (average of the highest third). */
    height: number;
    /** Peak period Tp, seconds. */
    period: number;
    /** Direction the waves travel TOWARD, degrees. 0 = +Z (downwind), 90 = +X. */
    direction: number;
    /** Directional spread half-width, degrees. */
    spread: number;
    /** Number of spectral components. More = smoother, less repetitive sets. */
    components: number;
    /** Relative frequency half-width. 0.05 => periods span Tp*(1 +/- 5%). */
    bandwidth: number;
}

export interface WaveComponent {
    dx: number;
    dz: number;
    /** Amplitude, metres (crest height above mean for this component alone). */
    amp: number;
    /** Wavenumber, rad/m. */
    k: number;
    /** Angular frequency, rad/s. */
    omega: number;
    /** Random phase offset, rad. */
    phase: number;
    /** Index of the parent swell in the spec array. */
    swell: number;
}

/** Per-swell values derived from the spec, for HUD readouts. */
export interface SwellDerived {
    /** Peak wavelength, metres. */
    wavelength: number;
    /** Phase speed of individual crests, m/s. */
    phaseSpeed: number;
    /** Speed the set travels at, m/s. Always half the phase speed. */
    groupSpeed: number;
    /** Approximate along-direction length of one set, metres. */
    groupLength: number;
    /** Unit direction the swell travels toward. */
    dirX: number;
    dirZ: number;
}

export interface WaveField {
    components: WaveComponent[];
    derived: SwellDerived[];
    /** Index of the component used as the carrier for each swell's envelope. */
    carrier: number[];
    /** Global amplitude scale applied to respect MAX_TOTAL_STEEPNESS (<= 1). */
    steepnessScale: number;
}

/**
 * Deterministic RNG. The wave field must be reproducible from its spec alone so
 * that two players racing the same conditions get the same ocean.
 */
function makeRng(seed: number) {
    let s = seed >>> 0;
    return () => {
        // xorshift32
        s ^= s << 13; s >>>= 0;
        s ^= s >> 17;
        s ^= s << 5; s >>>= 0;
        return s / 0xffffffff;
    };
}

export function periodToWavelength(period: number): number {
    return (GRAVITY * period * period) / (2 * Math.PI);
}

export function periodToPhaseSpeed(period: number): number {
    return (GRAVITY * period) / (2 * Math.PI);
}

/**
 * Expand swell specs into individual sinusoidal components.
 *
 * Each swell gets `components` sinusoids spread across a frequency band and a
 * directional fan. Amplitudes follow a Gaussian weighting across the band and
 * are normalised so the swell's total variance matches the requested Hs:
 *   m0 = sum(a^2 / 2),  Hs = 4*sqrt(m0)  =>  sum(a^2) = Hs^2 / 8
 */
export function buildWaveField(swells: SwellSpec[], seed = 1337): WaveField {
    const rng = makeRng(seed);
    const components: WaveComponent[] = [];
    const derived: SwellDerived[] = [];
    const carrier: number[] = [];

    for (let si = 0; si < swells.length; si++) {
        const s = swells[si];
        const dirRad = THREE.MathUtils.degToRad(s.direction);
        const baseDx = Math.sin(dirRad);
        const baseDz = Math.cos(dirRad);

        derived.push({
            wavelength: periodToWavelength(s.period),
            phaseSpeed: periodToPhaseSpeed(s.period),
            groupSpeed: periodToPhaseSpeed(s.period) / 2,
            // Band half-width b spans omega*(1 +/- b) => dk_total = 4*b*k, so the
            // beat length is 2*pi/dk_total = wavelength / (4*b).
            groupLength: s.bandwidth > 1e-4
                ? periodToWavelength(s.period) / (4 * s.bandwidth)
                : Infinity,
            dirX: baseDx,
            dirZ: baseDz,
        });
        carrier.push(-1);

        if (!s.enabled || s.height <= 0 || s.components < 1) continue;

        const n = Math.max(1, Math.floor(s.components));
        const raw: WaveComponent[] = [];
        let weightSq = 0;
        let peakWeight = -1;
        let peakLocal = 0;

        for (let i = 0; i < n; i++) {
            // u sweeps -1..1 across the band; centre component sits on Tp.
            const u = n === 1 ? 0 : (i / (n - 1)) * 2 - 1;
            const period = s.period * (1 + s.bandwidth * u);
            const omega = (2 * Math.PI) / period;
            const k = (omega * omega) / GRAVITY;

            // Gaussian weight across the band keeps the group narrow-banded.
            const weight = Math.exp(-2 * u * u);
            weightSq += weight * weight;
            if (weight > peakWeight) { peakWeight = weight; peakLocal = i; }

            // Directional fan. Deterministic jitter decorrelates direction from
            // frequency so the field does not look like a rotating comb.
            const spreadRad = THREE.MathUtils.degToRad(s.spread);
            const fan = n === 1 ? 0 : (rng() * 2 - 1) * spreadRad;
            const a = dirRad + fan;

            raw.push({
                dx: Math.sin(a),
                dz: Math.cos(a),
                amp: weight, // normalised below
                k,
                omega,
                phase: rng() * Math.PI * 2,
                swell: si,
            });
        }

        // Normalise so sum(a^2) == Hs^2 / 8.
        const targetSumSq = (s.height * s.height) / 8;
        const scale = Math.sqrt(targetSumSq / Math.max(weightSq, 1e-9));
        for (const c of raw) c.amp *= scale;

        carrier[si] = components.length + peakLocal;
        components.push(...raw);
    }

    // Global steepness guard.
    let totalSteepness = 0;
    for (const c of components) totalSteepness += c.amp * c.k;
    let steepnessScale = 1;
    if (totalSteepness > MAX_TOTAL_STEEPNESS) {
        steepnessScale = MAX_TOTAL_STEEPNESS / totalSteepness;
        for (const c of components) c.amp *= steepnessScale;
    }

    return { components, derived, carrier, steepnessScale };
}

// --- CPU SAMPLING -----------------------------------------------------------
// Must stay numerically identical to the GLSL in the water material, otherwise
// the rider flies through visible water or hovers above it.

export interface SurfaceSample {
    /** Displaced surface point (Gerstner moves points horizontally too). */
    position: THREE.Vector3;
    normal: THREE.Vector3;
}

const _tangent = new THREE.Vector3();
const _binormal = new THREE.Vector3();

/**
 * Evaluate the Gerstner sum at grid point (x, z). Note the returned position is
 * displaced away from (x, z) — use `surfaceAtWorldPos` to sample at a known
 * world location.
 */
export function waterDisplacement(
    field: WaveField, x: number, z: number, time: number, out?: SurfaceSample
): SurfaceSample {
    const result = out ?? { position: new THREE.Vector3(), normal: new THREE.Vector3() };
    result.position.set(x, 0, z);
    _tangent.set(1, 0, 0);
    _binormal.set(0, 0, 1);

    for (const w of field.components) {
        const f = w.k * (w.dx * x + w.dz * z) - w.omega * time + w.phase;
        const sf = Math.sin(f);
        const cf = Math.cos(f);
        const steep = w.amp * w.k;

        result.position.x += w.dx * w.amp * cf;
        result.position.y += w.amp * sf;
        result.position.z += w.dz * w.amp * cf;

        _tangent.x -= w.dx * w.dx * steep * sf;
        _tangent.y += w.dx * steep * cf;
        _tangent.z -= w.dx * w.dz * steep * sf;

        _binormal.x -= w.dx * w.dz * steep * sf;
        _binormal.y += w.dz * steep * cf;
        _binormal.z -= w.dz * w.dz * steep * sf;
    }

    result.normal.crossVectors(_binormal, _tangent).normalize();
    return result;
}

/**
 * Fixed-point solve for the grid point whose displaced position lands on the
 * requested world (x, z). Gerstner displacement is horizontal as well as
 * vertical, so this inversion is needed to get the true surface under a point.
 */
export function surfaceAtWorldPos(
    field: WaveField, worldX: number, worldZ: number, time: number, iterations = 3
): SurfaceSample {
    let testX = worldX;
    let testZ = worldZ;
    let info = waterDisplacement(field, testX, testZ, time);

    for (let i = 0; i < iterations; i++) {
        testX += worldX - info.position.x;
        testZ += worldZ - info.position.z;
        info = waterDisplacement(field, testX, testZ, time);
    }
    return info;
}

/**
 * Vertical water velocity at depth `depth` below the surface.
 *
 * This is what keeps a foiler flying without pumping: on the right part of a
 * bump the water itself is moving upward, which adds angle of attack to the
 * wing for free. Orbital motion decays exponentially with depth as exp(-k*d),
 * so short chop is felt far less at the wing than long swell is.
 */
export function verticalOrbitalVelocity(
    field: WaveField, x: number, z: number, time: number, depth: number
): number {
    let w = 0;
    for (const c of field.components) {
        const f = c.k * (c.dx * x + c.dz * z) - c.omega * time + c.phase;
        w += -c.amp * c.omega * Math.cos(f) * Math.exp(-c.k * depth);
    }
    return w;
}

/** Vertical displacement only — cheap, for wake/bubble/buoy placement. */
export function waterHeightFast(
    field: WaveField, x: number, z: number, time: number
): number {
    let y = 0;
    for (const w of field.components) {
        y += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.omega * time + w.phase);
    }
    return y;
}

// --- WAVE TRAIN ANALYSIS ----------------------------------------------------

export interface SwellAnalysis {
    /** Local envelope height (amplitude of the set here), metres. */
    envelope: number;
    /** Envelope as a fraction of this swell's maximum possible envelope, 0..1. */
    setStrength: number;
    /**
     * Phase within the current wave, radians, wrapped to (-pi, pi].
     *   0      = on the crest
     *   -pi/2  = on the back (wave approaching from behind)
     *   +pi/2  = on the front face (the downhill you want)
     *   +/-pi  = in the trough
     */
    phase: number;
    /** This swell's contribution to surface height here, metres. */
    height: number;
}

/**
 * Decompose one swell into its slowly-varying envelope and its fast carrier
 * phase.
 *
 * Writing the sum against a carrier component c:
 *   sum a_i cos(theta_i) = Re[ e^{i*theta_c} * sum a_i e^{i(theta_i - theta_c)} ]
 *                        = |A| cos(theta_c + arg A)
 * so |A| is the set envelope and (theta_c + arg A) is where you sit on the wave.
 */
export function analyseSwell(
    field: WaveField, swellIndex: number, x: number, z: number, time: number
): SwellAnalysis {
    const ci = field.carrier[swellIndex];
    if (ci < 0) {
        return { envelope: 0, setStrength: 0, phase: 0, height: 0 };
    }

    const carrier = field.components[ci];
    const thetaC =
        carrier.k * (carrier.dx * x + carrier.dz * z) - carrier.omega * time + carrier.phase;

    let re = 0;
    let im = 0;
    let ampSum = 0;

    for (const w of field.components) {
        if (w.swell !== swellIndex) continue;
        const theta = w.k * (w.dx * x + w.dz * z) - w.omega * time + w.phase;
        const d = theta - thetaC;
        re += w.amp * Math.cos(d);
        im += w.amp * Math.sin(d);
        ampSum += w.amp;
    }

    const envelope = Math.hypot(re, im);
    // Surface = |A| * cos(thetaC + arg A). Crest is where that argument is 0.
    let phase = thetaC + Math.atan2(im, re);
    phase = ((phase + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

    return {
        envelope,
        setStrength: ampSum > 1e-9 ? envelope / ampSum : 0,
        phase,
        height: envelope * Math.cos(phase),
    };
}

/**
 * Which swell dominates at this point — the one with the tallest local
 * envelope. This is the wave the rider is actually working.
 */
export function dominantSwell(
    field: WaveField, x: number, z: number, time: number
): { index: number; analysis: SwellAnalysis } {
    let best = -1;
    let bestEnv = -1;
    let bestAnalysis: SwellAnalysis = { envelope: 0, setStrength: 0, phase: 0, height: 0 };

    for (let i = 0; i < field.derived.length; i++) {
        if (field.carrier[i] < 0) continue;
        const a = analyseSwell(field, i, x, z, time);
        if (a.envelope > bestEnv) {
            bestEnv = a.envelope;
            best = i;
            bestAnalysis = a;
        }
    }
    return { index: best, analysis: bestAnalysis };
}

/**
 * Surface height from a single swell only, so the primary and secondary trains
 * can be drawn apart from each other and from the chop.
 */
export function swellHeightAt(
    field: WaveField, swellIndex: number, x: number, z: number, time: number
): number {
    let y = 0;
    for (const w of field.components) {
        if (w.swell !== swellIndex) continue;
        y += w.amp * Math.sin(w.k * (w.dx * x + w.dz * z) - w.omega * time + w.phase);
    }
    return y;
}
