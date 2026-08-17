export interface TimerHandle {
  readonly handle: unknown;
}

export interface Clock {
  now(): number;
  setTimer(delayMs: number, callback: () => void): TimerHandle;
  clearTimer(handle: TimerHandle): void;
  sleep(delayMs: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  setTimer: (delayMs, callback) => ({handle: setTimeout(callback, delayMs)}),
  clearTimer: (timer) => clearTimeout(timer.handle as NodeJS.Timeout),
  sleep: (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
};
