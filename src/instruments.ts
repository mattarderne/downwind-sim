// Instrument cluster: the readouts a foiler gets from feel on the water but
// cannot get through a screen.
//
//  - Wave train profile: the surface along your line, the bump you are on, the
//    set envelope around it, and which way the crests are marching.
//  - Swell radar: where each swell system is coming from relative to your
//    heading, plus the foil's actual track angle.
//  - Trim gauge: front/back foot pressure against the trim needed to hold
//    altitude, with breach and touchdown limits marked.

import {
    analyseSwell,
    waterHeightFast,
    swellHeightAt,
    type WaveField,
} from './waves';

export interface RiderReadout {
    x: number;
    z: number;
    heading: number;
    /** Course over ground — differs from heading when slipping sideways. */
    track: number;
    speed: number;
    rideHeight: number;
    mastLength: number;
    footPressure: number;
    footPressureTrim: number;
    alpha: number;
    alphaTrim: number;
    inflowAngle: number;
    loadFactor: number;
    wingDepth: number;
    ventFactor: number;
    orbitalW: number;
    /** Forward drive from the wave right now, newtons. */
    waveThrust: number;
    roll: number;
    pitch: number;
    onFoil: boolean;
    /** Water surface height under the board, m — the datum for the side view. */
    surfaceHeight: number;
    /** Wing depth below which ventilation starts, m. */
    ventDepth: number;
}

const FG = 'rgba(255,255,255,0.85)';
const DIM = 'rgba(255,255,255,0.35)';
const FAINT = 'rgba(255,255,255,0.14)';
const PANEL = 'rgba(0, 18, 36, 0.72)';
const BORDER = 'rgba(255,255,255,0.12)';

const GREEN = '#4ade80';
const AMBER = '#fbbf24';
const RED = '#ef5350';

function panel(ctx: CanvasRenderingContext2D, w: number, h: number) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = PANEL;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, 10);
    ctx.fill();
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(0.5, 0.5, w - 1, h - 1, 10);
    ctx.stroke();
}

function label(
    ctx: CanvasRenderingContext2D, text: string, x: number, y: number,
    color = DIM, align: CanvasTextAlign = 'left', size = 9
) {
    ctx.fillStyle = color;
    ctx.font = `${size}px monospace`;
    ctx.textAlign = align;
    ctx.fillText(text, x, y);
}

// --- WAVE TRAIN PROFILE -----------------------------------------------------

export interface WaveTrainOpts {
    /** Metres shown behind the rider. */
    behind: number;
    /** Metres shown ahead of the rider. */
    ahead: number;
    /** Which swell's envelope to overlay. */
    swellIndex: number;
}

/**
 * Side elevation of the sea surface along the rider's heading.
 *
 * The solid line is the real surface (all swells summed). The shaded band is
 * the dominant swell's group envelope — the "set". Where the envelope is tall
 * you are inside a set; where it pinches you are between sets. Because crests
 * travel at twice the envelope speed, you can watch bumps being born at the
 * back of the band and dying off the front.
 */
export function drawWaveTrain(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    field: WaveField,
    rider: RiderReadout,
    time: number,
    opts: WaveTrainOpts
) {
    panel(ctx, w, h);

    const padL = 6, padR = 6, padT = 16, padB = 14;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;
    const midY = padT + plotH / 2;

    const total = opts.behind + opts.ahead;

    // Sampled along the PRIMARY SWELL's direction, not the rider's heading.
    // Heading-relative sampling swung the whole trace around every time the
    // board turned, which made it unreadable; the swell direction is fixed, so
    // the wave train holds still and the rider moves through it.
    const d = field.derived[opts.swellIndex] ?? field.derived[0];
    const dirX = d.dirX;
    const dirZ = d.dirZ;

    const N = Math.max(48, Math.min(220, Math.floor(plotW)));
    const prim = new Float32Array(N);
    const sec = new Float32Array(N);
    const envU = new Float32Array(N);
    let maxAbs = 0.35;

    // Second swell, if there is one running
    let secIdx = -1;
    for (let i = 0; i < field.derived.length; i++) {
        if (i !== opts.swellIndex && field.carrier[i] >= 0 && i !== 2) { secIdx = i; break; }
    }

    for (let i = 0; i < N; i++) {
        const sPos = -opts.behind + (i / (N - 1)) * total;
        const x = rider.x + dirX * sPos;
        const z = rider.z + dirZ * sPos;
        prim[i] = swellHeightAt(field, opts.swellIndex, x, z, time);
        sec[i] = secIdx >= 0 ? swellHeightAt(field, secIdx, x, z, time) : 0;
        envU[i] = analyseSwell(field, opts.swellIndex, x, z, time).envelope;
        const a = Math.max(Math.abs(prim[i]) + Math.abs(sec[i]), envU[i]);
        if (a > maxAbs) maxAbs = a;
    }

    // Vertical exaggeration. Ocean swell is very flat in profile — a 2 m face
    // on a 56 m wavelength is a 3% grade — so drawn true to scale the set
    // structure is invisible. Stretched and clipped to the panel instead.
    const VERT_GAIN = 1.7;
    const yScale = ((plotH / 2) / (maxAbs * 1.12)) * VERT_GAIN;
    const sx = (i: number) => padL + (i / (N - 1)) * plotW;
    const sy = (v: number) =>
        Math.max(padT - 2, Math.min(padT + plotH + 2, midY - v * yScale));

    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, midY); ctx.lineTo(padL + plotW, midY);
    ctx.stroke();

    // Set envelope of the primary — the bigger bumps
    ctx.fillStyle = 'rgba(60, 140, 255, 0.10)';
    ctx.beginPath();
    ctx.moveTo(sx(0), sy(envU[0]));
    for (let i = 1; i < N; i++) ctx.lineTo(sx(i), sy(envU[i]));
    for (let i = N - 1; i >= 0; i--) ctx.lineTo(sx(i), sy(-envU[i]));
    ctx.closePath();
    ctx.fill();

    // Secondary swell, drawn plainly behind
    if (secIdx >= 0) {
        ctx.strokeStyle = 'rgba(167,139,250,0.7)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let i = 0; i < N; i++) {
            const X = sx(i), Y = sy(sec[i]);
            i === 0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y);
        }
        ctx.stroke();
    }

    // Primary swell, coloured by slope: green where the face runs downhill
    // along the swell, which is the side that drives you.
    ctx.lineWidth = 2.4;
    ctx.lineJoin = 'round';
    for (let i = 1; i < N; i++) {
        const dyds = (prim[i] - prim[i - 1]) / (total / (N - 1));
        const t = Math.max(-1, Math.min(1, -dyds * 12));
        ctx.strokeStyle = t > 0.15 ? GREEN : t < -0.15 ? 'rgba(239,83,80,0.8)' : DIM;
        ctx.beginPath();
        ctx.moveTo(sx(i - 1), sy(prim[i - 1]));
        ctx.lineTo(sx(i), sy(prim[i]));
        ctx.stroke();
    }

    // Rider
    const riderI = Math.round((opts.behind / total) * (N - 1));
    const rx = sx(riderI);
    const ry = sy(prim[riderI] + sec[riderI] + rider.rideHeight);
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(rx, padT); ctx.lineTo(rx, padT + plotH); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = rider.onFoil ? '#fff' : RED;
    ctx.beginPath(); ctx.arc(rx, ry, 3.4, 0, Math.PI * 2); ctx.fill();

    label(ctx, 'WAVE TRAIN', padL, 11, DIM);
    label(ctx, 'primary', padL + plotW - 46, 11, 'rgba(74,222,128,0.8)', 'right', 8);
    if (secIdx >= 0) label(ctx, 'secondary', padL + plotW, 11, 'rgba(167,139,250,0.85)', 'right', 8);
    label(ctx, `${opts.behind | 0}m`, padL, h - 4, FAINT);
    label(ctx, 'you \u2192 swell travel', rx, h - 4, DIM, 'center', 8);
    label(ctx, `click to zoom \u00d7${VERT_GAIN}v`, padL + plotW, h - 4, FAINT, 'right', 8);
}

// --- SET POSITION -----------------------------------------------------------

/**
 * Where you sit inside the current set, and where you sit on the individual
 * wave. Two different things, and confusing them is what makes downwind hard.
 */
export function drawSetMeter(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    field: WaveField,
    rider: RiderReadout,
    time: number,
    swellIndex: number
) {
    panel(ctx, w, h);
    const a = analyseSwell(field, swellIndex, rider.x, rider.z, time);

    label(ctx, 'ON THE WAVE', 8, 12, DIM);

    // The ring IS the gauge. Colour runs green at the crest through to orange in
    // the trough, because the top of a wave carries the potential — height to
    // spend and a face to drop into — while the bottom has neither. Where the
    // marker sits on that gradient is the whole reading; a separate power bar
    // said the same thing worse.
    const cx = w / 2;
    const cy = h / 2 + 8;
    const R = Math.min(w, h) / 2 - 20;

    const SEG = 48;
    ctx.lineWidth = 6;
    for (let i = 0; i < SEG; i++) {
        // phase across the ring: 0 at top (crest), pi at bottom (trough)
        const p0 = (i / SEG) * Math.PI * 2 - Math.PI;
        const p1 = ((i + 1) / SEG) * Math.PI * 2 - Math.PI;
        const height = Math.cos((p0 + p1) / 2);        // +1 crest, -1 trough
        const t = (height + 1) / 2;                     // 0 trough .. 1 crest
        const r = Math.round(250 - 180 * t);
        const g = Math.round(150 + 72 * t);
        const b = Math.round(60 + 68 * t);
        ctx.strokeStyle = `rgba(${r},${g},${b},0.85)`;
        ctx.beginPath();
        ctx.arc(cx, cy, R, -Math.PI / 2 + p0, -Math.PI / 2 + p1);
        ctx.stroke();
    }

    // Rider marker
    const ang = -Math.PI / 2 + a.phase;
    const mx = cx + Math.cos(ang) * R;
    const my = cy + Math.sin(ang) * R;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.beginPath(); ctx.arc(mx, my, 6.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(mx, my, 4.2, 0, Math.PI * 2); ctx.fill();

    label(ctx, 'CREST', cx, cy - R - 6, 'rgba(74,222,128,0.85)', 'center', 8);
    label(ctx, 'TROUGH', cx, cy + R + 12, 'rgba(250,150,60,0.85)', 'center', 8);
    label(ctx, 'face', cx + R + 5, cy + 3, DIM, 'left', 7);
    label(ctx, 'back', cx - R - 5, cy + 3, DIM, 'right', 7);

    // How strong this set is, which is the other half of "is it worth being here"
    const strength = Math.max(0, Math.min(1, a.setStrength));
    label(ctx,
        strength > 0.66 ? 'peak of set' : strength > 0.33 ? 'building' : 'between sets',
        w - 8, 12, strength > 0.66 ? GREEN : strength > 0.33 ? AMBER : DIM, 'right', 8);
}

// --- SWELL RADAR ------------------------------------------------------------

/**
 * Compass rose showing each swell's travel direction against the rider's
 * heading and actual track. Downwind (+Z) points up.
 */
export function drawSwellRadar(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    field: WaveField,
    swellNames: string[],
    swellEnabled: boolean[],
    rider: RiderReadout
) {
    panel(ctx, w, h);
    const cx = w / 2;
    const cy = h / 2 + 4;
    const R = Math.min(w, h) / 2 - 16;

    label(ctx, 'SWELL / HEADING', 8, 12, DIM);

    // Rings and cardinal ticks
    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 1;
    for (const f of [0.5, 1]) {
        ctx.beginPath(); ctx.arc(cx, cy, R * f, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
    ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
    ctx.stroke();
    label(ctx, 'DW', cx, cy - R - 4, FAINT, 'center', 8);

    // Screen angle for a world bearing (0 = +Z = up, positive = clockwise)
    const toScreen = (bearing: number, r: number): [number, number] =>
        [cx + Math.sin(bearing) * r, cy - Math.cos(bearing) * r];

    function arrow(
        bearing: number, r: number, color: string, width: number, head = 5
    ) {
        const [ax, ay] = toScreen(bearing, r);
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(ax, ay);
        ctx.stroke();
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        const back = bearing + Math.PI;
        const [b1x, b1y] = [
            ax + Math.sin(back + 0.4) * head, ay - Math.cos(back + 0.4) * head,
        ];
        const [b2x, b2y] = [
            ax + Math.sin(back - 0.4) * head, ay - Math.cos(back - 0.4) * head,
        ];
        ctx.lineTo(b1x, b1y);
        ctx.lineTo(b2x, b2y);
        ctx.closePath();
        ctx.fill();
    }

    // Swell arrows, length scaled by relative size
    let maxH = 0.001;
    const heights = field.derived.map((_d, i) => {
        // Recover Hs from the component amplitudes of this swell.
        let sumSq = 0;
        for (const c of field.components) if (c.swell === i) sumSq += c.amp * c.amp;
        const hs = Math.sqrt(sumSq * 8);
        if (hs > maxH) maxH = hs;
        return hs;
    });

    const swellColors = ['#60a5fa', '#a78bfa', '#94a3b8'];
    for (let i = 0; i < field.derived.length; i++) {
        if (!swellEnabled[i] || heights[i] <= 0.01) continue;
        const d = field.derived[i];
        const bearing = Math.atan2(d.dirX, d.dirZ);
        const r = R * (0.4 + 0.6 * (heights[i] / maxH));
        arrow(bearing, r, swellColors[i % swellColors.length], 2.5, 6);
    }

    // Rider heading (where the board points) and track (where it actually goes)
    arrow(rider.track, R * 0.85, 'rgba(255,255,255,0.35)', 1.5, 4);
    arrow(rider.heading, R * 0.85, '#fff', 2, 5);

    // Legend: height and period per active swell (deep water, lambda = 1.56*T^2)
    const active = field.derived
        .map((d, i) => ({ d, i }))
        .filter(({ i }) => swellEnabled[i] && heights[i] > 0.01);

    let ly = h - 6 - (active.length - 1) * 10;
    for (const { d, i } of active) {
        const period = Math.sqrt(d.wavelength / 1.56);
        ctx.fillStyle = swellColors[i % swellColors.length];
        ctx.fillRect(8, ly - 5, 6, 2);
        label(
            ctx,
            `${swellNames[i].split(' ')[0].slice(0, 4)} ${heights[i].toFixed(1)}m ${period.toFixed(0)}s`,
            18, ly, DIM, 'left', 8
        );
        ly += 10;
    }

    // Sync angle. Staying with a swell needs V*cos(theta) = c, so when the
    // crests are slower than you the only way to keep the same bump under your
    // feet is to angle off by acos(c/V). Riding straight then means climbing
    // the back of every wave. When the crests are faster than you no angle
    // syncs, and the swell simply passes underneath.
    if (active.length > 0 && rider.speed > 2) {
        const cSwell = field.derived[active[0].i].phaseSpeed;
        const ratio = cSwell / rider.speed;
        if (ratio < 0.995) {
            const theta = Math.acos(ratio);
            const base = Math.atan2(field.derived[active[0].i].dirX, field.derived[active[0].i].dirZ);
            for (const sgn of [1, -1]) {
                const b = base + sgn * theta;
                const [tx, ty] = toScreen(b, R);
                ctx.strokeStyle = 'rgba(74,222,128,0.55)';
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(cx, cy);
                ctx.lineTo(tx, ty);
                ctx.stroke();
                ctx.setLineDash([]);
            }
            label(ctx, `sync ${(theta * 180 / Math.PI).toFixed(0)}\u00b0`,
                8, h - 6 - active.length * 10, GREEN, 'left', 8);
        } else {
            label(ctx, 'swell outruns you', 8, h - 6 - active.length * 10,
                'rgba(255,255,255,0.35)', 'left', 8);
        }
    }

    // Heading angle readout, relative to straight downwind
    const off = ((rider.heading * 180) / Math.PI + 540) % 360 - 180;
    label(
        ctx,
        `${off >= 0 ? '+' : ''}${off.toFixed(0)}° off DW`,
        w - 8, 12, off > 45 || off < -45 ? AMBER : FG, 'right', 9
    );
}

// --- TRIM / FOOT PRESSURE ---------------------------------------------------

/**
 * Trim and height, side by side.
 *
 * Left: fore/aft foot pressure. Laid out to match what you are looking at —
 * the camera sits behind the rider, so the nose is up-screen and the tail is
 * down-screen, and the gauge runs the same way. Front foot at the top drops
 * the nose toward the water; back foot at the bottom raises the angle of
 * attack and lifts you toward a breach. The green line is the trim that would
 * hold altitude right now; bring the bar to it.
 *
 * Right: a side elevation of the board on its mast against the water, because
 * a number in centimetres does not tell you how close you are to either limit.
 */
export function drawTrimGauge(
    ctx: CanvasRenderingContext2D,
    w: number, h: number,
    field: WaveField,
    rider: RiderReadout,
    time: number
) {
    panel(ctx, w, h);

    const padT = 22;
    const padB = 30;
    const colH = h - padT - padB;

    label(ctx, 'TRIM', 8, 12, DIM);
    label(ctx, 'HEIGHT', w - 8, 12, DIM, 'right');

    // --- Left column: fore/aft trim ---------------------------------------
    const trackW = 13;
    const trackX = 16;
    const trackTop = padT;
    const midY = trackTop + colH / 2;

    ctx.fillStyle = 'rgba(255,255,255,0.07)';
    ctx.beginPath(); ctx.roundRect(trackX, trackTop, trackW, colH, 6); ctx.fill();

    // Drawn so the bar goes where the key sends it, following the UP = DOWN
    // convention:
    //   TOP    = up arrow   = front foot = nose down = drive down = touchdown risk
    //   BOTTOM = down arrow = back foot  = nose up   = climb      = breach risk
    // This runs opposite to the height column beside it, so both are labelled
    // with the key that drives them.
    const zone = colH * 0.2;
    ctx.fillStyle = 'rgba(239,83,80,0.2)';
    ctx.beginPath(); ctx.roundRect(trackX, trackTop, trackW, zone, [6, 6, 0, 0]); ctx.fill();
    ctx.beginPath();
    ctx.roundRect(trackX, trackTop + colH - zone, trackW, zone, [0, 0, 6, 6]);
    ctx.fill();

    ctx.strokeStyle = FAINT;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(trackX - 3, midY); ctx.lineTo(trackX + trackW + 3, midY);
    ctx.stroke();

    // Up arrow gives front foot (-1), which sits at the TOP.
    const toY = (p: number) => midY + Math.max(-1, Math.min(1, p)) * (colH / 2);

    const ty = toY(rider.footPressureTrim);
    ctx.strokeStyle = GREEN;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(trackX - 5, ty); ctx.lineTo(trackX + trackW + 5, ty);
    ctx.stroke();

    const py = toY(rider.footPressure);
    const err = Math.abs(rider.footPressure - rider.footPressureTrim);
    ctx.fillStyle = err < 0.25 ? GREEN : err < 0.6 ? AMBER : RED;
    ctx.beginPath(); ctx.roundRect(trackX - 2, py - 3.5, trackW + 4, 7, 3); ctx.fill();

    // Label both the foot and its effect, so neither reading is ambiguous.
    label(ctx, '\u2191 NOSE DOWN', trackX + trackW / 2, trackTop - 12, DIM, 'center', 8);
    label(ctx, 'down the face', trackX + trackW / 2, trackTop - 4, FAINT, 'center', 7);
    label(ctx, 'climb', trackX + trackW / 2, trackTop + colH + 9, FAINT, 'center', 7);
    label(ctx, '\u2193 NOSE UP', trackX + trackW / 2, trackTop + colH + 17, DIM, 'center', 8);

    // --- Right column: side elevation of the rig against the water ---------
    const dx0 = 52;
    const dw = w - dx0 - 8;
    const dcx = dx0 + dw / 2;

    // Show one mast length above the surface and one below.
    const span = rider.mastLength * 1.15;
    const scale = colH / (span * 2);
    const waterY = trackTop + colH / 2;
    const mToPx = (m: number) => waterY - m * scale;

    ctx.save();
    ctx.beginPath();
    ctx.rect(dx0, trackTop - 6, dw, colH + 12);
    ctx.clip();

    // Water body, with the real local surface shape across a few metres
    const dirX = Math.sin(rider.heading);
    const dirZ = Math.cos(rider.heading);
    const HALF_M = 7;
    const steps = 22;
    const surfPx: number[] = [];
    for (let i = 0; i <= steps; i++) {
        const s = -HALF_M + (i / steps) * HALF_M * 2;
        const hgt = waterHeightFast(field, rider.x + dirX * s, rider.z + dirZ * s, time);
        // Draw relative to the surface under the board so the board reads as
        // sitting at exactly rideHeight above the line beneath it.
        surfPx.push(hgt - rider.surfaceHeight);
    }

    ctx.beginPath();
    ctx.moveTo(dx0, mToPx(surfPx[0]));
    for (let i = 1; i <= steps; i++) {
        ctx.lineTo(dx0 + (i / steps) * dw, mToPx(surfPx[i]));
    }
    ctx.lineTo(dx0 + dw, trackTop + colH + 12);
    ctx.lineTo(dx0, trackTop + colH + 12);
    ctx.closePath();
    ctx.fillStyle = 'rgba(60,140,255,0.20)';
    ctx.fill();

    ctx.strokeStyle = 'rgba(120,190,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(dx0, mToPx(surfPx[0]));
    for (let i = 1; i <= steps; i++) ctx.lineTo(dx0 + (i / steps) * dw, mToPx(surfPx[i]));
    ctx.stroke();

    // Ventilation band. The front wing inside this depth of the surface starts
    // pulling air down its low-pressure side and loses lift; break through and
    // you breach. Everything below the dashed line is clean water.
    const wingInBand = rider.wingDepth < rider.ventDepth;
    ctx.fillStyle = wingInBand ? 'rgba(239,83,80,0.30)' : 'rgba(239,83,80,0.14)';
    ctx.fillRect(dx0, mToPx(0), dw, rider.ventDepth * scale);
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = wingInBand ? 'rgba(239,83,80,0.9)' : 'rgba(239,83,80,0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(dx0, mToPx(-rider.ventDepth));
    ctx.lineTo(dx0 + dw, mToPx(-rider.ventDepth));
    ctx.stroke();
    ctx.setLineDash([]);
    label(
        ctx, 'VENT', dx0 + 3, mToPx(-rider.ventDepth) - 3,
        wingInBand ? RED : 'rgba(239,83,80,0.55)', 'left', 7
    );

    // --- The rig, side on, nose to the right ------------------------------
    // Board, mast, fuselage, front wing and stabiliser are one rigid body, so
    // the whole assembly pitches together. The mast is offset aft of board
    // centre and the fuselage carries a stab, so it reads as a foil rather
    // than a plain T.
    const boardY = mToPx(rider.rideHeight);
    const breaching = rider.ventFactor < 0.6;
    const rigColor = breaching ? RED : rider.rideHeight < 0.1 ? AMBER : '#fff';

    // Mast sits well aft on the board, under the rider's back foot, and joins
    // the fuselage just behind the front wing — so most of the fuselage trails
    // aft to the stabiliser, which is what a foil actually looks like.
    const mastX = dcx - dw * 0.16;
    const mastPx = rider.mastLength * scale;
    // Fuselage runs ~40% of board length, the way a real one does, with the
    // mast joining about a quarter of the way back from the front wing.
    const FUSE_FWD = dw * 0.07;
    const FUSE_AFT = dw * 0.19;

    // Pitch and AoA are amplified so small trim changes stay legible here.
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    // The rig is ONE rigid body — board, mast, fuselage and both wings. Drawing
    // the wings rotating against the fuselage was physically impossible, and
    // since alpha tracks the flow rather than the rider's input the wings
    // appeared to swing opposite to the board. Instead: rotate the whole rig by
    // the geometric trim the rider is holding, and draw the oncoming water as a
    // separate arrow. The gap between chord and flow IS the angle of attack.
    const ANG_VIS = 4.0;
    const pitchVis = clamp(-rider.alphaTrim * ANG_VIS, -0.45, 0.45);
    const flowVis = clamp(-rider.inflowAngle * ANG_VIS, -0.45, 0.45);
    const wingColor = Math.abs(rider.alpha) > 0.16 ? RED
        : Math.abs(rider.alpha) > 0.10 ? AMBER : rigColor;

    ctx.save();
    ctx.translate(mastX, boardY);
    ctx.rotate(pitchVis);

    // Board — tail left, nose right with a little rocker
    ctx.fillStyle = rigColor;
    ctx.beginPath();
    ctx.moveTo(-dw * 0.20, -4.5);
    ctx.lineTo(dw * 0.26, -4.5);
    ctx.quadraticCurveTo(dw * 0.35, -4.2, dw * 0.38, -1.2);
    ctx.lineTo(dw * 0.33, 0.6);
    ctx.lineTo(-dw * 0.20, 0.6);
    ctx.closePath();
    ctx.fill();

    // Mast
    ctx.strokeStyle = rigColor;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, mastPx);
    ctx.stroke();

    // Fuselage
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-FUSE_AFT, mastPx);
    ctx.lineTo(FUSE_FWD, mastPx);
    ctx.stroke();

    // Front wing — the lifting surface, and the part that has to stay buried.
    // Drawn heaviest of everything so it reads as the thing to watch.
    ctx.fillStyle = wingColor;
    ctx.beginPath();
    ctx.ellipse(FUSE_FWD, mastPx, dw * 0.09, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Rear stabiliser
    ctx.fillStyle = wingColor;
    ctx.beginPath();
    ctx.ellipse(-FUSE_AFT, mastPx, dw * 0.05, 1.6, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();

    // Oncoming water at the wing. Water flows past from the front, so the arrow
    // runs nose-to-tail; its tilt against the wing chord is the angle of attack.
    {
        const wingScreenX = mastX + FUSE_FWD;
        const wingScreenY = boardY + mastPx;
        ctx.save();
        ctx.translate(wingScreenX, wingScreenY);
        ctx.rotate(flowVis);
        ctx.strokeStyle = 'rgba(125,211,252,0.9)';
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(dw * 0.20, 0);
        ctx.lineTo(-dw * 0.02, 0);
        ctx.stroke();
        ctx.fillStyle = 'rgba(125,211,252,0.9)';
        ctx.beginPath();
        ctx.moveTo(-dw * 0.05, 0);
        ctx.lineTo(dw * 0.005, -2.2);
        ctx.lineTo(dw * 0.005, 2.2);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
    }

    ctx.restore();

    // Height callout
    label(
        ctx, `${(rider.rideHeight * 100).toFixed(0)} cm`,
        dcx, mToPx(rider.rideHeight) - 8,
        breaching ? RED : FG, 'center', 9
    );

    // --- Status ------------------------------------------------------------
    let msg = 'trimmed';
    let msgColor = GREEN;
    if (breaching) { msg = 'BREACHING — press \u2191'; msgColor = RED; }
    else if (rider.rideHeight < 0.1) { msg = 'TOUCHING — press \u2193'; msgColor = RED; }
    else if (rider.footPressure - rider.footPressureTrim > 0.3) { msg = 'press \u2191'; msgColor = AMBER; }
    else if (rider.footPressureTrim - rider.footPressure > 0.3) { msg = 'press \u2193'; msgColor = AMBER; }
    label(ctx, msg, w / 2, h - 14, msgColor, 'center', 9);

    label(
        ctx,
        `AoA ${(rider.alpha * 180 / Math.PI).toFixed(1)}°   ${rider.loadFactor.toFixed(2)}g`,
        w / 2, h - 4, DIM, 'center', 8
    );
}
