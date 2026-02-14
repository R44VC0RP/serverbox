import { ServerBoxError, type Logger } from "@serverbox/core";
import type { ServerBox } from "@serverbox/sdk";
import type { ServerBoxInstance } from "@serverbox/sdk";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      reject(new ServerBoxError("INSTANCE_NOT_RUNNING", message));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

export class ResumeCoordinator {
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly serverbox: ServerBox,
    private readonly autoResume: boolean,
    private readonly resumeTimeoutMs: number,
    private readonly logger: Logger
  ) {}

  async ensureRunning(id: string): Promise<ServerBoxInstance> {
    this.logger.debug(`[resume] Checking instance ${id}`);
    const instance = await this.serverbox.get(id);
    if (instance.state === "running") {
      this.logger.debug(`[resume] Instance ${id} already running`);
      return instance;
    }

    if (!this.autoResume) {
      throw new ServerBoxError(
        "INSTANCE_NOT_RUNNING",
        `Instance '${id}' is ${instance.state}. Auto-resume is disabled.`
      );
    }

    let pending = this.inFlight.get(id);
    if (!pending) {
      this.logger.info(`[resume] Auto-resuming instance ${id} from state=${instance.state}`);
      pending = instance
        .resume({ timeout: this.resumeTimeoutMs })
        .then(() => undefined)
        .finally(() => {
          this.inFlight.delete(id);
        });
      this.inFlight.set(id, pending);
    } else {
      this.logger.debug(`[resume] Reusing in-flight resume for instance ${id}`);
    }

    await withTimeout(
      pending,
      this.resumeTimeoutMs,
      `Timed out waiting to resume instance '${id}'.`
    );

    this.logger.info(`[resume] Instance ${id} resumed`);

    return this.serverbox.get(id);
  }
}
