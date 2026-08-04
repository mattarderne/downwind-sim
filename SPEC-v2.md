# Downwind Sim v2 — specification

A rebuild, informed by measurements taken against v1. Numbers here are derived
from the physics rather than chosen, and the derivations are shown so they can
be argued with.

---

## 1. The benchmark

State-of-the-art downwind race pace is the target the whole game is calibrated
against:

| | speed |
|---|---|
| **1:30 / km** sustained | 11.1 m/s · **21.6 kt** · 24.9 mph |
| Peak on a good bump | 13.4 m/s · **26.1 kt** · 30 mph |

Everything below is set so that a skilled player on the top-tier gear, riding
well, lands on that number. If they can hit 1:30 splits without linking bumps,
the physics is wrong.

---

## 2. The foil ladder

Cruise speed follows from wing area and aspect ratio through the lifting-line
slope `CL_alpha = 2*pi*AR/(AR+2)`, solved at the trim angle of attack for an
85 kg rider. This is not a balance knob — it falls out of the geometry.

| foil | area cm² | AR | cruise | min flying |
|---|---|---|---|---|
| Beginner 2000 | 2000 | 7 | 12.3 kt | 4.9 kt |
| Cruiser 1400 | 1400 | 9 | 14.3 kt | 5.7 kt |
| Allround 1000 | 1000 | 11 | 16.6 kt | 6.6 kt |
| Race 700 | 700 | 14 | 19.5 kt | 7.8 kt |
| Pro 500 | 500 | 16 | 22.9 kt | 9.2 kt |
| **Pro 450** | **450** | **17** | **24.1 kt** | 9.6 kt |
| Pro 400 | 400 | 18 | 25.5 kt | 10.2 kt |

**The 400–500 cm², AR 16–18 bracket is exactly the gear that reaches 1:30/km.**
That was an intuition; the physics agrees, which is a good sign the model is
sound. Rider weight shifts the whole ladder as `V ∝ sqrt(mass)`.

---

## 3. Sea state follows the foil, not the difficulty label

The single most important relationship in the game, established by measurement
in v1: staying with a swell requires

```
V * cos(theta) = c        =>   theta = acos(c / V)
```

where `c = g*T/2pi` is crest speed. Three regimes:

| c/V | result |
|---|---|
| **> 1** | no angle syncs; the swell passes underneath. Flat and dull |
| **≈ 1** | straight already syncs. Forgiving, no technique |
| **< 1** | must angle by `acos(c/V)` to hold a bump. **This is the game** |

Measured in v1: at c/V = 0.75, holding the sync angle gave **1416 m against
48 m** for any other heading — a 30× difference, with the optimum landing within
2° of theory.

So each tier pairs a foil with a swell that sits at a chosen c/V:

| tier | foil | c/V | sync angle | swell | Hs | steepness |
|---|---|---|---|---|---|---|
| Learning | Beginner 2000 | 1.00 | 0° | 4.2 s, 27 m | 0.8 m | 3.0% |
| Intermediate | Allround 1000 | 0.95 | 18° | 5.3 s, 44 m | 1.5 m | 3.4% |
| Advanced | Race 700 | 0.90 | 26° | 6.4 s, 64 m | 2.2 m | 3.4% |
| **Pro** | **Pro 450** | **0.88** | **28°** | **7.1 s, 79 m** | **2.5 m** | **3.2%** |

**Faster gear unlocks bigger water, and that is physically honest.** Syncing at
a higher speed demands a longer period, and a longer wave carries the same
height at lower steepness. So the pro tier rides 2.5 m faces that are *less*
steep than a beginner's 0.8 m chop. Progression and spectacle move together
without either being faked.

**Hard ceiling:** rms surface slope must stay under about 5°. Following a face
needs a flight-path change of roughly the slope, which needs comparable angle of
attack, and the wing stalls around 15°. v1 tried to reproduce the original
game's 10.4% steepness and produced a sea that no flying wing could track.

---

## 4. Control model

The control scheme is the difficulty, more than the water is.

### Easy — self-stabilising

The board seeks and holds a ride height on its own. Player input biases that
target rather than commanding angle of attack directly. Roll auto-levels.
Getting airborne and staying there is the tutorial, not the game.

### Medium — assisted

Height assist fades out above a speed threshold, so it rescues you when slow but
gets out of the way once you are flying properly. Roll still self-levels
gently.

### Hard — joystick

No assist. Roll and elevator are independent, continuous axes and **must be
coupled by the player**:

- Banking tilts the lift vector, so vertical lift falls with `cos(roll)`.
  Holding altitude through a turn requires simultaneous back-foot input.
- Releasing the turn requires easing both together, or the board balloons.
- Sideslip is modelled: an uncoordinated turn scrubs speed and washes the tail out.

This is the "lean and ease back on roll and elevator together" feel. It is
harder, and it is the only mode where the foil can be ridden to its limit.

---

## 5. Momentum — the thing v1 lacks most

The current sim never feels like it has momentum. Three causes, all fixable:

1. **Wave thrust falls off as c/V**, so it self-limits — correct, but it means
   there is no reservoir. Add stored energy the player manages.
2. **Height is a battery and must read as one.** Ride height converts to speed
   through the lift vector tilting forward; that already works and conserves
   energy. What is missing is the *feedback*: at 0.6 m the board should visibly
   sit high on the mast, the water should be visibly further below, and speed
   should climb noticeably as wetted mast shrinks.
3. **Mast drag must scale with submerged length.** Fixed in v1 late (46% spread
   between low and high riding). This is what makes flying high a decision.

**Design target:** a good rider should be able to bank a bump's energy as height,
carry it across a trough that would otherwise stop them, and spend it on the next
face. That loop — *climb, glide, spend, catch* — is the core game.

---

## 6. Failure should be survivable

Every failure mode gets a recovery window whose width scales with skill and
speed. Not binary.

**Touchdown.** Board contacts water. With enough speed and a quick back-foot
input, it skips and flies again, scrubbing maybe 20% of speed. Slow or late, it
is a stop. Recovery window proportional to `speed / stall_speed`.

**Breach.** Front wing nears the surface, ventilates, loses lift. Currently
instant death. Instead: lift degrades progressively, the board pitches, and an
immediate front-foot input can reseat the wing. Harder the higher and faster.

**Tip breach.** New, and the best idea in the pile. Sample the wave at both
wingtips (v1 already does this for roll torque). If one tip clears the surface:

- That side loses most of its lift
- A strong roll moment throws the board flat toward the breached side
- Recovery is a coordinated roll-and-elevator catch, exactly the Hard control skill

This gives asymmetric, readable, recoverable failure, and it rewards the coupled
control model rather than punishing randomly.

**Stall.** Angle of attack past ~15°. Lift collapses. Recovery only with height
in hand — spend it, unload, rebuild speed.

Failures should feel earned and *catchable*, so the highlight of a run is the
save, not the crash.

---

## 7. Visuals and assets

**Foil models from STL.** Load real printed-foil geometry rather than primitives.
Each entry in the foil ladder gets its own mesh, so the gear you pick is visible
under the board. Board and foil swappable independently.

**Clear water.** The current material is a near-mirror (roughness 0.05,
metalness 0.9) under an overhead sun, which is why the surface has shape but
shows none of it. v2 wants:

- Depth-based transparency so the mast and wing are visible below the waterline
- A raking sun as the default, which alone did more for legibility than any
  overlay in v1 testing
- Refraction and caustics if affordable
- Retain the readability overlay modes as an accessibility option, not the
  primary means of seeing the water

**Height must read visually.** Camera lowers slightly and FOV widens with speed;
spray and wake scale with wetted area; the mast is *visibly* out of the water
when riding high. Right now nothing on screen distinguishes 0.2 m from 0.6 m.

**Rendering.** Whatever library is chosen, the requirement is control over water
shading and a real material pipeline. Three.js is workable but the water needs
rewriting either way; worth evaluating alternatives before committing.

---

## 8. Game loop

**Core run.** Pick a distance, ride it, chase a split. Live split delta against
your best, and against the 1:30/km benchmark.

**Progression.** Faster gear is earned. Each foil unlocks at a split threshold on
the previous one, so you graduate by demonstrating you can hold the sync angle,
not by grinding.

**Bump-linking score.** Reward the actual skill: consecutive bumps connected
without dropping off foil. A streak counter with a speed multiplier gives the
loop a rhythm and teaches the mechanic without a tutorial.

**Conditions as content.** Runs generated from a forecast-style spec — two swells
plus wind. Some days are fast, some are a grind. Daily conditions shared across
players make times comparable.

**Ghosts.** Race your own best line, or a friend's. Downwind is invisible to
spectators, so a ghost is what makes the line legible.

### Parked

Paddle-up to get on foil. A real technique and a good tutorial beat, but it is a
whole second control mode; revisit once flight feels right.

---

## 9. Carried over from v1 — proven, do not rediscover

- **Wave field:** spectral, from significant height, peak period and direction,
  with deep-water dispersion. Groups emerge from beating; measured group speed
  came out at half crest speed as theory requires
- **Propulsion:** lift tilting forward in rising water, `L*sin(atan(w/V))`. Not
  gravity down the surface slope — the rider is flying, not sliding
- **Concentrate the spectrum:** 3 components for the primary swell. A broad
  spectrum is more realistic but leaves no single wave big enough to see or ride
- **Sub-step at 1/240 s.** The AoA feedback gives ~30/s effective damping and an
  explicit integrator sits at its stability limit whenever a frame drops
- **Centripetal force applies to velocity**, not just heading. Rotating heading
  and letting a damper drag the velocity round destroys kinetic energy every
  frame of every turn
- **Instruments** — wave train, set position, swell radar with sync angle, trim
  and height card — all worth keeping

## 10. Build order

1. Wave field and flight model as a headless, testable module. No renderer.
   Every claim in this spec should be a test.
2. Foil ladder and the c/V tier table. Verify cruise speeds and sync angles.
3. Control modes, easy through joystick, with the coupled roll/elevator model.
4. Failure and recovery windows, including tip breach.
5. Renderer: clear water, STL foils, height that reads.
6. Game loop, progression, ghosts.

Physics first and testable is the main lesson from v1. Most of the time went on
bugs the renderer hid — a fixed mast drag area, a turn that deleted momentum, a
control mapping that disagreed with its own gauge. All of them would have been
caught by a test in the first hour.


---

## 11. Fudges in v1 that v2 must not inherit

Two places where v1 trades physics for feel. Both are marked in the source.

**Asymmetric wave drive (`WAVE_ENERGY_MULT = 1.7`).** The thrust term is derived
— lift tilting forward in rising water — and honest at 1.0. v1 scales only the
accelerating side, leaving the braking side halved, so energy is not conserved
across a wave cycle. It exists because the true accelerations, while real, are
too gentle to perceive through a screen.

*The v2 answer is presentation, not force.* Clear water, a visibly high mast,
camera and spray that scale with speed. If acceleration can be seen it does not
need inflating. Build the renderer first, then check whether 1.0 still feels
dead.

**Halved adverse thrust.** Climbing the back of a bump cost about 7 kt at full
strength, which stopped a run dead. Halving it is a blunt fix for what is really
a positioning problem — the rider should rarely be pinned on the back at all if
c/V is set correctly.

**Also worth carrying forward:** tuning changes couple. Halving the adverse
penalty made riders 1 kt faster, which lowered c/V and broke the sync angle the
whole tier was built around. Any force change needs the tier table re-derived,
not just re-tested.
