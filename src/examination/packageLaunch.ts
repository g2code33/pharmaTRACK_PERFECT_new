export interface PharmaExamLaunch {
  path?: string;
  bytes?: Uint8Array;
}

const pending: PharmaExamLaunch[] = [];
const listeners = new Set<(launch: PharmaExamLaunch) => void>();

export function queuePharmaExamLaunch(launch: PharmaExamLaunch): void {
  pending.push(launch);
  listeners.forEach((listener) => listener(launch));
}

export function takePharmaExamLaunches(): PharmaExamLaunch[] {
  return pending.splice(0, pending.length);
}

export function subscribePharmaExamLaunches(listener: (launch: PharmaExamLaunch) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
