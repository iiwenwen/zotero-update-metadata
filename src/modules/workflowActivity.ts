export type WorkflowActivity = "idle" | "reviewing" | "retrying" | "rolling-back";

let activity: WorkflowActivity = "idle";
const listeners = new Set<(activity: WorkflowActivity) => void>();

export function getWorkflowActivity(): WorkflowActivity {
  return activity;
}

export function subscribeWorkflowActivity(listener: (activity: WorkflowActivity) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function notifyActivity(): void {
  const current = activity;
  for (const listener of [...listeners]) {
    try {
      listener(current);
    } catch {
      // 展示监听失败不能中断工作流取得或释放占用。
    }
  }
}

/** 同步取得占用，不排队；返回仅能释放本次占用的幂等清理函数。 */
export function tryAcquireWorkflowActivity(next: Exclude<WorkflowActivity, "idle">): (() => void) | null {
  if (activity !== "idle") return null;
  activity = next;
  notifyActivity();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activity = "idle";
    notifyActivity();
  };
}
