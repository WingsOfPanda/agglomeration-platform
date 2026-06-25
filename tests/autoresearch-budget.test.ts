import { test, expect } from 'vitest';
import { marginalGainStop } from '../src/core/autoresearchBudget.js';

test('fires when windowed marginal gain per cost falls below threshold', () => {
  const flat = [
    { metric: 0.9, cost: 1 },
    { metric: 0.901, cost: 1 },
    { metric: 0.9012, cost: 1 },
    { metric: 0.9013, cost: 1 },
  ];
  expect(marginalGainStop(flat, 0.01, 3, 'maximize')).toBe(true);
});

test('holds while gains continue', () => {
  const rising = [
    { metric: 0.5, cost: 1 },
    { metric: 0.6, cost: 1 },
    { metric: 0.7, cost: 1 },
    { metric: 0.8, cost: 1 },
  ];
  expect(marginalGainStop(rising, 0.01, 3, 'maximize')).toBe(false);
});

test('never fires before the window is full', () => {
  expect(marginalGainStop([{ metric: 0.9, cost: 1 }], 0.01, 3, 'maximize')).toBe(false);
});

test('minimize direction: gains come from a falling metric', () => {
  // metric falling steadily -> still making progress -> hold
  const falling = [
    { metric: 0.8, cost: 1 },
    { metric: 0.7, cost: 1 },
    { metric: 0.6, cost: 1 },
    { metric: 0.5, cost: 1 },
  ];
  expect(marginalGainStop(falling, 0.01, 3, 'minimize')).toBe(false);
  // metric flat under minimize -> no gain -> fire
  const flat = [
    { metric: 0.5, cost: 1 },
    { metric: 0.4999, cost: 1 },
    { metric: 0.4998, cost: 1 },
    { metric: 0.4997, cost: 1 },
  ];
  expect(marginalGainStop(flat, 0.01, 3, 'minimize')).toBe(true);
});

test('zero windowed cost does not fire (avoids divide-by-zero)', () => {
  const history = [
    { metric: 0.9, cost: 0 },
    { metric: 0.91, cost: 0 },
    { metric: 0.92, cost: 0 },
    { metric: 0.93, cost: 0 },
  ];
  expect(marginalGainStop(history, 0.01, 3, 'maximize')).toBe(false);
});
