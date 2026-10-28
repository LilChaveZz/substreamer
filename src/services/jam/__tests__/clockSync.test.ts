import { ClockSync, clockSample } from '../clockSync';

describe('clockSample', () => {
  it('calculates round trip time and server offset', () => {
    expect(clockSample(1000, 1100, 1080)).toEqual({ rttMs: 100, offsetMs: 30 });
  });

  it('rejects invalid timestamps and clamps a negative round trip to zero', () => {
    expect(clockSample(0, 100, 150)).toBeNull();
    expect(clockSample(100, 90, 150)).toEqual({ rttMs: 0, offsetMs: 55 });
  });
});

describe('ClockSync', () => {
  it('keeps the offset from the sample with the lowest round trip time', () => {
    jest.useFakeTimers();
    let now = 1000;
    const sent: number[] = [];
    const samples: Array<[number, number]> = [];
    const clock = new ClockSync(
      (t0) => sent.push(t0),
      (rttMs, offsetMs) => samples.push([rttMs, offsetMs]),
      () => now,
    );

    clock.start();
    expect(sent).toEqual([1000]);
    now = 1100;
    clock.handlePong(1000, 1070);
    expect(clock.offsetMs).toBe(20);
    expect(clock.rttMs).toBe(100);

    now = 1500;
    jest.advanceTimersByTime(500);
    now = 1550;
    clock.handlePong(1500, 1540);
    expect(clock.offsetMs).toBe(15);
    expect(clock.rttMs).toBe(50);
    expect(samples).toEqual([[100, 20], [50, 15]]);
    clock.stop();
    jest.useRealTimers();
  });

  it('ignores pongs that do not match an outstanding ping', () => {
    const samples = jest.fn();
    const clock = new ClockSync(jest.fn(), samples, () => 1100);
    clock.handlePong(1000, 1050);
    expect(samples).not.toHaveBeenCalled();
    clock.stop();
  });
});
