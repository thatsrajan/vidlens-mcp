export interface ProgressEvent {
  phase: string;
  current: number;
  total?: number;
  message?: string;
}

export interface ProgressReporter {
  report(event: ProgressEvent): Promise<void> | void;
}

export const noopProgressReporter: ProgressReporter = {
  report: () => undefined,
};

export async function reportProgress(
  reporter: ProgressReporter | undefined,
  event: ProgressEvent,
): Promise<void> {
  if (!reporter) {
    return;
  }
  await reporter.report(event);
}
