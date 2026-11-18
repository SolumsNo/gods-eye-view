import assert from 'node:assert/strict';
import test from 'node:test';
import { eciToEcf, gstime, propagate, twoline2satrec } from 'satellite.js';
import { reckonEarthFixed, sampleOrbit } from './satelliteMotion.js';

const L1 = '1 25544U 98067A   08264.51782528  .00002182  00000-0  48812-4 0  2320';
const L2 = '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125395302832';
const EPOCH_MS = Date.UTC(2008, 8, 20, 12, 30);

test('reckoned positions stay within 10 metres of SGP4 at 10 and 30 seconds', () => {
  const satrec = twoline2satrec(L1, L2);
  const sample = sampleOrbit(satrec, EPOCH_MS);
  assert.ok(sample);

  for (const deltaSeconds of [-30, -10, 10, 30]) {
    const atMs = EPOCH_MS + deltaSeconds * 1000;
    const exact = propagate(satrec, new Date(atMs));
    assert.ok(exact?.position && typeof exact.position !== 'boolean');

    const gmst = gstime(new Date(atMs));
    const expected = eciToEcf(exact.position, gmst);
    const actual = reckonEarthFixed(sample, atMs, gmst, {});
    const errorM = Math.hypot(
      actual.x - expected.x * 1000,
      actual.y - expected.y * 1000,
      actual.z - expected.z * 1000,
    );
    assert.ok(errorM < 10, `error at ${deltaSeconds}s was ${errorM.toFixed(3)} m`);
  }
});

test('sampleOrbit returns null when SGP4 cannot produce a state', () => {
  assert.equal(sampleOrbit({ error: 6 }, EPOCH_MS), null);
});
