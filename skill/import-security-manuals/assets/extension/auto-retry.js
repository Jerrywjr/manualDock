/** One timer for the currently selected task. Persisted deadlines belong to the task. */
export class AutoRetryClock {
  constructor({
    getTask,
    retry,
    now = () => Date.now(),
    setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimer = (id) => globalThis.clearTimeout(id),
    onError = () => {},
  }) {
    Object.assign(this, { getTask, retry, now, setTimer, clearTimer, onError });
    this.timer = null;
    this.generation = 0;
    this.running = false;
  }
  dispose() {
    this.generation++;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }
  refresh() {
    this.dispose();
    const task = this.getTask(),
      state = task?.autoRecovery;
    if (!state?.enabled || !Number.isFinite(state.nextAttemptAt) || this.running) return;
    const generation = this.generation,
      taskId = task.taskId;
    this.timer = this.setTimer(
      async () => {
        this.timer = null;
        if (
          generation !== this.generation ||
          this.getTask()?.taskId !== taskId ||
          !this.getTask()?.autoRecovery?.enabled ||
          this.running
        )
          return;
        this.running = true;
        try {
          await this.retry(taskId);
        } catch (e) {
          this.onError(e);
        } finally {
          this.running = false;
          if (generation === this.generation) this.refresh();
        }
      },
      Math.max(1, state.nextAttemptAt - this.now()),
    );
  }
}
