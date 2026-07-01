# Medical Welcome Scenario Notes

Source context found in:

- `Projects/scratch-2026-05-25/deliverables/welcome-aurora-animation/`
- `Projects/scratch-2026-05-25/deliverables/welcome-aurora-animation/handoff.md`
- `Projects/scratch-2026-05-25/deliverables/welcome-aurora-animation/google-flow-test-kit.md`

## Scenario

This is not a giant stage LED show. The intended setting is a premium medical conference welcome / reception area:

- doctors arrive and check in
- a doctor signs on an iPad at a reception counter
- the iPad interaction triggers a wall-mounted horizontal LED display
- target LED scale reads as about 200 cm wide x 100 cm high
- the LED bottom edge is around 135 cm from the floor
- LED PAR fixtures sit directly below the wall display
- this MVP renders aurora as a programmatic browser effect
- PAR lighting remains a later-stage OSC / Art-Net cue after the signature receiver flow is stable

## Implication For This MVP

The first programming milestone should stay narrow:

```text
iPad signature
-> local event server
-> medical LED renderer
-> operator reset / replay
-> retained signatures in server / control
-> auto return to standby backplate
```

OSC, Art-Net, and DMX should remain second-stage integration. The reason is that the key unknown is still whether multiple doctors can reliably sign, trigger the display, and preserve their signatures without losing state.

## Renderer Adjustment

Added:

```text
/medical-wall
```

This page uses the same iPad signature event as `/wall`, but frames it for the medical welcome context:

- 2:1 LED content area
- no stage-scale composition
- standby backplate animation
- latest incoming signature as the main reveal
- SVG signature reveal
- retained signature cards for multiple doctors
- no PAR in this milestone

## Activation Timing

Recommended production timing:

| State | Duration | Description |
|---|---:|---|
| Idle | indefinite | animated standby backplate with retained signature cards |
| Signature received | immediate | latest submitted iPad stroke becomes the main signature reveal |
| Aurora effect | 1.5-8.5s | programmatic cyan / teal / green aurora intensifies behind the signature |
| Auto return | about 9.5s | large signature clears and wall returns to standby backplate |
| Reset | operator-controlled | return to standby backplate immediately; retained signatures stay available in control |
| Clear all | explicit operator action | remove all retained signatures |

## Privacy / Content Note

The previous animation direction explicitly avoided readable text and readable signatures. For a medical event, decide this before production:

- `exact`: show the real submitted signature
- `abstract`: preserve gesture feel but stylize the mark so it is not a readable legal signature
- do not persist raw signatures unless the event copy says so
- MVP keeps stroke data in memory only; production needs retention and deletion policy

## Next Build Step

After `/medical-wall` is accepted:

1. Add a `privacyMode` option: `exact` vs `abstract`.
2. Add a persistent local store if signatures must survive server restart.
3. Rework the visual layer against the actual main visual once provided.
4. Add a cue scheduler so `signature:submitted` emits timed states:
   - `signature_draw`
   - `aurora_bloom`
   - `auto_idle`
5. Add optional lighting bridge later:
   - `/doctorWelcome/signatureReceived`
   - `/doctorWelcome/auroraStart`
   - `/doctorWelcome/parActivate`
6. Add rehearsal checklist for actual venue network, display resolution, browser fullscreen mode, and later PAR control path.
